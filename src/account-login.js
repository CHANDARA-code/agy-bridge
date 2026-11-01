const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { AccountError, getAccount, accountEnv, accountOverrides, checkAccount, saveAccount, getAccountsDir } = require('./accounts');
const { PROVIDERS, resolveBin, loginArgs } = require('./providers');

const sessions = new Map();
const childProcesses = new Map();
const sessionTimers = new Map();
const terminalSessions = new Map();
const submittedCodes = new Map();
const loginChangeListeners = new Set();

function onLoginChange(listener) {
  loginChangeListeners.add(listener);
  return () => {
    loginChangeListeners.delete(listener);
  };
}

function notifyLoginChange(session) {
  if (!session || !session.id) return;
  const payload = { id: session.id, state: session.state };
  for (const listener of loginChangeListeners) {
    try {
      listener(payload);
    } catch (err) {}
  }
}

function inTerminal(bin, args) {
  if (process.platform === 'darwin') return { bin: 'sh', args: ['-c', 'cat | script -q /dev/null "$@" 2>&1 | cat', 'sh', bin, ...args] };
  return { bin: 'sh', args: ['-c', 'cat | script -qfec "$1" /dev/null 2>&1 | cat', 'sh', [bin, ...args].map(shellQuote).join(' ')] };
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommand(overrides, bin, args) {
  const exports = Object.entries(overrides).map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [...exports, shellQuote(bin), ...args.map(shellQuote)].join(' ');
}

function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch (err) {
      return false;
    }
  });
}

function markSignedInHere(accountId) {
  const account = getAccount(accountId);
  if (!account) return;
  account.signedInHere = true;
  account.status = { ...account.status, warning: null };
  saveAccount(account);
}

function getLogin(loginId) {
  return sessions.get(loginId) || null;
}

function stopSessionTimers(loginId) {
  const timers = sessionTimers.get(loginId);
  if (timers) {
    timers.forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    sessionTimers.delete(loginId);
  }
}

function processGroupsUnder(rootPid) {
  let table = '';
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf-8' });
  } catch (err) {
    return [];
  }
  const rows = table.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid]) => pid);
  const own = rows.find(([pid]) => pid === process.pid);
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  const groups = rows.filter(([pid]) => tree.has(pid)).map(([, , pgid]) => pgid);
  return [...new Set(groups)].filter((pgid) => pgid > 1 && (!own || pgid !== own[2]));
}

function killProcessGroup(proc) {
  if (!proc || !proc.pid) return;
  const groups = new Set([proc.pid, ...processGroupsUnder(proc.pid)]);
  const signalAll = (signal) => {
    for (const pgid of groups) {
      try {
        process.kill(-pgid, signal);
      } catch (err) {}
    }
  };
  signalAll('SIGTERM');
  try {
    proc.kill('SIGTERM');
  } catch (err) {}
  setTimeout(() => signalAll('SIGKILL'), 3000).unref();
}

function terminalStillRunning(rootPid) {
  let table = '';
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf-8' });
  } catch (err) {
    return true;
  }
  const rows = table.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2]), m[3]]);
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return rows.some(([pid, , command]) => tree.has(pid) && /(^|\/)script\s/.test(command));
}

const AUTH_CODE_PATTERN = /\b4\/0[\w-]{20,}/g;

function redact(text, codes) {
  let result = text.replace(AUTH_CODE_PATTERN, '••••');
  for (const code of codes) result = result.split(code).join('••••');
  return result;
}

function purgeOldSessions() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.finishedAt && Date.parse(session.finishedAt) < cutoff) {
      sessions.delete(id);
      submittedCodes.delete(id);
    }
  }
}

function stopAllLogins() {
  for (const [loginId, child] of childProcesses) {
    for (const pgid of new Set([child.pid, ...processGroupsUnder(child.pid)])) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch (err) {}
    }
    const session = sessions.get(loginId);
    if (session && (session.state === 'starting' || session.state === 'waiting')) {
      session.state = 'cancelled';
      session.finishedAt = new Date().toISOString();
      notifyLoginChange(session);
    }
  }
  childProcesses.clear();
}

function startLogin(accountId, method) {
  const account = getAccount(accountId);
  if (!account) {
    throw new AccountError(`Account "${accountId}" not found`, 404);
  }
  if (account.apiKey) throw new AccountError('This account uses an API key. Use Change key instead of signing in.', 400);
  const providerDef = PROVIDERS[account.provider];
  if (!providerDef || !providerDef.loginMethods.includes(method)) {
    throw new AccountError(`Provider "${account.provider}" does not support login method "${method}"`, 400);
  }

  purgeOldSessions();
  const active = Array.from(sessions.values()).filter((s) => s.state === 'starting' || s.state === 'waiting');
  if (active.some((s) => s.accountId === accountId)) {
    throw new AccountError('A login session is already active for this account', 409);
  }
  if (account.provider === 'codex' && method === 'browser') {
    const codexBrowserActive = active.some((s) => {
      const a = getAccount(s.accountId);
      return a && a.provider === 'codex' && s.method === 'browser';
    });
    if (codexBrowserActive) {
      throw new AccountError('Another Codex browser login is already in progress. Codex uses a fixed local port (1455) for callbacks; wait for it to finish or use device login.', 409);
    }
  }

  const loginId = `login_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const bin = resolveBin(account.provider);
  const overrides = accountOverrides(account);
  const args = loginArgs(account.provider, method);
  const commandStr = shellCommand(overrides, bin, args);
  const scratch = path.join(getAccountsDir(), '.sign-in');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });

  const session = {
    id: loginId,
    accountId,
    method,
    state: 'starting',
    url: null,
    code: null,
    needsCode: false,
    verifying: false,
    command: commandStr,
    terminalOpened: false,
    output: '',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  sessions.set(loginId, session);
  notifyLoginChange(session);
  const timers = [];
  sessionTimers.set(loginId, timers);

  if (method === 'terminal') {
    const scriptFile = path.join(scratch, `${account.id}.command`);
    const exportLines = Object.entries(overrides).map(([name, value]) => `export ${name}=${shellQuote(value)}\n`).join('');
    const scriptContent = `#!/bin/sh\n${exportLines}exec ${[shellQuote(bin), ...args.map(shellQuote)].join(' ')}\n`;
    fs.writeFileSync(scriptFile, scriptContent, { mode: 0o700 });

    const candidates = process.platform === 'darwin'
      ? [['open', [scriptFile]]]
      : [['x-terminal-emulator', ['-e', scriptFile]], ['gnome-terminal', ['--', scriptFile]], ['konsole', ['-e', scriptFile]], ['xterm', ['-e', scriptFile]]];
    const terminal = candidates.find(([name]) => onPath(name));
    if (terminal) {
      const proc = spawn(terminal[0], terminal[1], { detached: true, stdio: 'ignore' });
      proc.on('error', () => {
        session.terminalOpened = false;
        notifyLoginChange(session);
      });
      proc.unref();
    }

    session.terminalOpened = Boolean(terminal);
    session.state = 'waiting';
    notifyLoginChange(session);

    const pollTimer = setInterval(async () => {
      try {
        const updated = await checkAccount(accountId);
        if (updated.status.state === 'signed-in') {
          stopSessionTimers(loginId);
          session.state = 'succeeded';
          session.finishedAt = new Date().toISOString();
          markSignedInHere(accountId);
          notifyLoginChange(session);
        }
      } catch (err) {}
    }, 10000);
    pollTimer.unref();
    timers.push(pollTimer);

    const timeoutTimer = setTimeout(() => {
      stopSessionTimers(loginId);
      if (session.state === 'waiting' || session.state === 'starting') {
        session.state = 'failed';
        session.error = 'Login timed out waiting for sign-in';
        session.finishedAt = new Date().toISOString();
        notifyLoginChange(session);
      }
    }, 15 * 60 * 1000);
    timeoutTimer.unref();
    timers.push(timeoutTimer);

    return session;
  }

  const env = accountEnv(account);
  const needsTerminal = account.provider === 'agy' && method === 'browser';
  const launch = needsTerminal ? inTerminal(bin, args) : { bin, args };
  const child = spawn(launch.bin, launch.args, {
    env,
    cwd: scratch,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const codes = [];
  submittedCodes.set(loginId, codes);
  if (needsTerminal) {
    terminalSessions.set(loginId, true);
    let seenTerminal = false;
    let ticks = 0;
    const terminalWatch = setInterval(() => {
      ticks++;
      const running = terminalStillRunning(child.pid);
      if (running) seenTerminal = true;
      if ((seenTerminal && !running) || (!seenTerminal && ticks >= 5)) {
        clearInterval(terminalWatch);
        child.stdin.end();
      }
    }, 1000);
    terminalWatch.unref();
    timers.push(terminalWatch);
  }

  childProcesses.set(loginId, child);
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    stopSessionTimers(loginId);
    childProcesses.delete(loginId);
    terminalSessions.delete(loginId);
    if (session.state === 'cancelled') return;
    session.state = 'failed';
    session.error = `Could not start ${bin}: ${err.message}`;
    session.finishedAt = new Date().toISOString();
    notifyLoginChange(session);
  });

  const timeoutTimer = setTimeout(() => {
    stopSessionTimers(loginId);
    killProcessGroup(child);
    if (session.state === 'waiting' || session.state === 'starting') {
      session.state = 'failed';
      session.error = 'Login timed out after 15 minutes';
      session.finishedAt = new Date().toISOString();
      notifyLoginChange(session);
    }
  }, 15 * 60 * 1000);
  timeoutTimer.unref();
  timers.push(timeoutTimer);

  const onData = (data) => {
    const raw = data.toString('utf-8');
    const clean = stripAnsi(raw).replace(/\r/g, '');
    session.output = redact(session.output + clean, codes).slice(-8000);

    const urlMatch = session.output.match(/https:\/\/[^\s"'`<>]+/);
    if (urlMatch && !session.url) {
      session.url = urlMatch[0];
    }
    const codeMatch = method === 'device' && session.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/);
    if (codeMatch && !session.code) {
      session.code = codeMatch[0];
    }
    if (/paste code here|paste the authorization code/i.test(session.output)) {
      session.needsCode = true;
    }
    if (session.url && session.state === 'starting') {
      session.state = 'waiting';
    }
    notifyLoginChange(session);
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', async (code) => {
    stopSessionTimers(loginId);
    childProcesses.delete(loginId);
    terminalSessions.delete(loginId);
    if (session.state !== 'starting' && session.state !== 'waiting') return;

    if (code === 0 || needsTerminal) {
      session.verifying = true;
      notifyLoginChange(session);
      try {
        const checked = await checkAccount(accountId);
        if (checked.status.state === 'signed-in') {
          session.state = 'succeeded';
          markSignedInHere(accountId);
        } else {
          session.state = 'failed';
          session.error = checked.status.detail || 'Sign-in verification failed';
        }
      } catch (err) {
        session.state = 'failed';
        session.error = err.message;
      }
    } else {
      session.state = 'failed';
      const lines = session.output.trim().split('\n').filter(Boolean);
      session.error = lines.length ? lines[lines.length - 1] : 'Login process exited with error';
    }
    session.verifying = false;
    session.finishedAt = new Date().toISOString();
    notifyLoginChange(session);
  });

  return session;
}

function submitCode(loginId, code) {
  const session = sessions.get(loginId);
  if (!session || session.state !== 'waiting') {
    throw new AccountError('No waiting login session for this id', 400);
  }
  if (typeof code !== 'string' || !code.trim() || code.length > 2000 || /[\r\n]/.test(code)) {
    throw new AccountError('Invalid code', 400);
  }
  const child = childProcesses.get(loginId);
  if (!child || !child.stdin) {
    throw new AccountError('Login process not writable', 500);
  }
  const codes = submittedCodes.get(loginId);
  if (codes) codes.push(code.trim());
  session.output = redact(session.output, codes || [code.trim()]);
  child.stdin.write(code.trim() + (terminalSessions.has(loginId) ? '\r' : '\n'));
  notifyLoginChange(session);
  return session;
}

function cancelLogin(loginId) {
  const session = sessions.get(loginId);
  if (!session) {
    throw new AccountError('Login session not found', 404);
  }
  if (session.verifying || (session.state !== 'starting' && session.state !== 'waiting')) return session;
  stopSessionTimers(loginId);
  const child = childProcesses.get(loginId);
  if (child) {
    killProcessGroup(child);
    childProcesses.delete(loginId);
  }
  terminalSessions.delete(loginId);
  session.state = 'cancelled';
  session.finishedAt = new Date().toISOString();
  notifyLoginChange(session);
  return session;
}

module.exports = {
  stopAllLogins,
  startLogin,
  getLogin,
  submitCode,
  cancelLogin,
  onLoginChange
};
