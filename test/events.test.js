const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
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

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

async function startInstance(extraEnv = {}) {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ev-test-'));
  const logsDir = path.join(sandbox, 'logs');
  const tokenFile = path.join(sandbox, 'token');
  const workspace = path.join(sandbox, 'ws');
  const presetsDir = path.join(sandbox, 'presets');
  const accountsDir = path.join(sandbox, 'accounts');
  const teamsDir = path.join(sandbox, 'teams');
  const realHome = path.join(sandbox, 'home');

  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(presetsDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(teamsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(realHome, { recursive: true });
  fs.writeFileSync(tokenFile, TOKEN + '\n');

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      A2A_PORT: String(port),
      A2A_LOGS_DIR: logsDir,
      A2A_TOKEN_FILE: tokenFile,
      A2A_PRESETS_DIR: presetsDir,
      A2A_ACCOUNTS_DIR: accountsDir,
      A2A_TEAMS_DIR: teamsDir,
      A2A_REAL_HOME: realHome,
      AGY_BIN: FAKE_AGY,
      CLAUDE_BIN: FAKE_CLAUDE,
      CODEX_BIN: FAKE_CODEX,
      FAKE_AGY_MODE: 'stream',
      FAKE_AGY_STREAM_DELAY: '2',
      FAKE_CLAUDE_MODE: 'stream',
      A2A_UPDATE_CHECK: '0',
      ...extraEnv
    },
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

after(async () => {
  for (const instance of instances) {
    if (instance.proc && instance.proc.pid) {
      try {
        instance.proc.kill('SIGKILL');
      } catch (err) {}
    }
    try {
      fs.rmSync(instance.sandbox, { recursive: true, force: true });
    } catch (err) {}
  }
});

function createSSEReader(url, controller) {
  let response = null;
  let reader = null;
  const decoder = new TextDecoder();
  let buffer = '';

  const initPromise = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    response = res;
    reader = res.body.getReader();
    return res;
  })();

  async function nextRawBlock(timeoutMs = 8000) {
    await initPromise;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const splitIdx = buffer.indexOf('\n\n');
      if (splitIdx !== -1) {
        const raw = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        return raw;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const readPromise = reader.read().catch(() => ({ done: true }));
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remainingMs));
      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result && result.timeout) {
        break;
      }
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
    }
    return null;
  }

  async function nextEvent(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const raw = await nextRawBlock(remaining);
      if (raw === null) return null;
      const lines = raw.split('\n');
      let event = 'message';
      let data = null;
      let isComment = false;
      let isRetry = false;
      for (const line of lines) {
        if (line.startsWith(':')) {
          isComment = true;
        } else if (line.startsWith('retry:')) {
          isRetry = true;
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const rawData = line.slice(5).trim();
          try {
            data = JSON.parse(rawData);
          } catch (e) {
            data = rawData;
          }
        }
      }
      if (isComment || isRetry) {
        continue;
      }
      return { event, data, raw };
    }
    return null;
  }

  return {
    ready: initPromise,
    getResponse: () => response,
    nextEvent
  };
}

test('case a: GET /api/events returns 200, text/event-stream, and hello, tasks, teams, usage', async () => {
  const instance = await startInstance();
  const controller = new AbortController();
  try {
    const sse = createSSEReader(`${instance.base}/api/events`, controller);
    const res = await sse.ready;
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const evHello = await sse.nextEvent();
    assert.ok(evHello);
    assert.strictEqual(evHello.event, 'hello');
    assert.strictEqual(typeof evHello.data.uptimeSeconds, 'number');
    assert.strictEqual(typeof evHello.data.pid, 'number');

    const evTasks = await sse.nextEvent();
    assert.ok(evTasks);
    assert.strictEqual(evTasks.event, 'tasks');
    assert.ok(Array.isArray(evTasks.data.tasks));

    assert.strictEqual(evTasks.data.full, true);
    const resTasks = await fetch(`${instance.base}/api/tasks`);
    const tasksBody = await resTasks.json();
    const expectedIds = tasksBody.tasks.map((t) => t.id);
    const streamIds = evTasks.data.tasks.map((t) => t.id);
    assert.deepStrictEqual(streamIds, expectedIds);

    const evTeams = await sse.nextEvent();
    assert.ok(evTeams);
    assert.strictEqual(evTeams.event, 'teams');
    assert.deepStrictEqual(evTeams.data, {});

    const evUsage = await sse.nextEvent();
    assert.ok(evUsage);
    assert.strictEqual(evUsage.event, 'usage');
    assert.deepStrictEqual(evUsage.data, {});

    const evVersion = await sse.nextEvent();
    assert.ok(evVersion);
    assert.strictEqual(evVersion.event, 'version');
    assert.strictEqual(evVersion.data.current, require('../package.json').version);
    assert.strictEqual(evHello.data.version, require('../package.json').version);
  } finally {
    controller.abort();
  }
});

test('case b: Idle: no further tasks/teams/usage event arrives within 5 s', async () => {
  const instance = await startInstance();
  const controller = new AbortController();
  try {
    const sse = createSSEReader(`${instance.base}/api/events`, controller);
    await sse.ready;
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();
    assert.strictEqual((await sse.nextEvent()).event, 'version');

    const extraEvent = await sse.nextEvent(5000);
    assert.strictEqual(extraEvent, null);
  } finally {
    controller.abort();
  }
});

test('case c: POST /api/tasks stream pushes new task then finished task', async () => {
  const instance = await startInstance();
  const controller = new AbortController();
  try {
    const sse = createSSEReader(`${instance.base}/api/events`, controller);
    await sse.ready;
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();

    const rolesRes = await fetch(`${instance.base}/api/roles`);
    const { roles } = await rolesRes.json();
    const role = roles[0].id;

    const dispatchRes = await fetch(`${instance.base}/api/tasks`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({
        role,
        prompt: 'Build feature',
        workspace: instance.workspace,
        mode: 'plan'
      })
    });
    assert.ok(dispatchRes.status >= 200 && dispatchRes.status < 300);
    const body = await dispatchRes.json();
    const taskId = body.taskId;

    let sawRunning = false;
    let sawFinished = false;

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !sawFinished) {
      const evt = await sse.nextEvent(5000);
      if (!evt || evt.event !== 'tasks' || !Array.isArray(evt.data.tasks)) continue;
      assert.strictEqual(evt.data.full, false);
      assert.deepStrictEqual(evt.data.tasks.map((t) => t.id), [taskId]);
      assert.deepStrictEqual(evt.data.removed, []);
      const found = evt.data.tasks.find((t) => t.id === taskId);
      if (!found) continue;
      if (found.status === 'running') {
        sawRunning = true;
      } else {
        sawFinished = true;
      }
    }

    assert.strictEqual(sawRunning, true);
    assert.strictEqual(sawFinished, true);
  } finally {
    controller.abort();
  }
});

test('case d: Appending usage.jsonl and writing team-runs/<runId>.json emit usage and teams events', async () => {
  const instance = await startInstance();
  const controller = new AbortController();
  try {
    const sse = createSSEReader(`${instance.base}/api/events`, controller);
    await sse.ready;
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();

    const usageLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      task_id: 'a2a_test1',
      account_id: 'agy',
      role: 'web-engineer',
      total_tokens: 50
    }) + '\n';
    fs.appendFileSync(path.join(instance.logsDir, 'usage.jsonl'), usageLine);

    let evUsage = await sse.nextEvent(8000);
    while (evUsage && evUsage.event !== 'usage') {
      evUsage = await sse.nextEvent(8000);
    }
    assert.ok(evUsage);
    assert.strictEqual(evUsage.event, 'usage');

    const runsDir = path.join(instance.logsDir, 'team-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const runId = `run_${Date.now()}_testrun`;
    fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
      id: runId,
      teamId: 'dev-team',
      status: 'completed'
    }));

    let evTeams = await sse.nextEvent(8000);
    while (evTeams && evTeams.event !== 'teams') {
      evTeams = await sse.nextEvent(8000);
    }
    assert.ok(evTeams);
    assert.strictEqual(evTeams.event, 'teams');
  } finally {
    controller.abort();
  }
});

test('case e: Starting a sign-in pushes login event with only id and state', async () => {
  const instance = await startInstance();
  const controller = new AbortController();
  try {
    const sse = createSSEReader(`${instance.base}/api/events`, controller);
    await sse.ready;
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();
    await sse.nextEvent();

    const accRes = await fetch(`${instance.base}/api/accounts`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ id: 'test-ev-acc', provider: 'claude', label: 'Test Claude' })
    });
    assert.strictEqual(accRes.status, 201);

    const loginRes = await fetch(`${instance.base}/api/accounts/test-ev-acc/login`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ method: 'browser' })
    });
    assert.strictEqual(loginRes.status, 202);
    const { login } = await loginRes.json();
    const loginId = login.id;

    let evLogin = await sse.nextEvent(8000);
    while (evLogin && (evLogin.event !== 'login' || evLogin.data.id !== loginId)) {
      evLogin = await sse.nextEvent(8000);
    }
    assert.ok(evLogin);
    assert.strictEqual(evLogin.event, 'login');
    assert.strictEqual(evLogin.data.id, loginId);
    assert.ok(evLogin.data.state);
    assert.deepStrictEqual(Object.keys(evLogin.data).sort(), ['id', 'state']);
  } finally {
    controller.abort();
  }
});

test('case f: With A2A_MAX_EVENT_CLIENTS=1, a second concurrent GET /api/events gets 503', async () => {
  const instance = await startInstance({ A2A_MAX_EVENT_CLIENTS: '1' });
  const controller1 = new AbortController();
  const controller2 = new AbortController();
  try {
    const sse1 = createSSEReader(`${instance.base}/api/events`, controller1);
    const res1 = await sse1.ready;
    assert.strictEqual(res1.status, 200);

    const res2 = await fetch(`${instance.base}/api/events`, { signal: controller2.signal });
    assert.strictEqual(res2.status, 503);
    const body2 = await res2.json();
    assert.deepStrictEqual(body2, { error: 'Too many event streams' });
  } finally {
    controller1.abort();
    controller2.abort();
  }
});
