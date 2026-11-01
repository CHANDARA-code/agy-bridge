const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { DATA_DIR } = require('./config');
const { PROVIDERS, MODEL_PATTERN, statusCommand, parseStatus, resolveBin, logoutArgs } = require('./providers');
const apiServices = require('./api-services');

const RESERVED_IDS = new Set(['agy', 'claude', 'codex', 'none', 'default', 'system', 'logins']);
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

class AccountError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

function getAccountsDir() {
  const dir = process.env.A2A_ACCOUNTS_DIR || path.join(DATA_DIR, 'accounts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getRealHome() {
  return process.env.A2A_REAL_HOME || os.homedir();
}

function accountsFile() {
  return path.join(getAccountsDir(), 'accounts.json');
}

const SYSTEM_ACCOUNTS_TEMPLATE = {
  agy: {
    id: 'agy',
    provider: 'agy',
    system: true,
    label: 'Default Antigravity sign-in',
    model: null,
    createdAt: null,
    signedInHere: true,
    status: {
      state: 'unknown',
      detail: 'Not checked yet',
      email: null,
      plan: null,
      checkedAt: null,
      warning: null
    },
    limits: null,
    budget: null
  },
  claude: {
    id: 'claude',
    provider: 'claude',
    system: true,
    label: 'Default Claude Code sign-in',
    model: null,
    createdAt: null,
    signedInHere: true,
    status: {
      state: 'unknown',
      detail: 'Not checked yet',
      email: null,
      plan: null,
      checkedAt: null,
      warning: null
    },
    limits: null,
    budget: null
  },
  codex: {
    id: 'codex',
    provider: 'codex',
    system: true,
    label: 'Default Codex sign-in',
    model: null,
    createdAt: null,
    signedInHere: true,
    status: {
      state: 'unknown',
      detail: 'Not checked yet',
      email: null,
      plan: null,
      checkedAt: null,
      warning: null
    },
    limits: null,
    budget: null
  }
};

function readStore() {
  const file = accountsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { accounts: [], systemStatus: {}, systemLimits: {}, systemBudgets: {}, systemIdentities: {} };
    throw new AccountError(`Could not read ${file}: ${err.message}`, 500);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new AccountError(`${file} is not valid JSON. Fix or remove it; the account folders next to it are kept.`, 500);
  }
  return {
    accounts: data && Array.isArray(data.accounts) ? data.accounts : [],
    systemStatus: data && data.systemStatus && typeof data.systemStatus === 'object' ? data.systemStatus : {},
    systemLimits: data && data.systemLimits && typeof data.systemLimits === 'object' ? data.systemLimits : {},
    systemBudgets: data && data.systemBudgets && typeof data.systemBudgets === 'object' ? data.systemBudgets : {},
    systemIdentities: data && data.systemIdentities && typeof data.systemIdentities === 'object' ? data.systemIdentities : {}
  };
}

function readStoreForSystem() {
  try {
    return readStore();
  } catch (err) {
    return { accounts: [], systemStatus: {}, systemLimits: {}, systemBudgets: {}, systemIdentities: {} };
  }
}

function writeStore(store) {
  const file = accountsFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function getSystemAccount(id, store = readStoreForSystem()) {
  if (!SYSTEM_ACCOUNTS_TEMPLATE[id]) return null;
  const base = { ...SYSTEM_ACCOUNTS_TEMPLATE[id] };
  if (store.systemStatus && store.systemStatus[id]) {
    base.status = { ...base.status, ...store.systemStatus[id] };
  }
  base.limits = (store.systemLimits && store.systemLimits[id]) || null;
  base.budget = (store.systemBudgets && store.systemBudgets[id]) || null;
  base.identity = (store.systemIdentities && store.systemIdentities[id]) || null;
  base.avatarUrl = getAvatarUrl(id, true);
  return base;
}

function listAccounts() {
  const store = readStore();
  const sys = ['agy', 'claude', 'codex'].map((id) => getSystemAccount(id, store));
  const added = store.accounts.map((a) => ({
    ...a,
    budget: a.budget || null,
    limits: a.limits || null,
    identity: a.identity || null,
    avatarUrl: getAvatarUrl(a.id, false)
  }));
  return [...sys, ...added];
}

function getAccount(id) {
  if (SYSTEM_ACCOUNTS_TEMPLATE[id]) return getSystemAccount(id);
  const acc = readStore().accounts.find((a) => a.id === id);
  if (!acc) return null;
  return {
    ...acc,
    budget: acc.budget || null,
    limits: acc.limits || null,
    identity: acc.identity || null,
    avatarUrl: getAvatarUrl(acc.id, false)
  };
}

function accountFolder(account) {
  const base = path.join(getAccountsDir(), account.id);
  if (account.provider === 'agy') return path.join(base, 'home');
  if (account.provider === 'claude') return path.join(base, 'claude');
  if (account.provider === 'codex') return path.join(base, 'codex');
  return base;
}

const SECURITY_PREFS = 'com.apple.security.plist';

function mirrorEntries(sourceDir, targetDir, skip) {
  try {
    for (const name of fs.readdirSync(sourceDir)) {
      if (skip.has(name)) continue;
      const linkPath = path.join(targetDir, name);
      try {
        fs.lstatSync(linkPath);
      } catch (err) {
        try {
          fs.symlinkSync(path.join(sourceDir, name), linkPath);
        } catch (linkErr) {}
      }
    }
  } catch (err) {}
  try {
    for (const name of fs.readdirSync(targetDir)) {
      const full = path.join(targetDir, name);
      try {
        if (fs.lstatSync(full).isSymbolicLink() && (skip.has(name) || !fs.existsSync(fs.readlinkSync(full)))) fs.unlinkSync(full);
      } catch (err) {}
    }
  } catch (err) {}
}

function ensureAgyKeychain(home) {
  if (process.platform !== 'darwin') return;
  const prefsDir = path.join(home, 'Library', 'Preferences');
  try {
    if (fs.lstatSync(prefsDir).isSymbolicLink() || fs.existsSync(path.join(prefsDir, SECURITY_PREFS)) && fs.lstatSync(path.join(prefsDir, SECURITY_PREFS)).isSymbolicLink()) return;
  } catch (err) {
    return;
  }
  const keychain = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
  const options = { env: { ...process.env, HOME: home }, stdio: 'ignore', timeout: 15000 };
  try {
    fs.mkdirSync(path.dirname(keychain), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(keychain)) {
      execFileSync('/usr/bin/security', ['create-keychain', '-p', '', keychain], options);
      execFileSync('/usr/bin/security', ['set-keychain-settings', keychain], options);
    }
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', '', keychain], options);
  } catch (err) {}
}

function ensureAgyHome(account) {
  const targetHome = accountFolder(account);
  fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  const realHome = getRealHome();

  if (fs.existsSync(realHome)) {
    try {
      const realEntries = fs.readdirSync(realHome);
      for (const name of realEntries) {
        if (name === '.gemini' || name === 'Library') continue;
        const linkPath = path.join(targetHome, name);
        const targetPath = path.join(realHome, name);
        if (!fs.existsSync(linkPath)) {
          try {
            fs.symlinkSync(targetPath, linkPath);
          } catch (err) {}
        }
      }
    } catch (err) {}

    try {
      const currentLinks = fs.readdirSync(targetHome);
      for (const name of currentLinks) {
        if (name === '.gemini' || name === 'Library' || name === 'sign-in.command') continue;
        const full = path.join(targetHome, name);
        try {
          const stat = fs.lstatSync(full);
          if (stat.isSymbolicLink()) {
            const dest = fs.readlinkSync(full);
            if (!fs.existsSync(dest)) {
              fs.unlinkSync(full);
            }
          }
        } catch (err) {}
      }
    } catch (err) {}
  }

  const libDir = path.join(targetHome, 'Library');
  fs.mkdirSync(libDir, { recursive: true, mode: 0o700 });
  const realLib = path.join(realHome, 'Library');
  if (fs.existsSync(realLib)) mirrorEntries(realLib, libDir, new Set(['Keychains', 'Preferences']));

  const prefsDir = path.join(libDir, 'Preferences');
  try {
    if (fs.lstatSync(prefsDir).isSymbolicLink()) fs.unlinkSync(prefsDir);
  } catch (err) {}
  fs.mkdirSync(prefsDir, { recursive: true, mode: 0o700 });
  const realPrefs = path.join(realLib, 'Preferences');
  if (fs.existsSync(realPrefs)) mirrorEntries(realPrefs, prefsDir, new Set([SECURITY_PREFS]));
  ensureAgyKeychain(targetHome);

  const geminiDir = path.join(targetHome, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  const configLink = path.join(geminiDir, 'config');
  const realConfig = path.join(realHome, '.gemini', 'config');
  if (fs.existsSync(realConfig) && !fs.existsSync(configLink)) {
    try {
      fs.symlinkSync(realConfig, configLink);
    } catch (err) {}
  }

  return targetHome;
}

const REMOVED_ENV = {
  agy: ['AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY']
};

function accountOverrides(account) {
  if (account.system) return {};
  if (account.provider === 'agy') return { HOME: ensureAgyHome(account) };
  const dir = accountFolder(account);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (account.provider === 'claude') return { CLAUDE_CONFIG_DIR: dir };
  if (account.provider === 'codex') return { CODEX_HOME: dir };
  return {};
}

function accountEnv(account, baseEnv = process.env) {
  const env = { ...baseEnv, ...accountOverrides(account) };
  if (!account.system) {
    for (const name of REMOVED_ENV[account.provider] || []) delete env[name];
  }
  if (account.apiKey) {
    const key = readApiKey(account);
    if (!key) throw new AccountError(`Account "${account.id}" has no API key saved`, 400);
    apiServices.taskEnv(account, key, env);
  }
  return env;
}

const apiKeyFile = (account) => path.join(getAccountsDir(), account.id, 'api-key');

function readApiKey(account) {
  try {
    return fs.readFileSync(apiKeyFile(account), 'utf-8').trim();
  } catch (err) {
    return '';
  }
}

const API_KEY_PATTERN = /^[\x21-\x7e]{8,1024}$/;
const LOOPBACK_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/|$)/;

function validBaseUrl(value, service) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!text) {
    if (service.baseUrl === '' || /\{/.test(service.baseUrl || '')) throw new AccountError(`${service.name} needs a base URL`, 400);
    return null;
  }
  if (text.length > 300 || /[\s"'\\<>{}]/.test(text) || !(/^https:\/\/[^/]/.test(text) || LOOPBACK_URL.test(text))) {
    throw new AccountError('The base URL must be an https:// address (http:// only for localhost), without spaces or placeholders like {WorkspaceId}', 400);
  }
  return text === service.baseUrl ? null : text;
}

function applyApiKey(record, { service: serviceId, key, baseUrl, fastModel }, { requireKey }) {
  const service = apiServices.getService(serviceId);
  if (!service) throw new AccountError(`Unknown API service "${serviceId}"`, 400);
  if (service.engine !== record.provider) throw new AccountError(`${service.name} runs with ${PROVIDERS[service.engine].name}, not ${PROVIDERS[record.provider].name}`, 400);
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (trimmed && !API_KEY_PATTERN.test(trimmed)) throw new AccountError('The API key must be 8 to 1024 characters without spaces', 400);
  if (!trimmed && requireKey) throw new AccountError('Paste the API key', 400);
  const previous = record.apiKey && record.apiKey.service === service.id ? record.apiKey : null;
  record.apiKey = {
    service: service.id,
    baseUrl: baseUrl === undefined && previous ? previous.baseUrl : validBaseUrl(baseUrl, service),
    fastModel: fastModel === undefined ? (previous ? previous.fastModel : null) : validModel(fastModel),
    last4: trimmed ? trimmed.slice(-4) : previous ? previous.last4 : ''
  };
  if (!record.model && service.models.main) record.model = service.models.main;
  const needsModel = service.engine === 'codex' ? service.id !== 'openai' : service.id !== 'anthropic';
  if (needsModel && !record.model) throw new AccountError(`Choose the ${service.name} model this account uses`, 400);
  return { service, key: trimmed };
}

function writeApiFiles(record, key) {
  const dir = path.join(getAccountsDir(), record.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (key) {
    const temp = `${apiKeyFile(record)}.${process.pid}.tmp`;
    fs.writeFileSync(temp, key + '\n', { mode: 0o600 });
    fs.renameSync(temp, apiKeyFile(record));
    fs.chmodSync(apiKeyFile(record), 0o600);
  }
  const config = apiServices.codexConfig(record);
  if (record.provider === 'codex') {
    const home = accountFolder(record);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, 'config.toml');
    if (config) fs.writeFileSync(file, config, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
  }
}

function setApiKey(id, { key, baseUrl, fastModel, model } = {}) {
  if (SYSTEM_ACCOUNTS_TEMPLATE[id]) throw new AccountError('A default sign-in cannot use an API key', 400);
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new AccountError(`Account "${id}" not found`, 404);
  if (!account.apiKey) throw new AccountError(`Account "${id}" signs in with ${PROVIDERS[account.provider].name}, not an API key`, 400);
  if (model !== undefined) account.model = validModel(model);
  const { key: saved } = applyApiKey(account, { service: account.apiKey.service, key, baseUrl, fastModel }, { requireKey: false });
  writeApiFiles(account, saved);
  if (saved) account.status = { state: 'unknown', detail: 'Not checked yet', email: null, plan: null, checkedAt: null, warning: null };
  writeStore(store);
  forgetModels(id);
  return account;
}

function resolveAccount(id) {
  if (id === undefined || id === null || id === '') {
    return getSystemAccount('agy');
  }
  const account = getAccount(id);
  if (!account) {
    throw new AccountError(`Account "${id}" not found`, 404);
  }
  return account;
}


function validModel(model) {
  const value = typeof model === 'string' ? model.trim() : '';
  if (!value) return null;
  if (!MODEL_PATTERN.test(value)) throw new AccountError('Invalid model name: use letters, digits and . : _ - / ~ @ + [ ] (at most 128)', 400);
  return value;
}

function signOutBeforeDelete(account) {
  if (account.apiKey || (account.provider !== 'claude' && account.provider !== 'codex')) return;
  try {
    execFileSync(resolveBin(account.provider), logoutArgs(account.provider), { env: accountEnv(account), stdio: 'ignore', timeout: 20000 });
  } catch (err) {}
}

function createAccount({ id, provider, label, model, apiKey }) {
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw new AccountError('Invalid account id', 400);
  }
  if (RESERVED_IDS.has(id)) {
    throw new AccountError(`Account id "${id}" is reserved`, 400);
  }
  if (apiKey !== undefined && apiKey !== null) {
    if (typeof apiKey !== 'object' || Array.isArray(apiKey)) throw new AccountError('apiKey must be an object with service and key', 400);
    const service = apiServices.getService(apiKey.service);
    if (!service) throw new AccountError(`Unknown API service "${apiKey.service}"`, 400);
    provider = provider || service.engine;
  }
  if (!PROVIDERS[provider]) {
    throw new AccountError(`Unknown provider "${provider}"`, 400);
  }
  const store = readStore();
  if (store.accounts.some((a) => a.id === id)) {
    throw new AccountError(`Account "${id}" already exists`, 409);
  }

  const record = {
    id,
    provider,
    label: (label && typeof label === 'string' && label.trim()) || id,
    model: validModel(model),
    createdAt: new Date().toISOString(),
    signedInHere: false,
    status: {
      state: 'unknown',
      detail: 'Not checked yet',
      email: null,
      plan: null,
      checkedAt: null,
      warning: null
    },
    limits: null,
    budget: null
  };

  let key = '';
  if (apiKey) {
    ({ key } = applyApiKey(record, apiKey, { requireKey: true }));
    record.signedInHere = true;
  }
  const folder = path.join(getAccountsDir(), id);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (apiKey) writeApiFiles(record, key);

  store.accounts.push(record);
  writeStore(store);
  return record;
}

function updateAccount(id, { label, model }) {
  if (SYSTEM_ACCOUNTS_TEMPLATE[id]) {
    throw new AccountError('Cannot modify system account', 400);
  }
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) {
    throw new AccountError(`Account "${id}" not found`, 404);
  }
  if (label !== undefined) {
    account.label = (typeof label === 'string' && label.trim()) || account.id;
  }
  if (model !== undefined) {
    account.model = validModel(model);
    if (account.apiKey) {
      applyApiKey(account, { service: account.apiKey.service }, { requireKey: false });
      writeApiFiles(account, '');
      forgetModels(id);
    }
  }
  writeStore(store);
  return account;
}

function unlinkLinksAndRemoveDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fs.unlinkSync(full);
    } else {
      unlinkLinksAndRemoveDir(full);
      fs.rmdirSync(full);
    }
  }
}

function deleteAccount(id) {
  if (SYSTEM_ACCOUNTS_TEMPLATE[id]) {
    throw new AccountError('Cannot delete system account', 400);
  }
  const store = readStore();
  const index = store.accounts.findIndex((a) => a.id === id);
  if (index === -1) {
    throw new AccountError(`Account "${id}" not found`, 404);
  }
  const { teamsUsingAccount } = require('./teams');
  const using = teamsUsingAccount(id);
  if (using && using.length > 0) {
    throw new AccountError(`Account "${id}" is used by team(s): ${using.join(', ')}. Change those teams first.`, 409);
  }
  signOutBeforeDelete(store.accounts[index]);
  const accountDir = path.join(getAccountsDir(), id);
  if (fs.existsSync(accountDir)) {
    unlinkLinksAndRemoveDir(accountDir);
    if (fs.existsSync(accountDir)) {
      fs.rmdirSync(accountDir);
    }
  }
  fs.rmSync(path.join(getAccountsDir(), '.sign-in', `${id}.command`), { force: true });
  const avatarDir = path.join(getAccountsDir(), '.avatars');
  for (const ext of AVATAR_EXTENSIONS) {
    try {
      const f = path.join(avatarDir, `${id}.${ext}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (err) {}
  }
  store.accounts.splice(index, 1);
  writeStore(store);
}

function saveAccount(account) {
  const store = readStore();
  if (account.system) {
    store.systemStatus[account.id] = account.status;
    if (account.limits !== undefined) {
      if (!store.systemLimits) store.systemLimits = {};
      store.systemLimits[account.id] = account.limits;
    }
    if (account.budget !== undefined) {
      if (!store.systemBudgets) store.systemBudgets = {};
      store.systemBudgets[account.id] = account.budget;
    }
  } else {
    const index = store.accounts.findIndex((a) => a.id === account.id);
    if (index === -1) return;
    store.accounts[index] = account;
  }
  writeStore(store);
}

const AVATAR_EXTENSIONS = ['png', 'jpg', 'webp'];
const AVATAR_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
};

function getAvatarFileInfo(id, isSystem) {
  const accountsDir = getAccountsDir();
  const dir = isSystem ? path.join(accountsDir, '.avatars') : path.join(accountsDir, id);
  if (!fs.existsSync(dir)) return null;
  const names = [
    ...AVATAR_EXTENSIONS.map((ext) => [isSystem ? `${id}.${ext}` : `avatar.${ext}`, ext]),
    ...AVATAR_EXTENSIONS.map((ext) => [isSystem ? `${id}.profile.${ext}` : `profile.${ext}`, ext])
  ];
  for (const [filename, ext] of names) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        return {
          path: fullPath,
          ext,
          contentType: AVATAR_MIME_TYPES[ext],
          mtimeMs: stat.mtimeMs
        };
      } catch (err) {}
    }
  }
  return null;
}

function getAvatarUrl(id, isSystem) {
  const info = getAvatarFileInfo(id, isSystem);
  return info ? `/api/accounts/${id}/avatar?v=${Math.floor(info.mtimeMs)}` : null;
}

function saveAvatar(id, dataUrl) {
  const account = getAccount(id);
  if (!account) {
    throw new AccountError(`Account "${id}" not found`, 404);
  }
  if (typeof dataUrl !== 'string') {
    throw new AccountError('Invalid image data URL', 400);
  }
  const match = dataUrl.trim().match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/s);
  if (!match) {
    throw new AccountError('Invalid image format (must be PNG, JPEG, or WebP base64 data URL)', 400);
  }
  const type = match[1];
  const ext = type === 'jpeg' ? 'jpg' : type;
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length === 0 || buf.length > 512 * 1024) {
    throw new AccountError('Image decoded size must be between 1 byte and 512 KB', 400);
  }

  if (type === 'png') {
    const isPng = buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
    if (!isPng) throw new AccountError('Image bytes do not match PNG signature', 400);
  } else if (type === 'jpeg') {
    const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (!isJpeg) throw new AccountError('Image bytes do not match JPEG signature', 400);
  } else if (type === 'webp') {
    const isWebp = buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isWebp) throw new AccountError('Image bytes do not match WebP signature', 400);
  }

  const accountsDir = getAccountsDir();
  const dir = account.system ? path.join(accountsDir, '.avatars') : path.join(accountsDir, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const e of AVATAR_EXTENSIONS) {
    const oldFile = path.join(dir, account.system ? `${id}.${e}` : `avatar.${e}`);
    try {
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    } catch (err) {}
  }

  const targetFile = path.join(dir, account.system ? `${id}.${ext}` : `avatar.${ext}`);
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, buf);
  fs.renameSync(tempFile, targetFile);
  return getAccount(id);
}

function imageExtension(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function saveProfilePicture(id, buf, ext) {
  const isSystem = Boolean(SYSTEM_ACCOUNTS_TEMPLATE[id]);
  if (!AVATAR_EXTENSIONS.includes(ext) || imageExtension(buf) !== ext || buf.length > 512 * 1024) return;
  const dir = isSystem ? path.join(getAccountsDir(), '.avatars') : path.join(getAccountsDir(), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const old of AVATAR_EXTENSIONS) fs.rmSync(path.join(dir, isSystem ? `${id}.profile.${old}` : `profile.${old}`), { force: true });
  const target = path.join(dir, isSystem ? `${id}.profile.${ext}` : `profile.${ext}`);
  fs.writeFileSync(`${target}.${process.pid}.tmp`, buf, { mode: 0o600 });
  fs.renameSync(`${target}.${process.pid}.tmp`, target);
}

function saveIdentity(id, identity) {
  const store = readStore();
  if (SYSTEM_ACCOUNTS_TEMPLATE[id]) {
    store.systemIdentities[id] = identity;
  } else {
    const account = store.accounts.find((a) => a.id === id);
    if (!account) return;
    account.identity = identity;
  }
  writeStore(store);
}

function deleteAvatar(id) {
  const account = getAccount(id);
  if (!account) {
    throw new AccountError(`Account "${id}" not found`, 404);
  }
  const accountsDir = getAccountsDir();
  const dir = account.system ? path.join(accountsDir, '.avatars') : path.join(accountsDir, id);
  for (const ext of AVATAR_EXTENSIONS) {
    const oldFile = path.join(dir, account.system ? `${id}.${ext}` : `avatar.${ext}`);
    try {
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    } catch (err) {}
  }
  return getAccount(id);
}

function setAccountBudget(id, budget) {
  const account = getAccount(id);
  if (!account) {
    throw new AccountError(`Account "${id}" not found`, 404);
  }
  if (budget !== null) {
    if (!budget || typeof budget !== 'object') {
      throw new AccountError('Invalid budget configuration', 400);
    }
    const { period, tokens, stop } = budget;
    if (!['day', 'week', 'month'].includes(period)) {
      throw new AccountError('Budget period must be day, week, or month', 400);
    }
    if (!Number.isInteger(tokens) || tokens < 1000) {
      throw new AccountError('Budget tokens must be an integer >= 1000', 400);
    }
    if (typeof stop !== 'boolean') {
      throw new AccountError('Budget stop must be a boolean', 400);
    }
    account.budget = { period, tokens, stop };
  } else {
    account.budget = null;
  }
  saveAccount(account);
  return getAccount(id);
}

function updateAccountLimits(id, limits) {
  const account = getAccount(id);
  if (!account) return null;
  account.limits = limits;
  saveAccount(account);
  return getAccount(id);
}

function credentialStamp(account) {
  if (account.provider !== 'codex') return null;
  const home = account.system ? (process.env.CODEX_HOME || path.join(getRealHome(), '.codex')) : accountFolder(account);
  try {
    return fs.statSync(path.join(home, 'auth.json')).mtimeMs;
  } catch (err) {
    return null;
  }
}

function markSignedOut(id, detail = 'Not signed in') {
  try {
    const account = getAccount(id);
    if (!account) return;
    account.status = {
      ...account.status,
      state: 'signed-out',
      detail,
      checkedAt: new Date().toISOString(),
      rejectedStamp: credentialStamp(account)
    };
    saveAccount(account);
  } catch (err) {}
}

function saveStatus(id, status) {
  const store = readStore();
  if (SYSTEM_ACCOUNTS_TEMPLATE[id]) {
    store.systemStatus[id] = status;
  } else {
    const account = store.accounts.find((a) => a.id === id);
    if (!account) return null;
    account.status = status;
  }
  writeStore(store);
  return getAccount(id);
}

const MODELS_TTL_MS = 10 * 60 * 1000;
const modelLists = new Map();
const modelGenerations = new Map();

function forgetModels(id) {
  modelGenerations.set(id, (modelGenerations.get(id) || 0) + 1);
  modelLists.delete(id);
}

function listModels(id, { refresh = false } = {}) {
  const account = getAccount(id);
  if (!account) return Promise.reject(new AccountError(`Account "${id}" not found`, 404));
  const cached = modelLists.get(id);
  if (cached && (cached.pending || (!refresh && Date.now() - cached.at < MODELS_TTL_MS))) return cached.pending || Promise.resolve(cached.value);
  if (account.apiKey) {
    const service = apiServices.getService(account.apiKey.service);
    const generation = modelGenerations.get(id) || 0;
    const pending = apiServices.checkKey(account, readApiKey(account)).then((result) => {
      const value = {
        account: id,
        provider: account.provider,
        models: service ? apiServices.modelsFrom(service, result.body).filter((model) => MODEL_PATTERN.test(model.id)) : [],
        source: service ? `${service.name} API` : 'API',
        fetchedAt: new Date().toISOString(),
        error: result.state === 'signed-in' ? null : result.detail
      };
      if ((modelGenerations.get(id) || 0) === generation) modelLists.set(id, { at: Date.now(), value });
      return value;
    });
    modelLists.set(id, { at: cached ? cached.at : 0, value: cached ? cached.value : null, pending });
    return pending;
  }
  const { modelsCommand, parseModels } = require('./providers');
  const command = modelsCommand(account.provider);
  const pending = new Promise((resolve) => {
    execFile(command.bin, command.args, { env: accountEnv(account), timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const models = parseModels(account.provider, stdout || '').filter((model) => MODEL_PATTERN.test(model.id));
      const value = {
        account: id,
        provider: account.provider,
        models,
        source: [path.basename(command.bin), ...command.args].join(' '),
        fetchedAt: new Date().toISOString(),
        error: models.length ? null : err && err.code === 'ENOENT' ? `${path.basename(command.bin)} is not installed` : 'No models listed. Is this account signed in?'
      };
      modelLists.set(id, { at: Date.now(), value });
      resolve(value);
    });
  });
  modelLists.set(id, { at: cached ? cached.at : 0, value: cached ? cached.value : null, pending });
  return pending;
}

async function checkApiAccount(account) {
  const result = await apiServices.checkKey(account, readApiKey(account));
  const status = { state: result.state, detail: result.detail, email: null, plan: null, checkedAt: new Date().toISOString(), warning: null };
  return saveStatus(account.id, status) || { ...account, status };
}

function checkAccount(id) {
  const apiAccount = getAccount(id);
  if (apiAccount && apiAccount.apiKey) return checkApiAccount(apiAccount);
  return new Promise((resolve, reject) => {
    const account = getAccount(id);
    if (!account) {
      return reject(new AccountError(`Account "${id}" not found`, 404));
    }
    const { bin, args } = statusCommand(account.provider);
    const env = accountEnv(account);
    const rejectedStamp = account.status && account.status.rejectedStamp;

    execFile(bin, args, { env, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const parsed = parseStatus(account.provider, {
        exitCode,
        stdout: stdout || '',
        stderr: stderr || ''
      });
      account.status = {
        state: parsed.state,
        detail: parsed.detail,
        email: parsed.email || null,
        plan: parsed.plan || null,
        checkedAt: new Date().toISOString(),
        warning: null
      };
      if (account.status.state === 'signed-in' && rejectedStamp != null && credentialStamp(account) === rejectedStamp) {
        account.status = {
          ...account.status,
          state: 'signed-out',
          detail: 'Codex rejected the stored sign-in when a task ran. Sign in again.',
          rejectedStamp
        };
      }
      if (!account.system && account.status.state === 'signed-in' && !account.signedInHere) {
        account.status.warning = 'Reports signed in although it was never signed in from a2a-panel, so it may be using your default sign-in.';
      }
      const current = saveStatus(account.id, account.status);
      if (!current) return resolve(account);
      if (current.status.state !== 'signed-in') return resolve(current);
      require('./identity').refreshIdentity(current).catch(() => null).then(() => resolve(getAccount(current.id) || current));
    });
  });
}

module.exports = {
  AccountError,
  saveIdentity,
  saveProfilePicture,
  imageExtension,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  setApiKey,
  deleteAccount,
  resolveAccount,
  accountEnv,
  listModels,
  accountOverrides,
  checkAccount,
  markSignedOut,
  ensureAgyHome,
  accountFolder,
  saveAccount,
  getAccountsDir,
  getRealHome,
  setAccountBudget,
  updateAccountLimits,
  getAvatarFileInfo,
  getAvatarUrl,
  saveAvatar,
  deleteAvatar
};
