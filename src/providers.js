const fs = require('fs');
const path = require('path');

const MODEL_PATTERN = /^[A-Za-z0-9~][\w.:/~@+\[\]-]{0,127}$/;

const PROVIDERS = {
  agy: {
    id: 'agy',
    name: 'Antigravity',
    loginMethods: ['browser', 'terminal'],
    canLogout: false
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    loginMethods: ['browser', 'terminal'],
    canLogout: true
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    loginMethods: ['browser', 'device', 'terminal'],
    canLogout: true
  }
};

const ENV_BIN_VARS = {
  agy: 'AGY_BIN',
  claude: 'CLAUDE_BIN',
  codex: 'CODEX_BIN'
};

function resolveBin(providerId) {
  const envVar = ENV_BIN_VARS[providerId];
  if (envVar && process.env[envVar]) return process.env[envVar];
  const candidates = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, providerId));
  candidates.push(path.join(process.env.HOME || '', '.local', 'bin', providerId));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (err) {}
  }
  return providerId;
}

function buildCommand(providerId, { prompt, mode, effort, model, conversationId, workspace }) {
  const bin = resolveBin(providerId);
  if (providerId === 'agy') {
    const args = [
      '-p', prompt,
      '--mode', mode || 'accept-edits',
      '--effort', effort || 'high',
      '--output-format', 'stream-json',
      '--add-dir', workspace,
      '--dangerously-skip-permissions'
    ];
    if (model) args.push('--model', model);
    if (conversationId) args.push('--conversation', conversationId);
    return { bin, args, stdin: null };
  }
  if (providerId === 'claude') {
    const isPlan = mode === 'plan';
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--add-dir', workspace
    ];
    if (isPlan) {
      args.push(
        '--permission-mode', 'dontAsk',
        '--allowedTools', 'Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)'
      );
    } else {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--effort', effort || 'high');
    if (model) args.push('--model', model);
    if (conversationId) args.push('--resume', conversationId);
    return { bin, args, stdin: prompt };
  }
  if (providerId === 'codex') {
    const codexEffort = (effort === 'max' ? 'xhigh' : effort) || 'high';
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', workspace];
    if (mode === 'plan') {
      args.push('-s', 'read-only');
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (model) args.push('-m', model);
    args.push('-c', `model_reasoning_effort="${codexEffort}"`);
    if (conversationId) args.push('resume', conversationId);
    args.push('-');
    return { bin, args, stdin: prompt };
  }
  throw new Error(`Unknown provider: ${providerId}`);
}

function statusCommand(providerId) {
  const bin = resolveBin(providerId);
  if (providerId === 'agy') return { bin, args: ['models'] };
  if (providerId === 'claude') return { bin, args: ['auth', 'status', '--json'] };
  if (providerId === 'codex') return { bin, args: ['login', 'status'] };
  throw new Error(`Unknown provider: ${providerId}`);
}

function modelsCommand(providerId) {
  const bin = resolveBin(providerId);
  if (providerId === 'agy') return { bin, args: ['models'] };
  if (providerId === 'claude') return { bin, args: ['--help'] };
  if (providerId === 'codex') return { bin, args: ['debug', 'models'] };
  throw new Error(`Unknown provider: ${providerId}`);
}

function parseModels(providerId, stdout = '') {
  if (providerId === 'agy') {
    return stdout.split('\n')
      .filter((line) => line.includes('\t'))
      .map((line) => {
        const [id, ...rest] = line.split('\t');
        return { id: id.trim(), name: rest.join(' ').trim() || id.trim() };
      });
  }
  if (providerId === 'claude') {
    const text = stdout.replace(/\s+/g, ' ');
    const match = text.match(/--model <model>.*?alias for the latest model \(e\.g\. ([^)]*)\)/i);
    if (!match) return [];
    return [...match[1].matchAll(/'([A-Za-z][\w-]*)'/g)].map(([, alias]) => ({
      id: alias,
      name: `${alias.charAt(0).toUpperCase()}${alias.slice(1)} (latest)`,
      description: 'Alias for the newest model of this family'
    }));
  }
  if (providerId === 'codex') {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.models) || [];
    return list
      .filter((model) => model && typeof model.slug === 'string' && model.visibility !== 'hide')
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      .map((model) => ({ id: model.slug, name: model.display_name || model.slug, description: model.description || undefined }));
  }
  throw new Error(`Unknown provider: ${providerId}`);
}

function parseStatus(providerId, { exitCode, stdout = '', stderr = '' }) {
  if (providerId === 'agy') {
    const lines = stdout.split('\n').filter((l) => l.includes('\t'));
    if (lines.length) {
      return { state: 'signed-in', detail: `${lines.length} model(s) available`, email: null, plan: null };
    }
    if (/sign in/i.test(stdout) || /sign in/i.test(stderr)) {
      return { state: 'signed-out', detail: 'Not signed in', email: null, plan: null };
    }
    if (exitCode !== 0) {
      return { state: 'error', detail: (stderr || stdout || 'Failed to check status').trim(), email: null, plan: null };
    }
    return { state: 'signed-out', detail: (stdout || 'Not signed in').trim(), email: null, plan: null };
  }
  if (providerId === 'claude') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object') {
        if (parsed.loggedIn) {
          return {
            state: 'signed-in',
            detail: parsed.email ? `Signed in as ${parsed.email}` : 'Signed in',
            email: parsed.email || null,
            plan: parsed.subscriptionType || null
          };
        }
        return { state: 'signed-out', detail: 'Not signed in', email: null, plan: null };
      }
    } catch (err) {}
    if (/not logged in/i.test(stdout) || /not logged in/i.test(stderr)) {
      return { state: 'signed-out', detail: 'Not signed in', email: null, plan: null };
    }
    return { state: 'error', detail: (stderr || stdout || 'Failed to check status').trim(), email: null, plan: null };
  }
  if (providerId === 'codex') {
    const text = `${stdout}\n${stderr}`;
    if (/logged in/i.test(text) && !/not logged in/i.test(text)) {
      return { state: 'signed-in', detail: 'Credentials stored (verified on next task run)', email: null, plan: null };
    }
    if (/not logged in/i.test(text)) {
      return { state: 'signed-out', detail: 'Not signed in', email: null, plan: null };
    }
    if (exitCode !== 0) {
      return { state: 'error', detail: (stderr || stdout || 'Failed to check status').trim(), email: null, plan: null };
    }
    return { state: 'signed-out', detail: (stdout || 'Not signed in').trim(), email: null, plan: null };
  }
  throw new Error(`Unknown provider: ${providerId}`);
}

function loginArgs(providerId, method) {
  if (providerId === 'agy') {
    return method === 'browser' ? ['-p', '/help', '--output-format', 'stream-json'] : [];
  }
  if (providerId === 'claude') return ['auth', 'login'];
  if (providerId === 'codex') {
    return method === 'device' ? ['login', '--device-auth'] : ['login'];
  }
  throw new Error(`Unknown provider: ${providerId}`);
}

function logoutArgs(providerId) {
  if (providerId === 'claude') return ['auth', 'logout'];
  if (providerId === 'codex') return ['logout'];
  throw new Error(`Provider ${providerId} does not support logout`);
}

function authFailurePattern(providerId) {
  if (providerId === 'agy') return /please sign in|not signed in|authentication required|authentication failed or timed out/i;
  if (providerId === 'claude') return /please run \/login|authentication_error|oauth token has expired/i;
  if (providerId === 'codex') return /access token could not be refreshed|not logged in|please log out and sign in again|401 unauthorized/i;
  return /$^/;
}

function signInPromptPattern(providerId) {
  if (providerId === 'agy') return /Authentication required\. Please visit the URL to log in/i;
  return null;
}

function quotaFailurePattern(providerId) {
  if (providerId === 'agy') return /quota|resource.?exhausted|capacity.?exhausted|rate.?limit|resets in/i;
  if (providerId === 'claude') return /usage limit|hit your limit|rate limit/i;
  return null;
}

function createParser(providerId, handlers) {
  if (providerId === 'agy') return require('./agy-stream').createStreamParser(handlers);
  if (providerId === 'claude') return require('./claude-stream').createStreamParser(handlers);
  if (providerId === 'codex') return require('./codex-stream').createStreamParser(handlers);
  throw new Error(`Unknown provider: ${providerId}`);
}

module.exports = {
  MODEL_PATTERN,
  PROVIDERS,
  resolveBin,
  buildCommand,
  statusCommand,
  parseStatus,
  loginArgs,
  modelsCommand,
  parseModels,
  logoutArgs,
  authFailurePattern,
  signInPromptPattern,
  quotaFailurePattern,
  createParser
};
