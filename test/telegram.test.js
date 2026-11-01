const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'g'.repeat(64);
const BOT_TOKEN = '123456789:AAH' + 'b'.repeat(32);
const CHAT = 5550001;
const USER = 7770001;
const STRANGER = 7770002;
const instances = [];
let fake;
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

function startFakeTelegram() {
  const state = { updates: [], sent: [], calls: [], answers: [], edits: [], webhook: '', failSends: 0, nextUpdate: 1, nextMessage: 100, pollers: [] };
  const reply = (res, result) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  };
  const pending = (offset) => state.updates.filter((u) => u.update_id >= offset);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const match = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!match || match[1] !== BOT_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        return;
      }
      const method = match[2];
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ method, body });
      if (method === 'getMe') return reply(res, { id: 4242, is_bot: true, username: 'a2a_test_bot' });
      if (method === 'getWebhookInfo') return reply(res, { url: state.webhook });
      if (method === 'setMyCommands') return reply(res, true);
      if (method === 'sendMessage') {
        if (state.failSends > 0) {
          state.failSends--;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }));
          return null;
        }
        state.sent.push(body);
        return reply(res, { message_id: state.nextMessage++, chat: { id: body.chat_id }, text: body.text });
      }
      if (method === 'answerCallbackQuery') {
        state.answers.push(body);
        return reply(res, true);
      }
      if (method === 'editMessageReplyMarkup') {
        state.edits.push(body);
        return reply(res, true);
      }
      if (method === 'getUpdates') {
        if (body.offset !== undefined) state.updates = pending(body.offset);
        const offset = body.offset || 0;
        if (pending(offset).length || !body.timeout) return reply(res, pending(offset));
        const poller = {
          done: () => {
            clearTimeout(poller.timer);
            state.pollers = state.pollers.filter((p) => p !== poller);
            reply(res, pending(offset));
          }
        };
        poller.timer = setTimeout(poller.done, body.timeout * 1000);
        state.pollers.push(poller);
        return null;
      }
      return reply(res, true);
    });
  });
  const push = (update) => {
    state.updates.push({ update_id: state.nextUpdate++, ...update });
    for (const poller of [...state.pollers]) poller.done();
  };
  const message = (text, { chat = CHAT, user = USER, isBot = false, ageSeconds = 0, type = 'private' } = {}) => push({
    message: { message_id: state.nextMessage++, date: Math.floor(Date.now() / 1000) - ageSeconds, chat: { id: chat, type, first_name: 'Tester' }, from: { id: user, is_bot: isBot, first_name: 'Tester' }, text }
  });
  const tap = (data, { user = USER, messageId = 1 } = {}) => push({
    callback_query: { id: `cq${state.nextUpdate}`, from: { id: user, is_bot: false, first_name: 'Tester' }, message: { message_id: messageId, chat: { id: CHAT, type: 'private' } }, data }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, push, message, tap, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

async function startInstance(extraEnv = {}) {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-telegram-test-'));
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
    A2A_TELEGRAM_API: fake.base,
    A2A_TELEGRAM_POLL_SECONDS: '1',
    AGY_BIN: path.join(__dirname, 'fake-agy.sh'),
    CLAUDE_BIN: path.join(__dirname, 'fake-claude.sh'),
    CODEX_BIN: path.join(__dirname, 'fake-codex.sh'),
    FAKE_AGY_MODE: 'stream',
    FAKE_CLAUDE_MODE: 'stream',
    ...extraEnv
  };
  fs.writeFileSync(env.A2A_TOKEN_FILE, TOKEN + '\n');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' });
  const instance = { base: `http://127.0.0.1:${port}`, sandbox, workspace, home, env, proc };
  instances.push(instance);
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

const put = (instance, values) => fetch(`${instance.base}/api/settings`, { method: 'PUT', headers: authed(), body: JSON.stringify({ values }) });
const post = async (instance, url, body) => {
  const res = await fetch(instance.base + url, { method: 'POST', headers: authed(), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const status = async (instance) => (await (await fetch(`${instance.base}/api/telegram/status`)).json()).status;
const sentAfter = (count, pattern) => waitFor(() => fake.state.sent.slice(count).find((m) => pattern.test(m.text)));

before(async () => {
  fake = await startFakeTelegram();
  main = await startInstance();
});

after(() => {
  for (const instance of instances) {
    try {
      instance.proc.kill('SIGKILL');
    } catch (err) {}
    fs.rmSync(instance.sandbox, { recursive: true, force: true });
  }
  fake.close();
});

test('setup: find the chat without consuming it, then connect, register commands and answer the waiting /start', async () => {
  assert.strictEqual((await status(main)).state, 'off');
  assert.strictEqual((await put(main, { A2A_TELEGRAM_ENABLED: true })).status, 200);
  assert.strictEqual((await status(main)).state, 'incomplete');

  fake.message('/start');
  const found = await post(main, '/api/telegram/discover', { token: BOT_TOKEN });
  assert.strictEqual(found.status, 200);
  assert.strictEqual(found.body.bot, 'a2a_test_bot');
  assert.deepStrictEqual(found.body.chats.map((c) => [c.id, c.users.map((u) => u.id)]), [[String(CHAT), [String(USER)]]]);
  assert.strictEqual(fake.state.updates.length, 1);

  const tested = await post(main, '/api/telegram/test', { token: BOT_TOKEN, chatId: String(CHAT) });
  assert.deepStrictEqual(tested.body, { bot: 'a2a_test_bot', sent: true });
  const wrong = await post(main, '/api/telegram/test', { token: '987654321:AAH' + 'z'.repeat(32), chatId: String(CHAT) });
  assert.strictEqual(wrong.status, 400);
  assert.ok(!JSON.stringify(wrong.body).includes('987654321:AAH'));

  const before = fake.state.sent.length;
  assert.strictEqual((await put(main, { A2A_TELEGRAM_BOT_TOKEN: BOT_TOKEN, A2A_TELEGRAM_CHAT_ID: String(CHAT), A2A_TELEGRAM_ALLOWED_USER_IDS: String(USER) })).status, 200);
  const live = await waitFor(async () => {
    const current = await status(main);
    return current.state === 'listening' ? current : null;
  });
  assert.strictEqual(live.bot, 'a2a_test_bot');
  const commands = fake.state.calls.find((c) => c.method === 'setMyCommands');
  assert.deepStrictEqual(commands.body.scope, { type: 'chat', chat_id: CHAT });
  assert.ok(commands.body.commands.some((c) => c.command === 'run'));
  const help = await sentAfter(before, /\/status/);
  assert.strictEqual(help.chat_id, String(CHAT));
  assert.strictEqual(help.parse_mode, 'HTML');
  const discoverWhileListening = await post(main, '/api/telegram/discover', {});
  assert.strictEqual(discoverWhileListening.status, 409);
});

test('only the configured chat and allowed users are answered, and old messages are skipped', async () => {
  const before = fake.state.sent.length;
  const ignoredBefore = (await status(main)).ignored;
  fake.message('/status', { user: STRANGER });
  fake.message('/status', { chat: CHAT + 1 });
  fake.message('/status', { isBot: true });
  fake.message('/status', { ageSeconds: 3600 });
  fake.message('/status');
  const reply = await sentAfter(before, /Agents running: 0 of 6/);
  assert.match(reply.text, /Team runs: 0 active/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(fake.state.sent.length - before, 1);
  assert.strictEqual((await status(main)).ignored - ignoredBefore, 3);

  assert.strictEqual((await put(main, { A2A_TELEGRAM_ALLOWED_USER_IDS: null })).status, 200);
  try {
    const open = fake.state.sent.length;
    fake.message('/status', { type: 'group', user: STRANGER });
    await waitFor(async () => (await status(main)).ignored - ignoredBefore === 4);
    fake.message('/status', { user: STRANGER });
    await sentAfter(open, /Agents running/);
  } finally {
    assert.strictEqual((await put(main, { A2A_TELEGRAM_ALLOWED_USER_IDS: String(USER) })).status, 200);
  }
});

test('/run needs permission, then starts an agent and reports when it finishes', async () => {
  let before = fake.state.sent.length;
  fake.message('/run web-engineer build it');
  await sentAfter(before, /Starting work from Telegram is off/);

  assert.strictEqual((await put(main, { A2A_TELEGRAM_ALLOW_RUN: true, A2A_TELEGRAM_WORKSPACE: main.workspace })).status, 200);
  before = fake.state.sent.length;
  fake.message('/run no-such-role build it');
  await sentAfter(before, /Unknown role/);

  before = fake.state.sent.length;
  fake.message('/run web-engineer Build the login page');
  const started = await sentAfter(before, /Started <b>web-engineer<\/b>/);
  fake.state.failSends = 1;
  const taskId = started.text.match(/<code>(a2a_[\w-]+)<\/code>/)[1];
  assert.strictEqual(started.reply_markup.inline_keyboard[0][0].callback_data, `stop:${taskId}`);
  const done = await sentAfter(before, new RegExp(`✅ <b>web-engineer</b>[\\s\\S]*${taskId}`));
  assert.strictEqual(fake.state.failSends, 0);
  assert.strictEqual(done.reply_markup.inline_keyboard[0][0].callback_data, `log:${taskId}`);

  before = fake.state.sent.length;
  fake.tap(`log:${taskId}`);
  await sentAfter(before, /<pre>/);
  assert.ok(fake.state.answers.length > 0);

  before = fake.state.sent.length;
  fake.message('/tasks');
  await sentAfter(before, new RegExp(`Latest tasks[\\s\\S]*${taskId}`));
});

test('free text waits in the inbox for the team leader, and a waiting leader gets it at once', async () => {
  let before = fake.state.sent.length;
  fake.message('please also add tests');
  await sentAfter(before, /Saved for your team leader/);
  const queued = await post(main, '/api/telegram/inbox/wait', { timeoutSeconds: 0 });
  assert.deepStrictEqual(queued.body.messages.map((m) => [m.kind, m.text]), [['message', 'please also add tests']]);
  assert.deepStrictEqual((await post(main, '/api/telegram/inbox/wait', { timeoutSeconds: 0 })).body.messages, []);

  const waiting = post(main, '/api/telegram/inbox/wait', { timeoutSeconds: 10 });
  await waitFor(async () => (await status(main)).waiting === 1);
  before = fake.state.sent.length;
  fake.message('/do ship it');
  const delivered = await waiting;
  assert.deepStrictEqual(delivered.body.messages.map((m) => m.text), ['ship it']);
  await sentAfter(before, /Delivered to your team leader/);
  assert.strictEqual(fs.statSync(path.join(main.sandbox, 'telegram-inbox.json')).mode & 0o777, 0o600);
});

test('the leader asks with buttons through MCP and reads the tapped answer', async () => {
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp-server.js')], { env: main.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = new Map();
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    try {
      const parsed = JSON.parse(line);
      replies.set(parsed.id, parsed);
    } catch (err) {}
  });
  const rpc = async (id, method, params) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return waitFor(() => replies.get(id), 20000);
  };
  try {
    const tools = (await rpc(1, 'tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(tools.includes('a2a_notify_user') && tools.includes('a2a_wait_for_user'));

    const before = fake.state.sent.length;
    const sent = await rpc(2, 'tools/call', { name: 'a2a_notify_user', arguments: { text: 'Plan <ready>? Pick one', choices: ['Ship', 'Wait'] } });
    assert.strictEqual(sent.result.isError, undefined);
    const question = await sentAfter(before, /Plan &lt;ready&gt;\? Pick one/);
    assert.deepStrictEqual(question.reply_markup.inline_keyboard.map((row) => row[0].callback_data), ['pick:Ship', 'pick:Wait']);

    fake.tap('pick:Ship', { user: STRANGER });
    await waitFor(() => fake.state.answers.find((a) => a.text === 'Not allowed'));
    fake.tap('pick:Ship', { messageId: 77 });
    const answer = await rpc(3, 'tools/call', { name: 'a2a_wait_for_user', arguments: { timeout_seconds: 10 } });
    assert.match(answer.result.content[0].text, /tapped \(Tester\): Ship/);
    assert.ok(fake.state.edits.some((e) => e.message_id === 77));

    const empty = await rpc(4, 'tools/call', { name: 'a2a_wait_for_user', arguments: { timeout_seconds: 1 } });
    assert.match(empty.result.content[0].text, /No message from the user in 1 seconds/);

    const longBefore = fake.state.sent.length;
    const longText = `${'<&>'.repeat(3000)}\nend of the long message`;
    await rpc(6, 'tools/call', { name: 'a2a_notify_user', arguments: { text: longText } });
    const longParts = await waitFor(() => {
      const parts = fake.state.sent.slice(longBefore);
      return parts.some((m) => m.text.includes('end of the long message')) ? parts : null;
    });
    assert.ok(longParts.length > 1 && longParts.every((m) => m.text.length <= 3900));
    const unescaped = longParts.map((m) => m.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('');
    assert.ok(unescaped.replace(/\n/g, '') === longText.replace(/\n/g, ''), 'the long message lost or changed text');

    const bad = await rpc(5, 'tools/call', { name: 'a2a_notify_user', arguments: { text: 'x', choices: ['a'.repeat(80)] } });
    assert.strictEqual(bad.result.isError, true);
  } finally {
    mcp.kill();
  }
});

test('/team plans first, sends the plan with Build, and reports the finished run without a message per agent', async () => {
  const plan = {
    summary: 'One step',
    tasks: [{ id: 't1', title: 'Build the page', assignee: 'agy', role: 'web-engineer', prompt: 'Build the page', acceptance_criteria: ['page ok'], verification_command: null, depends_on: [] }]
  };
  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  fs.mkdirSync(path.join(main.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(main.home, '.claude', '.claude-replay'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tg' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: planText, usage: { input_tokens: 5, output_tokens: 5 } })
  ].join('\n') + '\n');
  const created = await post(main, '/api/teams', { id: 'tg-team', name: 'Phone Team', leader: { account: 'claude' }, members: [{ account: 'agy', roles: ['web-engineer'] }] });
  assert.strictEqual(created.status, 201);

  let before = fake.state.sent.length;
  fake.message('/team tg-team Make the landing page');
  await sentAfter(before, /Phone Team<\/b> is planning/);
  const planned = await sentAfter(before, /Plan ready/);
  assert.match(planned.text, /1\. Build the page — web-engineer @ agy/);
  const [build, cancel] = planned.reply_markup.inline_keyboard[0];
  assert.match(build.callback_data, /^build:run_\d+_[a-z0-9]+$/);
  assert.match(cancel.callback_data, /^cancel:run_/);

  before = fake.state.sent.length;
  fake.tap(build.callback_data);
  await sentAfter(before, /Building <b>Phone Team<\/b>/);
  await sentAfter(before, /✅ <b>Phone Team<\/b> · completed · 1\/1 done/);
  assert.ok(!fake.state.sent.slice(before).some((m) => /✅ <b>web-engineer<\/b>/.test(m.text)));

  before = fake.state.sent.length;
  fake.tap(build.callback_data);
  await sentAfter(before, /⚠️/);
});

test('a bot with a webhook is refused with a clear reason', async () => {
  fake.state.webhook = 'https://example.com/hook';
  try {
    const other = await startInstance();
    await put(other, { A2A_TELEGRAM_ENABLED: true, A2A_TELEGRAM_BOT_TOKEN: BOT_TOKEN, A2A_TELEGRAM_CHAT_ID: String(CHAT) });
    const failed = await waitFor(async () => {
      const current = await status(other);
      return current.state === 'error' ? current : null;
    });
    assert.match(failed.lastError, /webhook/);
    other.proc.kill('SIGKILL');
  } finally {
    fake.state.webhook = '';
  }
});

test('long messages are split on line breaks under the Telegram limit', () => {
  const { splitMessage } = require('../src/telegram');
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
  const parts = splitMessage(lines.join('\n'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 3900));
  assert.strictEqual(parts.join('\n'), lines.join('\n'));
  const long = splitMessage('y'.repeat(9000));
  assert.ok(long.every((part) => part.length <= 3900));
  assert.strictEqual(long.join(''), 'y'.repeat(9000));
  const entities = splitMessage('x'.repeat(3897) + '&amp;' + 'z'.repeat(10));
  assert.ok(entities.every((part) => !/&[a-z]*$/.test(part)));
  assert.strictEqual(entities.join(''), 'x'.repeat(3897) + '&amp;' + 'z'.repeat(10));
});
