const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { getAgentCard, buildTaskPrompt, runAgyTask, cancelTask, isTaskProcessLive, readUsageTotals, LOGS_DIR, TASK_ID_PATTERN } = require('./dispatcher');
const presets = require('./presets');
const accounts = require('./accounts');
const providers = require('./providers');
const accountLogin = require('./account-login');
const teams = require('./teams');
const { findProviderIcon } = require('./provider-icons');
const { PACKAGE_ROOT } = require('./config');
const updates = require('./updates');
const settings = require('./settings');
const telegram = require('./telegram');
const apiServices = require('./api-services');

const BASE_PATH = '/dashboard';
const DIST_DIR = path.join(PACKAGE_ROOT, 'panel', 'dist');
const TOKEN_PLACEHOLDER = '__A2A_TOKEN__';
const LEGACY_STALE_MS = 12 * 60 * 60 * 1000;
const FINISH_GRACE_MS = 10000;
const HEAD_BYTES = 16000;
const DETAIL_HEAD_BYTES = 80000;
const TAIL_BYTES = 6000;
const MAX_TASKS = 200;
const MAX_PROMPT_LENGTH = 20000;
const MAX_BODY_BYTES = 1024 * 1024;
const LOG_SEPARATOR = '--------------------------------------------------';
const MODES = ['accept-edits', 'plan'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const START_TIME = Date.now();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readHead(full, bytes) {
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(full, bytes) {
  const stat = fs.statSync(full);
  const fd = fs.openSync(full, 'r');
  try {
    const len = Math.min(bytes, stat.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function pidFile(id) {
  return path.join(LOGS_DIR, `${id}.pid`);
}

function cancelMarker(id) {
  return path.join(LOGS_DIR, `${id}.cancelled`);
}

function isAlive(id) {
  if (!fs.existsSync(pidFile(id))) return true;
  const pid = parseInt(fs.readFileSync(pidFile(id), 'utf-8'), 10);
  if (!pid) return false;
  return isTaskProcessLive(id, pid);
}

function extractPrompt(head) {
  const start = head.indexOf('Prompt:\n');
  if (start === -1) return '';
  const rest = head.slice(start + 'Prompt:\n'.length);
  const end = rest.indexOf(`\n${LOG_SEPARATOR}\n`);
  const body = end === -1 ? rest : rest.slice(0, end);
  const marker = body.indexOf('### TASK\n');
  return marker === -1 ? body : body.slice(marker + '### TASK\n'.length);
}

function parseLog(id, headBytes = HEAD_BYTES) {
  const full = path.join(LOGS_DIR, `${id}.log`);
  const stat = fs.statSync(full);
  const head = readHead(full, headBytes);
  const grab = (re) => (head.match(re) || [])[1] || '';
  const tail = readTail(full, 1500);
  const finished = tail.match(/=== TASK FINISHED: Exit code (\S+) \((\w+)\) ===/);
  const hasPid = fs.existsSync(pidFile(id));
  const cancelRequested = fs.existsSync(cancelMarker(id));

  let status = 'running';
  if (finished) status = finished[2];
  else if (!isAlive(id)) status = Date.now() - stat.mtimeMs < FINISH_GRACE_MS ? 'running' : 'stale';
  else if (!hasPid && Date.now() - stat.mtimeMs > LEGACY_STALE_MS) status = 'stale';
  if (cancelRequested && (status === 'failed' || status === 'stale')) status = 'cancelled';

  const startedAt = grab(/^Started: (.*)$/m);
  const finishedAt = status === 'running' ? null : new Date(stat.mtimeMs).toISOString();
  const endMs = finishedAt ? Date.parse(finishedAt) : Date.now();
  const startMs = Date.parse(startedAt);
  const errorMatch = tail.match(/\[A2A\] Marked failed: (.*)/) || tail.match(/\[TASK ERROR\]: (.*)/);

  return {
    id,
    role: grab(/^Role: (.*)$/m),
    account: grab(/^Account: (.*)$/m) || null,
    provider: grab(/^Provider: (.*)$/m) || null,
    workspace: grab(/^Workspace: (.*)$/m),
    preset: ['', 'none'].includes(grab(/^Preset: (.*)$/m)) ? null : grab(/^Preset: (.*)$/m),
    preferences: ['', 'none'].includes(grab(/^Preferences: (.*)$/m)) ? [] : grab(/^Preferences: (.*)$/m).split(', '),
    startedAt,
    finishedAt,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    durationMs: Number.isNaN(startMs) ? null : Math.max(0, endMs - startMs),
    status,
    exitCode: finished ? finished[1] : null,
    sizeBytes: stat.size,
    cancellable: status === 'running' && hasPid,
    cancelRequested,
    error: errorMatch ? errorMatch[1].trim() : null,
    prompt: extractPrompt(head)
  };
}

function toSummary(task) {
  const { prompt, ...rest } = task;
  return { ...rest, promptPreview: prompt.replace(/\s+/g, ' ').slice(0, 160) };
}

const summaryCache = new Map();
const RUNNING_SUMMARY_TTL_MS = 1000;

function cachedSummary(id, names) {
  const stat = fs.statSync(path.join(LOGS_DIR, `${id}.log`));
  const key = `${stat.mtimeMs}:${stat.size}:${names.has(`${id}.pid`) ? 1 : 0}:${names.has(`${id}.cancelled`) ? 1 : 0}`;
  const hit = summaryCache.get(id);
  if (hit && hit.key === key && (hit.summary.status !== 'running' || Date.now() - hit.at < RUNNING_SUMMARY_TTL_MS)) return hit.summary;
  const summary = toSummary(parseLog(id));
  summaryCache.set(id, { key, summary, at: Date.now() });
  return summary;
}

function listTasks() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const names = new Set(fs.readdirSync(LOGS_DIR));
  const ids = [...names].filter((f) => /^a2a_[\w-]+\.log$/.test(f)).map((f) => f.replace(/\.log$/, ''));
  for (const id of summaryCache.keys()) if (!names.has(`${id}.log`)) summaryCache.delete(id);
  return ids
    .map((id) => {
      try {
        return cachedSummary(id, names);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_TASKS);
}

function recentWorkspaces(tasks) {
  const seen = new Set();
  for (const task of tasks) {
    if (task.workspace && !seen.has(task.workspace) && fs.existsSync(task.workspace)) seen.add(task.workspace);
    if (seen.size >= 10) break;
  }
  return Array.from(seen);
}

function listRoles() {
  return (getAgentCard().skills || []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags || []
  }));
}

function validateDispatch(body) {
  const roles = listRoles().map((r) => r.id);
  if (typeof body.role !== 'string' || !roles.includes(body.role)) return 'Unknown role';
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return 'Prompt is required';
  if (body.prompt.trim().startsWith('--')) return 'Prompt must not start with "--"';
  if (body.prompt.length > MAX_PROMPT_LENGTH) return `Prompt is longer than ${MAX_PROMPT_LENGTH} characters`;
  if (typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace)) return 'Workspace must be an absolute path';
  let stat;
  try {
    stat = fs.statSync(body.workspace);
  } catch (err) {
    return 'Workspace does not exist';
  }
  if (!stat.isDirectory()) return 'Workspace is not a directory';
  if (body.mode !== undefined && !MODES.includes(body.mode)) return 'Unsupported mode';
  if (body.effort !== undefined && !EFFORTS.includes(body.effort)) return 'Unsupported effort';
  if (body.preset !== undefined && body.preset !== null && typeof body.preset !== 'string') return 'preset must be a preset id, or null for none';
  if (body.account !== undefined && body.account !== null) {
    if (typeof body.account !== 'string' || !accounts.getAccount(body.account)) return 'Unknown account';
  }
  return null;
}

function startTask(body) {
  const problem = validateDispatch(body);
  if (problem) throw new Error(problem);
  return runAgyTask({
    role: body.role,
    prompt: body.prompt,
    workspace: body.workspace,
    mode: body.mode || 'accept-edits',
    effort: body.effort || 'high',
    model: body.model,
    conversation_id: body.conversation_id,
    preset: body.preset,
    account: body.account
  });
}

async function dispatch(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  try {
    const { taskId } = startTask(body);
    return sendJson(res, 202, { taskId, status: 'running' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
}

async function previewPrompt(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (typeof body.role !== 'string' || !listRoles().some((r) => r.id === body.role)) return sendJson(res, 400, { error: 'Unknown role' });
  const workspace = typeof body.workspace === 'string' && path.isAbsolute(body.workspace) && fs.existsSync(body.workspace) ? body.workspace : null;
  try {
    const { finalPrompt, preferences } = buildTaskPrompt({
      role: body.role,
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : '(your task)',
      workspace,
      preset: body.preset
    });
    return sendJson(res, 200, {
      prompt: finalPrompt,
      preset: preferences.presetId,
      files: preferences.files.map((file) => ({ name: file.name, source: file.source }))
    });
  } catch (err) {
    return sendJson(res, err.code === 404 ? 404 : 400, { error: err.message });
  }
}

async function handleTelegram(req, res, method, pathname) {
  const fail = (err) => sendJson(res, err instanceof telegram.TelegramError ? err.code : err.message === 'Payload too large' || err.message === 'Invalid JSON' ? 400 : 500, { error: err.message });

  if (method === 'GET' && pathname === '/api/telegram/status') {
    sendJson(res, 200, { status: telegram.getStatus(), commands: telegram.COMMANDS.map(([command, description]) => ({ command, description })) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/telegram/test') {
    try {
      const body = await readJson(req);
      sendJson(res, 200, await telegram.test({ token: body.token || undefined, chatId: body.chatId || undefined }));
    } catch (err) {
      fail(err);
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/telegram/discover') {
    try {
      const body = await readJson(req);
      sendJson(res, 200, await telegram.discoverChats({ token: body.token || undefined }));
    } catch (err) {
      fail(err);
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/telegram/send') {
    try {
      const body = await readJson(req);
      sendJson(res, 200, await telegram.notifyUser({ text: body.text, choices: body.choices }));
    } catch (err) {
      fail(err);
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/telegram/inbox/wait') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      fail(err);
      return true;
    }
    const seconds = Number(body.timeoutSeconds);
    const timeoutMs = Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : 300, 3600) * 1000;
    let cancel = null;
    const gone = () => {
      if (cancel) cancel();
    };
    res.on('close', gone);
    const messages = await telegram.waitForUser({ timeoutMs, onRegister: (fn) => { cancel = fn; } });
    if (res.destroyed || res.writableEnded) telegram.requeue(messages);
    else sendJson(res, 200, { messages, status: telegram.getStatus() });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

// /api/presets[/:id[/default]]
async function handlePresets(req, res, method, pathname) {
  const match = pathname.match(/^\/api\/presets(?:\/([\w-]+)(?:\/(default))?)?$/);
  if (!match) return false;
  const [, id, action] = match;
  const run = async (fn) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof presets.PresetError) return sendJson(res, err.code, { error: err.message });
      return sendJson(res, err.message === 'Payload too large' || err.message === 'Invalid JSON' ? 400 : 500, { error: err.message });
    }
  };

  if (!id && method === 'GET') {
    await run(() => sendJson(res, 200, { presets: presets.listPresets(), templates: presets.listTemplates(), defaultPreset: presets.getDefaultPresetId() }));
    return true;
  }
  if (!id && method === 'POST') {
    await run(async () => sendJson(res, 201, { preset: presets.createPreset(await readJson(req)) }));
    return true;
  }
  if (id && action === 'default' && (method === 'POST' || method === 'DELETE')) {
    await run(() => {
      if (method === 'POST') presets.setDefaultPresetId(id);
      else if (presets.getDefaultPresetId() === id) presets.setDefaultPresetId(null);
      sendJson(res, 200, { defaultPreset: presets.getDefaultPresetId() });
    });
    return true;
  }
  if (id && !action && method === 'GET') {
    await run(() => sendJson(res, 200, { preset: presets.getPreset(id) }));
    return true;
  }
  if (id && !action && method === 'PUT') {
    await run(async () => sendJson(res, 200, { preset: presets.updatePreset(id, await readJson(req)) }));
    return true;
  }
  if (id && !action && method === 'DELETE') {
    await run(() => {
      presets.deletePreset(id);
      sendJson(res, 200, { deleted: id });
    });
    return true;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

function decorateAccount(acc) {
  const { getBudgetUsed, accountUsageTotals } = require('./usage');
  const u = accountUsageTotals(acc);
  return {
    ...acc,
    system: Boolean(acc.system),
    usage: { tasks: u.tasks, total_tokens: u.total_tokens },
    budget: acc.budget || null,
    limits: acc.limits || null,
    budgetUsed: acc.budget ? getBudgetUsed(acc) : null,
    avatarUrl: acc.avatarUrl || null,
    apiKey: acc.apiKey ? { ...acc.apiKey, serviceName: (apiServices.getService(acc.apiKey.service) || { name: acc.apiKey.service }).name } : null
  };
}

async function handleAccounts(req, res, method, pathname) {
  if (!pathname.startsWith('/api/accounts')) return false;

  const run = async (fn) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof accounts.AccountError) return sendJson(res, err.code, { error: err.message });
      return sendJson(res, err.message === 'Payload too large' || err.message === 'Invalid JSON' ? 400 : 500, { error: err.message });
    }
  };

  const loginMatch = pathname.match(/^\/api\/accounts\/logins\/([\w-]+)(?:\/(code|cancel))?$/);
  if (loginMatch) {
    const [, loginId, action] = loginMatch;
    if (method === 'GET' && !action) {
      await run(() => {
        const login = accountLogin.getLogin(loginId);
        if (!login) return sendJson(res, 404, { error: 'Login session not found' });
        sendJson(res, 200, { login });
      });
      return true;
    }
    if (method === 'POST' && action === 'code') {
      await run(async () => {
        const body = await readJson(req);
        const login = accountLogin.submitCode(loginId, body.code);
        sendJson(res, 200, { login });
      });
      return true;
    }
    if (method === 'POST' && action === 'cancel') {
      await run(() => {
        const login = accountLogin.cancelLogin(loginId);
        sendJson(res, 200, { login });
      });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const avatarMatch = pathname.match(/^\/api\/accounts\/([\w-]+)\/avatar$/);
  if (avatarMatch) {
    const [, targetId] = avatarMatch;
    if (method === 'GET') {
      const account = accounts.getAccount(targetId);
      if (!account) return sendJson(res, 404, { error: 'Account not found' });
      const info = accounts.getAvatarFileInfo(targetId, Boolean(account.system));
      if (!info) return sendJson(res, 404, { error: 'No avatar found' });
      try {
        const bytes = fs.readFileSync(info.path);
        res.writeHead(200, {
          'Content-Type': info.contentType,
          'Content-Length': bytes.length,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Cache-Control': 'no-cache'
        });
        res.end(bytes);
      } catch (err) {
        return sendJson(res, 404, { error: 'Could not read avatar' });
      }
      return true;
    }
    if (method === 'PUT') {
      await run(async () => {
        const body = await readJson(req);
        if (!body || typeof body.image !== 'string') {
          return sendJson(res, 400, { error: 'Missing image data URL' });
        }
        const updated = accounts.saveAvatar(targetId, body.image);
        sendJson(res, 200, { account: decorateAccount(updated) });
      });
      return true;
    }
    if (method === 'DELETE') {
      await run(() => {
        const updated = accounts.deleteAvatar(targetId);
        sendJson(res, 200, { account: decorateAccount(updated) });
      });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const budgetMatch = pathname.match(/^\/api\/accounts\/([\w-]+)\/budget$/);
  if (budgetMatch) {
    const [, targetId] = budgetMatch;
    if (method === 'PUT') {
      await run(async () => {
        const body = await readJson(req);
        if (!body || typeof body !== 'object') {
          return sendJson(res, 400, { error: 'Invalid request body' });
        }
        const { period, tokens, stop } = body;
        if (!['day', 'week', 'month'].includes(period)) {
          return sendJson(res, 400, { error: 'Period must be day, week, or month' });
        }
        if (!Number.isInteger(tokens) || tokens < 1000) {
          return sendJson(res, 400, { error: 'Tokens must be an integer >= 1000' });
        }
        if (typeof stop !== 'boolean') {
          return sendJson(res, 400, { error: 'Stop must be a boolean' });
        }
        const updated = accounts.setAccountBudget(targetId, { period, tokens, stop });
        sendJson(res, 200, { account: decorateAccount(updated) });
      });
      return true;
    }
    if (method === 'DELETE') {
      await run(() => {
        const updated = accounts.setAccountBudget(targetId, null);
        sendJson(res, 200, { account: decorateAccount(updated) });
      });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const accountMatch = pathname.match(/^\/api\/accounts(?:\/([\w-]+)(?:\/(check|login|logout|models|api-key))?)?$/);
  if (!accountMatch) return false;
  const [, id, action] = accountMatch;

  if (!id && method === 'GET') {
    await run(() => {
      const accs = accounts.listAccounts().map(decorateAccount);
      const provs = Object.values(providers.PROVIDERS).map((p) => {
        const bin = providers.resolveBin(p.id);
        let installed = false;
        try {
          fs.accessSync(bin, fs.constants.X_OK);
          installed = true;
        } catch (err) {}
        const icon = findProviderIcon(p.id);
        return {
          id: p.id,
          name: p.name,
          installed,
          bin,
          loginMethods: p.loginMethods,
          canLogout: p.canLogout,
          iconUrl: icon ? `/api/providers/${p.id}/icon` : null
        };
      });
      sendJson(res, 200, { accounts: accs, providers: provs });
    });
    return true;
  }

  if (!id && method === 'POST') {
    await run(async () => {
      const body = await readJson(req);
      const account = accounts.createAccount(body);
      const checked = account.apiKey ? await accounts.checkAccount(account.id).catch(() => account) : account;
      sendJson(res, 201, { account: decorateAccount(checked) });
    });
    return true;
  }

  if (id && action === 'api-key' && method === 'PUT') {
    await run(async () => {
      const body = await readJson(req);
      const account = accounts.setApiKey(id, body);
      const checked = await accounts.checkAccount(account.id).catch(() => account);
      sendJson(res, 200, { account: decorateAccount(checked) });
    });
    return true;
  }

  if (id && !action && method === 'PUT') {
    await run(async () => {
      const body = await readJson(req);
      const account = accounts.updateAccount(id, body);
      sendJson(res, 200, { account: decorateAccount(account) });
    });
    return true;
  }

  if (id && !action && method === 'DELETE') {
    await run(() => {
      accounts.deleteAccount(id);
      sendJson(res, 200, { deleted: id });
    });
    return true;
  }

  if (id && action === 'models' && method === 'GET') {
    await run(async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      sendJson(res, 200, await accounts.listModels(id, { refresh: url.searchParams.get('refresh') === '1' }));
    });
    return true;
  }

  if (id && action === 'check' && method === 'POST') {
    await run(async () => {
      const account = await accounts.checkAccount(id);
      sendJson(res, 200, { account: decorateAccount(account) });
    });
    return true;
  }

  if (id && action === 'login' && method === 'POST') {
    await run(async () => {
      const body = await readJson(req);
      const login = accountLogin.startLogin(id, body.method);
      sendJson(res, 202, { login });
    });
    return true;
  }

  if (id && action === 'logout' && method === 'POST') {
    await run(async () => {
      const account = accounts.getAccount(id);
      if (!account) return sendJson(res, 404, { error: `Account "${id}" not found` });
      if (account.apiKey) return sendJson(res, 400, { error: 'This account uses an API key. Delete the account, or replace the key with Change key.' });
      if (account.provider === 'agy') {
        return sendJson(res, 400, { error: 'Antigravity has no sign-out command; delete the account to remove its sign-in' });
      }
      const args = providers.logoutArgs(account.provider);
      const bin = providers.resolveBin(account.provider);
      const failure = await new Promise((resolve) => {
        execFile(bin, args, { env: accounts.accountEnv(account), timeout: 30000 }, (err, stdout, stderr) => {
          resolve(err ? (String(stderr || '').trim().split('\n').pop() || err.message) : null);
        });
      });
      if (failure) return sendJson(res, 502, { error: `Sign-out failed: ${failure}` });
      accounts.markSignedOut(id, 'Logged out');
      sendJson(res, 200, { account: decorateAccount(accounts.getAccount(id)) });
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

async function handleTeams(req, res, method, pathname) {
  if (!pathname.startsWith('/api/teams')) return false;

  const run = async (fn) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof teams.TeamError) return sendJson(res, err.code, { error: err.message });
      return sendJson(res, err.message === 'Payload too large' || err.message === 'Invalid JSON' ? 400 : 500, { error: err.message });
    }
  };

  const runsMatch = pathname.match(/^\/api\/teams\/([\w-]+)\/runs$/);
  if (runsMatch) {
    const [, teamId] = runsMatch;
    if (method === 'POST') {
      await run(async () => {
        const body = await readJson(req);
        const teamRun = teams.startRun({ ...body, teamId });
        sendJson(res, 202, { run: teamRun });
      });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const teamMatch = pathname.match(/^\/api\/teams(?:\/([\w-]+))?$/);
  if (!teamMatch) return false;
  const [, id] = teamMatch;

  if (!id && method === 'GET') {
    await run(() => sendJson(res, 200, { teams: teams.listTeams() }));
    return true;
  }

  if (!id && method === 'POST') {
    await run(async () => {
      const body = await readJson(req);
      const team = teams.createTeam(body);
      sendJson(res, 201, { team });
    });
    return true;
  }

  if (id && method === 'GET') {
    await run(() => sendJson(res, 200, { team: teams.getTeam(id) }));
    return true;
  }

  if (id && method === 'PUT') {
    await run(async () => {
      const body = await readJson(req);
      const team = teams.updateTeam(id, body);
      sendJson(res, 200, { team });
    });
    return true;
  }

  if (id && method === 'DELETE') {
    await run(() => {
      teams.deleteTeam(id);
      sendJson(res, 200, { deleted: id });
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

async function handleTeamRuns(req, res, method, pathname) {
  if (!pathname.startsWith('/api/team-runs')) return false;

  const run = async (fn) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof teams.TeamError) return sendJson(res, err.code, { error: err.message });
      return sendJson(res, err.message === 'Payload too large' || err.message === 'Invalid JSON' ? 400 : 500, { error: err.message });
    }
  };

  const runMatch = pathname.match(/^\/api\/team-runs(?:\/([\w-]+)(?:\/(execute|cancel))?)?$/);
  if (!runMatch) return false;
  const [, runId, action] = runMatch;

  if (!runId && method === 'GET') {
    await run(() => {
      let teamId = undefined;
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        teamId = parsed.searchParams.get('team') || undefined;
      } catch (err) {}
      const runs = teams.listRuns({ teamId, limit: 50 });
      sendJson(res, 200, { runs });
    });
    return true;
  }

  if (runId && !action && method === 'GET') {
    await run(() => {
      const teamRun = teams.getRun(runId);
      sendJson(res, 200, { run: teamRun });
    });
    return true;
  }

  if (runId && action === 'execute' && method === 'POST') {
    await run(() => {
      const teamRun = teams.executeRun(runId);
      sendJson(res, 200, { run: teamRun });
    });
    return true;
  }

  if (runId && action === 'cancel' && method === 'POST') {
    await run(() => {
      const teamRun = teams.cancelRun(runId);
      sendJson(res, 200, { run: teamRun });
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

const LOG_TRUNCATED = '[... earlier output truncated ...]\n';

function completeUtf8End(buf) {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const byte = buf[buf.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

function readLogChunk(full, from) {
  const size = fs.statSync(full).size;
  const limit = TAIL_BYTES * 5;
  const reset = !(Number.isInteger(from) && from >= 0 && from <= size && size - from <= limit);
  if (!reset && from === size) return { reset: false, next: size, text: '' };
  const start = reset ? Math.max(0, size - limit) : from;
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(full, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let skip = 0;
  if (reset && start > 0) while (skip < buf.length && skip < 3 && (buf[skip] & 0xc0) === 0x80) skip++;
  const end = completeUtf8End(buf);
  const text = buf.subarray(skip, Math.max(skip, end)).toString('utf-8');
  return { reset, next: start + Math.max(skip, end), text: reset && start > 0 ? LOG_TRUNCATED + text : text };
}

function serveTaskLog(res, id, query) {
  const full = path.join(LOGS_DIR, `${id}.log`);
  if (!fs.existsSync(full)) return sendText(res, 404, 'Not found');
  if (query.has('from')) return sendJson(res, 200, readLogChunk(full, Number(query.get('from'))));
  return sendText(res, 200, readLogChunk(full, -1).text);
}

function serveStatic(res, pathname, token) {
  const relative = pathname.slice(BASE_PATH.length).replace(/^\/+/, '');
  const resolved = path.resolve(DIST_DIR, relative || 'index.html');
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) return sendText(res, 403, 'Forbidden');

  let target = resolved;
  const exists = fs.existsSync(target) && fs.statSync(target).isFile();
  if (!exists) {
    if (path.extname(relative)) return sendText(res, 404, 'Not found');
    target = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(target)) {
    return sendText(res, 503, 'Panel is not built. Run: npm run build:panel');
  }

  const type = MIME_TYPES[path.extname(target)] || 'application/octet-stream';
  if (path.basename(target) === 'index.html') {
    const html = fs.readFileSync(target, 'utf-8').split(TOKEN_PLACEHOLDER).join(token);
    res.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  const immutable = relative.startsWith('assets/');
  res.writeHead(200, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  const stream = fs.createReadStream(target);
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
}

const eventClients = new Set();
let watcherTimer = null;
let lastTasksStamp = '';
let lastTaskPrints = new Map();
let lastTasksList = [];
let lastUsageStamp = '';
let lastTeamsStamp = '';
let pingTicks = 0;

function writeClient(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(payload);
  } catch (err) {}
}

function broadcastRaw(payload) {
  for (const client of eventClients) {
    writeClient(client.res, payload);
  }
}

function broadcastEvent(name, data) {
  broadcastRaw(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function getTasksStamp() {
  if (!fs.existsSync(LOGS_DIR)) return '';
  try {
    const entries = fs.readdirSync(LOGS_DIR)
      .filter((name) => /^a2a_[\w-]+\.(log|pid|cancelled|verify)$/.test(name))
      .sort();
    return entries.map((name) => {
      try {
        const s = fs.statSync(path.join(LOGS_DIR, name));
        return `${name}:${s.mtimeMs}:${s.size}`;
      } catch (err) {
        return '';
      }
    }).join(';');
  } catch (err) {
    return '';
  }
}

const PROGRESS_INTERVAL_MS = 5000;

function taskPrints(tasks) {
  return new Map(tasks.map((t) => [t.id, {
    state: JSON.stringify(t.status === 'running' ? { ...t, durationMs: null, updatedAt: null, sizeBytes: null } : t),
    full: JSON.stringify(t.status === 'running' ? { ...t, durationMs: null } : t),
    sentAt: 0
  }]));
}

const logClients = new Set();

function sendLogChunk(client, always = false) {
  let chunk;
  try {
    chunk = readLogChunk(path.join(LOGS_DIR, `${client.id}.log`), client.next);
  } catch (err) {
    return;
  }
  if (!always && !chunk.reset && !chunk.text) return;
  client.next = chunk.next;
  writeClient(client.res, `id: ${chunk.next}\nevent: log\ndata: ${JSON.stringify(chunk)}\n\n`);
}

function handleLogStream(req, res, id, query) {
  if (!fs.existsSync(path.join(LOGS_DIR, `${id}.log`))) return sendJson(res, 404, { error: 'Task not found' });
  if (logClients.size >= 16) return sendJson(res, 503, { error: 'Too many log streams' });
  const lastEventId = req.headers['last-event-id'];
  const from = Number(lastEventId !== undefined && lastEventId !== '' ? lastEventId : query.get('from'));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff'
  });
  writeClient(res, 'retry: 3000\n\n');
  const client = { id, res, next: from };
  sendLogChunk(client, true);
  logClients.add(client);
  syncWatcher();
  res.on('close', () => {
    logClients.delete(client);
    syncWatcher();
  });
}

function getUsageStamp() {
  const usageFile = path.join(LOGS_DIR, 'usage.jsonl');
  try {
    const s = fs.statSync(usageFile);
    return `${s.mtimeMs}:${s.size}`;
  } catch (err) {
    return 'none';
  }
}

function dirJsonStamp(dir) {
  if (!fs.existsSync(dir)) return '';
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp'))
      .sort();
    return files.map((name) => {
      try {
        const s = fs.statSync(path.join(dir, name));
        return `${name}:${s.mtimeMs}:${s.size}`;
      } catch (err) {
        return '';
      }
    }).join(';');
  } catch (err) {
    return '';
  }
}

function getTeamsStamp() {
  return `${dirJsonStamp(teams.getTeamsDir())}|${dirJsonStamp(teams.getRunsDir())}`;
}

function watcherTick() {
  pingTicks++;
  if (pingTicks >= 17) {
    pingTicks = 0;
    broadcastRaw(': ping\n\n');
  }

  const currentTasksStamp = getTasksStamp();
  const hasRunning = lastTasksList.some((t) => t.status === 'running');
  if (currentTasksStamp !== lastTasksStamp || hasRunning) {
    lastTasksStamp = currentTasksStamp;
    const currentTasks = listTasks();
    const prints = taskPrints(currentTasks);
    const now = Date.now();
    const changed = [];
    const nextPrints = new Map();
    for (const task of currentTasks) {
      const before = lastTaskPrints.get(task.id);
      const next = prints.get(task.id);
      const progressDue = before && before.full !== next.full && now - before.sentAt >= PROGRESS_INTERVAL_MS;
      if (!before || before.state !== next.state || progressDue) {
        changed.push(task);
        nextPrints.set(task.id, { ...next, sentAt: now });
      } else {
        nextPrints.set(task.id, before);
      }
    }
    const removed = [...lastTaskPrints.keys()].filter((id) => !prints.has(id));
    lastTaskPrints = nextPrints;
    lastTasksList = currentTasks;
    if (changed.length || removed.length) broadcastEvent('tasks', { tasks: changed, removed, full: false });
    if (changed.length) telegram.tasksChanged(changed);
  }

  for (const client of logClients) sendLogChunk(client);

  const currentUsageStamp = getUsageStamp();
  if (currentUsageStamp !== lastUsageStamp) {
    lastUsageStamp = currentUsageStamp;
    broadcastEvent('usage', {});
  }

  const currentTeamsStamp = getTeamsStamp();
  if (currentTeamsStamp !== lastTeamsStamp) {
    lastTeamsStamp = currentTeamsStamp;
    broadcastEvent('teams', {});
    telegram.runsChanged();
  }
}

function startWatcher() {
  if (watcherTimer) return;
  lastTasksStamp = getTasksStamp();
  lastTasksList = listTasks();
  lastTaskPrints = taskPrints(lastTasksList);
  lastUsageStamp = getUsageStamp();
  lastTeamsStamp = getTeamsStamp();
  pingTicks = 0;
  watcherTimer = setInterval(watcherTick, 1500);
  if (watcherTimer.unref) watcherTimer.unref();
}

function stopWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

function syncWatcher() {
  if (eventClients.size > 0 || logClients.size > 0 || telegram.isActive()) startWatcher();
  else stopWatcher();
}

telegram.connect({
  listTasks,
  startTask,
  cancelTask,
  readLogTail: (id, chars) => {
    const full = path.join(LOGS_DIR, `${id}.log`);
    return fs.existsSync(full) ? readTail(full, chars + 4).replace(/^\uFFFD+/, '') : '';
  }
});

telegram.onStatusChange((status) => {
  syncWatcher();
  broadcastEvent('telegram', status);
});

accountLogin.onLoginChange((evt) => {
  broadcastEvent('login', { id: evt.id, state: evt.state });
});

updates.onUpdateChange((info) => {
  broadcastEvent('version', info);
});

function handleEvents(req, res) {
  const maxClients = Number(process.env.A2A_MAX_EVENT_CLIENTS) || 32;
  if (eventClients.size >= maxClients) {
    sendJson(res, 503, { error: 'Too many event streams' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff'
  });
  writeClient(res, 'retry: 3000\n\n');
  const helloData = {
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    pid: process.pid,
    version: updates.versionInfo().current
  };
  writeClient(res, `event: hello\ndata: ${JSON.stringify(helloData)}\n\n`);
  writeClient(res, `event: tasks\ndata: ${JSON.stringify({ tasks: listTasks(), removed: [], full: true })}\n\n`);
  writeClient(res, `event: teams\ndata: {}\n\n`);
  writeClient(res, `event: usage\ndata: {}\n\n`);
  updates.checkForUpdate().then((info) => writeClient(res, `event: version\ndata: ${JSON.stringify(info)}\n\n`)).catch(() => {});

  const client = { req, res };
  eventClients.add(client);
  syncWatcher();

  const cleanup = () => {
    if (!eventClients.has(client)) return;
    eventClients.delete(client);
    syncWatcher();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

async function handle(req, res, pathname, { token }) {
  const method = req.method;

  if (method === 'GET' && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) {
    serveStatic(res, pathname, token);
    return true;
  }

  if (!pathname.startsWith('/api/')) return false;

  if (method === 'GET' && pathname === '/api/events') {
    handleEvents(req, res);
    return true;
  }

  if (method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, { settings: settings.describe() });
    return true;
  }

  if (method === 'PUT' && pathname === '/api/settings') {
    try {
      const body = await readJson(req);
      const described = settings.update(body && body.values);
      telegram.reconfigure();
      broadcastEvent('settings', {});
      sendJson(res, 200, { settings: described });
    } catch (err) {
      sendJson(res, err instanceof settings.SettingsError ? err.code : 400, { error: err.message });
    }
    return true;
  }

  if (pathname.startsWith('/api/telegram/')) {
    if (await handleTelegram(req, res, method, pathname)) return true;
  }

  if (method === 'GET' && pathname === '/api/version') {
    const url = new URL(req.url, 'http://127.0.0.1');
    sendJson(res, 200, await updates.checkForUpdate({ force: url.searchParams.get('refresh') === '1' }));
    return true;
  }

  if (method === 'POST' && pathname === '/api/update') {
    try {
      sendJson(res, 202, await updates.startUpdate());
    } catch (err) {
      sendJson(res, err instanceof updates.UpdateError ? err.code : 500, { error: err.message });
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/health') {
    const tasks = listTasks();
    sendJson(res, 200, {
      status: 'healthy',
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      running: tasks.filter((t) => t.status === 'running').length,
      pid: process.pid
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/roles') {
    sendJson(res, 200, { roles: listRoles(), modes: MODES, efforts: EFFORTS });
    return true;
  }

  if (method === 'GET' && pathname === '/api/usage/accounts') {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const daysParam = url.searchParams.get('days');
    let days = 30;
    if (daysParam !== null) {
      const parsed = parseInt(daysParam, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90 || String(parsed) !== daysParam.trim()) {
        sendJson(res, 400, { error: 'Invalid days parameter (must be an integer 1..90)' });
        return true;
      }
      days = parsed;
    }
    const { getAccountsUsageReport } = require('./usage');
    sendJson(res, 200, getAccountsUsageReport(days));
    return true;
  }

  if (method === 'GET' && pathname === '/api/usage') {
    sendJson(res, 200, readUsageTotals());
    return true;
  }

  if (method === 'GET' && pathname === '/api/workspaces') {
    sendJson(res, 200, { workspaces: recentWorkspaces(listTasks()) });
    return true;
  }

  if (method === 'GET' && pathname === '/api/tasks') {
    sendJson(res, 200, { tasks: listTasks() });
    return true;
  }

  if (method === 'POST' && pathname === '/api/tasks') {
    await dispatch(req, res);
    return true;
  }

  if (method === 'POST' && pathname === '/api/prompt-preview') {
    await previewPrompt(req, res);
    return true;
  }

  if (pathname === '/api/presets' || pathname.startsWith('/api/presets/')) {
    if (await handlePresets(req, res, method, pathname)) return true;
  }

  if (pathname === '/api/accounts' || pathname.startsWith('/api/accounts/')) {
    if (await handleAccounts(req, res, method, pathname)) return true;
  }

  const iconMatch = pathname.match(/^\/api\/providers\/([\w-]+)\/icon$/);
  if (iconMatch) {
    const [, id] = iconMatch;
    if (method !== 'GET' || !['agy', 'claude', 'codex'].includes(id)) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    const icon = findProviderIcon(id);
    if (!icon) {
      sendJson(res, 404, { error: 'Icon not found' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': icon.contentType,
      'Content-Length': icon.data.length,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'max-age=3600'
    });
    res.end(icon.data);
    return true;
  }

  if (method === 'GET' && pathname === '/api/api-services') {
    sendJson(res, 200, { services: apiServices.listServices() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/team-templates') {
    sendJson(res, 200, { templates: teams.listTeamTemplates() });
    return true;
  }

  const templateDraft = pathname.match(/^\/api\/team-templates\/([\w-]+)\/draft$/);
  if (method === 'GET' && templateDraft) {
    try {
      sendJson(res, 200, { team: teams.draftFromTemplate(templateDraft[1]) });
    } catch (err) {
      sendJson(res, err instanceof teams.TeamError ? err.code : 500, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/teams' || pathname.startsWith('/api/teams/')) {
    if (await handleTeams(req, res, method, pathname)) return true;
  }

  if (pathname === '/api/team-runs' || pathname.startsWith('/api/team-runs/')) {
    if (await handleTeamRuns(req, res, method, pathname)) return true;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([\w-]+)(?:\/(log\/stream|log|cancel))?$/);
  if (taskMatch && TASK_ID_PATTERN.test(taskMatch[1])) {
    const [, id, action] = taskMatch;
    if (method === 'GET' && action === 'log/stream') {
      handleLogStream(req, res, id, new URL(req.url, 'http://127.0.0.1').searchParams);
      return true;
    }
    if (method === 'GET' && action === 'log') {
      serveTaskLog(res, id, new URL(req.url, 'http://127.0.0.1').searchParams);
      return true;
    }
    if (method === 'GET' && !action) {
      if (!fs.existsSync(path.join(LOGS_DIR, `${id}.log`))) {
        sendJson(res, 404, { error: 'Task not found' });
      } else {
        sendJson(res, 200, { task: parseLog(id, DETAIL_HEAD_BYTES) });
      }
      return true;
    }
    if (method === 'POST' && action === 'cancel') {
      const result = cancelTask(id);
      sendJson(res, result.code, result.ok ? { id, status: result.status } : { error: result.error });
      return true;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

module.exports = { handle, listTasks };
