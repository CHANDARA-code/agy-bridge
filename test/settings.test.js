const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 's'.repeat(64);
const instances = [];

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

async function startInstance(extraEnv = {}) {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-settings-test-'));
  const workspace = path.join(sandbox, 'ws');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(sandbox, 'home'));
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
    FAKE_AGY_MODE: 'busy',
    FAKE_AGY_BUSY_LINES: '120',
    ...extraEnv
  };
  fs.writeFileSync(env.A2A_TOKEN_FILE, TOKEN + '\n');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  const instance = { base: `http://127.0.0.1:${port}`, sandbox, workspace, env, proc };
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

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

const getSettings = async (instance) => (await (await fetch(`${instance.base}/api/settings`)).json()).settings;
const put = (instance, values, headers = authed()) => fetch(`${instance.base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ values }) });
const dispatch = (instance) => fetch(`${instance.base}/api/tasks`, {
  method: 'POST',
  headers: authed(),
  body: JSON.stringify({ role: 'web-engineer', prompt: 'work', workspace: instance.workspace })
});

test('settings list their defaults and sources, and saving writes a private file that wins over the default', async () => {
  const instance = await startInstance({ A2A_KILL_ESCALATION_MS: '2000' });
  const listed = await getSettings(instance);
  const byKey = Object.fromEntries(listed.map((s) => [s.key, s]));
  assert.strictEqual(byKey.A2A_MAX_CONCURRENT.value, 6);
  assert.strictEqual(byKey.A2A_MAX_CONCURRENT.source, 'default');
  assert.strictEqual(byKey.A2A_KILL_ESCALATION_MS.value, 2000);
  assert.strictEqual(byKey.A2A_KILL_ESCALATION_MS.source, 'env');
  assert.strictEqual(byKey.A2A_TELEGRAM_API, undefined);

  const saved = await put(instance, { A2A_TASK_TIMEOUT_MS: 1800000, A2A_LOG_RETENTION_DAYS: 30, A2A_NPM_REGISTRY: 'https://registry.example.com/' });
  assert.strictEqual(saved.status, 200);
  const after = Object.fromEntries((await getSettings(instance)).map((s) => [s.key, s]));
  assert.strictEqual(after.A2A_TASK_TIMEOUT_MS.value, 1800000);
  assert.strictEqual(after.A2A_TASK_TIMEOUT_MS.source, 'file');
  assert.strictEqual(after.A2A_LOG_RETENTION_DAYS.value, 30);
  assert.strictEqual(after.A2A_UPDATE_CHECK.source, 'env');
  const file = path.join(instance.sandbox, 'settings.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).A2A_TASK_TIMEOUT_MS, 1800000);

  assert.strictEqual((await put(instance, { A2A_TASK_TIMEOUT_MS: null })).status, 200);
  const reset = Object.fromEntries((await getSettings(instance)).map((s) => [s.key, s]));
  assert.strictEqual(reset.A2A_TASK_TIMEOUT_MS.value, 3600000);
  assert.strictEqual(reset.A2A_TASK_TIMEOUT_MS.source, 'default');
});

test('bad settings are refused and nothing is written', async () => {
  const instance = await startInstance({ A2A_KILL_ESCALATION_MS: '2000' });
  const cases = [
    [{ A2A_MAX_CONCURRENT: 'many' }, 400, /whole number/],
    [{ A2A_MAX_CONCURRENT: 999 }, 400, /at most 200/],
    [{ A2A_NPM_REGISTRY: 'ftp://x' }, 400, /http/],
    [{ A2A_NPM_BIN: 'npm' }, 400, /absolute path/],
    [{ A2A_NOPE: 1 }, 400, /Unknown setting/],
    [{ A2A_TELEGRAM_API: 'https://evil.example.com' }, 400, /Unknown setting/],
    [{ A2A_KILL_ESCALATION_MS: 1000 }, 409, /environment variable/]
  ];
  for (const [values, status, pattern] of cases) {
    const res = await put(instance, values);
    assert.strictEqual(res.status, status, JSON.stringify(values));
    assert.match((await res.json()).error, pattern);
  }
  assert.strictEqual((await put(instance, { A2A_MAX_CONCURRENT: 2 }, { 'Content-Type': 'application/json' })).status, 401);
  assert.strictEqual(fs.existsSync(path.join(instance.sandbox, 'settings.json')), false);
});

test('a new agent limit applies to the next task without a restart', async () => {
  const instance = await startInstance();
  assert.strictEqual((await put(instance, { A2A_MAX_CONCURRENT: 1 })).status, 200);
  const first = await dispatch(instance);
  assert.strictEqual(first.status, 202);
  const { taskId } = await first.json();
  await waitFor(async () => {
    const tasks = (await (await fetch(`${instance.base}/api/tasks`)).json()).tasks;
    return tasks.some((t) => t.id === taskId && t.cancellable);
  });
  const second = await dispatch(instance);
  assert.strictEqual(second.status, 400);
  assert.match((await second.json()).error, /Concurrency limit reached.*Settings/);
  await fetch(`${instance.base}/api/tasks/${taskId}/cancel`, { method: 'POST', headers: authed() });
});

test('the log can be read in pieces from an offset', async () => {
  const instance = await startInstance();
  const { taskId } = await (await dispatch(instance)).json();
  const read = async (from) => (await fetch(`${instance.base}/api/tasks/${taskId}/log?from=${from}`)).json();
  const first = await waitFor(async () => {
    const chunk = await read(0);
    return chunk.text.includes('working on the change') ? chunk : null;
  });
  assert.strictEqual(first.reset, false);
  assert.ok(first.next > 0);
  const later = await waitFor(async () => {
    const chunk = await read(first.next);
    return chunk.text ? chunk : null;
  });
  assert.strictEqual(later.reset, false);
  assert.ok(later.next > first.next);
  assert.ok(!later.text.includes('Role: web-engineer'));
  const full = await (await fetch(`${instance.base}/api/tasks/${taskId}/log`)).text();
  assert.ok(full.startsWith(first.text.slice(0, 200)));
  const beyond = await read(10 ** 9);
  assert.strictEqual(beyond.reset, true);
  assert.ok(beyond.text.includes('Role: web-engineer'));
  await fetch(`${instance.base}/api/tasks/${taskId}/cancel`, { method: 'POST', headers: authed() });
});

async function readEvents(url, { headers = {}, ms, until = () => false }) {
  const controller = new AbortController();
  const events = [];
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = { event: 'message', id: null, data: null };
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event.event = line.slice(6).trim();
          if (line.startsWith('id:')) event.id = line.slice(3).trim();
          if (line.startsWith('data:')) event.data = JSON.parse(line.slice(5));
        }
        if (event.data !== null) events.push(event);
        if (until(events)) return events;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

test('the log stream pushes new output and continues from the last event id after a reconnect', async () => {
  const instance = await startInstance();
  const { taskId } = await (await dispatch(instance)).json();
  const url = `${instance.base}/api/tasks/${taskId}/log/stream?from=0`;
  const first = await readEvents(url, { ms: 8000, until: (events) => events.length >= 3 });
  assert.ok(first.length >= 3);
  assert.ok(first.every((e) => e.event === 'log'));
  assert.strictEqual(first[0].data.reset, false);
  for (let i = 1; i < first.length; i++) {
    assert.strictEqual(first[i].data.reset, false);
    assert.ok(Number(first[i].id) > Number(first[i - 1].id));
  }
  assert.match(first.map((e) => e.data.text).join(''), /Role: web-engineer/);
  const resumed = await readEvents(url, { headers: { 'Last-Event-ID': first[first.length - 1].id }, ms: 8000, until: (events) => events.some((e) => e.data.text) });
  assert.ok(!resumed.map((e) => e.data.text).join('').includes('Role: web-engineer'));
  assert.strictEqual((await fetch(`${instance.base}/api/tasks/a2a_missing/log/stream`)).status, 404);
  await fetch(`${instance.base}/api/tasks/${taskId}/cancel`, { method: 'POST', headers: authed() });
});

test('a running task that only prints more output is pushed at most every 5 seconds', async () => {
  const instance = await startInstance({ FAKE_AGY_BUSY_LINES: '400' });
  const watching = readEvents(`${instance.base}/api/events`, { ms: 9000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const { taskId } = await (await dispatch(instance)).json();
  const events = (await watching).filter((e) => e.event === 'tasks' && e.data.full === false);
  const mine = events.filter((e) => e.data.tasks.some((t) => t.id === taskId && t.status === 'running'));
  assert.ok(mine.length >= 1 && mine.length <= 3, `running task pushed ${mine.length} times in 8.5 s`);
  await fetch(`${instance.base}/api/tasks/${taskId}/cancel`, { method: 'POST', headers: authed() });
});
