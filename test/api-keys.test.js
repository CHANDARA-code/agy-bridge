const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'k'.repeat(64);
const GOOD_KEY = 'sk-good-key-0123456789abcd';
const BAD_KEY = 'sk-bad-key-0123456789wxyz';
let fakeApi;
let main;

const authed = () => ({ 'X-A2A-Token': TOKEN, 'Content-Type': 'application/json' });

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

function startFakeApi() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    const key = auth.replace(/^Bearer /, '') || req.headers['x-api-key'] || '';
    seen.push({ url: req.url, key });
    res.writeHead(key === GOOD_KEY ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(key === GOOD_KEY ? { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-pro-listed' }] } : { error: 'invalid key' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}/models`, close: () => server.close() })));
}

async function startInstance() {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-apikey-test-'));
  const workspace = path.join(sandbox, 'ws');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    A2A_PORT: String(port),
    A2A_HOME: sandbox,
    A2A_TOKEN_FILE: path.join(sandbox, 'token'),
    A2A_LOGS_DIR: path.join(sandbox, 'logs'),
    A2A_ACCOUNTS_DIR: path.join(sandbox, 'accounts'),
    A2A_PRESETS_DIR: path.join(sandbox, 'presets'),
    A2A_TEAMS_DIR: path.join(sandbox, 'teams'),
    A2A_REAL_HOME: home,
    A2A_UPDATE_CHECK: '0',
    A2A_API_CHECK_URL: fakeApi.url,
    AGY_BIN: path.join(__dirname, 'fake-agy.sh'),
    CLAUDE_BIN: path.join(__dirname, 'fake-claude.sh'),
    CODEX_BIN: path.join(__dirname, 'fake-codex.sh'),
    FAKE_ARGS_FILE: path.join(sandbox, 'fake_args.log'),
    FAKE_CLAUDE_MODE: 'stream',
    FAKE_CODEX_MODE: 'stream',
    ANTHROPIC_API_KEY: 'sk-from-the-shell-must-not-leak',
    ANTHROPIC_BASE_URL: 'https://leaked.example.com',
    ANTHROPIC_CUSTOM_HEADERS: 'x-corp-gateway-key: must-not-leak'
  };
  fs.writeFileSync(env.A2A_TOKEN_FILE, TOKEN + '\n');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  const instance = { base: `http://127.0.0.1:${port}`, sandbox, workspace, env, proc };
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${instance.base}/health`)).ok) return instance;
    } catch (err) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

const post = async (url, body) => {
  const res = await fetch(main.base + url, { method: 'POST', headers: authed(), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json(), raw: JSON.stringify(body) };
};
const put = async (url, body) => {
  const res = await fetch(main.base + url, { method: 'PUT', headers: authed(), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const accountsFile = () => fs.readFileSync(path.join(main.sandbox, 'accounts', 'accounts.json'), 'utf-8');

async function runTask(account) {
  const { body } = await post('/api/tasks', { role: 'web-engineer', prompt: 'check the env', workspace: main.workspace, mode: 'plan', account });
  return waitFor(async () => {
    const task = (await (await fetch(`${main.base}/api/tasks`)).json()).tasks.find((t) => t.id === body.taskId);
    return task && task.status !== 'running' ? task : null;
  });
}

before(async () => {
  fakeApi = await startFakeApi();
  main = await startInstance();
});

after(() => {
  try {
    main.proc.kill('SIGKILL');
  } catch (err) {}
  fs.rmSync(main.sandbox, { recursive: true, force: true });
  fakeApi.close();
});

test('the service list names each provider, its engine and whether the key can be checked, with no secrets', async () => {
  const { services } = await (await fetch(`${main.base}/api/api-services`)).json();
  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  for (const id of ['anthropic', 'deepseek', 'kimi', 'zai', 'zhipu', 'minimax', 'alibaba', 'openrouter', 'volcengine', 'custom-anthropic', 'openai', 'kimi-codex', 'groq', 'custom-openai']) assert.ok(byId[id], id);
  assert.strictEqual(byId.deepseek.engine, 'claude');
  assert.strictEqual(byId.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.strictEqual(byId.openai.engine, 'codex');
  assert.strictEqual(byId.alibaba.baseUrlRequired, true);
  assert.strictEqual(byId['custom-anthropic'].baseUrlRequired, true);
  assert.ok(!JSON.stringify(services).includes('keyVar'));
});

test('a DeepSeek key account is checked, never sends its key back, and runs Claude Code against DeepSeek', async () => {
  const created = await post('/api/accounts', { id: 'deepseek-1', label: 'DeepSeek', apiKey: { service: 'deepseek', key: GOOD_KEY } });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const account = created.body.account;
  assert.strictEqual(account.provider, 'claude');
  assert.deepStrictEqual(account.apiKey, { service: 'deepseek', baseUrl: null, fastModel: null, last4: 'abcd', serviceName: 'DeepSeek' });
  assert.strictEqual(account.model, 'deepseek-flash[1m]');
  assert.strictEqual(account.status.state, 'signed-in');
  assert.match(account.status.detail, /DeepSeek accepted the key ending in abcd/);
  assert.ok(!JSON.stringify(created.body).includes(GOOD_KEY));
  assert.ok(!accountsFile().includes(GOOD_KEY));
  const keyFile = path.join(main.sandbox, 'accounts', 'deepseek-1', 'api-key');
  assert.strictEqual(fs.readFileSync(keyFile, 'utf-8').trim(), GOOD_KEY);
  assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!(await (await fetch(`${main.base}/api/accounts`)).text()).includes(GOOD_KEY));

  const models = await (await fetch(`${main.base}/api/accounts/deepseek-1/models`)).json();
  assert.deepStrictEqual(models.models.map((m) => m.id), ['deepseek-flash[1m]', 'deepseek-flash', 'deepseek-pro-listed']);

  fs.writeFileSync(main.env.FAKE_ARGS_FILE, '');
  const task = await runTask('deepseek-1');
  assert.strictEqual(task.status, 'completed');
  const logged = fs.readFileSync(main.env.FAKE_ARGS_FILE, 'utf-8');
  assert.match(logged, /ANTHROPIC_AUTH_TOKEN_SET: yes/);
  assert.match(logged, /ANTHROPIC_API_KEY_SET: no/);
  assert.match(logged, /ANTHROPIC_CUSTOM_HEADERS_SET: no/);
  assert.match(logged, /ANTHROPIC_BASE_URL: https:\/\/api\.deepseek\.com\/anthropic/);
  assert.match(logged, /ANTHROPIC_MODEL: deepseek-flash\[1m\]/);
  assert.match(logged, /ANTHROPIC_DEFAULT_HAIKU_MODEL: deepseek-flash\n/);
  assert.match(logged, /ARGV: .*--model deepseek-flash\[1m\]/);
  const log = await (await fetch(`${main.base}/api/tasks/${task.id}/log`)).text();
  assert.ok(!log.includes(GOOD_KEY));
});

test('a rejected key shows as signed out until it is replaced, and sign-in is refused for key accounts', async () => {
  const created = await post('/api/accounts', { id: 'deepseek-bad', apiKey: { service: 'deepseek', key: BAD_KEY } });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.account.status.state, 'signed-out');
  assert.match(created.body.account.status.detail, /rejected the key ending in wxyz/);
  const login = await post('/api/accounts/deepseek-bad/login', { method: 'browser' });
  assert.strictEqual(login.status, 400);
  assert.match(login.body.error, /API key/);
  assert.strictEqual((await post('/api/accounts/deepseek-bad/logout', {})).status, 400);

  const replaced = await put('/api/accounts/deepseek-bad/api-key', { key: GOOD_KEY });
  assert.strictEqual(replaced.status, 200);
  assert.strictEqual(replaced.body.account.status.state, 'signed-in');
  assert.strictEqual(replaced.body.account.apiKey.last4, 'abcd');
  assert.strictEqual((await put('/api/accounts/claude/api-key', { key: GOOD_KEY })).status, 400);
});

test('bad API key accounts are refused with a reason', async () => {
  const cases = [
    [{ id: 'x1', apiKey: { service: 'nope', key: GOOD_KEY } }, /Unknown API service/],
    [{ id: 'x2', apiKey: { service: 'deepseek', key: 'has a space in it' } }, /without spaces/],
    [{ id: 'x3', apiKey: { service: 'deepseek' } }, /Paste the API key/],
    [{ id: 'x4', apiKey: { service: 'custom-anthropic', key: GOOD_KEY } }, /needs a base URL/],
    [{ id: 'x5', apiKey: { service: 'custom-anthropic', key: GOOD_KEY, baseUrl: 'http://gateway.example.com' } }, /https/],
    [{ id: 'x6', apiKey: { service: 'alibaba', key: GOOD_KEY, baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic' } }, /placeholders/],
    [{ id: 'x7', provider: 'codex', apiKey: { service: 'deepseek', key: GOOD_KEY } }, /runs with Claude Code, not Codex/],
    [{ id: 'x8', apiKey: { service: 'kimi-cn', key: GOOD_KEY } }, /Choose the Kimi \(Moonshot AI, China\) model/],
    [{ id: 'x9', apiKey: { service: 'deepseek', key: GOOD_KEY, fastModel: '--dangerous' } }, /Invalid model name/]
  ];
  for (const [body, pattern] of cases) {
    const res = await post('/api/accounts', body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  }
  assert.ok(!fs.existsSync(path.join(main.sandbox, 'accounts', 'x2')));
  const local = await post('/api/accounts', { id: 'gateway', model: 'my-model', apiKey: { service: 'custom-anthropic', key: GOOD_KEY, baseUrl: 'http://127.0.0.1:4000/' } });
  assert.strictEqual(local.status, 201, JSON.stringify(local.body));
  assert.strictEqual(local.body.account.apiKey.baseUrl, 'http://127.0.0.1:4000');
  assert.match(local.body.account.status.detail, /saved for http:\/\/127\.0\.0\.1:4000\. The first task proves it/);
  const seenBefore = fakeApi.seen.length;
  await post('/api/accounts/gateway/check', {});
  assert.strictEqual(fakeApi.seen.length, seenBefore);
});

test('a Kimi account on Codex gets its own provider config and key variable', async () => {
  const created = await post('/api/accounts', { id: 'kimi-codex-1', apiKey: { service: 'kimi-codex', key: GOOD_KEY } });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.account.provider, 'codex');
  const config = fs.readFileSync(path.join(main.sandbox, 'accounts', 'kimi-codex-1', 'codex', 'config.toml'), 'utf-8');
  assert.match(config, /^model_provider = "a2a"$/m);
  assert.match(config, /^model = "kimi-k3\.1-pro"$/m);
  assert.match(config, /^base_url = "https:\/\/api\.moonshot\.ai\/v1"$/m);
  assert.match(config, /^env_key = "A2A_PROVIDER_API_KEY"$/m);
  assert.match(config, /^wire_api = "responses"$/m);
  assert.ok(!config.includes(GOOD_KEY));

  fs.writeFileSync(main.env.FAKE_ARGS_FILE, '');
  const task = await runTask('kimi-codex-1');
  assert.strictEqual(task.status, 'completed');
  const logged = fs.readFileSync(main.env.FAKE_ARGS_FILE, 'utf-8');
  assert.match(logged, /A2A_PROVIDER_API_KEY_SET: yes/);
  assert.match(logged, /OPENAI_API_KEY_SET: no/);
  assert.match(logged, /CODEX_HOME: .*kimi-codex-1\/codex/);

  assert.strictEqual((await put('/api/accounts/kimi-codex-1', { model: 'kimi-other' })).status, 200);
  assert.match(fs.readFileSync(path.join(main.sandbox, 'accounts', 'kimi-codex-1', 'codex', 'config.toml'), 'utf-8'), /^model = "kimi-other"$/m);
});

test('the CLI lists services and adds a key account from stdin, and deleting it removes the key', async () => {
  const cli = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'accounts', ...args], { env: main.env });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
    child.stdin.end(input || '');
  });
  assert.match(await cli(['services']), /deepseek +DeepSeek +runs with Claude Code/);
  const out = await cli(['add', 'ds-cli', '--service', 'deepseek', '--label', 'From CLI'], GOOD_KEY + '\n');
  assert.match(out, /Created API key account "ds-cli" \(DeepSeek, runs with Claude Code\): DeepSeek accepted the key ending in abcd/);
  assert.ok(!accountsFile().includes(GOOD_KEY));
  const res = await fetch(`${main.base}/api/accounts/ds-cli`, { method: 'DELETE', headers: authed() });
  assert.strictEqual(res.status, 200);
  assert.ok(!fs.existsSync(path.join(main.sandbox, 'accounts', 'ds-cli')));
});
