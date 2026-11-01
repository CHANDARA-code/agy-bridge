const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { DATA_DIR, PACKAGE_ROOT } = require('./config');
const settings = require('./settings');

const PACKAGE = require('../package.json');
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const FORCE_MIN_INTERVAL_MS = 60 * 1000;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const ACTIVE_RUN_STATES = ['planning', 'running', 'reviewing'];
const REPOSITORY = (() => {
  const raw = PACKAGE.repository && (PACKAGE.repository.url || PACKAGE.repository);
  const url = typeof raw === 'string' ? raw.replace(/^git\+/, '').replace(/\.git$/, '') : '';
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url) ? url : null;
})();

let cached = null;
let pendingCheck = null;
let npmGlobalRoot;
let updateState = { state: 'idle', version: null, output: '', error: null, startedAt: null, finishedAt: null };
const listeners = new Set();

function onUpdateChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(versionInfo());
    } catch (err) {}
  }
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareVersions(a, b) {
  const left = VERSION_PATTERN.exec(a);
  const right = VERSION_PATTERN.exec(b);
  if (!left || !right) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Math.sign(Number(left[i]) - Number(right[i]));
    if (diff) return diff;
  }
  if (!left[4] && !right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  const leftParts = left[4].split('.');
  const rightParts = right[4].split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    if (leftParts[i] === undefined) return -1;
    if (rightParts[i] === undefined) return 1;
    const diff = compareIdentifiers(leftParts[i], rightParts[i]);
    if (diff) return diff;
  }
  return 0;
}

function checksEnabled() {
  return settings.get('A2A_UPDATE_CHECK');
}

function registry() {
  return settings.get('A2A_NPM_REGISTRY').replace(/\/+$/, '');
}

function npmBin() {
  if (settings.get('A2A_NPM_BIN')) return settings.get('A2A_NPM_BIN');
  const besideNode = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return fs.existsSync(besideNode) ? besideNode : 'npm';
}

function resolveNpmGlobalRoot() {
  if (npmGlobalRoot !== undefined) return Promise.resolve(npmGlobalRoot);
  return new Promise((resolve) => {
    execFile(npmBin(), ['root', '-g'], { timeout: 20000 }, (err, stdout) => {
      npmGlobalRoot = err ? null : stdout.trim() || null;
      resolve(npmGlobalRoot);
    });
  });
}

async function installKind() {
  const globalRoot = await resolveNpmGlobalRoot();
  if (globalRoot && path.resolve(path.dirname(PACKAGE_ROOT)) === path.resolve(globalRoot)) return 'npm-global';
  if (fs.existsSync(path.join(PACKAGE_ROOT, '.git'))) return 'source';
  return 'other';
}

function restartMode() {
  const autostart = require('./autostart');
  if (autostart.isInstalled()) return 'service';
  try {
    if (parseInt(fs.readFileSync(path.join(DATA_DIR, 'server.pid'), 'utf-8'), 10) === process.pid) return 'pid-file';
  } catch (err) {}
  return 'manual';
}

function versionInfo(kind = cached && cached.kind) {
  const latest = cached ? cached.latest : null;
  const updateAvailable = Boolean(latest && compareVersions(latest, PACKAGE.version) > 0);
  let command = null;
  if (latest && kind === 'npm-global') command = `npm install -g ${PACKAGE.name}@${latest}`;
  if (kind === 'source') command = 'git pull && npm run build:panel';
  return {
    name: PACKAGE.name,
    current: PACKAGE.version,
    latest,
    updateAvailable,
    checksEnabled: checksEnabled(),
    checkedAt: cached && cached.checkedAt ? new Date(cached.checkedAt).toISOString() : null,
    error: cached ? cached.error : null,
    install: kind || null,
    canUpdate: updateAvailable && kind === 'npm-global',
    command,
    notesUrl: REPOSITORY ? `${REPOSITORY}/blob/main/CHANGELOG.md` : null,
    restart: restartMode(),
    update: updateState
  };
}

async function fetchLatest() {
  const res = await fetch(`${registry()}/${PACKAGE.name}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The npm registry answered ${res.status}`);
  const body = await res.json();
  if (typeof body.version !== 'string' || !VERSION_PATTERN.test(body.version)) throw new Error('The npm registry returned no valid version');
  return body.version;
}

async function checkForUpdate({ force = false } = {}) {
  const kind = await installKind();
  if (!checksEnabled()) {
    cached = { latest: null, checkedAt: null, error: null, kind };
    return versionInfo(kind);
  }
  const age = cached && cached.checkedAt ? Date.now() - cached.checkedAt : Infinity;
  if (age < (force ? FORCE_MIN_INTERVAL_MS : CHECK_TTL_MS)) return versionInfo(kind);
  if (!pendingCheck) {
    const before = cached ? cached.latest : null;
    pendingCheck = fetchLatest()
      .then((latest) => {
        cached = { latest, checkedAt: Date.now(), error: null, kind };
      }, (err) => {
        cached = { latest: before, checkedAt: Date.now(), error: err.message, kind };
      })
      .then(() => {
        pendingCheck = null;
        if (cached.latest !== before) notify();
      });
  }
  await pendingCheck;
  return versionInfo(kind);
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  notify();
}

function activeWork() {
  const { countRunningTasks } = require('./dispatcher');
  const tasks = countRunningTasks();
  let runs = 0;
  try {
    runs = require('./teams').listRuns({ limit: 200 }).filter((run) => ACTIVE_RUN_STATES.includes(run.status)).length;
  } catch (err) {}
  return { tasks, runs };
}

class UpdateError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function startUpdate() {
  const info = await checkForUpdate();
  if (updateState.state === 'installing' || updateState.state === 'restarting') throw new UpdateError('An update is already in progress', 409);
  if (!info.updateAvailable) throw new UpdateError(`Version ${info.current} is already the newest`, 409);
  if (info.install !== 'npm-global') throw new UpdateError(`This copy was not installed with "npm install -g", so it cannot update itself. ${info.command ? `Run: ${info.command}` : ''}`.trim(), 409);
  const { tasks, runs } = activeWork();
  if (tasks || runs) throw new UpdateError(`Wait until running work finishes: ${tasks} task(s) and ${runs} team run(s) are still running`, 409);

  const version = info.latest;
  setUpdateState({ state: 'installing', version, output: '', error: null, startedAt: new Date().toISOString(), finishedAt: null });
  const child = spawn(npmBin(), ['install', '-g', `${PACKAGE.name}@${version}`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => {
    output = (output + chunk.toString('utf-8')).slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS);
  child.on('error', (err) => {
    clearTimeout(timer);
    setUpdateState({ state: 'failed', output, error: `Could not run npm: ${err.message}`, finishedAt: new Date().toISOString() });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (updateState.state !== 'installing') return;
    if (code !== 0) {
      setUpdateState({ state: 'failed', output, error: `npm install exited with code ${code}`, finishedAt: new Date().toISOString() });
      return;
    }
    const mode = restartMode();
    if (mode === 'manual') {
      setUpdateState({ state: 'installed', output, finishedAt: new Date().toISOString() });
      return;
    }
    setUpdateState({ state: 'restarting', output, finishedAt: new Date().toISOString() });
    const restarter = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'cli.js'), 'server', 'restart'], { detached: true, stdio: 'ignore', env: process.env });
    restarter.unref();
  });
  return versionInfo(info.install);
}

module.exports = { compareVersions, checkForUpdate, versionInfo, startUpdate, onUpdateChange, UpdateError, VERSION_PATTERN };
