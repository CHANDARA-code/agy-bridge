const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'a'.repeat(64);
const FAKE_AGENT = path.join(__dirname, 'fake-agy.sh');
const instances = [];
// Keep every server and in-process run away from the user's own presets (and their default preset).
process.env.A2A_PRESETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-presets-'));
process.env.A2A_ACCOUNTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-accounts-'));
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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function descendantsMatching(rootPid, pattern) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf-8' });
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[2]) === rootPid && pattern.test(m[3]))
    .map((m) => Number(m[1]));
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
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
  const logsDir = path.join(sandbox, 'logs');
  const tokenFile = path.join(sandbox, 'token');
  const workspace = path.join(sandbox, 'ws');
  fs.mkdirSync(workspace);
  fs.writeFileSync(tokenFile, TOKEN + '\n');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, A2A_PORT: String(port), A2A_LOGS_DIR: logsDir, A2A_TOKEN_FILE: tokenFile, A2A_SETTINGS_FILE: path.join(sandbox, 'settings.json'), AGY_BIN: FAKE_AGENT, ...extraEnv },
    stdio: 'ignore'
  });
  const instance = { port, base: `http://127.0.0.1:${port}`, sandbox, logsDir, workspace, proc };
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

function rawRequest(instance, requestPath, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: instance.port, path: requestPath, method, headers: host ? { Host: host } : {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function dispatch(instance, overrides = {}) {
  const res = await fetch(`${instance.base}/api/tasks`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'web-engineer', prompt: 'long task', workspace: instance.workspace, mode: 'plan', effort: 'low', ...overrides })
  });
  return { res, body: await res.json() };
}

function leaderPid(instance, taskId) {
  return waitFor(() => {
    try {
      return parseInt(fs.readFileSync(path.join(instance.logsDir, `${taskId}.pid`), 'utf-8'), 10);
    } catch (err) {
      return 0;
    }
  });
}

async function taskOf(instance, taskId) {
  return (await (await fetch(`${instance.base}/api/tasks/${taskId}`)).json()).task;
}

let main;

before(async () => {
  main = await startInstance();
});

after(() => {
  for (const instance of instances) {
    try {
      for (const file of fs.readdirSync(instance.logsDir).filter((f) => f.endsWith('.pid'))) {
        const pid = parseInt(fs.readFileSync(path.join(instance.logsDir, file), 'utf-8'), 10);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (err) {}
      }
    } catch (err) {}
    instance.proc.kill('SIGKILL');
    fs.rmSync(instance.sandbox, { recursive: true, force: true });
  }
});

test('rejects a request whose Host header is not local', async () => {
  assert.strictEqual((await rawRequest(main, '/health', { host: 'evil.example' })).status, 403);
  assert.strictEqual((await rawRequest(main, '/health', { host: `evil.example:${main.port}` })).status, 403);
  assert.strictEqual((await rawRequest(main, '/health', { host: `localhost:${main.port}` })).status, 200);
});

test('sends no CORS headers', async () => {
  const res = await fetch(`${main.base}/health`);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${main.base}/rpc`, { method: 'OPTIONS' });
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), null);
});

test('every write route and every non-GET method needs the token', async () => {
  for (const route of ['/api/tasks', '/tasks/send', '/rpc', '/api/tasks/a2a_x/cancel', '/tasks/a2a_x/cancel']) {
    const res = await fetch(`${main.base}${route}`, { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 401, route);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(`${main.base}/api/tasks`, { method, body: '{}' });
    assert.strictEqual(res.status, 401, method);
  }
});

test('POST with a wrong token is rejected', async () => {
  const res = await fetch(`${main.base}/api/tasks`, { method: 'POST', headers: { 'X-A2A-Token': 'b'.repeat(64) }, body: '{}' });
  assert.strictEqual(res.status, 401);
});

test('POST with a valid token from a foreign Origin is rejected', async () => {
  const res = await fetch(`${main.base}/api/tasks`, { method: 'POST', headers: authed({ Origin: 'http://evil.example' }), body: '{}' });
  assert.strictEqual(res.status, 403);
});

test('Authorization bearer token is accepted', async () => {
  const res = await fetch(`${main.base}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.getCard' })
  });
  assert.strictEqual(res.status, 200);
});

test('dispatch validates role, workspace, prompt, mode and effort', async () => {
  const bad = async (overrides) => (await dispatch(main, overrides)).res.status;
  assert.strictEqual(await bad({ role: 'nope' }), 400);
  assert.strictEqual(await bad({ prompt: '   ' }), 400);
  assert.strictEqual(await bad({ prompt: '--workspace' }), 400);
  assert.strictEqual(await bad({ workspace: 'relative/path' }), 400);
  assert.strictEqual(await bad({ workspace: path.join(main.sandbox, 'missing') }), 400);
  assert.strictEqual(await bad({ mode: 'auto' }), 400);
  assert.strictEqual(await bad({ effort: 'extreme' }), 400);
});

test('static serving rejects traversal with a literal dot-dot path', async () => {
  const toToken = await rawRequest(main, '/dashboard/../../token');
  assert.strictEqual(toToken.status, 403);
  assert.ok(!toToken.body.includes(TOKEN));
  const toSource = await rawRequest(main, '/dashboard/../server.js');
  assert.strictEqual(toSource.status, 403);
  assert.ok(!toSource.body.includes('require('));
});

test('dashboard page carries the token, a CSP and is never cached; no API leaks the token', async (t) => {
  if (!fs.existsSync(path.join(ROOT, 'panel', 'dist', 'index.html'))) return t.skip('panel is not built');
  const page = await rawRequest(main, '/dashboard');
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes(`content="${TOKEN}"`));
  assert.ok(!page.body.includes('__A2A_TOKEN__'));
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.strictEqual(page.headers['cache-control'], 'no-store');
  assert.strictEqual(page.headers['x-frame-options'], 'DENY');
  for (const route of ['/api/health', '/api/tasks', '/api/roles', '/health', '/tasks']) {
    assert.ok(!(await rawRequest(main, route)).body.includes(TOKEN), route);
  }
});

test('dispatch then cancel stops the agent and its whole process group', async () => {
  const { res, body } = await dispatch(main);
  assert.strictEqual(res.status, 202);
  const pid = await leaderPid(main, body.taskId);
  const children = await waitFor(() => {
    const found = descendantsMatching(pid, /sleep 300/);
    return found.length ? found : null;
  });

  const running = await taskOf(main, body.taskId);
  assert.strictEqual(running.status, 'running');
  assert.strictEqual(running.cancellable, true);

  const cancelled = await fetch(`${main.base}/api/tasks/${body.taskId}/cancel`, { method: 'POST', headers: authed() });
  assert.strictEqual(cancelled.status, 200);

  await waitFor(() => !processAlive(pid) && children.every((child) => !processAlive(child)));
  const finished = await waitFor(async () => {
    const task = await taskOf(main, body.taskId);
    return task.status === 'cancelled' ? task : null;
  });
  assert.strictEqual(finished.cancellable, false);

  const again = await fetch(`${main.base}/api/tasks/${body.taskId}/cancel`, { method: 'POST', headers: authed() });
  assert.strictEqual(again.status, 409);
});

test('legacy REST cancel and JSON-RPC cancel use the same group-wide stop', async () => {
  for (const via of ['rest', 'rpc']) {
    const { body } = await dispatch(main);
    const pid = await leaderPid(main, body.taskId);
    await waitFor(() => descendantsMatching(pid, /sleep 300/).length);
    const res =
      via === 'rest'
        ? await fetch(`${main.base}/tasks/${body.taskId}/cancel`, { method: 'POST', headers: authed() })
        : await fetch(`${main.base}/rpc`, {
            method: 'POST',
            headers: authed(),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { taskId: body.taskId } })
          });
    assert.strictEqual(res.status, 200, via);
    await waitFor(() => !processAlive(pid) && descendantsMatching(pid, /sleep 300/).length === 0);
  }
});

test('SIGKILL escalation kills a descendant that ignores SIGTERM', async () => {
  const stubborn = await startInstance({ FAKE_AGY_MODE: 'stubborn', A2A_KILL_ESCALATION_MS: '800' });
  const { body } = await dispatch(stubborn);
  const pid = await leaderPid(stubborn, body.taskId);
  const children = await waitFor(() => {
    const found = descendantsMatching(pid, /sleep 300/);
    return found.length ? found : null;
  });
  const res = await fetch(`${stubborn.base}/api/tasks/${body.taskId}/cancel`, { method: 'POST', headers: authed() });
  assert.strictEqual(res.status, 200);
  await waitFor(() => !processAlive(pid), 3000);
  assert.ok(children.some((child) => processAlive(child)), 'child should still be alive right after SIGTERM');
  await waitFor(() => children.every((child) => !processAlive(child)), 6000);
});

test('a task whose leader exited but whose group is alive stays running and can be cancelled', async () => {
  const lingering = await startInstance({ FAKE_AGY_MODE: 'detached-child' });
  const { body } = await dispatch(lingering);
  const pid = await leaderPid(lingering, body.taskId);
  await waitFor(() => !processAlive(pid), 4000);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const task = await taskOf(lingering, body.taskId);
  assert.strictEqual(task.status, 'running');
  assert.strictEqual(task.cancellable, true);

  const res = await fetch(`${lingering.base}/api/tasks/${body.taskId}/cancel`, { method: 'POST', headers: authed() });
  assert.strictEqual(res.status, 200);
  const finished = await waitFor(async () => {
    const current = await taskOf(lingering, body.taskId);
    return current.status === 'cancelled' ? current : null;
  });
  assert.strictEqual(finished.cancellable, false);
});

test('a missing agent binary fails the task without crashing the server', async () => {
  const broken = await startInstance({ AGY_BIN: '/nonexistent/agy' });
  const { res, body } = await dispatch(broken);
  assert.strictEqual(res.status, 202);
  const task = await waitFor(async () => {
    const current = await taskOf(broken, body.taskId);
    return current.status === 'failed' ? current : null;
  });
  assert.match(task.error, /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual((await fetch(`${broken.base}/health`)).status, 200);
  assert.strictEqual(broken.proc.exitCode, null);
});

test('cancelling an unknown or malformed task id fails cleanly', async () => {
  const unknown = await fetch(`${main.base}/api/tasks/a2a_0_none/cancel`, { method: 'POST', headers: authed() });
  assert.strictEqual(unknown.status, 409);
  const malformed = await fetch(`${main.base}/api/tasks/..%2f..%2fx/cancel`, { method: 'POST', headers: authed() });
  assert.ok([400, 404].includes(malformed.status));
});

test('a task past the wall-clock limit is stopped and marked failed', async () => {
  const limited = await startInstance({ A2A_TASK_TIMEOUT_MS: '600', A2A_KILL_ESCALATION_MS: '300' });
  const { body } = await dispatch(limited);
  const task = await waitFor(async () => {
    const current = await taskOf(limited, body.taskId);
    return current.status === 'failed' ? current : null;
  });
  assert.match(task.error, /Timed out after/);
});

test('a task that goes silent past the idle limit is stopped and marked failed', async () => {
  const limited = await startInstance({ A2A_IDLE_TIMEOUT_MS: '600', A2A_KILL_ESCALATION_MS: '300' });
  const { body } = await dispatch(limited);
  const task = await waitFor(async () => {
    const current = await taskOf(limited, body.taskId);
    return current.status === 'failed' ? current : null;
  });
  assert.match(task.error, /No output for/);
});

test('dispatch is refused once the concurrency limit is reached', async () => {
  const capped = await startInstance({ A2A_MAX_CONCURRENT: '1' });
  const first = await dispatch(capped);
  assert.strictEqual(first.res.status, 202);
  await leaderPid(capped, first.body.taskId);
  const second = await dispatch(capped);
  assert.strictEqual(second.res.status, 400);
  assert.match(second.body.error, /Concurrency limit reached/);
  await fetch(`${capped.base}/api/tasks/${first.body.taskId}/cancel`, { method: 'POST', headers: authed() });
  await waitFor(async () => (await taskOf(capped, first.body.taskId)).status === 'cancelled');
  const third = await dispatch(capped);
  assert.strictEqual(third.res.status, 202);
  await fetch(`${capped.base}/api/tasks/${third.body.taskId}/cancel`, { method: 'POST', headers: authed() });
});

const waitForLog = `
  const waitForLog = (file, done) => {
    const started = Date.now();
    const tick = () => {
      const log = require('fs').readFileSync(file, 'utf-8');
      if (log.includes('=== TASK FINISHED') || Date.now() - started > 8000) done(log);
      else setTimeout(tick, 25);
    };
    tick();
  };
`;

test('in-memory task output is capped while the log keeps everything', async () => {
  const script = `
    ${waitForLog}
    const { runAgyTask } = require(${JSON.stringify(path.join(ROOT, 'src', 'dispatcher.js'))});
    runAgyTask({ role: 'web-engineer', prompt: 'x', workspace: process.argv[1], onDone: (t) => waitForLog(t.logFile, (log) => {
      console.log(JSON.stringify({ kept: t.output.length, total: t.outputChars, truncated: t.outputTruncated, logLength: log.length }));
    }) });
  `;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-cap-'));
  const workspace = path.join(sandbox, 'ws');
  fs.mkdirSync(workspace);
  const out = execFileSync(process.execPath, ['-e', script, workspace], {
    encoding: 'utf-8',
    env: { ...process.env, A2A_LOGS_DIR: path.join(sandbox, 'logs'), AGY_BIN: FAKE_AGENT, FAKE_AGY_MODE: 'chatty', A2A_MAX_OUTPUT_CHARS: '1000' }
  });
  const result = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(result.kept, 1000);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.total > 50000);
  assert.ok(result.logLength > result.total);
});

function runInProcess(mode, extraEnv = {}, taskArgs = {}) {
  const script = `
    ${waitForLog}
    const { runAgyTask } = require(${JSON.stringify(path.join(ROOT, 'src', 'dispatcher.js'))});
    runAgyTask({ role: 'web-engineer', prompt: 'x', workspace: process.argv[1], ...JSON.parse(process.argv[2] || '{}'), onDone: (t) => waitForLog(t.logFile, (log) => {
      console.log(JSON.stringify({ status: t.status, error: t.error, verification: t.verification, output: t.output, usage: t.usage, conversationId: t.conversationId, changes: t.changes, log }));
    }) });
  `;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-run-'));
  const workspace = path.join(sandbox, 'ws');
  fs.mkdirSync(workspace);
  const logsDir = path.join(sandbox, 'logs');
  const out = execFileSync(process.execPath, ['-e', script, workspace, JSON.stringify(taskArgs)], {
    encoding: 'utf-8',
    env: { ...process.env, A2A_LOGS_DIR: logsDir, AGY_BIN: FAKE_AGENT, FAKE_AGY_MODE: mode, ...extraEnv }
  });
  return { result: JSON.parse(out.trim().split('\n').pop()), logsDir, workspace };
}

test('stream-json output becomes readable text, with usage and conversation id captured', () => {
  const { result, logsDir } = runInProcess('stream');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.output, 'Hello world' + 'plain passthrough line\n');
  assert.strictEqual(result.conversationId, 'conv-12345678');
  assert.strictEqual(result.usage.total_tokens, 120);
  assert.match(result.log, /\[step\] run_command/);
  assert.ok(!result.log.includes('"event"'));
  const logged = fs.readFileSync(path.join(logsDir, 'usage.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].usage.total_tokens, 120);
  assert.strictEqual(logged[0].role, 'web-engineer');
});

test('tool steps are logged with their arguments, and failed steps and denied actions are reported', () => {
  const { result } = runInProcess('tools');
  assert.match(result.log, /\[tool\] run_command: npm test/);
  assert.match(result.log, /\[error\] run_command: ls -la \(user denied permission to run command:\)/);
  assert.ok(result.output.startsWith('done'));
  assert.match(result.output, /denied these actions: RunCommand/);
});

test('an agent result whose status is not SUCCESS marks the task failed', () => {
  const { result } = runInProcess('failed');
  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /ERROR/);
});

test('a git workspace reports what changed after the run', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-git-'));
  const workspace = path.join(sandbox, 'ws');
  fs.mkdirSync(workspace);
  execFileSync('git', ['-C', workspace, 'init', '-q']);
  fs.writeFileSync(path.join(workspace, 'new-file.txt'), 'hi');
  const script = `
    const { runAgyTask } = require(${JSON.stringify(path.join(ROOT, 'src', 'dispatcher.js'))});
    runAgyTask({ role: 'web-engineer', prompt: 'x', workspace: process.argv[1], onDone: (t) => console.log(JSON.stringify({ changes: t.changes })) });
  `;
  const out = execFileSync(process.execPath, ['-e', script, workspace], {
    encoding: 'utf-8',
    env: { ...process.env, A2A_LOGS_DIR: path.join(sandbox, 'logs'), AGY_BIN: FAKE_AGENT, FAKE_AGY_MODE: 'stream' }
  });
  assert.match(JSON.parse(out.trim().split('\n').pop()).changes, /new-file\.txt/);
});

test('conversation_id and model reject values that could act as flags', () => {
  const script = `
    const { runAgyTask } = require(${JSON.stringify(path.join(ROOT, 'src', 'dispatcher.js'))});
    for (const extra of [{ conversation_id: '--evil-flag-x' }, { model: '--evil' }]) {
      try { runAgyTask({ role: 'web-engineer', prompt: 'x', workspace: process.argv[1], ...extra }); console.log('accepted'); } catch (e) { console.log(e.message); }
    }
  `;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-val-'));
  const out = execFileSync(process.execPath, ['-e', script, sandbox], {
    encoding: 'utf-8',
    env: { ...process.env, A2A_LOGS_DIR: path.join(sandbox, 'logs'), AGY_BIN: FAKE_AGENT }
  });
  assert.deepStrictEqual(out.trim().split('\n'), ['Invalid conversation_id', 'Invalid model name']);
});

test('shipped personas are used when no plugin persona exists', () => {
  const { result } = runInProcess('stream', { A2A_PLUGINS_DIR: '/nonexistent-plugins-dir' });
  assert.match(result.log, /### YOUR ROLE \(web-engineer\)/);
  assert.match(result.log, /Web engineer/);
});

test('every role in the agent card has a shipped persona except the general lead', () => {
  const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-card.json'), 'utf-8'));
  for (const skill of card.skills) {
    if (skill.id === 'lead-software-engineer') continue;
    const name = skill.agy_agent || skill.id;
    assert.ok(fs.existsSync(path.join(ROOT, 'personas', `${name}.md`)), `missing persona for ${name}`);
  }
});

test('doctor and init --dry-run run without touching Claude Code', () => {
  const dry = execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'init', '--dry-run'], { encoding: 'utf-8' });
  assert.match(dry, /claude mcp add --scope user a2a-panel/);
  const version = execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'version'], { encoding: 'utf-8' });
  assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
});

async function instanceRpc(instance, method, params) {
  const res = await fetch(`${instance.base}/rpc`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

test('tasks/list returns recent tasks and filters by status', async () => {
  const listed = await instanceRpc(main, 'tasks/list', {});
  assert.ok(Array.isArray(listed.result.tasks));
  const none = await instanceRpc(main, 'tasks/list', { status: 'no-such-status' });
  assert.deepStrictEqual(none.result.tasks, []);
});

test('the agent card does not claim capabilities the server lacks', async () => {
  const card = await (await fetch(`${main.base}/.well-known/agent-card.json`)).json();
  assert.strictEqual(card.capabilities.streaming, false);
  assert.strictEqual(card.capabilities.pushNotifications, false);
});

test('logs older than the retention window are pruned, recent ones kept', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-prune-'));
  const logsDir = path.join(sandbox, 'logs');
  fs.mkdirSync(logsDir);
  const old = path.join(logsDir, 'a2a_1_old.log');
  const recent = path.join(logsDir, 'a2a_2_recent.log');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(recent, 'x');
  const longAgo = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(old, longAgo, longAgo);
  const workspace = path.join(sandbox, 'ws');
  fs.mkdirSync(workspace);
  const script = `
    const { runAgyTask } = require(${JSON.stringify(path.join(ROOT, 'src', 'dispatcher.js'))});
    runAgyTask({ role: 'web-engineer', prompt: 'x', workspace: process.argv[1], onDone: () => console.log('done') });
  `;
  execFileSync(process.execPath, ['-e', script, workspace], {
    encoding: 'utf-8',
    env: { ...process.env, A2A_LOGS_DIR: logsDir, AGY_BIN: FAKE_AGENT, FAKE_AGY_MODE: 'stream', A2A_LOG_RETENTION_DAYS: '14' }
  });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent));
});

test('the bridge runs the verification command itself and a pass keeps the task completed', () => {
  const { result, workspace } = runInProcess('stream', {}, { verification_command: 'pwd > ran-here.txt && exit 0' });
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.verification.passed, true);
  assert.strictEqual(result.verification.exitCode, 0);
  assert.strictEqual(fs.readFileSync(path.join(workspace, 'ran-here.txt'), 'utf-8').trim(), fs.realpathSync(workspace));
  assert.match(result.log, /VERIFICATION PASSED/);
  assert.ok(result.log.indexOf('VERIFICATION PASSED') < result.log.indexOf('TASK FINISHED'));
});

test('a failing verification command marks an otherwise successful task failed and keeps the output', () => {
  const { result } = runInProcess('stream', {}, { verification_command: 'echo boom-output; exit 3' });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.verification.passed, false);
  assert.strictEqual(result.verification.exitCode, 3);
  assert.match(result.verification.outputTail, /boom-output/);
  assert.match(result.error, /Verification failed \(exit 3\)/);
});

test('a hung verification command is killed at the verify timeout', () => {
  const { result } = runInProcess('stream', { A2A_VERIFY_TIMEOUT_MS: '300', A2A_KILL_ESCALATION_MS: '200' }, { verification_command: 'sleep 30' });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.verification.timedOut, true);
  assert.match(result.error, /Verification timed out/);
});

test('verification is skipped when the agent itself failed', () => {
  const { result } = runInProcess('failed', {}, { verification_command: 'exit 0' });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.verification, null);
});

test('a task is visible through the API the instant dispatch returns', async () => {
  const fresh = await startInstance();
  for (let i = 0; i < 5; i++) {
    const { res, body } = await dispatch(fresh);
    assert.strictEqual(res.status, 202);
    const lookup = await fetch(`${fresh.base}/api/tasks/${body.taskId}`);
    assert.strictEqual(lookup.status, 200);
    const { task } = await lookup.json();
    assert.strictEqual(task.role, 'web-engineer');
    assert.ok(task.startedAt);
    await fetch(`${fresh.base}/api/tasks/${body.taskId}/cancel`, { method: 'POST', headers: authed() });
  }
});

test('the server refuses to bind to a non-loopback address', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, A2A_HOST: '0.0.0.0', A2A_PORT: '5999', A2A_LOGS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-')) }
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Refusing to listen/);
});

test('the consistency check passes on this repo and fails when the role lists drift', () => {
  const script = path.join(ROOT, 'scripts', 'check-consistency.js');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf-8' });
  assert.strictEqual(ok.status, 0, ok.stderr);

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-consistency-'));
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith('.js') || ['agent-card.json', 'agent.json', 'README.md', 'package.json'].includes(name)) {
      fs.copyFileSync(path.join(ROOT, name), path.join(copy, name));
    }
  }
  fs.cpSync(path.join(ROOT, 'personas'), path.join(copy, 'personas'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(copy, 'src'), { recursive: true });
  const mcp = path.join(copy, 'src', 'mcp-server.js');
  fs.writeFileSync(mcp, fs.readFileSync(mcp, 'utf-8').replace("            'devops-engineer',\n", ''));
  const drifted = spawnSync(process.execPath, [script, copy], { encoding: 'utf-8' });
  assert.strictEqual(drifted.status, 1);
  assert.match(drifted.stderr, /role enum .* differs from agent-card\.json/);

  fs.rmSync(path.join(copy, 'personas', 'test-engineer.md'));
  const noPersona = spawnSync(process.execPath, [script, copy], { encoding: 'utf-8' });
  assert.match(noPersona.stderr, /no persona file personas\/test-engineer\.md/);
});

test('an async task reports usage, verification and conversation id through GET /tasks/:id and tasks/get', async () => {
  const instance = await startInstance({ FAKE_AGY_MODE: 'stream' });
  const sent = await fetch(`${instance.base}/tasks/send`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ role: 'web-engineer', prompt: 'x', workspace: instance.workspace, mode: 'plan', async: true, verification_command: 'exit 0' })
  });
  const { taskId } = await sent.json();
  const task = await waitFor(async () => {
    const body = await (await fetch(`${instance.base}/tasks/${taskId}`)).json();
    return body.status === 'completed' && body.verification ? body : null;
  });
  assert.strictEqual(task.usage.total_tokens, 120);
  assert.strictEqual(task.verification.passed, true);
  assert.strictEqual(task.conversationId, 'conv-12345678');
  assert.strictEqual(task.workspace, instance.workspace);
  const rpc = await instanceRpc(instance, 'tasks/get', { id: taskId });
  assert.strictEqual(rpc.result.usage.total_tokens, 120);
  assert.strictEqual(rpc.result.verification.passed, true);
});

async function presetInstance() {
  return startInstance({ A2A_PRESETS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-presets-')) });
}

async function api(instance, method, requestPath, body) {
  const res = await fetch(`${instance.base}${requestPath}`, { method, headers: authed(), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function taskLog(instance, taskId) {
  return fs.readFileSync(path.join(instance.logsDir, `${taskId}.log`), 'utf-8');
}

test('presets start empty and can be created from a template, edited, made default and deleted', async () => {
  const instance = await presetInstance();
  const empty = await api(instance, 'GET', '/api/presets');
  assert.deepStrictEqual(empty.body.presets, []);
  assert.strictEqual(empty.body.defaultPreset, null);
  assert.ok(empty.body.templates.some((t) => t.id === 'nestjs-react'));

  const created = await api(instance, 'POST', '/api/presets', { id: 'team', template: 'nestjs-react' });
  assert.strictEqual(created.status, 201);
  assert.ok(created.body.preset.files.some((f) => f.name === 'frontend.md' && f.roles.includes('web-engineer')));
  assert.strictEqual((await api(instance, 'POST', '/api/presets', { id: 'team' })).status, 409);
  assert.strictEqual((await api(instance, 'POST', '/api/presets', { id: 'none' })).status, 400);

  const files = [{ name: 'style.md', content: '- tabs, not spaces' }];
  const updated = await api(instance, 'PUT', '/api/presets/team', { title: 'Team', description: 'd', files });
  assert.strictEqual(updated.status, 200);
  assert.deepStrictEqual(updated.body.preset.files.map((f) => f.name), ['style.md']);
  assert.strictEqual((await api(instance, 'PUT', '/api/presets/team', { files: [{ name: '../evil.md', content: 'x' }] })).status, 400);

  assert.strictEqual((await api(instance, 'POST', '/api/presets/team/default')).body.defaultPreset, 'team');
  const unauth = await fetch(`${instance.base}/api/presets/team`, { method: 'DELETE' });
  assert.strictEqual(unauth.status, 401);
  assert.strictEqual((await api(instance, 'DELETE', '/api/presets/team')).status, 200);
  const after = await api(instance, 'GET', '/api/presets');
  assert.deepStrictEqual(after.body.presets, []);
  assert.strictEqual(after.body.defaultPreset, null);
});

test('a dispatched task gets the default preset files scoped to its role, with workspace files overriding', async () => {
  const instance = await presetInstance();
  await api(instance, 'POST', '/api/presets', { id: 'team', template: 'nestjs-react' });
  await api(instance, 'POST', '/api/presets/team/default');
  fs.mkdirSync(path.join(instance.workspace, '.agy', 'preferences'), { recursive: true });
  fs.writeFileSync(path.join(instance.workspace, '.agy', 'preferences', 'frontend.md'), '---\nroles: [web-engineer]\n---\n- Use MUI for this repo.\n');

  const web = await dispatch(instance, { role: 'web-engineer' });
  const webLog = taskLog(instance, web.body.taskId);
  assert.match(webLog, /^Preset: team$/m);
  assert.match(webLog, /### USER PREFERENCES \(preset: team\)/);
  assert.match(webLog, /Use MUI for this repo/);
  assert.ok(fs.readFileSync(path.join(ROOT, 'preset-templates', 'nestjs-react', 'frontend.md'), 'utf-8').includes('Do not add Tailwind'));
  assert.ok(!webLog.includes('Do not add Tailwind'));
  assert.ok(!webLog.includes('#### api.md'));

  const apiTask = await dispatch(instance, { role: 'api-engineer' });
  const apiLog = taskLog(instance, apiTask.body.taskId);
  assert.match(apiLog, /#### api\.md/);
  assert.ok(!apiLog.includes('Use MUI'));

  const none = await dispatch(instance, { role: 'web-engineer', preset: null });
  const noneLog = taskLog(instance, none.body.taskId);
  assert.match(noneLog, /^Preset: none$/m);
  assert.match(noneLog, /^Preferences: frontend\.md \(workspace\)$/m);

  const listed = await (await fetch(`${instance.base}/api/tasks/${web.body.taskId}`)).json();
  assert.strictEqual(listed.task.preset, 'team');
  assert.ok(listed.task.preferences.includes('frontend.md (workspace)'));

  for (const id of [web.body.taskId, apiTask.body.taskId, none.body.taskId]) await fetch(`${instance.base}/api/tasks/${id}/cancel`, { method: 'POST', headers: authed() });
});

test('an unknown preset is refused by every dispatch endpoint, and the prompt preview shows the preset', async () => {
  const instance = await presetInstance();
  const panel = await dispatch(instance, { preset: 'missing' });
  assert.strictEqual(panel.res.status, 400);
  assert.match(panel.body.error, /Unknown preset "missing"/);
  const rest = await api(instance, 'POST', '/tasks/send', { role: 'web-engineer', prompt: 'x', workspace: instance.workspace, preset: 'missing', async: true });
  assert.strictEqual(rest.status, 400);
  const rpc = await instanceRpc(instance, 'message/send', { skill: 'web-engineer', prompt: 'x', workspace: instance.workspace, preset: 'missing', async: true });
  assert.strictEqual(rpc.error.code, -32602);

  await api(instance, 'POST', '/api/presets', { id: 'team', template: 'nestjs-react' });
  const preview = await api(instance, 'POST', '/api/prompt-preview', { role: 'api-engineer', preset: 'team', prompt: 'Add orders', workspace: instance.workspace });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.preset, 'team');
  assert.ok(preview.body.files.some((f) => f.name === 'api.md'));
  assert.match(preview.body.prompt, /### TASK\nAdd orders$/);
});

test('autostart enable --dry-run prints the login service without installing it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-home-'));
  const out = execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'autostart', 'enable', '--dry-run'], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), A2A_PORT: '5999', PATH: `/usr/bin:/bin:/usr/bin` }
  });
  assert.ok(out.includes(path.join(ROOT, 'server.js')));
  assert.ok(out.includes('A2A_PORT'));
  if (process.platform === 'darwin') {
    assert.match(out, /com\.a2a-panel\.server\.plist/);
    assert.match(out, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(out, /<string>\/usr\/bin:\/bin<\/string>/);
  } else {
    assert.match(out, /a2a-panel\.service/);
    assert.match(out, /WantedBy=default\.target/);
    assert.match(out, /Environment="PATH=\/usr\/bin:\/bin"/);
  }
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('the engineering-practices template sends the core file to every role and each domain file only to its roles', async () => {
  const instance = await startInstance({ A2A_PRESETS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-presets-')), A2A_PLUGINS_DIR: '/nonexistent-plugins-dir' });
  assert.strictEqual((await api(instance, 'POST', '/api/presets', { id: 'practices', template: 'engineering-practices' })).status, 201);
  const roles = (await (await fetch(`${instance.base}/api/roles`)).json()).roles.map((r) => r.id);
  assert.strictEqual(roles.length, 13);
  assert.ok(roles.includes('release-manager'));
  const domain = {
    'web.md': ['web-engineer', 'web-performance-auditor'],
    'api.md': ['api-engineer'],
    'mobile.md': ['mobile-engineer'],
    'desktop.md': ['desktop-engineer'],
    'testing.md': ['test-engineer', 'code-reviewer', 'lead-software-engineer'],
    'debugging.md': ['bug-triager'],
    'security.md': ['security-auditor', 'code-reviewer', 'api-engineer'],
    'git.md': ['devops-engineer', 'lead-software-engineer', 'release-manager']
  };
  for (const role of roles) {
    const preview = await api(instance, 'POST', '/api/prompt-preview', { role, preset: 'practices', prompt: 'x', workspace: instance.workspace });
    const expected = ['core.md', ...Object.keys(domain).filter((file) => domain[file].includes(role))].sort();
    assert.deepStrictEqual(preview.body.files.map((f) => f.name).sort(), expected, role);
    assert.ok(!preview.body.prompt.includes('preferences truncated'), role);
  }
  const release = await api(instance, 'POST', '/api/prompt-preview', { role: 'release-manager', preset: 'practices', prompt: 'x', workspace: instance.workspace });
  assert.match(release.body.prompt, /### YOUR ROLE \(release-manager\)\n# Release manager/);
});
