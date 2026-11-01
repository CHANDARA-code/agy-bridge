const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'c'.repeat(64);
const FAKE_AGY = path.join(__dirname, 'fake-agy.sh');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.sh');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.sh');
const instances = [];

function authed(extra = {}) {
  return { 'X-A2A-Token': TOKEN, 'Content-Type': 'application/json', ...extra };
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
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

async function startInstance(extraEnv = {}) {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-usage-test-'));
  const logsDir = path.join(sandbox, 'logs');
  const tokenFile = path.join(sandbox, 'token');
  const workspace = path.join(sandbox, 'ws');
  const presetsDir = path.join(sandbox, 'presets');
  const accountsDir = path.join(sandbox, 'accounts');
  const realHome = path.join(sandbox, 'home');
  const teamsDir = path.join(sandbox, 'teams');
  const argsFile = path.join(sandbox, 'fake_args.log');

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(presetsDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(realHome, { recursive: true });
  fs.mkdirSync(teamsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, TOKEN + '\n');

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      A2A_PORT: String(port),
      A2A_LOGS_DIR: logsDir,
      A2A_TOKEN_FILE: tokenFile,
      A2A_SETTINGS_FILE: path.join(sandbox, 'settings.json'),
      A2A_PRESETS_DIR: presetsDir,
      A2A_ACCOUNTS_DIR: accountsDir,
      A2A_TEAMS_DIR: teamsDir,
      A2A_REAL_HOME: realHome,
      AGY_BIN: FAKE_AGY,
      CLAUDE_BIN: FAKE_CLAUDE,
      CODEX_BIN: FAKE_CODEX,
      FAKE_ARGS_FILE: argsFile,
      FAKE_AGY_MODE: 'stream',
      FAKE_CLAUDE_MODE: 'stream',
      FAKE_CODEX_MODE: 'stream',
      ...extraEnv
    },
    stdio: 'ignore'
  });

  proc.on('error', () => {});

  const instance = {
    port,
    base: `http://127.0.0.1:${port}`,
    sandbox,
    logsDir,
    workspace,
    presetsDir,
    accountsDir,
    teamsDir,
    realHome,
    argsFile,
    proc
  };
  instances.push(instance);

  await waitFor(async () => {
    try {
      return (await fetch(`${instance.base}/health`)).ok;
    } catch (err) {
      return false;
    }
  });

  return instance;
}

let main;

before(async () => {
  main = await startInstance();
  process.env.A2A_ACCOUNTS_DIR = main.accountsDir;
  process.env.A2A_REAL_HOME = main.realHome;
  process.env.A2A_LOGS_DIR = main.logsDir;
  process.env.A2A_TEAMS_DIR = main.teamsDir;
});

after(() => {
  for (const instance of instances) {
    try {
      instance.proc.kill('SIGKILL');
    } catch (err) {}
    try {
      fs.rmSync(instance.sandbox, { recursive: true, force: true });
    } catch (err) {}
  }
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BUFFER.toString('base64')}`;
const WEBP_DATA_URL = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

test('Claude quota windows stored with labels, percent and ISO reset', async () => {
  const addRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'claude-quota-acc', provider: 'claude', label: 'Claude Quota' })
  });
  assert.strictEqual(addRes.status, 201);

  const accDir = path.join(main.accountsDir, 'claude-quota-acc', 'claude');
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(accDir, '.claude-mode'), 'quota');

  const dispatchRes = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Check quota',
      workspace: main.workspace,
      account: 'claude-quota-acc'
    })
  });
  assert.strictEqual(dispatchRes.status, 202);
  const { taskId } = await dispatchRes.json();

  const task = await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    if (!res.ok) return null;
    const body = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(body.task?.status) ? body.task : null;
  });
  assert.strictEqual(task.status, 'completed');

  const accRes = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  const { accounts: accList } = await accRes.json();
  const acc = accList.find((a) => a.id === 'claude-quota-acc');
  assert(acc);
  assert(acc.limits);
  assert.strictEqual(acc.limits.status, 'ok');
  assert(Array.isArray(acc.limits.windows));
  assert.strictEqual(acc.limits.windows.length, 2);

  const fiveHour = acc.limits.windows.find((w) => w.name === 'five_hour');
  assert(fiveHour);
  assert.strictEqual(fiveHour.label, '5-hour');
  assert.strictEqual(fiveHour.usedPercent, 22);
  assert.strictEqual(fiveHour.resetsAt, new Date(1793278800 * 1000).toISOString());

  const sevenDay = acc.limits.windows.find((w) => w.name === 'seven_day');
  assert(sevenDay);
  assert.strictEqual(sevenDay.label, '7-day');
  assert.strictEqual(sevenDay.usedPercent, 26);
  assert.strictEqual(sevenDay.resetsAt, new Date(1793520000 * 1000).toISOString());

  const usageFile = path.join(main.logsDir, 'usage.jsonl');
  const usageLines = fs.readFileSync(usageFile, 'utf-8').trim().split('\n');
  const lastRecord = JSON.parse(usageLines[usageLines.length - 1]);
  assert(lastRecord.models);
  assert(lastRecord.models['claude-opus-5-5']);
  assert.strictEqual(lastRecord.models['claude-opus-5-5'].total_tokens, 4 + 17132 + 299, 'per-model totals leave out the 59935 cache reads too');
  assert.strictEqual(lastRecord.models['claude-opus-5-5'].cost_usd, 0.155039);
});

test('Claude usage-limit failure marks account limited', async () => {
  const addRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'claude-limit-acc', provider: 'claude', label: 'Claude Limit' })
  });
  assert.strictEqual(addRes.status, 201);

  const accDir = path.join(main.accountsDir, 'claude-limit-acc', 'claude');
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(accDir, '.claude-mode'), 'usage-limit');

  const dispatchRes = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Trigger usage limit',
      workspace: main.workspace,
      account: 'claude-limit-acc'
    })
  });
  assert.strictEqual(dispatchRes.status, 202);
  const { taskId } = await dispatchRes.json();

  const task = await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    if (!res.ok) return null;
    const body = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(body.task?.status) ? body.task : null;
  });
  assert.strictEqual(task.status, 'failed');

  const accRes = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  const { accounts: accList } = await accRes.json();
  const acc = accList.find((a) => a.id === 'claude-limit-acc');
  assert(acc);
  assert(acc.limits);
  assert.strictEqual(acc.limits.status, 'limited');
});

test('Codex windows read from task own rollout file (and rollout for another thread is ignored)', async () => {
  const addRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'codex-quota-acc', provider: 'codex', label: 'Codex Quota' })
  });
  assert.strictEqual(addRes.status, 201);

  const accDir = path.join(main.accountsDir, 'codex-quota-acc', 'codex');
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(accDir, '.codex-mode'), 'quota');

  const dispatchRes = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'test-engineer',
      prompt: 'Check codex quota',
      workspace: main.workspace,
      account: 'codex-quota-acc'
    })
  });
  assert.strictEqual(dispatchRes.status, 202);
  const { taskId } = await dispatchRes.json();

  const task = await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    if (!res.ok) return null;
    const body = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(body.task?.status) ? body.task : null;
  });
  assert.strictEqual(task.status, 'completed');

  const accRes = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  const { accounts: accList } = await accRes.json();
  const acc = accList.find((a) => a.id === 'codex-quota-acc');
  assert(acc);
  assert(acc.limits);
  assert.strictEqual(acc.limits.status, 'ok');
  assert(Array.isArray(acc.limits.windows));
  assert.strictEqual(acc.limits.windows.length, 2);

  const primary = acc.limits.windows.find((w) => w.name === 'primary');
  assert(primary);
  assert.strictEqual(primary.label, '5-hour');
  assert.strictEqual(primary.usedPercent, 8);
  assert.strictEqual(primary.resetsAt, new Date(1780902442 * 1000).toISOString());

  const secondary = acc.limits.windows.find((w) => w.name === 'secondary');
  assert(secondary);
  assert.strictEqual(secondary.label, 'Weekly');
  assert.strictEqual(secondary.usedPercent, 37);
  assert.strictEqual(secondary.resetsAt, new Date(1781421196 * 1000).toISOString());
});

test('Antigravity exhaustion marks account limited', async () => {
  const addRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'agy-quota-acc', provider: 'agy', label: 'AGY Quota' })
  });
  assert.strictEqual(addRes.status, 201);

  const accDir = path.join(main.accountsDir, 'agy-quota-acc', 'home');
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(accDir, '.agy-mode'), 'quota');

  const dispatchRes = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'solution-architect',
      prompt: 'Trigger AGY exhaustion',
      workspace: main.workspace,
      account: 'agy-quota-acc'
    })
  });
  assert.strictEqual(dispatchRes.status, 202);
  const { taskId } = await dispatchRes.json();

  const task = await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    if (!res.ok) return null;
    const body = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(body.task?.status) ? body.task : null;
  });
  assert.strictEqual(task.status, 'failed');

  const accRes = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  const { accounts: accList } = await accRes.json();
  const acc = accList.find((a) => a.id === 'agy-quota-acc');
  assert(acc);
  assert(acc.limits);
  assert.strictEqual(acc.limits.status, 'limited');
  assert(Array.isArray(acc.limits.windows));
  assert.strictEqual(acc.limits.windows.length, 0);
});

test('/api/usage/accounts returns zero-filled byDay, today/last7d, byRole, byModel with cost and validates days', async () => {
  const badParamRes = await fetch(`${main.base}/api/usage/accounts?days=0`);
  assert.strictEqual(badParamRes.status, 400);
  const badParamRes2 = await fetch(`${main.base}/api/usage/accounts?days=100`);
  assert.strictEqual(badParamRes2.status, 400);
  const badParamRes3 = await fetch(`${main.base}/api/usage/accounts?days=abc`);
  assert.strictEqual(badParamRes3.status, 400);

  const res = await fetch(`${main.base}/api/usage/accounts?days=7`);
  assert.strictEqual(res.status, 200);
  const report = await res.json();

  assert.strictEqual(report.days, 7);
  assert(typeof report.from === 'string');
  assert(typeof report.to === 'string');
  assert(typeof report.generatedAt === 'string');
  assert(report.totals);
  assert(typeof report.totals.tasks === 'number');
  assert(typeof report.totals.total_tokens === 'number');
  assert(typeof report.totals.cost_usd === 'number');
  assert(Array.isArray(report.accounts));

  const claudeAcc = report.accounts.find((a) => a.id === 'claude-quota-acc');
  assert(claudeAcc);
  assert.strictEqual(claudeAcc.byDay.length, 7);
  for (let i = 0; i < 7; i++) {
    assert(claudeAcc.byDay[i].date);
    assert(typeof claudeAcc.byDay[i].tasks === 'number');
    assert(typeof claudeAcc.byDay[i].total_tokens === 'number');
  }
  assert(claudeAcc.today);
  assert(claudeAcc.last7d);
  assert(Array.isArray(claudeAcc.byRole));
  assert(Array.isArray(claudeAcc.byModel));

  const opus = claudeAcc.byModel.find((m) => m.model === 'claude-opus-5-5');
  assert(opus);
  assert(opus.total_tokens > 0);
  assert(opus.cost_usd > 0);

  const sysAgy = report.accounts.find((a) => a.id === 'agy');
  assert(sysAgy);
  assert.strictEqual(sysAgy.byDay.length, 7);
});

test('budget PUT/DELETE validation, budgetUsed calculation, and stop enforcement', async () => {
  const addRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'budget-test-acc', provider: 'claude', label: 'Budget Test' })
  });
  assert.strictEqual(addRes.status, 201);

  const badPeriod = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'year', tokens: 5000, stop: false })
  });
  assert.strictEqual(badPeriod.status, 400);

  const badTokens = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'day', tokens: 500, stop: false })
  });
  assert.strictEqual(badTokens.status, 400);

  const badStop = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'day', tokens: 5000, stop: 'yes' })
  });
  assert.strictEqual(badStop.status, 400);

  const putRes = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'day', tokens: 1000, stop: false })
  });
  assert.strictEqual(putRes.status, 200);
  const putBody = await putRes.json();
  assert(putBody.account.budget);
  assert.strictEqual(putBody.account.budget.period, 'day');
  assert.strictEqual(putBody.account.budget.tokens, 1000);
  assert.strictEqual(putBody.account.budget.stop, false);
  assert(putBody.account.budgetUsed);
  assert.strictEqual(typeof putBody.account.budgetUsed.percent, 'number');

  const accDir = path.join(main.accountsDir, 'budget-test-acc', 'claude');
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(accDir, '.claude-mode'), 'stream');

  const dispatch1 = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Spend some tokens',
      workspace: main.workspace,
      account: 'budget-test-acc'
    })
  });
  assert.strictEqual(dispatch1.status, 202);
  const { taskId: id1 } = await dispatch1.json();
  const task1 = await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${id1}`, { headers: authed() });
    if (!res.ok) return null;
    const b = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(b.task?.status) ? b.task : null;
  });
  assert.strictEqual(task1.status, 'completed');

  const check1 = await (await fetch(`${main.base}/api/accounts`, { headers: authed() })).json();
  const acc1 = check1.accounts.find((a) => a.id === 'budget-test-acc');
  assert(acc1.budgetUsed.tokens > 0);

  const setLowBudget = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'day', tokens: 1000, stop: false })
  });
  assert.strictEqual(setLowBudget.status, 200);

  const usageFile = path.join(main.logsDir, 'usage.jsonl');
  const heavyEntry = {
    at: new Date().toISOString(),
    taskId: 'heavy_1',
    role: 'web-engineer',
    status: 'completed',
    model: 'default',
    account: 'budget-test-acc',
    provider: 'claude',
    usage: { total_tokens: 1500 }
  };
  fs.appendFileSync(usageFile, JSON.stringify(heavyEntry) + '\n');

  const dispatchAllowed = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Run with stop=false',
      workspace: main.workspace,
      account: 'budget-test-acc'
    })
  });
  assert.strictEqual(dispatchAllowed.status, 202);
  const { taskId: idAllowed } = await dispatchAllowed.json();
  await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${idAllowed}`, { headers: authed() });
    if (!res.ok) return null;
    const b = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(b.task?.status) ? b.task : null;
  });

  const setStop = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'day', tokens: 1000, stop: true })
  });
  assert.strictEqual(setStop.status, 200);

  const dispatchBlocked = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Run with stop=true',
      workspace: main.workspace,
      account: 'budget-test-acc'
    })
  });
  assert.strictEqual(dispatchBlocked.status, 400);
  const blockedBody = await dispatchBlocked.json();
  assert(blockedBody.error.includes('reached its day budget of 1000 tokens'));

  const teamPayload = {
    id: 'budget-team',
    name: 'Budget Team',
    leader: { account: 'claude', effort: 'medium' },
    members: [{ account: 'budget-test-acc', roles: ['web-engineer'] }],
    workspace: main.workspace
  };
  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify(teamPayload)
  });

  const teamRunRes = await fetch(`${main.base}/api/teams/budget-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ goal: 'Test team budget enforcement' })
  });
  assert.strictEqual(teamRunRes.status, 202);
  const { run } = await teamRunRes.json();

  const finishedRun = await waitFor(async () => {
    const res = await fetch(`${main.base}/api/team-runs/${run.id}`, { headers: authed() });
    if (!res.ok) return null;
    const b = await res.json();
    return ['completed', 'failed', 'cancelled'].includes(b.run?.status) ? b.run : null;
  }, 10000);
  assert.strictEqual(finishedRun.status, 'failed');

  const delRes = await fetch(`${main.base}/api/accounts/budget-test-acc/budget`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(delRes.status, 200);
  const delBody = await delRes.json();
  assert.strictEqual(delBody.account.budget, null);
  assert.strictEqual(delBody.account.budgetUsed, null);
});

test('Avatar PUT/GET/DELETE validation, magic bytes, nosniff, CSP, and removal on account delete', async () => {
  const addRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'avatar-test-acc', provider: 'agy', label: 'Avatar Test' })
  });
  assert.strictEqual(addRes.status, 201);

  const svgRes = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
  });
  assert.strictEqual(svgRes.status, 400);

  const fakePngRes = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: 'data:image/png;base64,aGVsbG8gd29ybGQ=' })
  });
  assert.strictEqual(fakePngRes.status, 400);

  const bigBuf = Buffer.alloc(513 * 1024, 0);
  bigBuf[0] = 0x89; bigBuf[1] = 0x50; bigBuf[2] = 0x4e; bigBuf[3] = 0x47;
  bigBuf[4] = 0x0d; bigBuf[5] = 0x0a; bigBuf[6] = 0x1a; bigBuf[7] = 0x0a;
  const bigRes = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: `data:image/png;base64,${bigBuf.toString('base64')}` })
  });
  assert.strictEqual(bigRes.status, 400);

  const pngPut = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: PNG_DATA_URL })
  });
  assert.strictEqual(pngPut.status, 200);
  const pngBody = await pngPut.json();
  assert(pngBody.account.avatarUrl);
  assert(pngBody.account.avatarUrl.startsWith('/api/accounts/avatar-test-acc/avatar?v='));

  const pngGet = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`);
  assert.strictEqual(pngGet.status, 200);
  assert.strictEqual(pngGet.headers.get('content-type'), 'image/png');
  assert.strictEqual(pngGet.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(pngGet.headers.get('content-security-policy'), "default-src 'none'");
  assert.strictEqual(pngGet.headers.get('cache-control'), 'no-cache');

  const jpegPut = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: JPEG_DATA_URL })
  });
  assert.strictEqual(jpegPut.status, 200);

  const jpegGet = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`);
  assert.strictEqual(jpegGet.status, 200);
  assert.strictEqual(jpegGet.headers.get('content-type'), 'image/jpeg');

  const webpPut = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: WEBP_DATA_URL })
  });
  assert.strictEqual(webpPut.status, 200);

  const webpGet = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`);
  assert.strictEqual(webpGet.status, 200);
  assert.strictEqual(webpGet.headers.get('content-type'), 'image/webp');

  const sysPut = await fetch(`${main.base}/api/accounts/agy/avatar`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ image: PNG_DATA_URL })
  });
  assert.strictEqual(sysPut.status, 200);
  const sysBody = await sysPut.json();
  assert(sysBody.account.avatarUrl.startsWith('/api/accounts/agy/avatar?v='));

  const sysGet = await fetch(`${main.base}/api/accounts/agy/avatar`);
  assert.strictEqual(sysGet.status, 200);
  assert.strictEqual(sysGet.headers.get('content-type'), 'image/png');

  const sysDel = await fetch(`${main.base}/api/accounts/agy/avatar`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(sysDel.status, 200);
  const sysDelBody = await sysDel.json();
  assert.strictEqual(sysDelBody.account.avatarUrl, null);
  const sysAfterDel = await fetch(`${main.base}/api/accounts/agy/avatar`);
  assert.strictEqual(sysAfterDel.status, 404);

  const deleteAccRes = await fetch(`${main.base}/api/accounts/avatar-test-acc`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(deleteAccRes.status, 200);

  const getDeletedAvatar = await fetch(`${main.base}/api/accounts/avatar-test-acc/avatar`);
  assert.strictEqual(getDeletedAvatar.status, 404);
});

test('MCP tools/list includes a2a_account_usage, dispatch stays first, output has quota line', () => {
  const mcpBin = path.join(ROOT, 'mcp-server.js');
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'a2a_account_usage', arguments: {} } })
  ].join('\n') + '\n';

  const output = execFileSync(process.execPath, [mcpBin], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, A2A_ACCOUNTS_DIR: main.accountsDir, A2A_LOGS_DIR: main.logsDir }
  });

  const lines = output.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const toolsMsg = lines.find((l) => l.id === 1);
  assert(toolsMsg);
  const tools = toolsMsg.result.tools;
  assert.strictEqual(tools[0].name, 'a2a_dispatch_to_antigravity');
  const usageTool = tools.find((t) => t.name === 'a2a_account_usage');
  assert(usageTool);

  const callMsg = lines.find((l) => l.id === 2);
  assert(callMsg);
  assert(callMsg.result && callMsg.result.content);
  const text = callMsg.result.content[0].text;
  assert(text.includes('claude-quota-acc'));
  assert(text.includes('5-hour 22%'));
  assert(text.includes('7-day 26%'));
});

test('CLI usage per account and accounts budget', () => {
  const cliBin = path.join(ROOT, 'cli.js');
  const env = { ...process.env, A2A_ACCOUNTS_DIR: main.accountsDir, A2A_LOGS_DIR: main.logsDir };

  const setOut = execFileSync(process.execPath, [cliBin, 'accounts', 'budget', 'claude-quota-acc', '--period', 'week', '--tokens', '50000', '--stop'], {
    encoding: 'utf-8',
    env
  });
  assert(setOut.includes('Set week budget of 50,000 tokens for account "claude-quota-acc" (stop: on)'));

  const usageOut = execFileSync(process.execPath, [cliBin, 'usage', '--days', '14'], {
    encoding: 'utf-8',
    env
  });
  assert(usageOut.includes('By account (14 days:'));
  assert(usageOut.includes('claude-quota-acc'));
  assert(usageOut.includes('quota:   5-hour: 22%'));
  assert(usageOut.includes('budget:'));

  const clearOut = execFileSync(process.execPath, [cliBin, 'accounts', 'budget', 'claude-quota-acc', '--clear'], {
    encoding: 'utf-8',
    env
  });
  assert(clearOut.includes('Cleared budget for account "claude-quota-acc"'));
});

test('usage records written before accounts existed count for the default Antigravity account', async () => {
  const instance = await startInstance();
  fs.mkdirSync(instance.logsDir, { recursive: true });
  fs.appendFileSync(path.join(instance.logsDir, 'usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), taskId: 'a2a_1_legacy', role: 'web-engineer', status: 'completed', model: null, usage: { total_tokens: 4321 } }) + '\n');
  const report = await (await fetch(`${instance.base}/api/usage/accounts?days=7`)).json();
  const agy = report.accounts.find((a) => a.id === 'agy');
  assert.strictEqual(agy.today.total_tokens, 4321);
  assert.strictEqual(agy.totals.tasks, 1);
  const budget = await fetch(`${instance.base}/api/accounts/agy/budget`, { method: 'PUT', headers: authed(), body: JSON.stringify({ period: 'day', tokens: 1000, stop: true }) });
  assert.strictEqual((await budget.json()).account.budgetUsed.tokens, 4321);
});

test('Codex quota is read from the account folder even when CODEX_HOME is set for the server', async () => {
  const instance = await startInstance({ CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-other-codex-home-')) });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'codex-home-acc', provider: 'codex' }) });
  const accDir = path.join(instance.accountsDir, 'codex-home-acc', 'codex');
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(accDir, '.codex-mode'), 'quota');
  const { taskId } = await (await fetch(`${instance.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'test-engineer', prompt: 'quota with CODEX_HOME set', workspace: instance.workspace, account: 'codex-home-acc' })
  })).json();
  await waitFor(async () => ['completed', 'failed', 'cancelled'].includes((await (await fetch(`${instance.base}/api/tasks/${taskId}`)).json()).task?.status));
  const acc = (await (await fetch(`${instance.base}/api/accounts`)).json()).accounts.find((a) => a.id === 'codex-home-acc');
  assert.ok(acc.limits && acc.limits.windows.length === 2, JSON.stringify(acc.limits));
});

test('an account added again under a used id starts with none of the old account usage or budget spend', async () => {
  const usageFile = path.join(main.logsDir, 'usage.jsonl');
  const record = (at, taskId, tokens) => JSON.stringify({ at, taskId, role: 'web-engineer', status: 'completed', account: 'claude-reused', provider: 'claude', usage: { total_tokens: tokens } }) + '\n';
  fs.appendFileSync(usageFile, record(new Date(Date.now() - 60000).toISOString(), 'a2a_1_previous_owner', 9000));
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'claude-reused', provider: 'claude' }) });
  await fetch(`${main.base}/api/accounts/claude-reused/budget`, { method: 'PUT', headers: authed(), body: JSON.stringify({ period: 'month', tokens: 10000, stop: false }) });

  const fresh = (await (await fetch(`${main.base}/api/accounts`)).json()).accounts.find((a) => a.id === 'claude-reused');
  assert.deepStrictEqual(fresh.usage, { tasks: 0, total_tokens: 0 });
  assert.strictEqual(fresh.budgetUsed.tokens, 0);
  const report = (await (await fetch(`${main.base}/api/usage/accounts?days=7`)).json()).accounts.find((a) => a.id === 'claude-reused');
  assert.strictEqual(report.totals.tasks, 0);

  fs.appendFileSync(usageFile, record(new Date(Date.now() + 1000).toISOString(), 'a2a_2_new_owner', 700));
  const used = (await (await fetch(`${main.base}/api/accounts`)).json()).accounts.find((a) => a.id === 'claude-reused');
  assert.deepStrictEqual(used.usage, { tasks: 1, total_tokens: 700 });
  assert.strictEqual(used.budgetUsed.tokens, 700);
});
