const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 't'.repeat(64);
const instances = [];

function authed() {
  return { 'X-A2A-Token': TOKEN, 'Content-Type': 'application/json' };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startInstance() {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-tpl-test-'));
  const env = {
    ...process.env,
    HOME: path.join(sandbox, 'home'),
    A2A_PORT: String(port),
    A2A_HOME: sandbox,
    A2A_TOKEN_FILE: path.join(sandbox, 'token'),
    A2A_LOGS_DIR: path.join(sandbox, 'logs'),
    A2A_ACCOUNTS_DIR: path.join(sandbox, 'accounts'),
    A2A_PRESETS_DIR: path.join(sandbox, 'presets'),
    A2A_TEAMS_DIR: path.join(sandbox, 'teams'),
    A2A_REAL_HOME: path.join(sandbox, 'home'),
    A2A_UPDATE_CHECK: '0',
    AGY_BIN: path.join(__dirname, 'fake-agy.sh'),
    CLAUDE_BIN: path.join(__dirname, 'fake-claude.sh'),
    CODEX_BIN: path.join(__dirname, 'fake-codex.sh')
  };
  fs.mkdirSync(env.A2A_REAL_HOME, { recursive: true });
  fs.writeFileSync(env.A2A_TOKEN_FILE, TOKEN + '\n');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  const instance = { base: `http://127.0.0.1:${port}`, sandbox, env, proc };
  instances.push(instance);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${instance.base}/health`)).ok) return instance;
    } catch (err) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

after(() => {
  for (const instance of instances) {
    try {
      instance.proc.kill('SIGKILL');
    } catch (err) {}
    fs.rmSync(instance.sandbox, { recursive: true, force: true });
  }
});

const get = async (instance, url) => {
  const res = await fetch(instance.base + url);
  return { status: res.status, body: await res.json() };
};
const addAccount = (instance, id, provider) => fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id, provider }) });
const createTeam = async (instance, draft) => {
  const { template, ...team } = draft;
  const res = await fetch(`${instance.base}/api/teams`, { method: 'POST', headers: authed(), body: JSON.stringify(team) });
  return { status: res.status, body: await res.json() };
};

test('the shipped team templates are valid and use only known roles', async () => {
  const instance = await startInstance();
  const { body } = await get(instance, '/api/team-templates');
  const roles = new Set((await get(instance, '/api/roles')).body.roles.map((r) => r.id));
  assert.deepStrictEqual(body.templates.map((t) => t.id).sort(), ['android-app', 'api-service', 'bug-fix', 'flutter-app', 'ios-app', 'release-prep', 'review-audit', 'web-app']);
  for (const t of body.templates) {
    assert.ok(t.title && t.description && t.leader.instructions, t.id);
    assert.ok(['agy', 'claude', 'codex'].includes(t.leader.provider), t.id);
    for (const m of t.members) for (const role of m.roles) assert.ok(roles.has(role), `${t.id}: ${role}`);
  }
  assert.strictEqual((await get(instance, '/api/team-templates/no-such/draft')).status, 404);
  assert.strictEqual((await get(instance, '/api/team-templates/bad%20id/draft')).status, 404);
});

test('a template draft gives every member its own account, prefers the suggested CLI, and saves as a team', async () => {
  const instance = await startInstance();
  await addAccount(instance, 'agy-b', 'agy');
  await addAccount(instance, 'claude-b', 'claude');
  const { body } = await get(instance, '/api/team-templates/web-app/draft');
  const draft = body.team;
  assert.strictEqual(draft.template, 'web-app');
  assert.strictEqual(draft.leader.account, 'claude');
  assert.deepStrictEqual(draft.members.map((m) => m.account), ['agy', 'agy-b', 'codex']);
  assert.deepStrictEqual(draft.members.map((m) => m.roles), [['web-engineer'], ['api-engineer'], ['test-engineer']]);
  for (const file of ['web-app', 'ios-app', 'android-app', 'flutter-app', 'api-service', 'bug-fix', 'review-audit', 'release-prep']) {
    const each = (await get(instance, `/api/team-templates/${file}/draft`)).body.team;
    assert.strictEqual(new Set(each.members.map((m) => m.account)).size, each.members.length, `${file}: a member account is used twice`);
    const saved = await createTeam(instance, each);
    assert.strictEqual(saved.status, 201, `${file}: ${JSON.stringify(saved.body)}`);
  }
});

test('the next team from a template is led by an account that leads no team yet, and gets a free id', async () => {
  const instance = await startInstance();
  await addAccount(instance, 'claude-b', 'claude');
  const ios = (await get(instance, '/api/team-templates/ios-app/draft')).body.team;
  assert.strictEqual(ios.leader.account, 'claude');
  assert.strictEqual((await createTeam(instance, ios)).status, 201);
  const android = (await get(instance, '/api/team-templates/android-app/draft')).body.team;
  assert.strictEqual(android.leader.account, 'claude-b');
  assert.strictEqual((await get(instance, '/api/team-templates/ios-app/draft')).body.team.id, 'ios-app-2');
});

test('with a single signed-in account the template roles merge into that one member', async () => {
  const instance = await startInstance();
  const cli = path.join(instance.env.A2A_REAL_HOME, '.gemini', 'antigravity-cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, '.signed-in'), 'ok\n');
  await fetch(`${instance.base}/api/accounts/agy/check`, { method: 'POST', headers: authed() });
  const draft = (await get(instance, '/api/team-templates/bug-fix/draft')).body.team;
  assert.strictEqual(draft.leader.account, 'agy');
  assert.strictEqual(draft.members.length, 1);
  assert.strictEqual(draft.members[0].account, 'agy');
  assert.deepStrictEqual(draft.members[0].roles, ['bug-triager', 'lead-software-engineer', 'web-engineer', 'api-engineer', 'mobile-engineer', 'test-engineer']);
  assert.strictEqual(draft.maxParallel, 1);
  assert.strictEqual((await createTeam(instance, draft)).status, 201);
});

test('the CLI lists the templates and creates a team from one', async () => {
  const instance = await startInstance();
  const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'teams', ...args], { env: instance.env, encoding: 'utf-8' });
  assert.match(run('templates'), /release-prep +Release preparation/);
  assert.match(run('new', 'my-review', '--template', 'review-audit'), /Created team "my-review" \(Review and audit\) from template "review-audit"/);
  const team = (await get(instance, '/api/teams/my-review')).body.team;
  assert.deepStrictEqual(team.members.map((m) => m.roles[0]), ['code-reviewer', 'security-auditor', 'web-performance-auditor']);
});
