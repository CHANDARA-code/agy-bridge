const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'b'.repeat(64);
const FAKE_AGY = path.join(__dirname, 'fake-agy.sh');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.sh');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.sh');
const instances = [];
process.env.A2A_TEAMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-teams-'));

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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-acc-test-'));
  const logsDir = path.join(sandbox, 'logs');
  const tokenFile = path.join(sandbox, 'token');
  const workspace = path.join(sandbox, 'ws');
  const presetsDir = path.join(sandbox, 'presets');
  const accountsDir = path.join(sandbox, 'accounts');
  const realHome = path.join(sandbox, 'home');
  const argsFile = path.join(sandbox, 'fake_args.log');

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(presetsDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(realHome, { recursive: true });
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

  const instance = {
    port,
    base: `http://127.0.0.1:${port}`,
    sandbox,
    logsDir,
    workspace,
    presetsDir,
    accountsDir,
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

test('account CRUD, reserved ids, system accounts listed, system delete refused', async () => {
  const listRes = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  assert.strictEqual(listRes.status, 200);
  const listData = await listRes.json();
  assert.strictEqual(listData.accounts.length, 3);
  assert.deepStrictEqual(listData.accounts.map((a) => a.id), ['agy', 'claude', 'codex']);
  assert.ok(listData.accounts.every((a) => a.system === true));
  assert.strictEqual(listData.providers.length, 3);

  const resReserved = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'default', provider: 'claude' })
  });
  assert.strictEqual(resReserved.status, 400);

  const resInvalidId = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'INVALID_ID!', provider: 'claude' })
  });
  assert.strictEqual(resInvalidId.status, 400);

  const resBadProvider = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'test-acc', provider: 'unknown-p' })
  });
  assert.strictEqual(resBadProvider.status, 400);

  const resCreate = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'my-claude', provider: 'claude', label: 'My Claude Account' })
  });
  assert.strictEqual(resCreate.status, 201);
  const created = await resCreate.json();
  assert.strictEqual(created.account.id, 'my-claude');
  assert.strictEqual(created.account.provider, 'claude');
  assert.strictEqual(created.account.label, 'My Claude Account');

  const resDup = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'my-claude', provider: 'claude' })
  });
  assert.strictEqual(resDup.status, 409);

  const resUpdate = await fetch(`${main.base}/api/accounts/my-claude`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ label: 'Updated Label', model: 'claude-3-7-sonnet' })
  });
  assert.strictEqual(resUpdate.status, 200);
  const updated = await resUpdate.json();
  assert.strictEqual(updated.account.label, 'Updated Label');
  assert.strictEqual(updated.account.model, 'claude-3-7-sonnet');

  const resUpdateSys = await fetch(`${main.base}/api/accounts/claude`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ label: 'Hacked' })
  });
  assert.strictEqual(resUpdateSys.status, 400);

  const resDelSys = await fetch(`${main.base}/api/accounts/claude`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(resDelSys.status, 400);

  const resDel = await fetch(`${main.base}/api/accounts/my-claude`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(resDel.status, 200);
  assert.deepStrictEqual(await resDel.json(), { deleted: 'my-claude' });
});

test('agy account home layout (symlinks, Library without Keychains, .gemini/config link) and HOME passed to agy', async () => {
  const realHome = main.realHome;
  fs.writeFileSync(path.join(realHome, '.gitconfig'), '[user]\nname = Test\n');
  fs.mkdirSync(path.join(realHome, 'Library', 'Keychains'), { recursive: true });
  fs.writeFileSync(path.join(realHome, 'Library', 'Keychains', 'login.keychain'), 'secret');
  fs.mkdirSync(path.join(realHome, 'Library', 'Preferences'), { recursive: true });
  fs.writeFileSync(path.join(realHome, 'Library', 'Preferences', 'test.plist'), 'pref');
  fs.mkdirSync(path.join(realHome, '.gemini', 'config'), { recursive: true });
  fs.writeFileSync(path.join(realHome, '.gemini', 'config', 'settings.json'), '{}');

  const resCreate = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'work-agy', provider: 'agy', label: 'Work Antigravity' })
  });
  assert.strictEqual(resCreate.status, 201);

  const accountsModule = require('../src/accounts');
  const account = accountsModule.getAccount('work-agy');
  const targetHome = accountsModule.ensureAgyHome(account);

  assert.ok(fs.existsSync(path.join(targetHome, '.gitconfig')));
  assert.strictEqual(fs.lstatSync(path.join(targetHome, '.gitconfig')).isSymbolicLink(), true);

  assert.strictEqual(fs.lstatSync(path.join(targetHome, 'Library')).isDirectory(), true);
  assert.strictEqual(fs.lstatSync(path.join(targetHome, 'Library')).isSymbolicLink(), false);
  assert.strictEqual(fs.existsSync(path.join(targetHome, 'Library', 'Keychains', 'login.keychain')), false);
  if (fs.existsSync(path.join(targetHome, 'Library', 'Keychains'))) {
    assert.strictEqual(fs.lstatSync(path.join(targetHome, 'Library', 'Keychains')).isSymbolicLink(), false);
  }
  assert.strictEqual(fs.lstatSync(path.join(targetHome, 'Library', 'Preferences')).isSymbolicLink(), false);
  assert.strictEqual(fs.lstatSync(path.join(targetHome, 'Library', 'Preferences', 'test.plist')).isSymbolicLink(), true);

  assert.strictEqual(fs.lstatSync(path.join(targetHome, '.gemini')).isDirectory(), true);
  assert.strictEqual(fs.lstatSync(path.join(targetHome, '.gemini')).isSymbolicLink(), false);
  assert.strictEqual(fs.lstatSync(path.join(targetHome, '.gemini', 'config')).isSymbolicLink(), true);

  fs.writeFileSync(main.argsFile, '');
  const resDispatch = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Check home layout',
      workspace: main.workspace,
      account: 'work-agy'
    })
  });
  assert.strictEqual(resDispatch.status, 202);
  const { taskId } = await resDispatch.json();

  await waitFor(async () => {
    const resTask = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    const data = await resTask.json();
    return data.task.status === 'completed';
  });

  const argsLogged = fs.readFileSync(main.argsFile, 'utf-8');
  assert.match(argsLogged, new RegExp(`HOME: ${targetHome}`));
});

test('deleting an agy account leaves the fake real home intact', async () => {
  const realHome = main.realHome;
  const resDel = await fetch(`${main.base}/api/accounts/work-agy`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(resDel.status, 200);

  assert.strictEqual(fs.existsSync(path.join(realHome, '.gitconfig')), true);
  assert.strictEqual(fs.readFileSync(path.join(realHome, '.gitconfig'), 'utf-8'), '[user]\nname = Test\n');
  assert.strictEqual(fs.existsSync(path.join(realHome, 'Library', 'Keychains', 'login.keychain')), true);
  assert.strictEqual(fs.existsSync(path.join(realHome, 'Library', 'Preferences', 'test.plist')), true);
  assert.strictEqual(fs.existsSync(path.join(realHome, '.gemini', 'config', 'settings.json')), true);

  const accountDir = path.join(main.accountsDir, 'work-agy');
  assert.strictEqual(fs.existsSync(accountDir), false);
});

test('claude task: text output, [tool] Bash: ... log line, normalised usage, conversationId from session_id, CLAUDE_CONFIG_DIR set, ANTHROPIC_API_KEY removed, prompt delivered on stdin, plan vs edit permission args', async () => {
  const resCreate = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'c1', provider: 'claude', label: 'Claude Test' })
  });
  assert.strictEqual(resCreate.status, 201);

  fs.writeFileSync(main.argsFile, '');
  const resDispatch = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Build new feature',
      workspace: main.workspace,
      mode: 'accept-edits',
      effort: 'medium',
      account: 'c1'
    })
  });
  assert.strictEqual(resDispatch.status, 202);
  const { taskId } = await resDispatch.json();

  let taskData;
  await waitFor(async () => {
    const resTask = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    taskData = (await resTask.json()).task;
    return taskData.status === 'completed';
  });

  assert.strictEqual(taskData.account, 'c1');
  assert.strictEqual(taskData.provider, 'claude');

  const resLog = await fetch(`${main.base}/api/tasks/${taskId}/log`, { headers: authed() });
  const logContent = await resLog.text();
  assert.match(logContent, /Account: c1/);
  assert.match(logContent, /Provider: claude/);
  assert.match(logContent, /\[tool\] Bash: npm test/);

  const loggedArgs = fs.readFileSync(main.argsFile, 'utf-8');
  assert.match(loggedArgs, /CLAUDE_CONFIG_DIR: .*\/c1\/claude/);
  assert.match(loggedArgs, /ANTHROPIC_API_KEY_SET: no/);
  assert.match(loggedArgs, /STDIN: [\s\S]*Build new feature/);
  assert.match(loggedArgs, /--dangerously-skip-permissions/);

  const resTaskDetail = await fetch(`${main.base}/tasks/${taskId}`, { headers: authed() });
  const taskRecord = await resTaskDetail.json();
  assert.strictEqual(taskRecord.conversationId, 'claude-session-987');
  assert.strictEqual(taskRecord.usage.input_tokens, 15, 'new input is uncached input plus cache writes');
  assert.strictEqual(taskRecord.usage.cache_read_tokens, 20);
  assert.strictEqual(taskRecord.usage.output_tokens, 15);
  assert.strictEqual(taskRecord.usage.thinking_tokens, 5);
  assert.strictEqual(taskRecord.usage.total_tokens, 30, 'cache reads are not counted in the total, as for Antigravity');
  assert.strictEqual(taskRecord.usage.cost_usd, 0.01);

  fs.writeFileSync(main.argsFile, '');
  const resPlan = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Plan feature only',
      workspace: main.workspace,
      mode: 'plan',
      account: 'c1'
    })
  });
  assert.strictEqual(resPlan.status, 202);
  const planTaskId = (await resPlan.json()).taskId;
  await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${planTaskId}`, { headers: authed() });
    return (await res.json()).task.status === 'completed';
  });

  const planArgs = fs.readFileSync(main.argsFile, 'utf-8');
  assert.match(planArgs, /--permission-mode dontAsk/);
  assert.match(planArgs, /--allowedTools Read Glob Grep/);
});

test('codex task: success parsing, and an auth-expired run marks the task failed with the codex message and flips the account to signed-out', async () => {
  const resCreate = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'cx1', provider: 'codex', label: 'Codex 1' })
  });
  assert.strictEqual(resCreate.status, 201);

  const markerPath = path.join(main.accountsDir, 'cx1', 'codex', '.signed-in');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, 'ok\n');

  fs.writeFileSync(main.argsFile, '');
  const resDispatch = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Execute codex task',
      workspace: main.workspace,
      mode: 'accept-edits',
      effort: 'max',
      account: 'cx1'
    })
  });
  assert.strictEqual(resDispatch.status, 202);
  const { taskId } = await resDispatch.json();

  let taskData;
  await waitFor(async () => {
    const resTask = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    taskData = (await resTask.json()).task;
    return taskData.status === 'completed';
  });

  const resLog = await fetch(`${main.base}/api/tasks/${taskId}/log`, { headers: authed() });
  const logContent = await resLog.text();
  assert.match(logContent, /Account: cx1/);
  assert.match(logContent, /Provider: codex/);
  assert.match(logContent, /\[tool\] shell: npm test/);

  const loggedArgs = fs.readFileSync(main.argsFile, 'utf-8');
  assert.match(loggedArgs, /CODEX_HOME: .*\/cx1\/codex/);
  assert.match(loggedArgs, /OPENAI_API_KEY_SET: no/);
  assert.match(loggedArgs, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(loggedArgs, /model_reasoning_effort="xhigh"/);

  const resTaskDetail = await fetch(`${main.base}/tasks/${taskId}`, { headers: authed() });
  const taskRecord = await resTaskDetail.json();
  assert.strictEqual(taskRecord.conversationId, 'codex-thread-111');
  assert.strictEqual(taskRecord.output.trim(), 'Codex finished all tasks.');
  assert.strictEqual(taskRecord.usage.input_tokens, 40, 'Codex input minus its cached input');
  assert.strictEqual(taskRecord.usage.cache_read_tokens, 10);
  assert.strictEqual(taskRecord.usage.output_tokens, 25);
  assert.strictEqual(taskRecord.usage.thinking_tokens, 5);
  assert.strictEqual(taskRecord.usage.total_tokens, 65, 'cache reads are not counted in the total, as for Antigravity');

  fs.writeFileSync(path.join(main.accountsDir, 'cx1', 'codex', '.codex-mode'), 'auth-expired\n');
  const resAuthFail = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Execute expiring codex task',
      workspace: main.workspace,
      account: 'cx1'
    })
  });
  const authTaskId = (await resAuthFail.json()).taskId;

  let failedTask;
  await waitFor(async () => {
    const resTask = await fetch(`${main.base}/api/tasks/${authTaskId}`, { headers: authed() });
    failedTask = (await resTask.json()).task;
    return failedTask.status === 'failed';
  });

  fs.unlinkSync(path.join(main.accountsDir, 'cx1', 'codex', '.codex-mode'));

  const resList = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  const checkAccount = (await resList.json()).accounts.find((a) => a.id === 'cx1');
  assert.strictEqual(checkAccount.status.state, 'signed-out');
  assert.match(failedTask.error, /Account cx1 is not signed in/);
  assert.match(failedTask.error, /Sign in again from the panel \(Accounts\) or with "a2a-panel accounts login cx1"/);
});

test('conversation_id -> claude --resume / codex resume', async () => {
  fs.writeFileSync(main.argsFile, '');
  const resClaude = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Resume conversation',
      workspace: main.workspace,
      conversation_id: 'session-resume-1234',
      account: 'c1'
    })
  });
  const claudeId = (await resClaude.json()).taskId;
  await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${claudeId}`, { headers: authed() });
    return (await res.json()).task.status === 'completed';
  });
  const claudeArgs = fs.readFileSync(main.argsFile, 'utf-8');
  assert.match(claudeArgs, /--resume session-resume-1234/);

  fs.writeFileSync(main.argsFile, '');
  const resCodex = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Resume codex conversation',
      workspace: main.workspace,
      conversation_id: 'thread-resume-5678',
      account: 'cx1'
    })
  });
  const codexId = (await resCodex.json()).taskId;
  await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${codexId}`, { headers: authed() });
    return (await res.json()).task.status === 'completed';
  });
  const codexArgs = fs.readFileSync(main.argsFile, 'utf-8');
  assert.match(codexArgs, /resume thread-resume-5678/);
});

test('usage.jsonl and /api/usage byAccount', async () => {
  const resUsage = await fetch(`${main.base}/api/usage`, { headers: authed() });
  assert.strictEqual(resUsage.status, 200);
  const usage = await resUsage.json();
  assert.ok(usage.byAccount);
  assert.ok(usage.byAccount.c1);
  assert.strictEqual(usage.byAccount.c1.provider, 'claude');
  assert.ok(usage.byAccount.c1.total_tokens > 0);
  assert.ok(usage.byAccount.cx1);
  assert.strictEqual(usage.byAccount.cx1.provider, 'codex');
  assert.ok(usage.byAccount.cx1.total_tokens > 0);
});

test('claude login session with needsCode -> POST code -> succeeded and signed-in', async () => {
  const resCreate = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'c-login', provider: 'claude', label: 'Login Test' })
  });
  assert.strictEqual(resCreate.status, 201);

  const resLogin = await fetch(`${main.base}/api/accounts/c-login/login`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ method: 'browser' })
  });
  assert.strictEqual(resLogin.status, 202);
  const { login } = await resLogin.json();
  const loginId = login.id;

  let sessionState;
  await waitFor(async () => {
    const resPoll = await fetch(`${main.base}/api/accounts/logins/${loginId}`, { headers: authed() });
    sessionState = (await resPoll.json()).login;
    return sessionState.state === 'waiting' && sessionState.needsCode === true;
  });

  assert.strictEqual(sessionState.url, 'https://claude.ai/login/oauth/12345');
  assert.strictEqual(sessionState.needsCode, true);

  const resCode = await fetch(`${main.base}/api/accounts/logins/${loginId}/code`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ code: 'good-code' })
  });
  assert.strictEqual(resCode.status, 200);

  await waitFor(async () => {
    const resPoll = await fetch(`${main.base}/api/accounts/logins/${loginId}`, { headers: authed() });
    sessionState = (await resPoll.json()).login;
    return sessionState.state === 'succeeded';
  });

  const resList = await fetch(`${main.base}/api/accounts`, { headers: authed() });
  const acc = (await resList.json()).accounts.find((a) => a.id === 'c-login');
  assert.strictEqual(acc.status.state, 'signed-in');
  assert.strictEqual(acc.signedInHere, true);
});

test('codex device session exposes url and code', async () => {
  const resCreate = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'cx-device', provider: 'codex', label: 'Device Test' })
  });
  assert.strictEqual(resCreate.status, 201);

  const resLogin = await fetch(`${main.base}/api/accounts/cx-device/login`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ method: 'device' })
  });
  assert.strictEqual(resLogin.status, 202);
  const { login } = await resLogin.json();

  let sessionState;
  await waitFor(async () => {
    const resPoll = await fetch(`${main.base}/api/accounts/logins/${login.id}`, { headers: authed() });
    sessionState = (await resPoll.json()).login;
    return sessionState.url && sessionState.code;
  });

  assert.strictEqual(sessionState.url, 'https://auth.openai.com/codex/device');
  assert.strictEqual(sessionState.code, 'ABCD-EFGH2');

  const resCancel = await fetch(`${main.base}/api/accounts/logins/${login.id}/cancel`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(resCancel.status, 200);
});

test('a second codex browser login is refused with 409', async () => {
  await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'cx-b1', provider: 'codex' })
  });
  await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'cx-b2', provider: 'codex' })
  });

  const res1 = await fetch(`${main.base}/api/accounts/cx-b1/login`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ method: 'browser' })
  });
  assert.strictEqual(res1.status, 202);
  const { login: l1 } = await res1.json();

  const res2 = await fetch(`${main.base}/api/accounts/cx-b2/login`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ method: 'browser' })
  });
  assert.strictEqual(res2.status, 409);
  const err = await res2.json();
  assert.match(err.error, /1455/);

  await fetch(`${main.base}/api/accounts/logins/${l1.id}/cancel`, {
    method: 'POST',
    headers: authed()
  });
});

test('cancel kills the login process', async () => {
  await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'cx-kill', provider: 'codex' })
  });

  const resLogin = await fetch(`${main.base}/api/accounts/cx-kill/login`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ method: 'browser' })
  });
  assert.strictEqual(resLogin.status, 202);
  const { login } = await resLogin.json();

  const resCancel = await fetch(`${main.base}/api/accounts/logins/${login.id}/cancel`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(resCancel.status, 200);
  const data = await resCancel.json();
  assert.strictEqual(data.login.state, 'cancelled');
});

test('/check flips status from the marker', async () => {
  await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'c-check', provider: 'claude' })
  });

  const resInitial = await fetch(`${main.base}/api/accounts/c-check/check`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(resInitial.status, 200);
  const initial = await resInitial.json();
  assert.strictEqual(initial.account.status.state, 'signed-out');

  const markerPath = path.join(main.accountsDir, 'c-check', 'claude', '.signed-in');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, 'ok\n');

  const resChecked = await fetch(`${main.base}/api/accounts/c-check/check`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(resChecked.status, 200);
  const checked = await resChecked.json();
  assert.strictEqual(checked.account.status.state, 'signed-in');
  assert.match(checked.account.status.warning, /never signed in from a2a-panel/);
});

test('cancelling a running claude task works and the concurrency limit counts it', async () => {
  const custom = await startInstance({ A2A_MAX_CONCURRENT: '1', FAKE_CLAUDE_MODE: 'stubborn' });
  await fetch(`${custom.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ id: 'c-busy', provider: 'claude' })
  });

  const res1 = await fetch(`${custom.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Task 1 running',
      workspace: custom.workspace,
      account: 'c-busy'
    })
  });
  assert.strictEqual(res1.status, 202);
  const { taskId: id1 } = await res1.json();

  await waitFor(async () => {
    const res = await fetch(`${custom.base}/api/tasks/${id1}`, { headers: authed() });
    return (await res.json()).task.status === 'running';
  });

  const res2 = await fetch(`${custom.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Task 2 running',
      workspace: custom.workspace,
      account: 'c-busy'
    })
  });
  assert.strictEqual(res2.status, 400);
  const err = await res2.json();
  assert.match(err.error, /Concurrency limit reached/);

  const resCancel = await fetch(`${custom.base}/api/tasks/${id1}/cancel`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(resCancel.status, 200);

  await waitFor(async () => {
    const res = await fetch(`${custom.base}/api/tasks/${id1}`, { headers: authed() });
    return (await res.json()).task.status === 'cancelled';
  });
});

test('a task without account behaves exactly as before', async () => {
  const resDispatch = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      role: 'web-engineer',
      prompt: 'Legacy dispatch without account',
      workspace: main.workspace
    })
  });
  assert.strictEqual(resDispatch.status, 202);
  const { taskId } = await resDispatch.json();

  let task;
  await waitFor(async () => {
    const res = await fetch(`${main.base}/api/tasks/${taskId}`, { headers: authed() });
    task = (await res.json()).task;
    return task.status === 'completed';
  });

  assert.strictEqual(task.account, 'agy');
  assert.strictEqual(task.provider, 'agy');
});

function runAccountsScript(accountsDir, script) {
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf-8',
    cwd: ROOT,
    env: { ...process.env, A2A_ACCOUNTS_DIR: accountsDir, A2A_REAL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-home-')) }
  }).trim();
}

async function loginOf(instance, loginId) {
  return (await (await fetch(`${instance.base}/api/accounts/logins/${loginId}`)).json()).login;
}

async function accountOf(instance, id) {
  const { accounts } = await (await fetch(`${instance.base}/api/accounts`)).json();
  return accounts.find((account) => account.id === id);
}

async function finishedTask(instance, taskId) {
  let task;
  await waitFor(async () => {
    task = (await (await fetch(`${instance.base}/api/tasks/${taskId}`)).json()).task;
    return ['completed', 'failed', 'cancelled'].includes(task.status);
  });
  return task;
}

let signinInstance;
const signinServer = () => (signinInstance = signinInstance || startInstance({ FAKE_AGY_MODE: 'signin' }));

test('a built-in account keeps every status update, not only the first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-acc-sys-'));
  const out = runAccountsScript(dir, `
    const a = require('./src/accounts');
    const s = (state) => ({ state, detail: state, email: null, plan: null, checkedAt: null, warning: null });
    const account = a.getAccount('codex');
    account.status = s('signed-in'); a.saveAccount(account);
    account.status = s('signed-out'); a.saveAccount(account);
    a.markSignedOut('agy', 'expired');
    console.log(a.getAccount('codex').status.state + ' ' + a.getAccount('agy').status.state);
  `);
  assert.strictEqual(out, 'signed-out signed-out');
});

test('an unreadable accounts file is reported and never replaced by an empty list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-acc-bad-'));
  const file = path.join(dir, 'accounts.json');
  const broken = '{"accounts": [{"id": "keep-me"';
  fs.writeFileSync(file, broken);
  const out = runAccountsScript(dir, `
    const a = require('./src/accounts');
    const results = [];
    for (const step of [() => a.listAccounts(), () => a.createAccount({ id: 'new-one', provider: 'claude' })]) {
      try { step(); results.push('ok'); } catch (e) { results.push(e.code); }
    }
    results.push(a.resolveAccount().id);
    console.log(results.join(' '));
  `);
  assert.strictEqual(out, '500 500 agy');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), broken);
});

test('signing in a built-in account uses the default sign-in, with no folder overrides', async () => {
  const res = await fetch(`${main.base}/api/accounts/codex/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'device' }) });
  assert.strictEqual(res.status, 202);
  const { login } = await res.json();
  try {
    assert.strictEqual(login.command, `'${FAKE_CODEX}' 'login' '--device-auth'`);
  } finally {
    await fetch(`${main.base}/api/accounts/logins/${login.id}/cancel`, { method: 'POST', headers: authed() });
  }
});

test('a sign-in whose CLI is missing fails the session without stopping the server', async () => {
  const broken = await startInstance({ CODEX_BIN: path.join(os.tmpdir(), 'no-such-codex-binary') });
  await fetch(`${broken.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'cx-missing', provider: 'codex' }) });
  const res = await fetch(`${broken.base}/api/accounts/cx-missing/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'device' }) });
  assert.strictEqual(res.status, 202);
  const { login } = await res.json();
  const failed = await waitFor(async () => {
    const current = await loginOf(broken, login.id);
    return current.state === 'failed' ? current : null;
  });
  assert.match(failed.error, /Could not start/);
  assert.ok((await fetch(`${broken.base}/health`)).ok);
});

test('an Antigravity task on a signed-out account stops at the sign-in prompt instead of hanging', async () => {
  const signin = await signinServer();
  await fetch(`${signin.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-out', provider: 'agy' }) });
  const res = await fetch(`${signin.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'web-engineer', prompt: 'do the work', workspace: signin.workspace, mode: 'plan', account: 'agy-out' })
  });
  assert.strictEqual(res.status, 202);
  const task = await finishedTask(signin, (await res.json()).taskId);
  assert.strictEqual(task.status, 'failed');
  assert.match(task.error, /agy-out/);
  assert.strictEqual((await accountOf(signin, 'agy-out')).status.state, 'signed-out');
});

test('an Antigravity account signs in from the panel with a pasted code, without a model prompt', async () => {
  const signin = await signinServer();
  await fetch(`${signin.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-in', provider: 'agy' }) });
  const res = await fetch(`${signin.base}/api/accounts/agy-in/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'browser' }) });
  assert.strictEqual(res.status, 202);
  const { login } = await res.json();
  const waiting = await waitFor(async () => {
    const current = await loginOf(signin, login.id);
    return current.needsCode && current.url ? current : null;
  });
  assert.match(waiting.url, /^https:\/\/accounts\.google\.com\//);
  const submitted = await fetch(`${signin.base}/api/accounts/logins/${login.id}/code`, { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'good-code' }) });
  assert.strictEqual(submitted.status, 200);
  const done = await waitFor(async () => {
    const current = await loginOf(signin, login.id);
    return ['succeeded', 'failed'].includes(current.state) ? current : null;
  });
  assert.strictEqual(done.state, 'succeeded', done.error);
  const account = await accountOf(signin, 'agy-in');
  assert.strictEqual(account.status.state, 'signed-in');
  assert.strictEqual(account.status.warning, null);
  const signInRuns = fs.readFileSync(signin.argsFile, 'utf-8').split('ARGV: ').slice(1)
    .filter((record) => record.includes(`${path.join('agy-in', 'home')}\n`))
    .map((record) => record.split('\n')[0])
    .filter((argv) => argv !== 'models');
  assert.deepStrictEqual(signInRuns, ['-p /help --output-format stream-json']);
});

test('auth words in the agent text do not sign the account out', async () => {
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'c-prose', provider: 'claude' }) });
  const configDir = path.join(main.accountsDir, 'c-prose', 'claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude-mode'), 'prose-fail');
  const res = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'test-engineer', prompt: 'fix the login page', workspace: main.workspace, mode: 'plan', account: 'c-prose' })
  });
  assert.strictEqual(res.status, 202);
  const task = await finishedTask(main, (await res.json()).taskId);
  assert.strictEqual(task.status, 'failed');
  assert.doesNotMatch(task.error || '', /not signed in/);
  assert.notStrictEqual((await accountOf(main, 'c-prose')).status.state, 'signed-out');
});

function runningCommands() {
  return execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf-8' }).split('\n').map((line) => line.trim());
}

test('a task can be cancelled while the bridge runs its verification command', async () => {
  const res = await fetch(`${main.base}/tasks/send`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ prompt: 'quick task', workspace: main.workspace, mode: 'plan', verification_command: 'sleep 31', async: true })
  });
  assert.strictEqual(res.status, 202);
  const { taskId } = await res.json();
  await waitFor(async () => (await (await fetch(`${main.base}/api/tasks/${taskId}/log`)).text()).includes('=== VERIFICATION (run'));
  const cancel = await fetch(`${main.base}/api/tasks/${taskId}/cancel`, { method: 'POST', headers: authed() });
  assert.strictEqual(cancel.status, 200);
  const task = await finishedTask(main, taskId);
  assert.strictEqual(task.status, 'cancelled');
  await waitFor(() => !runningCommands().includes('sleep 31'));
});

test('an Antigravity sign-in prompt on stdout also stops the task and signs the account out', async () => {
  const instance = await startInstance({ FAKE_AGY_MODE: 'signin-stdout' });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-stdout', provider: 'agy' }) });
  const res = await fetch(`${instance.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'web-engineer', prompt: 'do the work', workspace: instance.workspace, mode: 'plan', account: 'agy-stdout' })
  });
  const task = await finishedTask(instance, (await res.json()).taskId);
  assert.strictEqual(task.status, 'failed');
  assert.strictEqual((await accountOf(instance, 'agy-stdout')).status.state, 'signed-out');
});

test('an Antigravity sign-in that exits without a final event still finishes', async () => {
  const instance = await startInstance({ FAKE_AGY_MODE: 'signin-crash' });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-crash', provider: 'agy' }) });
  const { login } = await (await fetch(`${instance.base}/api/accounts/agy-crash/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'browser' }) })).json();
  await waitFor(async () => (await loginOf(instance, login.id)).needsCode);
  await fetch(`${instance.base}/api/accounts/logins/${login.id}/code`, { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'bad-code' }) });
  const done = await waitFor(async () => {
    const current = await loginOf(instance, login.id);
    return ['failed', 'succeeded'].includes(current.state) ? current : null;
  });
  assert.strictEqual(done.state, 'failed');
});

test('pasted codes and Google-style auth codes are hidden from every sign-in output', async () => {
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'c-redact', provider: 'claude' }) });
  const { login } = await (await fetch(`${main.base}/api/accounts/c-redact/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'browser' }) })).json();
  await waitFor(async () => (await loginOf(main, login.id)).needsCode);
  await fetch(`${main.base}/api/accounts/logins/${login.id}/code`, { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'good-code' }) });
  const done = await waitFor(async () => {
    const current = await loginOf(main, login.id);
    return ['failed', 'succeeded'].includes(current.state) ? current : null;
  });
  assert.strictEqual(done.state, 'succeeded', done.error);
  assert.ok(!done.output.includes('good-code'), done.output);
  assert.ok(!done.output.includes('4/0AbCdEfGhIjKl'), done.output);
  assert.match(done.output, /Received code ••••/);
});

test('added Antigravity accounts do not inherit application-default Google credentials', async () => {
  const instance = await startInstance({ AGY_ADC_AUTH: '1' });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-adc', provider: 'agy' }) });
  for (const account of ['agy-adc', undefined]) {
    fs.writeFileSync(instance.argsFile, '');
    const res = await fetch(`${instance.base}/api/tasks`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ role: 'web-engineer', prompt: 'env check', workspace: instance.workspace, mode: 'plan', ...(account ? { account } : {}) })
    });
    await finishedTask(instance, (await res.json()).taskId);
    assert.match(fs.readFileSync(instance.argsFile, 'utf-8'), account ? /AGY_ADC_AUTH_SET: no/ : /AGY_ADC_AUTH_SET: yes/);
  }
});

test('cancelling a sign-in also kills a process that ignores SIGTERM', async () => {
  const seconds = String(400 + Math.floor(Math.random() * 500));
  const instance = await startInstance({ FAKE_CODEX_LOGIN_STUBBORN: seconds });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'cx-stub', provider: 'codex' }) });
  const { login } = await (await fetch(`${instance.base}/api/accounts/cx-stub/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'device' }) })).json();
  await waitFor(async () => runningCommands().includes(`sleep ${seconds}`));
  await fetch(`${instance.base}/api/accounts/logins/${login.id}/cancel`, { method: 'POST', headers: authed() });
  await waitFor(() => !runningCommands().includes(`sleep ${seconds}`));
});

test('a Codex sign-in rejected by a task stays signed out until the stored credentials change', async () => {
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'cx-rejected', provider: 'codex' }) });
  const home = path.join(main.accountsDir, 'cx-rejected', 'codex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.signed-in'), 'ok\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  fs.writeFileSync(path.join(home, '.codex-mode'), 'auth-expired');
  const res = await fetch(`${main.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'web-engineer', prompt: 'expired run', workspace: main.workspace, mode: 'plan', account: 'cx-rejected' })
  });
  const task = await finishedTask(main, (await res.json()).taskId);
  assert.strictEqual(task.status, 'failed');
  const check = async () => (await (await fetch(`${main.base}/api/accounts/cx-rejected/check`, { method: 'POST', headers: authed() })).json()).account.status;
  const stale = await check();
  assert.strictEqual(stale.state, 'signed-out');
  assert.match(stale.detail, /Sign in again/);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(home, 'auth.json'), later, later);
  assert.strictEqual((await check()).state, 'signed-in');
});

test('each added Antigravity account gets its own keychain and keychain settings, never yours', { skip: process.platform !== 'darwin' }, async () => {
  const instance = await startInstance();
  const realLibrary = path.join(instance.realHome, 'Library');
  fs.mkdirSync(path.join(realLibrary, 'Preferences'), { recursive: true });
  fs.mkdirSync(path.join(realLibrary, 'Keychains'), { recursive: true });
  fs.writeFileSync(path.join(realLibrary, 'Preferences', 'com.apple.security.plist'), 'real security settings');
  fs.writeFileSync(path.join(realLibrary, 'Preferences', 'com.example.editor.plist'), 'editor settings');
  fs.writeFileSync(path.join(realLibrary, 'Keychains', 'login.keychain-db'), 'real keychain');
  const realListBefore = execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf-8' });

  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-kc', provider: 'agy' }) });
  await fetch(`${instance.base}/api/accounts/agy-kc/check`, { method: 'POST', headers: authed() });

  const home = path.join(instance.accountsDir, 'agy-kc', 'home');
  const prefs = path.join(home, 'Library', 'Preferences');
  const keychain = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
  assert.strictEqual(fs.lstatSync(prefs).isSymbolicLink(), false);
  assert.strictEqual(fs.lstatSync(path.join(prefs, 'com.example.editor.plist')).isSymbolicLink(), true);
  assert.strictEqual(fs.existsSync(path.join(prefs, 'com.apple.security.plist')), false);
  assert.strictEqual(fs.lstatSync(keychain).isSymbolicLink(), false);
  assert.notStrictEqual(fs.readFileSync(keychain, 'utf-8'), 'real keychain');
  const profileDefault = execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf-8', env: { ...process.env, HOME: home } });
  assert.match(profileDefault, /agy-kc\/home\/Library\/Keychains\/login\.keychain-db/);
  assert.strictEqual(execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf-8' }), realListBefore);
  assert.strictEqual(fs.readFileSync(path.join(realLibrary, 'Preferences', 'com.apple.security.plist'), 'utf-8'), 'real security settings');

  await fetch(`${instance.base}/api/accounts/agy-kc`, { method: 'DELETE', headers: authed() });
  assert.strictEqual(fs.existsSync(path.join(instance.accountsDir, 'agy-kc')), false);
  assert.strictEqual(fs.readFileSync(path.join(realLibrary, 'Keychains', 'login.keychain-db'), 'utf-8'), 'real keychain');
  assert.strictEqual(execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf-8' }), realListBefore);
});

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function fakeJwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

test('a Claude account shows its Claude display name from its own folder, not from another account', async () => {
  const dir = await signedInClaude(main, 'c-name');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Ada', fullName: 'Ada Lovelace', emailAddress: 'user@example.com' } }));
  const named = (await (await fetch(`${main.base}/api/accounts/c-name/check`, { method: 'POST', headers: authed() })).json()).account;
  assert.strictEqual(named.identity.name, 'Ada');
  assert.strictEqual(named.identity.email, 'user@example.com');

  const other = await signedInClaude(main, 'c-other');
  fs.writeFileSync(path.join(other, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Somebody Else', emailAddress: 'else@example.com' } }));
  const mismatch = (await (await fetch(`${main.base}/api/accounts/c-other/check`, { method: 'POST', headers: authed() })).json()).account;
  assert.strictEqual(mismatch.identity.name, null);
});

test('a Codex account shows the real name, email and plan from its own sign-in, without exposing tokens', async () => {
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'cx-identity', provider: 'codex' }) });
  const home = path.join(main.accountsDir, 'cx-identity', 'codex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.signed-in'), 'ok\n');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
    tokens: {
      id_token: fakeJwt({ name: 'Ada Lovelace', email: 'ada@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
      access_token: 'SECRET-ACCESS-CODEX',
      refresh_token: 'SECRET-REFRESH-CODEX'
    }
  }));
  const res = await fetch(`${main.base}/api/accounts/cx-identity/check`, { method: 'POST', headers: authed() });
  const text = await res.text();
  const identity = JSON.parse(text).account.identity;
  assert.deepStrictEqual({ name: identity.name, email: identity.email, plan: identity.plan, source: identity.source }, { name: 'Ada Lovelace', email: 'ada@example.com', plan: 'plus', source: 'codex-token' });
  const listing = await (await fetch(`${main.base}/api/accounts`)).text();
  for (const body of [text, listing]) assert.ok(!/SECRET-|id_token/.test(body), 'a token leaked into an API response');
});

test('an Antigravity account shows the real Google name and photo, and an uploaded picture wins', async () => {
  const seen = [];
  const google = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url === '/userinfo' && req.headers.authorization === 'Bearer SECRET-ACCESS-AGY') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: 'Grace Hopper', email: 'grace@example.com', picture: `http://127.0.0.1:${google.address().port}/photo.png` }));
    }
    if (req.url === '/photo.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(TINY_PNG);
    }
    res.writeHead(401);
    res.end();
  });
  await new Promise((resolve) => google.listen(0, '127.0.0.1', resolve));
  try {
    const port = google.address().port;
    const instance = await startInstance({ A2A_GOOGLE_USERINFO_URL: `http://127.0.0.1:${port}/userinfo`, A2A_PICTURE_HOSTS: '127.0.0.1' });
    await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-identity', provider: 'agy' }) });
    const cli = path.join(instance.accountsDir, 'agy-identity', 'home', '.gemini', 'antigravity-cli');
    fs.mkdirSync(cli, { recursive: true });
    fs.writeFileSync(path.join(cli, '.signed-in'), 'ok\n');
    fs.writeFileSync(path.join(cli, 'antigravity-oauth-token'), JSON.stringify({
      token: { access_token: 'SECRET-ACCESS-AGY', token_type: 'Bearer', refresh_token: 'SECRET-REFRESH-AGY', expiry: new Date(Date.now() + 3600000).toISOString() },
      auth_method: 'oauth',
      id_token_email: 'grace@example.com'
    }));

    const text = await (await fetch(`${instance.base}/api/accounts/agy-identity/check`, { method: 'POST', headers: authed() })).text();
    const account = JSON.parse(text).account;
    assert.strictEqual(account.identity.name, 'Grace Hopper');
    assert.strictEqual(account.identity.email, 'grace@example.com');
    assert.ok(account.avatarUrl);
    assert.ok(Buffer.from(await (await fetch(instance.base + account.avatarUrl)).arrayBuffer()).equals(TINY_PNG));
    assert.ok(!/SECRET-/.test(text) && !/SECRET-/.test(await (await fetch(`${instance.base}/api/accounts`)).text()));
    assert.ok(seen.every((request) => request.url === '/userinfo' || request.auth === ''), 'the token was sent somewhere other than the user-info endpoint');

    const uploaded = await fetch(`${instance.base}/api/accounts/agy-identity/avatar`, { method: 'PUT', headers: authed(), body: JSON.stringify({ image: `data:image/webp;base64,${Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ').toString('base64')}` }) });
    assert.strictEqual(uploaded.status, 200);
    const custom = Buffer.from(await (await fetch(instance.base + (await uploaded.json()).account.avatarUrl)).arrayBuffer());
    assert.strictEqual(custom.subarray(8, 12).toString('ascii'), 'WEBP');
    const removed = await (await fetch(`${instance.base}/api/accounts/agy-identity/avatar`, { method: 'DELETE', headers: authed() })).json();
    assert.ok(Buffer.from(await (await fetch(instance.base + removed.account.avatarUrl)).arrayBuffer()).equals(TINY_PNG));

    fs.writeFileSync(path.join(cli, 'antigravity-oauth-token'), JSON.stringify({
      token: { access_token: 'SECRET-ACCESS-AGY', expiry: new Date(Date.now() - 60000).toISOString() },
      id_token_email: 'grace@example.com'
    }));
    const later = (await (await fetch(`${instance.base}/api/accounts/agy-identity/check`, { method: 'POST', headers: authed() })).json()).account;
    assert.strictEqual(later.identity.name, 'Grace Hopper', 'a check made after the access token expired erased the name');
  } finally {
    google.close();
  }
});

test('an Antigravity sign-in kept in the account keychain shows the Google name, and the newest stored sign-in wins', { skip: process.platform !== 'darwin' }, async () => {
  const google = http.createServer((req, res) => {
    if (req.url === '/userinfo' && req.headers.authorization === 'Bearer SECRET-ACCESS-KEYCHAIN') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: 'Katherine Johnson', email: 'katherine@example.com' }));
    }
    res.writeHead(401);
    res.end();
  });
  await new Promise((resolve) => google.listen(0, '127.0.0.1', resolve));
  try {
    const instance = await startInstance({ A2A_GOOGLE_USERINFO_URL: `http://127.0.0.1:${google.address().port}/userinfo` });
    await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-keychain', provider: 'agy' }) });
    await fetch(`${instance.base}/api/accounts/agy-keychain/check`, { method: 'POST', headers: authed() });
    const home = path.join(instance.accountsDir, 'agy-keychain', 'home');
    const cli = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(cli, { recursive: true });
    fs.writeFileSync(path.join(cli, '.signed-in'), 'ok\n');
    fs.writeFileSync(path.join(cli, 'antigravity-oauth-token'), JSON.stringify({
      token: { access_token: 'SECRET-ACCESS-STALE', expiry: new Date(Date.now() - 86400000).toISOString() },
      id_token_email: 'old@example.com'
    }));
    const stored = JSON.stringify({
      token: { access_token: 'SECRET-ACCESS-KEYCHAIN', expiry: new Date(Date.now() + 3600000).toISOString() },
      auth_method: 'oauth',
      id_token_email: 'katherine@example.com'
    });
    execFileSync('/usr/bin/security', ['add-generic-password', '-s', 'gemini', '-a', 'katherine', '-w', `go-keyring-base64:${Buffer.from(stored).toString('base64')}`, path.join(home, 'Library', 'Keychains', 'login.keychain-db')], { env: { ...process.env, HOME: home }, stdio: 'ignore' });

    const account = (await (await fetch(`${instance.base}/api/accounts/agy-keychain/check`, { method: 'POST', headers: authed() })).json()).account;
    assert.strictEqual(account.identity.name, 'Katherine Johnson');
    assert.strictEqual(account.identity.email, 'katherine@example.com');
  } finally {
    google.close();
  }
});

async function signedInClaude(instance, id) {
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id, provider: 'claude' }) });
  const dir = path.join(instance.accountsDir, id, 'claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.signed-in'), 'ok\n');
  return dir;
}

test('an unknown mode or effort is refused instead of running with full permissions', async () => {
  await signedInClaude(main, 'c-mode');
  fs.writeFileSync(main.argsFile, '');
  const rest = await fetch(`${main.base}/tasks/send`, { method: 'POST', headers: authed(), body: JSON.stringify({ prompt: 'read the code', workspace: main.workspace, account: 'c-mode', mode: 'read-only', async: true }) });
  assert.ok(rest.status >= 400);
  assert.match(JSON.stringify(await rest.json()), /Unsupported mode/);
  const rpc = await fetch(`${main.base}/rpc`, { method: 'POST', headers: authed(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { prompt: 'read the code', workspace: main.workspace, account: 'c-mode', effort: '--dangerously-skip-permissions', async: true } }) });
  assert.match(JSON.stringify(await rpc.json()), /Unsupported effort/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!fs.readFileSync(main.argsFile, 'utf-8').includes('ARGV'), 'a Claude process was started');
});

test('changes made while a status check runs are kept', async () => {
  const instance = await startInstance({ FAKE_CLAUDE_STATUS_DELAY: '1' });
  await signedInClaude(instance, 'c-race');
  const checking = fetch(`${instance.base}/api/accounts/c-race/check`, { method: 'POST', headers: authed() });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fetch(`${instance.base}/api/accounts/c-race`, { method: 'PUT', headers: authed(), body: JSON.stringify({ label: 'Renamed during check' }) });
  await fetch(`${instance.base}/api/accounts/c-race/budget`, { method: 'PUT', headers: authed(), body: JSON.stringify({ period: 'day', tokens: 5000, stop: true }) });
  assert.strictEqual((await (await checking).json()).account.status.state, 'signed-in');
  const account = await accountOf(instance, 'c-race');
  assert.strictEqual(account.label, 'Renamed during check');
  assert.deepStrictEqual(account.budget, { period: 'day', tokens: 5000, stop: true });
});

function runCli(instance, args, input = '') {
  return require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), ...args], {
    input,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, A2A_ACCOUNTS_DIR: instance.accountsDir, A2A_LOGS_DIR: instance.logsDir, A2A_PRESETS_DIR: instance.presetsDir, A2A_REAL_HOME: instance.realHome, AGY_BIN: FAKE_AGY, CLAUDE_BIN: FAKE_CLAUDE, CODEX_BIN: FAKE_CODEX, FAKE_ARGS_FILE: instance.argsFile }
  });
}

test('the CLI login keeps the new status, and refuses a default account without --yes', async () => {
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'c-cli', provider: 'claude' }) });
  const result = runCli(main, ['accounts', 'login', 'c-cli'], 'good-code\n');
  assert.strictEqual(result.status, 0, result.stderr);
  const stored = await accountOf(main, 'c-cli');
  assert.strictEqual(stored.status.state, 'signed-in');
  assert.strictEqual(stored.signedInHere, true);
  fs.writeFileSync(main.argsFile, '');
  const guarded = runCli(main, ['accounts', 'login', 'claude']);
  assert.notStrictEqual(guarded.status, 0);
  assert.match(guarded.stderr, /--yes/);
  assert.ok(!fs.readFileSync(main.argsFile, 'utf-8').includes('auth login'), 'the default sign-in was started');
});

test('a failed sign-out reports the error and keeps the account signed in', async () => {
  const dir = await signedInClaude(main, 'c-logout');
  fs.writeFileSync(path.join(dir, '.logout-fail'), '');
  await fetch(`${main.base}/api/accounts/c-logout/check`, { method: 'POST', headers: authed() });
  const res = await fetch(`${main.base}/api/accounts/c-logout/logout`, { method: 'POST', headers: authed() });
  assert.strictEqual(res.status, 502);
  assert.match((await res.json()).error, /keychain is locked/);
  assert.strictEqual((await accountOf(main, 'c-logout')).status.state, 'signed-in');
});

test('deleting a Claude account signs out only that account first', async () => {
  const dir = await signedInClaude(main, 'c-delete');
  fs.writeFileSync(main.argsFile, '');
  assert.strictEqual((await fetch(`${main.base}/api/accounts/c-delete`, { method: 'DELETE', headers: authed() })).status, 200);
  const logouts = fs.readFileSync(main.argsFile, 'utf-8').split('\n').filter((line) => line.startsWith('LOGOUT: '));
  assert.deepStrictEqual(logouts, [`LOGOUT: ${dir}`]);
});

test('an account model that could act as a flag is refused', async () => {
  const bad = await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'c-model', provider: 'claude', model: '--dangerously-skip-permissions' }) });
  assert.strictEqual(bad.status, 400);
  await fetch(`${main.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'c-model', provider: 'claude', model: 'opus' }) });
  const update = await fetch(`${main.base}/api/accounts/c-model`, { method: 'PUT', headers: authed(), body: JSON.stringify({ model: '-x' }) });
  assert.strictEqual(update.status, 400);
  assert.strictEqual((await accountOf(main, 'c-model')).model, 'opus');
});

test('sign-in words in Claude’s final error text do not sign the account out', async () => {
  const dir = await signedInClaude(main, 'c-prose-final');
  fs.writeFileSync(path.join(dir, '.claude-mode'), 'prose-final');
  const res = await fetch(`${main.base}/api/tasks`, { method: 'POST', headers: authed(), body: JSON.stringify({ role: 'test-engineer', prompt: 'debug the login page', workspace: main.workspace, mode: 'plan', account: 'c-prose-final' }) });
  const task = await finishedTask(main, (await res.json()).taskId);
  assert.strictEqual(task.status, 'failed');
  assert.notStrictEqual((await accountOf(main, 'c-prose-final')).status.state, 'signed-out');
});

test('stopping the server also stops its sign-in processes', async () => {
  const seconds = String(400 + Math.floor(Math.random() * 500));
  const instance = await startInstance({ FAKE_CODEX_LOGIN_STUBBORN: seconds });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'cx-exit', provider: 'codex' }) });
  await fetch(`${instance.base}/api/accounts/cx-exit/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'device' }) });
  await waitFor(() => runningCommands().includes(`sleep ${seconds}`));
  instance.proc.kill('SIGTERM');
  await waitFor(() => !runningCommands().includes(`sleep ${seconds}`));
});

test('closing the sign-in while the new sign-in is being checked keeps it instead of cancelling it', async () => {
  const instance = await startInstance({ FAKE_CLAUDE_STATUS_DELAY: '2' });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'c-verify', provider: 'claude' }) });
  const { login } = await (await fetch(`${instance.base}/api/accounts/c-verify/login`, { method: 'POST', headers: authed(), body: JSON.stringify({ method: 'browser' }) })).json();
  await waitFor(async () => (await loginOf(instance, login.id)).needsCode);
  await fetch(`${instance.base}/api/accounts/logins/${login.id}/code`, { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'good-code' }) });
  await waitFor(async () => (await loginOf(instance, login.id)).verifying);

  const afterCancel = (await (await fetch(`${instance.base}/api/accounts/logins/${login.id}/cancel`, { method: 'POST', headers: authed() })).json()).login;
  assert.strictEqual(afterCancel.state, 'waiting');
  assert.strictEqual(afterCancel.verifying, true);
  const done = await waitFor(async () => {
    const current = await loginOf(instance, login.id);
    return ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
  });
  assert.strictEqual(done.state, 'succeeded');
  assert.strictEqual(done.verifying, false);
  assert.strictEqual((await accountOf(instance, 'c-verify')).status.state, 'signed-in');

  const finished = (await (await fetch(`${instance.base}/api/accounts/logins/${login.id}/cancel`, { method: 'POST', headers: authed() })).json()).login;
  assert.strictEqual(finished.state, 'succeeded', 'cancelling a finished sign-in rewrote its result');
});

test('each account lists the models its own CLI offers, cached, with hidden and invalid ids left out', async () => {
  const instance = await startInstance();
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'agy-models', provider: 'agy' }) });
  await fetch(`${instance.base}/api/accounts`, { method: 'POST', headers: authed(), body: JSON.stringify({ id: 'cx-models', provider: 'codex' }) });
  const models = async (id, query = '') => (await fetch(`${instance.base}/api/accounts/${id}/models${query}`)).json();

  const signedOut = await models('agy-models');
  assert.deepStrictEqual(signedOut.models, []);
  assert.match(signedOut.error, /signed in/);

  const cli = path.join(instance.accountsDir, 'agy-models', 'home', '.gemini', 'antigravity-cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, '.signed-in'), 'ok\n');
  const agy = await models('agy-models', '?refresh=1');
  assert.deepStrictEqual(agy.models, [{ id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }, { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' }]);
  assert.strictEqual(agy.source, 'fake-agy.sh models');

  fs.writeFileSync(instance.argsFile, '');
  const codex = await models('cx-models');
  assert.deepStrictEqual(codex.models.map((m) => m.id), ['gpt-test', 'gpt-test-mini']);
  assert.match(fs.readFileSync(instance.argsFile, 'utf-8'), /CODEX_HOME: .*\/cx-models\/codex/);
  await models('cx-models');
  assert.strictEqual(fs.readFileSync(instance.argsFile, 'utf-8').match(/ARGV: debug models/g).length, 1, 'the model list was not cached');

  const claude = await models('claude');
  assert.deepStrictEqual(claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet']);
  assert.strictEqual(claude.models[1].name, 'Opus (latest)');
});
