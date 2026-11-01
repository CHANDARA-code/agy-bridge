const { test } = require('node:test');
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

const TINY_PNG_1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const TINY_PNG_2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

async function startInstance(configureHome) {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-icon-test-'));
  const logsDir = path.join(sandbox, 'logs');
  const tokenFile = path.join(sandbox, 'token');
  const presetsDir = path.join(sandbox, 'presets');
  const accountsDir = path.join(sandbox, 'accounts');
  const teamsDir = path.join(sandbox, 'teams');
  const realHome = path.join(sandbox, 'home');

  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(presetsDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(realHome, { recursive: true });
  fs.writeFileSync(tokenFile, TOKEN + '\n');

  if (configureHome) {
    configureHome(realHome);
  }

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      A2A_PORT: String(port),
      A2A_LOGS_DIR: logsDir,
      A2A_TOKEN_FILE: tokenFile,
      A2A_SETTINGS_FILE: path.join(sandbox, 'settings.json'),
      A2A_PRESETS_DIR: presetsDir,
      A2A_ACCOUNTS_DIR: accountsDir,
      A2A_TEAMS_DIR: teamsDir,
      A2A_REAL_HOME: realHome,
      AGY_BIN: FAKE_AGY,
      CLAUDE_BIN: FAKE_CLAUDE,
      CODEX_BIN: FAKE_CODEX
    },
    stdio: 'ignore'
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  });

  return {
    base,
    sandbox,
    realHome,
    stop: () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('fake extension icon served with exact type, nosniff, default-src none, max-age 3600, iconUrl in /api/accounts', async () => {
  const instance = await startInstance((realHome) => {
    const extDir = path.join(realHome, '.vscode', 'extensions', 'google.google-antigravity-1.0.0');
    fs.mkdirSync(path.join(extDir, 'img'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ icon: 'img/logo.png' }));
    fs.writeFileSync(path.join(extDir, 'img', 'logo.png'), TINY_PNG_1);
  });

  try {
    const iconRes = await fetch(`${instance.base}/api/providers/agy/icon`);
    assert.strictEqual(iconRes.status, 200);
    assert.strictEqual(iconRes.headers.get('content-type'), 'image/png');
    assert.strictEqual(iconRes.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(iconRes.headers.get('content-security-policy'), "default-src 'none'");
    assert.strictEqual(iconRes.headers.get('cache-control'), 'max-age=3600');

    const iconBuffer = Buffer.from(await iconRes.arrayBuffer());
    assert.deepStrictEqual(iconBuffer, TINY_PNG_1);

    const accRes = await fetch(`${instance.base}/api/accounts`);
    assert.strictEqual(accRes.status, 200);
    const accData = await accRes.json();
    const agyProv = accData.providers.find((p) => p.id === 'agy');
    assert.ok(agyProv);
    assert.strictEqual(agyProv.iconUrl, '/api/providers/agy/icon');
  } finally {
    instance.stop();
  }
});

test('newest of two versions wins by mtime', async () => {
  const instance = await startInstance((realHome) => {
    const v1 = path.join(realHome, '.vscode', 'extensions', 'google.google-antigravity-1.0.0');
    const v2 = path.join(realHome, '.vscode', 'extensions', 'google.google-antigravity-1.1.0');
    fs.mkdirSync(path.join(v1, 'img'), { recursive: true });
    fs.mkdirSync(path.join(v2, 'img'), { recursive: true });
    fs.writeFileSync(path.join(v1, 'package.json'), JSON.stringify({ icon: 'img/logo.png' }));
    fs.writeFileSync(path.join(v1, 'img', 'logo.png'), TINY_PNG_1);
    fs.writeFileSync(path.join(v2, 'package.json'), JSON.stringify({ icon: 'img/logo.png' }));
    fs.writeFileSync(path.join(v2, 'img', 'logo.png'), TINY_PNG_2);

    const now = Math.floor(Date.now() / 1000);
    fs.utimesSync(v1, now - 60, now - 60);
    fs.utimesSync(v2, now, now);
  });

  try {
    const iconRes = await fetch(`${instance.base}/api/providers/agy/icon`);
    assert.strictEqual(iconRes.status, 200);
    const iconBuffer = Buffer.from(await iconRes.arrayBuffer());
    assert.deepStrictEqual(iconBuffer, TINY_PNG_2);
  } finally {
    instance.stop();
  }
});

test('path traversal escape is refused (404, iconUrl null)', async () => {
  const instance = await startInstance((realHome) => {
    const extDir = path.join(realHome, '.vscode', 'extensions', 'google.google-antigravity-1.0.0');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(realHome, '.vscode', 'secret.png'), TINY_PNG_1);
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ icon: '../../secret.png' }));
  });

  try {
    const iconRes = await fetch(`${instance.base}/api/providers/agy/icon`);
    assert.strictEqual(iconRes.status, 404);

    const accRes = await fetch(`${instance.base}/api/accounts`);
    const accData = await accRes.json();
    const agyProv = accData.providers.find((p) => p.id === 'agy');
    assert.strictEqual(agyProv.iconUrl, null);
  } finally {
    instance.stop();
  }
});

test('symlink pointing outside the extension folder is refused (404, iconUrl null)', async () => {
  const instance = await startInstance((realHome) => {
    const extDir = path.join(realHome, '.cursor', 'extensions', 'google.google-antigravity-1.0.0');
    fs.mkdirSync(path.join(extDir, 'img'), { recursive: true });
    const outsideFile = path.join(realHome, 'outside.png');
    fs.writeFileSync(outsideFile, TINY_PNG_1);
    fs.symlinkSync(outsideFile, path.join(extDir, 'img', 'symlink.png'));
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ icon: 'img/symlink.png' }));
  });

  try {
    const iconRes = await fetch(`${instance.base}/api/providers/agy/icon`);
    assert.strictEqual(iconRes.status, 404);

    const accRes = await fetch(`${instance.base}/api/accounts`);
    const accData = await accRes.json();
    const agyProv = accData.providers.find((p) => p.id === 'agy');
    assert.strictEqual(agyProv.iconUrl, null);
  } finally {
    instance.stop();
  }
});

test('.svg icon is refused (404, iconUrl null)', async () => {
  const instance = await startInstance((realHome) => {
    const extDir = path.join(realHome, '.vscode', 'extensions', 'google.google-antigravity-1.0.0');
    fs.mkdirSync(path.join(extDir, 'img'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ icon: 'img/logo.svg' }));
    fs.writeFileSync(path.join(extDir, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  });

  try {
    const iconRes = await fetch(`${instance.base}/api/providers/agy/icon`);
    assert.strictEqual(iconRes.status, 404);

    const accRes = await fetch(`${instance.base}/api/accounts`);
    const accData = await accRes.json();
    const agyProv = accData.providers.find((p) => p.id === 'agy');
    assert.strictEqual(agyProv.iconUrl, null);
  } finally {
    instance.stop();
  }
});

test('codex with no extension returns 404 and null iconUrl', async () => {
  const instance = await startInstance();
  try {
    const iconRes = await fetch(`${instance.base}/api/providers/codex/icon`);
    assert.strictEqual(iconRes.status, 404);

    const accRes = await fetch(`${instance.base}/api/accounts`);
    const accData = await accRes.json();
    const codexProv = accData.providers.find((p) => p.id === 'codex');
    assert.strictEqual(codexProv.iconUrl, null);
  } finally {
    instance.stop();
  }
});

test('unknown provider id returns 404', async () => {
  const instance = await startInstance();
  try {
    const iconRes = await fetch(`${instance.base}/api/providers/unknown/icon`);
    assert.strictEqual(iconRes.status, 404);
  } finally {
    instance.stop();
  }
});
