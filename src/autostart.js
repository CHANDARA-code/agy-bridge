const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATA_DIR, PACKAGE_ROOT } = require('./config');

// Start the HTTP server (and so the dashboard) when the user logs in:
// a LaunchAgent on macOS, a systemd user service on Linux.
const LABEL = 'com.a2a-panel.server';
const UNIT = 'a2a-panel.service';
const SERVER_PATH = path.join(PACKAGE_ROOT, 'server.js');
// Variables the server reads; they are copied into the service when it is enabled.
const PASSED_ENV = /^(A2A_[A-Z_]+|AGY_BIN)$/;

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function unitPath() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', UNIT);
}

// launchd opens these itself; macOS keeps per-user service logs in ~/Library/Logs (shown in Console.app).
function logDir() {
  return platform() === 'launchd' ? path.join(os.homedir(), 'Library', 'Logs', 'a2a-panel') : DATA_DIR;
}

function logFiles() {
  return { out: path.join(logDir(), 'server.log'), err: path.join(logDir(), 'server.err') };
}

function platform() {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
}

function servicePath() {
  return platform() === 'launchd' ? plistPath() : unitPath();
}

// The login session has a minimal PATH, so keep the one from the shell that enabled the
// service: agy and the tools a task runs (node, git, npm...) must still be found.
function serviceEnv() {
  const dirs = (process.env.PATH || '/usr/bin:/bin').split(path.delimiter).filter(Boolean);
  const env = { PATH: [...new Set(dirs)].join(path.delimiter), HOME: os.homedir() };
  for (const [key, value] of Object.entries(process.env)) {
    if (PASSED_ENV.test(key) && value) env[key] = value;
  }
  return env;
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildPlist(env = serviceEnv()) {
  const envEntries = Object.entries(env).map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(process.execPath)}</string>
      <string>${xml(SERVER_PATH)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(DATA_DIR)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(logFiles().out)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFiles().err)}</string>
  </dict>
</plist>
`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildUnit(env = serviceEnv()) {
  const envLines = Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n');
  return `[Unit]
Description=a2a-panel server and web dashboard
After=network.target

[Service]
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(SERVER_PATH)}
WorkingDirectory=${DATA_DIR}
${envLines}
Restart=on-failure
RestartSec=30
StandardOutput=append:${logFiles().out}
StandardError=append:${logFiles().err}

[Install]
WantedBy=default.target
`;
}

function run(file, args) {
  try {
    return { ok: true, output: execFileSync(file, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim() };
  } catch (err) {
    return { ok: false, output: String((err.stdout || '') + (err.stderr || '') || err.message).trim() };
  }
}

const launchdDomain = () => `gui/${process.getuid()}`;
const launchdTarget = () => `${launchdDomain()}/${LABEL}`;

function isInstalled() {
  return platform() !== null && fs.existsSync(servicePath());
}

// { installed, running, pid, detail }
function status() {
  const kind = platform();
  if (!kind) return { installed: false, running: false, pid: null, detail: `not supported on ${process.platform}` };
  if (!isInstalled()) return { installed: false, running: false, pid: null, detail: 'off' };
  if (kind === 'launchd') {
    const printed = run('launchctl', ['print', launchdTarget()]);
    const pid = printed.ok ? (printed.output.match(/^\s*pid = (\d+)/m) || [])[1] : null;
    return { installed: true, running: Boolean(pid), pid: pid ? Number(pid) : null, detail: printed.ok ? (pid ? 'running' : 'loaded, not running') : 'installed, not loaded' };
  }
  const active = run('systemctl', ['--user', 'is-active', UNIT]);
  const pid = run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT]).output;
  return { installed: true, running: active.output === 'active', pid: Number(pid) || null, detail: active.output || 'unknown' };
}

function enable({ dryRun = false } = {}) {
  const kind = platform();
  if (!kind) throw new Error(`Start at login is supported on macOS and Linux, not ${process.platform}.`);
  const file = servicePath();
  const content = kind === 'launchd' ? buildPlist() : buildUnit();
  if (dryRun) return { file, content, steps: [] };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  const steps = [];
  if (kind === 'launchd') {
    fs.writeFileSync(file, content);
    const loaded = reloadLaunchd(file);
    if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${loaded.output}`);
    steps.push(`launchctl bootstrap ${launchdDomain()} ${file}`);
  } else {
    fs.writeFileSync(file, content);
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', UNIT]]) {
      const result = run('systemctl', args);
      if (!result.ok) throw new Error(`systemctl ${args.join(' ')} failed: ${result.output}`);
      steps.push(`systemctl ${args.join(' ')}`);
    }
  }
  return { file, content, steps };
}

function disable() {
  const kind = platform();
  if (!kind || !isInstalled()) return false;
  const file = servicePath();
  if (kind === 'launchd') {
    run('launchctl', ['bootout', launchdTarget()]);
  } else {
    run('systemctl', ['--user', 'disable', '--now', UNIT]);
  }
  fs.unlinkSync(file);
  if (kind === 'systemd') run('systemctl', ['--user', 'daemon-reload']);
  return true;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reloadLaunchd(file) {
  run('launchctl', ['bootout', launchdTarget()]);
  let loaded = { ok: false, output: 'the old service did not unload' };
  for (let attempt = 0; attempt < 20; attempt++) {
    if (run('launchctl', ['print', launchdTarget()]).ok) {
      pause(250);
      continue;
    }
    loaded = run('launchctl', ['bootstrap', launchdDomain(), file]);
    if (loaded.ok) return loaded;
    pause(250);
  }
  return loaded;
}

function upgradePlist() {
  const file = plistPath();
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return false;
  }
  if (content.includes('<key>ProcessType</key>') || !content.includes('<key>StandardOutPath</key>')) return false;
  fs.writeFileSync(file, content.replace('    <key>StandardOutPath</key>', '    <key>ProcessType</key>\n    <string>Interactive</string>\n    <key>StandardOutPath</key>'));
  return true;
}

// start/stop/restart for "a2a-panel server ..." when the service is installed.
function start() {
  if (platform() === 'launchd') {
    if (upgradePlist()) return reloadLaunchd(plistPath());
    const loaded = run('launchctl', ['print', launchdTarget()]).ok;
    return loaded ? run('launchctl', ['kickstart', launchdTarget()]) : run('launchctl', ['bootstrap', launchdDomain(), plistPath()]);
  }
  return run('systemctl', ['--user', 'start', UNIT]);
}

function stop() {
  return platform() === 'launchd' ? run('launchctl', ['bootout', launchdTarget()]) : run('systemctl', ['--user', 'stop', UNIT]);
}

function restart() {
  if (platform() === 'launchd') {
    // Reload instead of "kickstart -k": a respawn waits out ThrottleInterval, a fresh bootstrap does not.
    upgradePlist();
    return reloadLaunchd(plistPath());
  }
  return run('systemctl', ['--user', 'restart', UNIT]);
}

// systemd user services start at boot only with lingering on; otherwise at login.
function lingerEnabled() {
  if (platform() !== 'systemd') return null;
  const result = run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']);
  return result.ok ? result.output === 'yes' : null;
}

module.exports = { LABEL, UNIT, platform, servicePath, logFiles, buildPlist, buildUnit, upgradePlist, isInstalled, status, enable, disable, start, stop, restart, lingerEnabled };
