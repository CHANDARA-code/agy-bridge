const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const SETTINGS_FILE = process.env.A2A_SETTINGS_FILE || path.join(DATA_DIR, 'settings.json');

const DEFINITIONS = [
  { key: 'A2A_TASK_TIMEOUT_MS', group: 'limits', type: 'int', default: 3600000, min: 0, unit: 'ms', label: 'Task time limit', help: 'Stops a task that runs longer than this and marks it failed. Set it above your longest task (a 4-hour task needs more than 240 min). 0 turns it off.' },
  { key: 'A2A_IDLE_TIMEOUT_MS', group: 'limits', type: 'int', default: 0, min: 0, unit: 'ms', label: 'Silence limit', help: 'Stops a task that prints nothing for this long. 0 (off) is safest, because agy can stay quiet while it works.' },
  { key: 'A2A_MAX_CONCURRENT', group: 'limits', type: 'int', default: 6, min: 0, max: 200, label: 'Agents at the same time', help: 'Refuses a new task while this many agents are running, across the server, MCP server and CLI. 0 turns it off.' },
  { key: 'A2A_MAX_OUTPUT_CHARS', group: 'limits', type: 'int', default: 200000, min: 1000, max: 5000000, label: 'Output kept in memory per task', help: 'Characters of output kept in memory per task. The log file keeps everything.' },
  { key: 'A2A_KILL_ESCALATION_MS', group: 'limits', type: 'int', default: 5000, min: 100, max: 60000, unit: 'ms', label: 'Grace period when stopping', help: 'Time between asking a task to stop and forcing it.' },
  { key: 'A2A_VERIFY_TIMEOUT_MS', group: 'limits', type: 'int', default: 600000, min: 0, unit: 'ms', label: 'Check command time limit', help: "Limit for the bridge's own run of a task's verification command. 0 turns it off." },
  { key: 'A2A_LOG_RETENTION_DAYS', group: 'limits', type: 'int', default: 14, min: 0, max: 3650, label: 'Keep task logs (days)', help: 'Task logs older than this are deleted when a new task starts. 0 keeps them forever.' },
  { key: 'A2A_UPDATE_CHECK', group: 'updates', type: 'bool', default: true, label: 'Check for updates', help: 'Asks the npm registry for a newer version at most every 6 hours and shows the Update button.' },
  { key: 'A2A_NPM_REGISTRY', group: 'updates', type: 'url', default: 'https://registry.npmjs.org', label: 'npm registry', help: 'Registry the update check asks.' },
  { key: 'A2A_NPM_BIN', group: 'updates', type: 'path', default: '', label: 'npm command', help: 'npm used to install an update. Empty uses the npm next to Node.js.' },
  { key: 'A2A_TELEGRAM_ENABLED', group: 'telegram', type: 'bool', default: false, label: 'Telegram remote control', help: 'Listen for commands from your Telegram chat and send notifications there.' },
  { key: 'A2A_TELEGRAM_BOT_TOKEN', group: 'telegram', type: 'secret', default: '', label: 'Bot token', help: 'From @BotFather. Stored only in settings.json in your data folder, readable only by you.' },
  { key: 'A2A_TELEGRAM_CHAT_ID', group: 'telegram', type: 'chat', default: '', label: 'Chat id', help: 'The only chat the bot listens to and writes to.' },
  { key: 'A2A_TELEGRAM_ALLOWED_USER_IDS', group: 'telegram', type: 'idlist', default: '', label: 'Allowed user ids', help: 'Comma-separated Telegram user ids allowed to send commands and messages. Empty works only for a private chat with the bot; a group chat needs the ids.' },
  { key: 'A2A_TELEGRAM_ALLOW_RUN', group: 'telegram', type: 'bool', default: false, label: 'Allow starting work from Telegram', help: 'Lets /run, /team and the Build button start agents. Messages for your team leader are delivered either way, and the leader decides what to do with them.' },
  { key: 'A2A_TELEGRAM_WORKSPACE', group: 'telegram', type: 'path', default: '', label: 'Workspace for /run', help: 'Absolute path of the project that /run and /team work in, unless a team has its own workspace.' },
  { key: 'A2A_TELEGRAM_NOTIFY_TASKS', group: 'telegram', type: 'bool', default: true, label: 'Tell me when tasks finish', help: 'A message when a task completes, fails or is cancelled.' },
  { key: 'A2A_TELEGRAM_NOTIFY_RUNS', group: 'telegram', type: 'bool', default: true, label: 'Tell me about team runs', help: 'A message with Build and Cancel buttons when a plan is ready, and one when a run ends.' },
  { key: 'A2A_TELEGRAM_API', group: 'hidden', type: 'url', default: 'https://api.telegram.org', label: 'Telegram API', help: 'Telegram Bot API base URL.' }
];

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

class SettingsError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

let cache = { mtimeMs: -1, size: -1, values: {} };
let lastStatAt = 0;

function readFile() {
  if (Date.now() - lastStatAt < 1000) return cache.values;
  lastStatAt = Date.now();
  let stat;
  try {
    stat = fs.statSync(SETTINGS_FILE);
  } catch (err) {
    cache = { mtimeMs: -1, size: -1, values: {} };
    return cache.values;
  }
  if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.values;
  let values = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed;
  } catch (err) {}
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, values };
  return values;
}

function parseValue(definition, raw) {
  if (definition.type === 'int') {
    const value = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(value)) throw new SettingsError(`${definition.label} must be a whole number`);
    if (definition.min !== undefined && value < definition.min) throw new SettingsError(`${definition.label} must be at least ${definition.min}`);
    if (definition.max !== undefined && value > definition.max) throw new SettingsError(`${definition.label} must be at most ${definition.max}`);
    return value;
  }
  if (definition.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(text)) return true;
    if (['0', 'false', 'off', 'no', ''].includes(text)) return false;
    throw new SettingsError(`${definition.label} must be on or off`);
  }
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (definition.type === 'url' && text && !/^https?:\/\/[^\s]+$/.test(text)) throw new SettingsError(`${definition.label} must be an http(s) URL`);
  if (definition.type === 'path' && text && !path.isAbsolute(text)) throw new SettingsError(`${definition.label} must be an absolute path`);
  if (definition.type === 'secret' && text && !/^\d{5,16}:[\w-]{30,64}$/.test(text)) throw new SettingsError(`${definition.label} does not look like a Telegram bot token (digits, a colon, then letters)`);
  if (definition.type === 'chat' && text && !/^-?\d{1,20}$/.test(text)) throw new SettingsError(`${definition.label} must be a number (group chat ids start with -)`);
  if (definition.type === 'idlist' && text && !/^\d{1,20}(\s*,\s*\d{1,20})*$/.test(text)) throw new SettingsError(`${definition.label} must be numbers separated by commas`);
  if (text.length > 1000) throw new SettingsError(`${definition.label} is too long`);
  return definition.type === 'idlist' ? text.split(',').map((id) => id.trim()).join(',') : text;
}

function source(key) {
  const env = process.env[key];
  if (env !== undefined && env !== '') return 'env';
  return Object.prototype.hasOwnProperty.call(readFile(), key) ? 'file' : 'default';
}

function get(key) {
  const definition = BY_KEY.get(key);
  if (!definition) throw new Error(`Unknown setting ${key}`);
  const from = source(key);
  try {
    if (from === 'env') return parseEnv(definition, process.env[key]);
    if (from === 'file') return parseValue(definition, readFile()[key]);
  } catch (err) {}
  return definition.default;
}

function parseEnv(definition, raw) {
  try {
    return parseValue(definition, raw);
  } catch (err) {
    const text = String(raw).trim();
    if (definition.type === 'int' && /^-?\d+$/.test(text)) {
      const value = parseInt(text, 10);
      return Math.min(definition.max ?? value, Math.max(definition.min ?? value, value));
    }
    if (definition.type === 'path' && text && text.length <= 1000) return text;
    throw err;
  }
}

function describe() {
  return DEFINITIONS.filter((definition) => definition.group !== 'hidden').map((definition) => {
    const from = source(definition.key);
    const value = get(definition.key);
    const secret = definition.type === 'secret';
    return {
      key: definition.key,
      group: definition.group,
      type: definition.type,
      label: definition.label,
      help: definition.help,
      unit: definition.unit || null,
      min: definition.min,
      max: definition.max,
      default: secret ? '' : definition.default,
      value: secret ? '' : value,
      isSet: secret ? Boolean(value) : undefined,
      source: from
    };
  });
}

function update(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('Send an object of settings to change');
  const next = { ...readFile() };
  for (const [key, raw] of Object.entries(patch)) {
    const definition = BY_KEY.get(key);
    if (!definition || definition.group === 'hidden') throw new SettingsError(`Unknown setting ${key}`);
    if (source(key) === 'env') throw new SettingsError(`${definition.label} is set by the environment variable ${key}; change it there`, 409);
    if (raw === null) {
      delete next[key];
      continue;
    }
    next[key] = parseValue(definition, raw);
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  const temp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, SETTINGS_FILE);
  fs.chmodSync(SETTINGS_FILE, 0o600);
  lastStatAt = 0;
  return describe();
}

module.exports = { DEFINITIONS, SettingsError, get, describe, update, SETTINGS_FILE };
