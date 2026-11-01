const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { DATA_DIR } = require('./config');

const STATE_FILE = process.env.A2A_TELEGRAM_STATE_FILE || path.join(DATA_DIR, 'telegram-state.json');
const INBOX_FILE = process.env.A2A_TELEGRAM_INBOX_FILE || path.join(DATA_DIR, 'telegram-inbox.json');
const MAX_MESSAGE = 3900;
const POLL_SECONDS = Number(process.env.A2A_TELEGRAM_POLL_SECONDS) || 25;
const INBOX_LIMIT = 50;
const STALE_COMMAND_SECONDS = 600;
const LIST_LIMIT = 10;
const LOG_TAIL_CHARS = 3000;

const COMMANDS = [
  ['status', 'Server, running agents and team runs'],
  ['tasks', 'Latest tasks'],
  ['task', '<id> details and the end of the log'],
  ['runs', 'Latest team runs'],
  ['teams', 'Your teams'],
  ['run', '<role>[@account] <prompt> start an agent'],
  ['team', '<team id> <goal> plan a team run'],
  ['cancel', '<task or run id> stop it'],
  ['usage', 'Tokens per account today'],
  ['do', '<text> message for your team leader'],
  ['help', 'What I can do']
];

const TASK_ICONS = { running: '⏳', completed: '✅', failed: '❌', cancelled: '⛔', stale: '⚠️' };
const RUN_ICONS = { planning: '🧠', planned: '📋', running: '⏳', reviewing: '🔎', completed: '✅', failed: '❌', cancelled: '⛔', stale: '⚠️' };
const RUN_DONE = new Set(['completed', 'failed', 'cancelled', 'stale']);
const TASK_DONE = new Set(['completed', 'failed', 'cancelled', 'stale']);

class TelegramError extends Error {
  constructor(message, code = 502) {
    super(message);
    this.code = code;
  }
}

let hooks = {
  listTasks: () => [],
  readLogTail: () => '',
  startTask: () => {
    throw new Error('not connected');
  },
  cancelTask: () => ({ ok: false, error: 'not connected' })
};

function connect(next) {
  hooks = { ...hooks, ...next };
}

const teams = () => require('./teams');

function config() {
  return {
    enabled: settings.get('A2A_TELEGRAM_ENABLED'),
    token: settings.get('A2A_TELEGRAM_BOT_TOKEN'),
    chatId: settings.get('A2A_TELEGRAM_CHAT_ID'),
    allowed: settings.get('A2A_TELEGRAM_ALLOWED_USER_IDS').split(',').filter(Boolean),
    allowRun: settings.get('A2A_TELEGRAM_ALLOW_RUN'),
    workspace: settings.get('A2A_TELEGRAM_WORKSPACE'),
    notifyTasks: settings.get('A2A_TELEGRAM_NOTIFY_TASKS'),
    notifyRuns: settings.get('A2A_TELEGRAM_NOTIFY_RUNS'),
    api: settings.get('A2A_TELEGRAM_API').replace(/\/+$/, '')
  };
}

const escapeHtml = (text) => String(text === null || text === undefined ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const oneLine = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function call(method, params = {}, { token, api, signal, timeoutMs = 15000 } = {}) {
  const cfg = config();
  const botToken = token || cfg.token;
  if (!botToken) throw new TelegramError('Add the bot token first', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  let res;
  try {
    res = await fetch(`${api || cfg.api}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });
  } catch (err) {
    if (signal && signal.aborted) throw new TelegramError('stopped');
    throw new TelegramError(controller.signal.aborted ? 'Telegram did not answer in time' : 'Cannot reach Telegram');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  let body = null;
  try {
    body = await res.json();
  } catch (err) {}
  if (!body || !body.ok) {
    const description = body && body.description ? body.description : `HTTP ${res.status}`;
    throw new TelegramError(`Telegram: ${description}`, res.status === 401 || res.status === 404 ? 400 : res.status === 409 ? 409 : 502);
  }
  return body.result;
}

function safeCut(line, max) {
  let cut = max;
  const amp = line.lastIndexOf('&', cut - 1);
  if (amp !== -1 && line.indexOf(';', amp) >= cut) cut = amp;
  const lt = line.lastIndexOf('<', cut - 1);
  if (lt !== -1 && line.indexOf('>', lt) >= cut) cut = lt;
  return cut > 0 ? cut : max;
}

function splitMessage(html) {
  const parts = [];
  let current = '';
  const pieces = [];
  for (let line of html.split('\n')) {
    while (line.length > MAX_MESSAGE) {
      const cut = safeCut(line, MAX_MESSAGE);
      pieces.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    pieces.push(line);
  }
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > MAX_MESSAGE) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) parts.push(current);
  return parts.length ? parts : [''];
}

function chunkText(text, maxEscaped) {
  const chunks = [];
  let current = '';
  let size = 0;
  for (const char of String(text)) {
    const cost = escapeHtml(char).length;
    if (size + cost > maxEscaped) {
      const newline = current.lastIndexOf('\n');
      if (newline > 0) {
        chunks.push(current.slice(0, newline));
        current = current.slice(newline + 1);
      } else {
        chunks.push(current);
        current = '';
      }
      size = escapeHtml(current).length;
    }
    current += char;
    size += cost;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

async function sendParts(parts, { buttons, chatId, token, api } = {}) {
  const target = chatId || config().chatId;
  if (!target) throw new TelegramError('Add the chat id first', 400);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const markup = buttons && buttons.length && i === parts.length - 1 ? { reply_markup: { inline_keyboard: buttons } } : {};
    last = await call('sendMessage', { chat_id: target, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, ...markup }, { token, api });
  }
  return last;
}

const send = (html, options) => sendParts(splitMessage(html), options);
const sendPlain = (text, options) => sendParts(chunkText(text, MAX_MESSAGE).map(escapeHtml), options);
const sendPre = (text, options) => sendParts(chunkText(text, MAX_MESSAGE - 20).map((chunk) => `<pre>${escapeHtml(chunk)}</pre>`), options);

const OUTBOX_LIMIT = 50;
let outbox = [];

function notify(html, options) {
  send(html, options).catch((err) => {
    outbox = [...outbox, { html, options }].slice(-OUTBOX_LIMIT);
    setStatus({ lastError: err.message });
  });
}

async function flushOutbox() {
  while (outbox.length) {
    const [next, ...rest] = outbox;
    await send(next.html, next.options);
    outbox = rest;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

const botId = (token) => String(token).split(':')[0];

function readOffset(token) {
  const state = readJson(STATE_FILE, {});
  return state && state.bot === botId(token) && Number.isInteger(state.offset) ? state.offset : 0;
}

function writeOffset(token, offset) {
  writeJson(STATE_FILE, { bot: botId(token), offset });
}

let status = { state: 'off', bot: null, lastError: null, since: null, ignored: 0 };
const statusListeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const listener of statusListeners) {
    try {
      listener(getStatus());
    } catch (err) {}
  }
}

function getStatus() {
  return { ...status, inbox: inbox.length, waiting: waiters.size };
}

function onStatusChange(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

const isActive = () => status.state === 'listening' || status.state === 'retrying';

let inbox = (() => {
  const saved = readJson(INBOX_FILE, []);
  return Array.isArray(saved) ? saved.slice(-INBOX_LIMIT) : [];
})();
const waiters = new Set();

function saveInbox() {
  try {
    writeJson(INBOX_FILE, inbox);
  } catch (err) {}
}

function deliverToWaiters() {
  for (const waiter of [...waiters]) {
    if (!inbox.length) break;
    waiters.delete(waiter);
    waiter.take();
  }
}

function pushInbox(entry) {
  inbox.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...entry });
  if (inbox.length > INBOX_LIMIT) inbox = inbox.slice(-INBOX_LIMIT);
  const delivered = waiters.size > 0;
  deliverToWaiters();
  saveInbox();
  setStatus({});
  return delivered;
}

function waitForUser({ timeoutMs, onRegister } = {}) {
  let cancelWaiter = null;
  const promise = new Promise((resolve) => {
    if (inbox.length) {
      const messages = inbox;
      inbox = [];
      saveInbox();
      setStatus({});
      resolve(messages);
      return;
    }
    const waiter = {
      take: () => {
        clearTimeout(waiter.timer);
        const messages = inbox;
        inbox = [];
        saveInbox();
        setStatus({});
        resolve(messages);
      }
    };
    cancelWaiter = () => {
      if (!waiters.delete(waiter)) return;
      clearTimeout(waiter.timer);
      setStatus({});
      resolve([]);
    };
    waiter.timer = setTimeout(cancelWaiter, Math.max(0, timeoutMs ?? 300000));
    waiters.add(waiter);
    setStatus({});
  });
  if (onRegister) onRegister(() => cancelWaiter && cancelWaiter());
  return promise;
}

function requeue(messages) {
  if (!messages.length) return;
  inbox = [...messages, ...inbox].slice(-INBOX_LIMIT);
  saveInbox();
  deliverToWaiters();
  setStatus({});
}

function isAllowed(chat, from, cfg) {
  if (!chat || String(chat.id) !== cfg.chatId) return false;
  if (!from || from.is_bot) return false;
  if (!cfg.allowed.length) return chat.type === 'private';
  return cfg.allowed.includes(String(from.id));
}

function taskLine(task) {
  const icon = TASK_ICONS[task.status] || '•';
  const time = duration(task.durationMs);
  return `${icon} <b>${escapeHtml(task.role)}</b> · ${escapeHtml(task.account || 'agy')}${time ? ` · ${time}` : ''}\n    <code>${escapeHtml(task.id)}</code> ${escapeHtml(oneLine(task.promptPreview || task.prompt, 80))}`;
}

function runLine(run) {
  const icon = RUN_ICONS[run.status] || '•';
  const tasks = run.tasks || [];
  const done = tasks.filter((t) => t.status === 'completed').length;
  return `${icon} <b>${escapeHtml(run.teamName || run.teamId)}</b> · ${escapeHtml(run.status)}${tasks.length ? ` · ${done}/${tasks.length} done` : ''}\n    <code>${escapeHtml(run.id)}</code> ${escapeHtml(oneLine(run.goal, 80))}`;
}

function planMessage(run) {
  const lines = [`📋 <b>Plan ready</b> · ${escapeHtml(run.teamName || run.teamId)}`, escapeHtml(oneLine(run.goal, 300))];
  if (run.summary) lines.push('', escapeHtml(oneLine(run.summary, 600)));
  lines.push('');
  (run.tasks || []).forEach((task, index) => {
    lines.push(`${index + 1}. ${escapeHtml(oneLine(task.title, 100))} — ${escapeHtml(task.role)} @ ${escapeHtml(task.assignee || '')}`);
  });
  lines.push('', `<code>${escapeHtml(run.id)}</code>`);
  return lines.join('\n');
}

function runButtons(run, cfg) {
  const row = [];
  if (cfg.allowRun) row.push({ text: '▶️ Build', callback_data: `build:${run.id}` });
  row.push({ text: '✖️ Cancel', callback_data: `cancel:${run.id}` });
  return [row];
}

function helpText(cfg) {
  const lines = ['<b>a2a-panel remote</b>', ''];
  for (const [command, description] of COMMANDS) lines.push(`/${command} ${escapeHtml(description)}`);
  lines.push('', 'Any other text goes to your team leader (Claude Code or Antigravity) when it calls <code>a2a_wait_for_user</code>.');
  if (!cfg.allowRun) lines.push('', 'Starting work (/run, /team, Build) is off. Turn on "Allow starting work from Telegram" in Settings.');
  return lines.join('\n');
}

function statusText() {
  const updates = require('./updates');
  const accounts = require('./accounts');
  const tasks = hooks.listTasks();
  const running = tasks.filter((t) => t.status === 'running').length;
  const limit = settings.get('A2A_MAX_CONCURRENT');
  const runs = teams().listRuns({ limit: 20 });
  const active = runs.filter((r) => ['planning', 'running', 'reviewing'].includes(r.status)).length;
  const waiting = runs.filter((r) => r.status === 'planned' && !r.planApproved).length;
  const list = accounts.listAccounts();
  const signedIn = list.filter((a) => a.status && a.status.state === 'signed-in').length;
  return [
    `<b>a2a-panel ${escapeHtml(updates.versionInfo().current)}</b> · up ${duration(process.uptime() * 1000)}`,
    `Agents running: ${running}${limit ? ` of ${limit}` : ''}`,
    `Team runs: ${active} active, ${waiting} waiting for Build`,
    `Accounts: ${signedIn} of ${list.length} signed in`,
    `Leader inbox: ${inbox.length} waiting${waiters.size ? ', leader is listening' : ''}`
  ].join('\n');
}

function usageText() {
  const accounts = require('./accounts');
  const usage = require('./usage');
  const records = usage.readUsageRecords();
  const start = usage.getPeriodStart('day');
  const lines = ['<b>Tokens today</b>'];
  for (const account of accounts.listAccounts()) {
    let tokens = 0;
    let count = 0;
    for (const record of records) {
      if (!usage.usageCountsFor(account, record) || !record.at || new Date(record.at) < start) continue;
      count++;
      tokens += Number(record.usage && record.usage.total_tokens) || 0;
    }
    const budget = account.budget ? usage.getBudgetUsed(account, records) : null;
    lines.push(`• <b>${escapeHtml(account.id)}</b> ${tokens.toLocaleString('en-US')} tokens, ${count} task${count === 1 ? '' : 's'}${budget ? ` · budget ${budget.percent}%` : ''}`);
  }
  return lines.join('\n');
}

function taskDetail(id) {
  const task = hooks.listTasks().find((t) => t.id === id);
  if (!task) return `No task <code>${escapeHtml(id)}</code>.`;
  const tail = hooks.readLogTail(id, LOG_TAIL_CHARS);
  const lines = [taskLine(task), `Workspace: <code>${escapeHtml(task.workspace)}</code>`];
  if (task.error) lines.push(`Problem: ${escapeHtml(oneLine(task.error, 400))}`);
  return { html: lines.join('\n'), log: tail, task };
}

function requireRun(cfg) {
  if (!cfg.allowRun) throw new TelegramError('Starting work from Telegram is off. Turn on "Allow starting work from Telegram" in the panel under Settings.', 403);
}

async function sendTaskDetail(id) {
  const detail = taskDetail(id);
  if (typeof detail === 'string') return send(detail);
  const buttons = detail.task.cancellable ? [[{ text: '⛔ Cancel task', callback_data: `stop:${id}` }]] : undefined;
  await send(detail.html, { buttons });
  if (detail.log.trim()) await sendPre(detail.log.slice(-LOG_TAIL_CHARS));
}

async function runCommand(command, args, cfg, message) {
  if (command === 'help' || command === 'start') return send(helpText(cfg));
  if (command === 'status') return send(statusText());
  if (command === 'usage') return send(usageText());
  if (command === 'tasks') {
    const tasks = hooks.listTasks().slice(0, LIST_LIMIT);
    return send(tasks.length ? ['<b>Latest tasks</b>', ...tasks.map(taskLine)].join('\n') : 'No tasks yet.');
  }
  if (command === 'task') {
    if (!/^a2a_[\w-]+$/.test(args)) return send('Send /task followed by a task id, for example <code>/task a2a_123</code>. /tasks lists them.');
    return sendTaskDetail(args);
  }
  if (command === 'runs') {
    const runs = teams().listRuns({ limit: LIST_LIMIT });
    return send(runs.length ? ['<b>Latest team runs</b>', ...runs.map(runLine)].join('\n') : 'No team runs yet.');
  }
  if (command === 'teams') {
    const list = teams().listTeams();
    if (!list.length) return send('No teams yet. Create one in the panel under Teams.');
    return send(['<b>Teams</b>', ...list.map((team) => `• <code>${escapeHtml(team.id)}</code> ${escapeHtml(team.name)} · leader ${escapeHtml(team.leader.account)} · ${team.members.length} member${team.members.length === 1 ? '' : 's'}`)].join('\n'));
  }
  if (command === 'run') {
    requireRun(cfg);
    const match = args.match(/^([\w-]+)(?:@([\w-]+))?\s+([\s\S]+)$/);
    if (!match) return send('Send /run role[@account] prompt, for example <code>/run web-engineer@claude-b Fix the login form</code>.');
    if (!cfg.workspace) throw new TelegramError('Set "Workspace for /run" in Settings first.', 400);
    const { taskId } = hooks.startTask({ role: match[1], account: match[2], prompt: match[3].trim(), workspace: cfg.workspace });
    return send(`⏳ Started <b>${escapeHtml(match[1])}</b>${match[2] ? ` on ${escapeHtml(match[2])}` : ''}\n<code>${escapeHtml(taskId)}</code>`, { buttons: [[{ text: '⛔ Cancel task', callback_data: `stop:${taskId}` }]] });
  }
  if (command === 'team') {
    requireRun(cfg);
    const match = args.match(/^([\w-]+)\s+([\s\S]+)$/);
    if (!match) return send('Send /team team-id goal, for example <code>/team web-app Add a dark mode switch</code>. /teams lists the ids.');
    const team = teams().getTeam(match[1]);
    const workspace = team.workspace || cfg.workspace;
    if (!workspace) throw new TelegramError('This team has no workspace and "Workspace for /run" is empty in Settings.', 400);
    const run = teams().startRun({ teamId: team.id, goal: match[2].trim(), workspace, mode: 'plan' });
    knownRuns.set(run.id, run.status);
    return send(`🧠 <b>${escapeHtml(team.name)}</b> is planning. I'll send the plan with a Build button.\n<code>${escapeHtml(run.id)}</code>`);
  }
  if (command === 'cancel') {
    if (/^run_\d+_[a-z0-9]+$/.test(args)) {
      const run = teams().cancelRun(args);
      return send(`⛔ Cancelled team run <b>${escapeHtml(run.teamName || run.teamId)}</b>.`);
    }
    if (/^a2a_[\w-]+$/.test(args)) {
      const result = hooks.cancelTask(args);
      return send(result.ok ? `⛔ Cancel requested for <code>${escapeHtml(args)}</code>.` : escapeHtml(result.error || 'Could not cancel it.'));
    }
    return send('Send /cancel followed by a task id (a2a_…) or a run id (run_…).');
  }
  if (command === 'do') {
    if (!args) return send('Send /do followed by your message for the team leader.');
    return queueForLeader(args, message);
  }
  return send(`I don't know /${escapeHtml(command)}. /help lists what I can do.`);
}

function queueForLeader(text, message) {
  const delivered = pushInbox({ kind: 'message', text: text.slice(0, 4000), from: message.from ? message.from.first_name || String(message.from.id) : '' });
  return send(delivered ? '📨 Delivered to your team leader.' : '📨 Saved for your team leader. It gets it the next time it calls <code>a2a_wait_for_user</code>.');
}

async function handleMessage(message, cfg) {
  if (!isAllowed(message.chat, message.from, cfg)) {
    setStatus({ ignored: status.ignored + 1 });
    return;
  }
  if (Date.now() / 1000 - message.date > STALE_COMMAND_SECONDS) return;
  const text = String(message.text || '').trim();
  if (!text) return;
  const command = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (!command) return queueForLeader(text, message);
  if (command[2] && status.bot && command[2].toLowerCase() !== status.bot.toLowerCase()) return;
  try {
    await runCommand(command[1].toLowerCase(), (command[3] || '').trim(), cfg, message);
  } catch (err) {
    await send(`⚠️ ${escapeHtml(err.message)}`).catch(() => {});
  }
}

async function removeButtons(query) {
  if (!query.message) return;
  await call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
}

async function handleButton(query, cfg) {
  const answer = (text) => call('answerCallbackQuery', { callback_query_id: query.id, text: text ? text.slice(0, 190) : undefined }).catch(() => {});
  if (!query.message || !isAllowed(query.message.chat, query.from, cfg)) {
    setStatus({ ignored: status.ignored + 1 });
    return answer('Not allowed');
  }
  const [action, ...rest] = String(query.data || '').split(':');
  const value = rest.join(':');
  try {
    if (action === 'build') {
      requireRun(cfg);
      const run = teams().executeRun(value);
      await answer('Building');
      await removeButtons(query);
      return send(`▶️ Building <b>${escapeHtml(run.teamName || run.teamId)}</b> · ${(run.tasks || []).length} tasks.`);
    }
    if (action === 'cancel') {
      const run = teams().cancelRun(value);
      await answer('Cancelled');
      await removeButtons(query);
      return send(`⛔ Cancelled <b>${escapeHtml(run.teamName || run.teamId)}</b>.`);
    }
    if (action === 'stop') {
      const result = hooks.cancelTask(value);
      await answer(result.ok ? 'Cancel requested' : result.error || 'Could not cancel');
      if (result.ok) await removeButtons(query);
      return null;
    }
    if (action === 'log') {
      await answer();
      return sendTaskDetail(value);
    }
    if (action === 'pick') {
      const delivered = pushInbox({ kind: 'button', text: value, from: query.from.first_name || String(query.from.id) });
      await answer(delivered ? 'Sent to your team leader' : 'Saved for your team leader');
      await removeButtons(query);
      return send(`👉 ${escapeHtml(value)}`);
    }
    return answer('Unknown button');
  } catch (err) {
    await answer(err.message);
    return send(`⚠️ ${escapeHtml(err.message)}`).catch(() => {});
  }
}

const knownTasks = new Map();
const knownRuns = new Map();
let baselineAt = 0;

function markBaseline() {
  baselineAt = Date.now();
  knownTasks.clear();
  knownRuns.clear();
  try {
    for (const task of hooks.listTasks()) knownTasks.set(task.id, task.status);
  } catch (err) {}
  try {
    for (const run of teams().listRuns({ limit: 50 })) knownRuns.set(run.id, run.status);
  } catch (err) {}
}

function teamTaskIds() {
  const ids = new Set();
  try {
    for (const run of teams().listRuns({ limit: 20 })) {
      if (run.leader && run.leader.taskId) ids.add(run.leader.taskId);
      if (run.review && run.review.taskId) ids.add(run.review.taskId);
      for (const task of run.tasks || []) if (task.taskId) ids.add(task.taskId);
    }
  } catch (err) {}
  return ids;
}

function tasksChanged(changed) {
  if (!isActive()) return;
  const cfg = config();
  const finished = [];
  for (const task of changed) {
    const before = knownTasks.get(task.id);
    knownTasks.set(task.id, task.status);
    if (!TASK_DONE.has(task.status) || before === task.status) continue;
    if (before === undefined && Date.parse(task.startedAt) < baselineAt) continue;
    finished.push(task);
  }
  if (!cfg.notifyTasks || !finished.length) return;
  const skip = cfg.notifyRuns ? teamTaskIds() : new Set();
  for (const task of finished) {
    if (skip.has(task.id)) continue;
    const lines = [taskLine(task)];
    if (task.error) lines.push(escapeHtml(oneLine(task.error, 300)));
    notify(lines.join('\n'), { buttons: [[{ text: '📄 Log', callback_data: `log:${task.id}` }]] });
  }
}

function runsChanged() {
  if (!isActive()) return;
  const cfg = config();
  let runs = [];
  try {
    runs = teams().listRuns({ limit: 20 });
  } catch (err) {
    return;
  }
  for (const run of runs) {
    const before = knownRuns.get(run.id);
    knownRuns.set(run.id, run.status);
    if (before === run.status || !cfg.notifyRuns) continue;
    if (before === undefined && Date.parse(run.startedAt) < baselineAt) continue;
    if (run.status === 'planned' && !run.planApproved) {
      notify(planMessage(run), { buttons: runButtons(run, cfg) });
    } else if (RUN_DONE.has(run.status)) {
      const lines = [runLine(run)];
      if (run.error) lines.push(escapeHtml(oneLine(run.error, 300)));
      notify(lines.join('\n'));
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function prepare(cfg, signal) {
  const bot = await call('getMe', {}, { token: cfg.token, api: cfg.api, signal });
  const hook = await call('getWebhookInfo', {}, { token: cfg.token, api: cfg.api, signal });
  if (hook && hook.url) throw new TelegramError('This bot delivers its messages to a webhook, so a2a-panel cannot read them. Remove the webhook or create a separate bot for a2a-panel.', 409);
  await call('setMyCommands', {
    commands: COMMANDS.map(([command, description]) => ({ command, description })),
    scope: { type: 'chat', chat_id: Number(cfg.chatId) }
  }, { token: cfg.token, api: cfg.api, signal });
  return bot;
}

async function pollLoop(cfg, signal) {
  setStatus({ state: 'starting', lastError: null });
  let ready = false;
  let delay = 0;
  while (!signal.aborted) {
    try {
      if (!ready) {
        const bot = await prepare(cfg, signal);
        ready = true;
        markBaseline();
        setStatus({ state: 'listening', bot: bot.username || null, lastError: null, since: new Date().toISOString() });
      }
      const updates = await call('getUpdates', {
        offset: readOffset(cfg.token),
        timeout: POLL_SECONDS,
        allowed_updates: ['message', 'callback_query']
      }, { token: cfg.token, api: cfg.api, signal, timeoutMs: (POLL_SECONDS + 15) * 1000 });
      delay = 0;
      if (outbox.length) await flushOutbox().catch(() => {});
      if (status.state !== 'listening' || status.lastError) setStatus({ state: 'listening', lastError: outbox.length ? status.lastError : null });
      for (const update of updates) {
        writeOffset(cfg.token, update.update_id + 1);
        const current = config();
        if (update.callback_query) await handleButton(update.callback_query, current);
        else if (update.message) await handleMessage(update.message, current);
      }
    } catch (err) {
      if (signal.aborted) return;
      delay = Math.min(delay ? delay * 2 : 3000, 60000);
      setStatus({ state: ready ? 'retrying' : 'error', lastError: err.message });
      await sleep(delay, signal);
    }
  }
}

let loop = null;

function configKey(cfg) {
  return cfg.enabled && cfg.token && cfg.chatId ? `${cfg.api}|${cfg.token}|${cfg.chatId}` : '';
}

function reconfigure() {
  const cfg = config();
  const key = configKey(cfg);
  if (loop && loop.key === key) return;
  if (loop) {
    loop.controller.abort();
    loop = null;
  }
  if (!key) {
    setStatus({ state: cfg.enabled ? 'incomplete' : 'off', bot: null, lastError: null, since: null });
    return;
  }
  const controller = new AbortController();
  loop = { key, controller };
  pollLoop(cfg, controller.signal).catch(() => {});
}

async function test({ token, chatId } = {}) {
  const cfg = config();
  const botToken = token || cfg.token;
  const target = chatId || cfg.chatId;
  if (!botToken) throw new TelegramError('Add the bot token first', 400);
  const bot = await call('getMe', {}, { token: botToken });
  if (!target) return { bot: bot.username, sent: false };
  await send(`👋 <b>a2a-panel</b> is connected to this chat.\nSend /help to see what I can do.`, { token: botToken, chatId: target });
  return { bot: bot.username, sent: true };
}

async function discoverChats({ token } = {}) {
  const botToken = token || config().token;
  if (!botToken) throw new TelegramError('Add the bot token first', 400);
  if (loop && loop.key && loop.key.includes(`|${botToken}|`)) {
    throw new TelegramError('The bot is already listening. Turn Telegram off, save, then look for chats again.', 409);
  }
  const bot = await call('getMe', {}, { token: botToken });
  const hook = await call('getWebhookInfo', {}, { token: botToken });
  if (hook && hook.url) throw new TelegramError('This bot delivers its messages to a webhook, so a2a-panel cannot read them. Remove the webhook or create a separate bot for a2a-panel.', 409);
  const updates = await call('getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query'] }, { token: botToken });
  const chats = new Map();
  for (const update of updates) {
    const message = update.message || (update.callback_query && update.callback_query.message);
    const from = update.message ? update.message.from : update.callback_query && update.callback_query.from;
    if (!message || !message.chat) continue;
    const chat = message.chat;
    const entry = chats.get(String(chat.id)) || { id: String(chat.id), type: chat.type, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '', users: [] };
    if (from && !from.is_bot && !entry.users.some((user) => user.id === String(from.id))) {
      entry.users.push({ id: String(from.id), name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '' });
    }
    chats.set(entry.id, entry);
  }
  return { bot: bot.username, chats: [...chats.values()] };
}

async function notifyUser({ text, choices } = {}) {
  if (!isActive()) throw new TelegramError('Telegram is not connected. Turn it on in the panel under Settings.', 409);
  if (typeof text !== 'string' || !text.trim()) throw new TelegramError('text is required', 400);
  if (text.length > 12000) throw new TelegramError('text is longer than 12000 characters', 400);
  let buttons;
  if (choices !== undefined) {
    if (!Array.isArray(choices) || choices.length > 6 || choices.some((choice) => typeof choice !== 'string' || !choice.trim() || Buffer.byteLength(`pick:${choice.trim()}`) > 64)) {
      throw new TelegramError('choices must be up to 6 short labels (about 50 characters each)', 400);
    }
    buttons = choices.map((choice) => [{ text: choice.trim(), callback_data: `pick:${choice.trim()}` }]);
  }
  await sendPlain(text.trim(), { buttons });
  return { sent: true };
}

module.exports = {
  TelegramError,
  COMMANDS,
  connect,
  reconfigure,
  getStatus,
  onStatusChange,
  isActive,
  tasksChanged,
  runsChanged,
  waitForUser,
  requeue,
  test,
  discoverChats,
  notifyUser,
  splitMessage
};
