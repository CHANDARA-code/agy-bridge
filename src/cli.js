#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { DATA_DIR, PACKAGE_ROOT } = require('./config');
const { getAgentCard, runAgyTask, cancelTask, activeTasks, readUsageTotals } = require('./dispatcher');
const presets = require('./presets');
const autostart = require('./autostart');
const accounts = require('./accounts');
const providers = require('./providers');
const teams = require('./teams');

const PORT = parseInt(process.env.A2A_PORT || '5188', 10);
const HOST = process.env.A2A_HOST || '127.0.0.1';
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const OPEN_COMMAND = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';

function showHelp() {
  console.log(`
========================================================================
  A2A-PANEL: Claude Code (Team Leader) <-> Antigravity (Senior Devs)
========================================================================

Usage:
  a2a-panel list                      List all Antigravity expert dev personas & specialties
  a2a-panel status                    Show A2A server health & agent status
  a2a-panel tasks                     List all running & recent tasks (alias: ps)
  a2a-panel doctor                    Check Node, agy, sign-in, git, data folder and Claude Code setup
  a2a-panel init [--dry-run]          Register this bridge as an MCP server in Claude Code
  a2a-panel usage [--days N]          Show token usage totals, quota windows and budgets
  a2a-panel logs [taskId] [-f]        View or stream live logs of a task (or latest task)
  a2a-panel dashboard [--no-open]     Open the web task panel (monitor, dispatch, cancel)
  a2a-panel run <role> "<task prompt>"  Dispatch task to an Antigravity developer
  a2a-panel accounts [list]           List signed-in accounts and status
  a2a-panel accounts add <id> --provider <agy|claude|codex> [--label <l>] [--model <m>]
  a2a-panel accounts add <id> --service <service> [--base-url <u>] [--model <m>] [--fast-model <m>] [--label <l>]
                                      Add an API key account; the key is read from stdin or A2A_API_KEY
  a2a-panel accounts key <id> [--base-url <u>] [--fast-model <m>]  Replace an API key (stdin or A2A_API_KEY)
  a2a-panel accounts services         List the API services (DeepSeek, Kimi, GLM, MiniMax, Qwen, OpenRouter, OpenAI, …)
  a2a-panel accounts budget <id> --period day|week|month --tokens N [--stop]
  a2a-panel accounts budget <id> --clear
  a2a-panel accounts login <id>       Sign in to an account in this terminal
  a2a-panel accounts check <id>       Check account sign-in status
  a2a-panel accounts logout <id>      Sign out of an account (Claude Code, Codex)
  a2a-panel accounts delete <id>      Delete an account and its isolated profile
  a2a-panel teams [list]              List configured developer teams
  a2a-panel teams show <id>           Show team details, leader and members
  a2a-panel teams new <id> --file <f> Create a team from a JSON definition file
  a2a-panel teams templates           List team templates (web, iOS, Android, Flutter, API, bug fix, review, release)
  a2a-panel teams new <id> --template <t> Create a team from a template, with your accounts picked
  a2a-panel teams delete <id>         Delete a team
  a2a-panel teams run <id> "<goal>"   Run a team on a goal (--workspace, --plan)
  a2a-panel teams runs                List recent team runs
  a2a-panel teams execute <runId>     Execute a planned team run
  a2a-panel presets [list]            List preference presets (coding style, libraries, tech defaults)
  a2a-panel presets show <id>         Print a preset's markdown files
  a2a-panel presets templates         List the starter templates presets can be created from
  a2a-panel presets new <id> [--template <t> | --from <preset>]   Create a preset
  a2a-panel presets default <id|none> Set or clear the preset used when none is given
  a2a-panel presets delete <id>       Delete a preset
  a2a-panel server start              Start A2A protocol HTTP & JSON-RPC daemon in background
  a2a-panel server stop               Stop background A2A daemon
  a2a-panel server restart            Restart A2A daemon
  a2a-panel server run                Run A2A server in foreground
  a2a-panel autostart [status]        Show whether the server starts at login
  a2a-panel autostart enable          Start the server (and dashboard) at login, and now
  a2a-panel autostart disable         Stop starting the server at login
  a2a-panel mcp                       Run A2A MCP server for Claude Code (stdio)

Options for "a2a-panel run":
  --workspace <path>   Target workspace (defaults to current directory)
  --mode <mode>        Execution mode: accept-edits (default), plan
  --effort <effort>    Reasoning effort: low, medium, high (default), xhigh, max
  --async              Run in background and print task ID
  --preset <id|none>   Preference preset to include (defaults to the default preset)
  --account <id>       Account to run the task on (defaults to "agy")

Available Roles:
  web-engineer, api-engineer, mobile-engineer, desktop-engineer,
  test-engineer, bug-triager, security-auditor, code-reviewer,
  web-performance-auditor, solution-architect, devops-engineer,
  release-manager, lead-software-engineer
`);
}

async function handleList() {
  const card = getAgentCard();
  console.log(`\nAgent Name: ${card.name} (v${card.version})`);
  console.log(`Provider:   ${card.provider.organization} (${card.provider.url})`);
  console.log(`Description:\n  ${card.description}\n`);
  console.log('Senior Software Developer Team Skills:');
  console.log('------------------------------------------------------------------------');
  (card.skills || card.roles || []).forEach(r => {
    console.log(`• \x1b[1m\x1b[36m${r.id.padEnd(25)}\x1b[0m ${r.name}`);
    console.log(`  \x1b[90m${r.description}\x1b[0m\n`);
  });
}

function checkServerOnline() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/health`, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ online: true, data: JSON.parse(body) });
        } catch {
          resolve({ online: true, data: body });
        }
      });
    });
    req.on('error', () => resolve({ online: false }));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve({ online: false });
    });
  });
}

async function handleStatus() {
  const s = await checkServerOnline();
  console.log('\n--- A2A Protocol Server Status ---');
  if (s.online) {
    console.log(`Status:      \x1b[32mONLINE\x1b[0m`);
    console.log(`URL:         http://${HOST}:${PORT}`);
    console.log(`Agent Card:  http://${HOST}:${PORT}/.well-known/agent-card.json`);
    console.log(`JSON-RPC:    http://${HOST}:${PORT}/rpc`);
    console.log(`Active Tasks: ${s.data.activeTaskCount || 0}`);
    console.log(`Dashboard:   http://${HOST}:${PORT}/dashboard`);
  } else {
    console.log(`Status:      \x1b[33mOFFLINE (Background daemon not running)\x1b[0m`);
    console.log(`(Note: Claude Code MCP connects directly via stdio without needing the HTTP daemon.)`);
  }
  const atLogin = autostart.status();
  console.log(`At login:    ${atLogin.installed ? 'starts automatically' : 'off (run "a2a-panel autostart enable")'}`);
}

async function handleServer(subcmd) {
  const managed = autostart.isInstalled();
  const report = (result, done) => {
    if (result.ok) console.log(`\x1b[32m[✓] ${done}\x1b[0m`);
    else console.error(`[A2A] ${result.output}`);
  };

  if (subcmd === 'run') {
    require('./server').startServer();
    return;
  }

  if (subcmd === 'start') {
    if (managed) {
      report(autostart.start(), `A2A server started by the login service (${autostart.LABEL})`);
      console.log(`    Dashboard: http://${HOST}:${PORT}/dashboard`);
      return;
    }
    const s = await checkServerOnline();
    if (s.online) {
      console.log(`A2A Server is already running on http://${HOST}:${PORT}`);
      return;
    }

    const outLog = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
    const errLog = fs.openSync(path.join(DATA_DIR, 'server.err'), 'a');

    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'server.js')], {
      detached: true,
      stdio: ['ignore', outLog, errLog]
    });
    child.unref();

    fs.writeFileSync(PID_FILE, child.pid.toString());
    console.log(`\x1b[32m[✓] A2A Server started in background (PID: ${child.pid})\x1b[0m`);
    return;
  }

  if (subcmd === 'stop') {
    if (managed) {
      report(autostart.stop(), 'Stopped the A2A server');
      console.log('    It starts again at your next login. Run "a2a-panel autostart disable" to turn that off.');
      return;
    }
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(PID_FILE);
        console.log(`\x1b[32m[✓] Stopped A2A Server (PID: ${pid})\x1b[0m`);
      } catch (err) {
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      }
      return;
    }
    console.log('Server is not running or already stopped.');
    return;
  }

  if (subcmd === 'restart') {
    if (managed) {
      report(autostart.restart(), 'A2A server restarted by the login service');
      return;
    }
    await handleServer('stop');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await handleServer('start');
    return;
  }

  console.log('Unknown server command. Use "a2a-panel server [start|stop|restart|run]"');
}

async function stopManualServer() {
  if (!fs.existsSync(PID_FILE)) return;
  await handleServer('stop');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function handleAutostart(args) {
  const sub = args[0] || 'status';
  try {
    if (sub === 'status') {
      const state = autostart.status();
      console.log(`Start at login: ${state.installed ? '\x1b[32mon\x1b[0m' : 'off'}${state.installed ? ` (${state.detail}${state.pid ? `, PID ${state.pid}` : ''})` : ''}`);
      if (state.installed) {
        console.log(`Service file:   ${autostart.servicePath()}`);
        console.log(`Logs:           ${autostart.logFiles().out}`);
      }
      else console.log('Run "a2a-panel autostart enable" to start the server and dashboard at login.');
      if (state.installed && autostart.lingerEnabled() === false) {
        console.log('Note: it starts when you log in. To start it at boot without logging in, run: sudo loginctl enable-linger $USER');
      }
      return;
    }
    if (sub === 'enable') {
      if (args.includes('--dry-run')) {
        const { file, content } = autostart.enable({ dryRun: true });
        console.log(`# ${file}\n${content}`);
        return;
      }
      if (!autostart.isInstalled()) await stopManualServer();
      const { file } = autostart.enable();
      console.log(`\x1b[32m[✓] The A2A server now starts at login.\x1b[0m`);
      console.log(`    Service file: ${file}`);
      console.log(`    Dashboard:    http://${HOST}:${PORT}/dashboard`);
      console.log(`    Logs:         ${autostart.logFiles().out} and server.err`);
      console.log('    Your current PATH was saved in the service. Run "a2a-panel autostart enable" again after you move agy, Node.js or this folder.');
      if (autostart.lingerEnabled() === false) {
        console.log('    It starts when you log in. To start it at boot without logging in, run: sudo loginctl enable-linger $USER');
      }
      return;
    }
    if (sub === 'disable') {
      console.log(autostart.disable() ? '\x1b[32m[✓] The A2A server no longer starts at login, and it was stopped.\x1b[0m' : 'Start at login was not enabled.');
      return;
    }
    throw new Error(`Unknown autostart command "${sub}". Use status, enable or disable.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function handleRun(args) {
  if (args.length < 2) {
    console.error('Error: "a2a-panel run" requires <role> and "<prompt>"');
    console.error('Example: a2a-panel run web-engineer "Create a responsive login form"');
    process.exit(1);
  }

  let role = null;
  let prompt = null;
  let workspace = process.cwd();
  let mode = 'accept-edits';
  let effort = 'high';
  let isAsync = false;
  let preset;
  let account;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspace = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1];
      i++;
    } else if (args[i] === '--effort' && args[i + 1]) {
      effort = args[i + 1];
      i++;
    } else if (args[i] === '--preset' && args[i + 1]) {
      preset = args[i + 1];
      i++;
    } else if (args[i] === '--account' && args[i + 1]) {
      account = args[i + 1];
      i++;
    } else if (args[i] === '--async') {
      isAsync = true;
    } else if (!args[i].startsWith('--') && role === null) {
      role = args[i];
    } else if (!args[i].startsWith('--') && prompt === null) {
      prompt = args[i];
    } else {
      console.error(`Error: unrecognized argument "${args[i]}"`);
      process.exit(1);
    }
  }

  if (!role) {
    console.error('Error: "a2a-panel run" requires a <role>');
    process.exit(1);
  }

  if (!prompt || !prompt.trim()) {
    console.error('Error: "a2a-panel run" requires a non-empty "<prompt>" (flags may appear before or after it)');
    process.exit(1);
  }

  let presetId;
  try {
    presetId = presets.resolvePresetId(preset);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n\x1b[1m\x1b[34m[A2A Dispatch]\x1b[0m Assigning task to \x1b[36m${role}\x1b[0m on account \x1b[36m${account || 'agy'}\x1b[0m...`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Mode: ${mode} | Effort: ${effort} | Preset: ${presetId || 'none'}`);
  console.log(`------------------------------------------------------------------------`);

  if (isAsync) {
    const { taskId, taskRecord } = runAgyTask({ role, prompt, workspace, mode, effort, preset, account });
    console.log(`Task dispatched in background.`);
    console.log(`Task ID: ${taskId}`);
    return;
  }

  let interrupted = false;
  const stopOnSignal = (signal) => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error(`\n[A2A] ${signal} received, stopping the task (press again to force quit)...`);
    cancelTask(foreground.taskId);
  };
  process.on('SIGINT', () => stopOnSignal('SIGINT'));
  process.on('SIGTERM', () => stopOnSignal('SIGTERM'));

  const foreground = runAgyTask({
    role,
    prompt,
    workspace,
    mode,
    effort,
    preset,
    account,
    onChunk: (chunk) => {
      process.stdout.write(chunk);
    },
    onDone: (taskRecord) => {
      console.log(`\n------------------------------------------------------------------------`);
      console.log(`\x1b[32m[A2A Finished]\x1b[0m Status: ${taskRecord.status.toUpperCase()} (Exit code: ${taskRecord.exitCode})`);
    },
    onError: (err) => {
      console.error(`\n\x1b[31m[A2A Error]\x1b[0m ${err.message}`);
      process.exit(1);
    }
  });
}

function handlePresets(args) {
  const [sub = 'list', id, ...rest] = args;
  const option = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  try {
    if (sub === 'list') {
      const list = presets.listPresets();
      if (!list.length) {
        console.log('No presets yet. Create one from a template, for example:');
        console.log('  a2a-panel presets templates');
        console.log('  a2a-panel presets new my-team --template nestjs-react');
        return;
      }
      console.log(`\nPresets (${presets.PRESETS_DIR})`);
      for (const preset of list) {
        console.log(`\n\x1b[1m\x1b[36m${preset.id}\x1b[0m${preset.isDefault ? ' \x1b[32m(default)\x1b[0m' : ''}  ${preset.title}`);
        if (preset.description) console.log(`  ${preset.description}`);
        for (const file of preset.files) console.log(`  - ${file.name}${file.roles ? `  [${file.roles.join(', ')}]` : '  [all roles]'}`);
      }
      return;
    }
    if (sub === 'templates') {
      for (const template of presets.listTemplates()) {
        console.log(`\x1b[1m${template.id}\x1b[0m  ${template.title}\n  ${template.description}\n  files: ${template.files.map((f) => f.name).join(', ')}\n`);
      }
      return;
    }
    if (!id) throw new Error(`"a2a-panel presets ${sub}" needs a preset id`);
    if (sub === 'show') {
      const preset = presets.getPreset(id);
      console.log(`# ${preset.title}${preset.isDefault ? ' (default)' : ''}\n${preset.description}`);
      for (const file of preset.files) console.log(`\n===== ${file.name} =====\n${file.content.trim()}`);
      return;
    }
    if (sub === 'new') {
      const preset = presets.createPreset({ id, template: option('--template'), from: option('--from'), title: option('--title') });
      console.log(`Created preset "${preset.id}" with ${preset.files.length} file(s) in ${path.join(presets.PRESETS_DIR, preset.id)}`);
      return;
    }
    if (sub === 'default') {
      const value = presets.setDefaultPresetId(id === 'none' ? null : id);
      console.log(value ? `Default preset is now "${value}".` : 'No default preset. Tasks run without preferences unless one is given.');
      return;
    }
    if (sub === 'delete') {
      presets.deletePreset(id);
      console.log(`Deleted preset "${id}".`);
      return;
    }
    throw new Error(`Unknown presets command "${sub}". Use list, show, templates, new, default or delete.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function handleTasks() {
  const logsDir = path.join(DATA_DIR, 'logs');
  const s = await checkServerOnline();

  let tasks = [];
  if (s.online) {
    try {
      tasks = await new Promise((resolve) => {
        http.get(`http://${HOST}:${PORT}/tasks`, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            try { resolve(JSON.parse(body).tasks || []); } catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });
    } catch {
      tasks = [];
    }
  }

  // Also check logs directory for offline history
  if (tasks.length === 0 && fs.existsSync(logsDir)) {
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    tasks = files.map(f => {
      const id = f.replace('.log', '');
      const stat = fs.statSync(path.join(logsDir, f));
      return {
        id,
        role: 'unknown',
        status: 'completed',
        startedAt: stat.birthtime.toISOString(),
        finishedAt: stat.mtime.toISOString(),
        workspace: ''
      };
    }).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 15);
  }

  console.log('\n--- Active & Recent A2A Tasks ---');
  if (tasks.length === 0) {
    console.log('No recent tasks found.');
    return;
  }

  console.log('-------------------------------------------------------------------------------------------------');
  console.log(`${'TASK ID'.padEnd(26)} ${'ROLE'.padEnd(22)} ${'STATUS'.padEnd(14)} ${'STARTED'.padEnd(20)}`);
  console.log('-------------------------------------------------------------------------------------------------');
  tasks.forEach(t => {
    let statusColored = t.status;
    if (t.status === 'running') statusColored = `\x1b[33m${t.status}\x1b[0m`;
    else if (t.status === 'completed') statusColored = `\x1b[32m${t.status}\x1b[0m`;
    else if (t.status === 'failed') statusColored = `\x1b[31m${t.status}\x1b[0m`;

    const startedTime = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : 'N/A';
    console.log(`${t.id.padEnd(26)} ${(t.role || 'developer').padEnd(22)} ${statusColored.padEnd(23)} ${startedTime.padEnd(20)}`);
  });
  console.log('-------------------------------------------------------------------------------------------------');
  console.log(`Tip: Run "a2a logs <taskId> -f" to stream a task's real-time output.\n`);
}

async function handleAccounts(args) {
  const [sub = 'list', id] = args;
  const confirmDefault = (account, action) => {
    if (account.system && !args.includes('--yes')) {
      throw new Error(`"${id}" is your default ${providers.PROVIDERS[account.provider].name} sign-in, used outside a2a-panel too. ${action} it with --yes, or add a separate account with "a2a-panel accounts add <id> --provider ${account.provider}".`);
    }
  };
  try {
    if (sub === 'list') {
      const list = accounts.listAccounts();
      console.log('\n--- Configured Accounts ---');
      console.log('-------------------------------------------------------------------------------------------------');
      console.log(`${'ID'.padEnd(16)} ${'PROVIDER'.padEnd(14)} ${'STATUS'.padEnd(14)} ${'LABEL'.padEnd(25)} DETAILS`);
      console.log('-------------------------------------------------------------------------------------------------');
      for (const a of list) {
        const pName = (providers.PROVIDERS[a.provider] && providers.PROVIDERS[a.provider].name) || a.provider;
        let coloredState = a.status.state;
        if (a.status.state === 'signed-in') coloredState = `\x1b[32m${a.status.state}\x1b[0m`;
        else if (a.status.state === 'signed-out') coloredState = `\x1b[31m${a.status.state}\x1b[0m`;
        else if (a.status.state === 'error') coloredState = `\x1b[31m${a.status.state}\x1b[0m`;
        console.log(`${a.id.padEnd(16)} ${pName.padEnd(14)} ${coloredState.padEnd(23)} ${a.label.slice(0, 24).padEnd(25)} ${a.status.detail || ''}`);
      }
      console.log('-------------------------------------------------------------------------------------------------\n');
      return;
    }
    if (sub === 'services') {
      const { listServices } = require('./api-services');
      console.log('\nAPI services for "a2a-panel accounts add <id> --service <service>":\n');
      for (const service of listServices()) {
        console.log(`${service.id.padEnd(18)} ${service.name.padEnd(40)} runs with ${providers.PROVIDERS[service.engine].name}${service.region !== 'Global' && service.region !== 'Any' ? ` (${service.region})` : ''}`);
      }
      console.log('\nPipe the key in, for example: printf %s "$DEEPSEEK_KEY" | a2a-panel accounts add deepseek-1 --service deepseek\n');
      return;
    }
    if (sub === 'add' || sub === 'key') {
      if (!id) throw new Error(sub === 'add'
        ? 'Usage: a2a-panel accounts add <id> (--provider <agy|claude|codex> | --service <service>) [--label <l>] [--model <m>]'
        : 'Usage: a2a-panel accounts key <id> [--base-url <u>] [--fast-model <m>] (key on stdin or in A2A_API_KEY)');
      const options = {};
      for (let i = 2; i < args.length; i++) {
        const name = { '--provider': 'provider', '--label': 'label', '--model': 'model', '--service': 'service', '--base-url': 'baseUrl', '--fast-model': 'fastModel' }[args[i]];
        if (name && args[i + 1] !== undefined) {
          options[name] = args[i + 1];
          i++;
        }
      }
      if (sub === 'key' || options.service) {
        const key = process.stdin.isTTY ? (process.env.A2A_API_KEY || '') : fs.readFileSync(0, 'utf-8').trim();
        if (!key && sub === 'add') throw new Error('Pipe the API key in (printf %s "$KEY" | a2a-panel accounts add ...) or set A2A_API_KEY');
        const account = sub === 'add'
          ? accounts.createAccount({ id, provider: options.provider, label: options.label, model: options.model, apiKey: { service: options.service, key, baseUrl: options.baseUrl, fastModel: options.fastModel } })
          : accounts.setApiKey(id, { key: key || undefined, baseUrl: options.baseUrl, fastModel: options.fastModel, model: options.model });
        const checked = await accounts.checkAccount(account.id);
        console.log(`${sub === 'add' ? 'Created' : 'Updated'} API key account "${checked.id}" (${require('./api-services').getService(checked.apiKey.service).name}, runs with ${providers.PROVIDERS[checked.provider].name}): ${checked.status.detail}`);
        return;
      }
      if (!options.provider) throw new Error('--provider is required (agy, claude, codex), or --service for an API key account');
      const created = accounts.createAccount({ id, provider: options.provider, label: options.label, model: options.model });
      console.log(`Created account "${created.id}" for ${providers.PROVIDERS[created.provider].name}.`);
      return;
    }
    if (sub === 'budget') {
      if (!id) throw new Error('Usage: a2a-panel accounts budget <id> --period day|week|month --tokens N [--stop] | --clear');
      const account = accounts.getAccount(id);
      if (!account) throw new Error(`Account "${id}" not found`);
      if (args.includes('--clear')) {
        accounts.setAccountBudget(id, null);
        console.log(`Cleared budget for account "${id}".`);
        return;
      }
      let period = null;
      let tokens = null;
      let stop = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--period' && args[i + 1]) {
          period = args[i + 1];
          i++;
        } else if (args[i] === '--tokens' && args[i + 1]) {
          tokens = parseInt(args[i + 1], 10);
          i++;
        } else if (args[i] === '--stop') {
          stop = true;
        }
      }
      if (!period || !['day', 'week', 'month'].includes(period)) {
        throw new Error('Invalid or missing --period (must be day, week, or month)');
      }
      if (!tokens || !Number.isInteger(tokens) || tokens < 1000) {
        throw new Error('Invalid or missing --tokens (must be an integer >= 1000)');
      }
      accounts.setAccountBudget(id, { period, tokens, stop });
      console.log(`Set ${period} budget of ${tokens.toLocaleString('en-US')} tokens for account "${id}" (stop: ${stop ? 'on' : 'off'}).`);
      return;
    }
    if (sub === 'login') {
      if (!id) throw new Error('Usage: a2a-panel accounts login <id>');
      const account = accounts.getAccount(id);
      if (!account) throw new Error(`Account "${id}" not found`);
      if (account.apiKey) throw new Error(`Account "${id}" uses an API key. Replace it with: a2a-panel accounts key ${id}`);
      confirmDefault(account, 'Sign in to');
      const env = accounts.accountEnv(account);
      const bin = providers.resolveBin(account.provider);
      if (account.provider === 'agy') {
        console.log(`\nLaunching Antigravity sign-in for account "${id}".`);
        console.log('Please sign in in the interactive interface, then quit the CLI to return here.\n');
        execFileSync(bin, [], { env, stdio: 'inherit' });
      } else {
        const cmdArgs = providers.loginArgs(account.provider, 'terminal');
        execFileSync(bin, cmdArgs, { env, stdio: 'inherit' });
      }
      const checked = await accounts.checkAccount(id);
      if (checked.status.state === 'signed-in') {
        const fresh = accounts.getAccount(id);
        fresh.signedInHere = true;
        fresh.status = { ...fresh.status, warning: null };
        accounts.saveAccount(fresh);
      }
      console.log(`\nAccount "${id}" status: ${checked.status.state} (${checked.status.detail})\n`);
      return;
    }
    if (sub === 'check') {
      if (!id) throw new Error('Usage: a2a-panel accounts check <id>');
      const checked = await accounts.checkAccount(id);
      console.log(`\nAccount "${id}": ${checked.status.state} - ${checked.status.detail}`);
      if (checked.status.warning) console.log(`Warning: ${checked.status.warning}`);
      console.log();
      return;
    }
    if (sub === 'logout') {
      if (!id) throw new Error('Usage: a2a-panel accounts logout <id>');
      const account = accounts.getAccount(id);
      if (!account) throw new Error(`Account "${id}" not found`);
      if (account.apiKey) throw new Error(`Account "${id}" uses an API key; delete the account to remove it`);
      if (account.provider === 'agy') {
        throw new Error('Antigravity has no sign-out command; delete the account to remove its sign-in');
      }
      confirmDefault(account, 'Sign out of');
      const cmdArgs = providers.logoutArgs(account.provider);
      const bin = providers.resolveBin(account.provider);
      const env = accounts.accountEnv(account);
      execFileSync(bin, cmdArgs, { env, stdio: 'inherit' });
      accounts.markSignedOut(id, 'Logged out');
      console.log(`Signed out account "${id}".`);
      return;
    }
    if (sub === 'delete') {
      if (!id) throw new Error('Usage: a2a-panel accounts delete <id>');
      accounts.deleteAccount(id);
      console.log(`Deleted account "${id}".`);
      return;
    }
    throw new Error(`Unknown accounts command "${sub}". Use list, add, login, check, logout or delete.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function followTeamRun(runId) {
  let cancelled = false;
  const onSigInt = () => {
    if (cancelled) process.exit(130);
    cancelled = true;
    console.log(`\nCancelling team run "${runId}"...`);
    try {
      teams.cancelRun(runId);
    } catch (err) {}
  };
  process.on('SIGINT', onSigInt);

  const taskStates = new Map();
  let lastStatus = null;
  let lastReviewStatus = null;

  while (true) {
    let run;
    try {
      run = teams.getRun(runId);
    } catch (err) {
      break;
    }

    if (run.status !== lastStatus) {
      if (lastStatus !== null) {
        console.log(`[Run Status] ${lastStatus} -> ${run.status}`);
      }
      lastStatus = run.status;
    }

    if (run.tasks) {
      for (const t of run.tasks) {
        const key = t.id;
        const prev = taskStates.get(key);
        if (prev !== t.status) {
          taskStates.set(key, t.status);
          const errorMsg = t.error ? ` (${t.error})` : '';
          console.log(`[Task ${t.id}] ${t.title} -> ${t.status} [${t.assignee} / ${t.role}]${errorMsg}`);
        }
      }
    }

    if (run.review && run.review.status !== lastReviewStatus) {
      lastReviewStatus = run.review.status;
      console.log(`[Review] Status: ${run.review.status}`);
    }

    if (['planned', 'completed', 'failed', 'cancelled', 'stale'].includes(run.status)) {
      console.log(`\nTeam run finished with status: \x1b[1m${run.status.toUpperCase()}\x1b[0m`);
      if (run.error) console.log(`Error: ${run.error}`);
      if (run.summary) console.log(`Plan: ${run.summary}`);
      if (run.review && run.review.output) console.log(`Review:\n${run.review.output}`);
      console.log(`Total tokens: ${run.usage?.total_tokens || 0}\n`);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  process.removeListener('SIGINT', onSigInt);
}

async function handleTeams(args) {
  const [sub = 'list', id, ...rest] = args;
  const option = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  try {
    if (sub === 'list') {
      const list = teams.listTeams();
      if (!list.length) {
        console.log('No teams configured yet.');
        return;
      }
      console.log('\n--- Configured Developer Teams ---');
      console.log('-------------------------------------------------------------------------------------------------');
      console.log(`${'ID'.padEnd(16)} ${'NAME'.padEnd(25)} ${'LEADER'.padEnd(16)} ${'MEMBERS'.padEnd(10)} PARALLEL REVIEW`);
      console.log('-------------------------------------------------------------------------------------------------');
      for (const t of list) {
        console.log(`${t.id.padEnd(16)} ${t.name.slice(0, 24).padEnd(25)} ${t.leader.account.padEnd(16)} ${String(t.members.length).padEnd(10)} ${String(t.maxParallel).padEnd(8)} ${t.review ? 'yes' : 'no'}`);
      }
      console.log('-------------------------------------------------------------------------------------------------\n');
      return;
    }

    if (sub === 'show') {
      if (!id) throw new Error('Usage: a2a-panel teams show <id>');
      const t = teams.getTeam(id);
      console.log(`\nTeam: ${t.name} (${t.id})`);
      if (t.description) console.log(`Description: ${t.description}`);
      console.log(`Leader: account=${t.leader.account}, model=${t.leader.model || 'default'}, effort=${t.leader.effort}`);
      if (t.leader.instructions) console.log(`Instructions: ${t.leader.instructions}`);
      console.log(`Workspace: ${t.workspace || '(none)'} | Preset: ${t.preset || 'default'} | MaxParallel: ${t.maxParallel} | Review: ${t.review}`);
      console.log('Members:');
      for (const m of t.members) {
        console.log(`  - ${m.account}: roles=${m.roles && m.roles.length ? m.roles.join(', ') : 'any'}${m.notes ? ` (${m.notes})` : ''}`);
      }
      console.log();
      return;
    }

    if (sub === 'templates') {
      for (const t of teams.listTeamTemplates()) {
        const roles = [...new Set(t.members.flatMap((m) => m.roles))].join(', ');
        console.log(`${t.id.padEnd(14)} ${t.title}\n${' '.repeat(15)}${t.description}\n${' '.repeat(15)}Roles: ${roles}\n`);
      }
      console.log('Create one with: a2a-panel teams new <id> --template <template>');
      return;
    }

    if (sub === 'new' && option('--template')) {
      if (!id) throw new Error('Usage: a2a-panel teams new <id> --template <template>');
      const { template, ...draft } = teams.draftFromTemplate(option('--template'));
      const created = teams.createTeam({ ...draft, id });
      console.log(`Created team "${created.id}" (${created.name}) from template "${template}".`);
      console.log(`Leader: ${created.leader.account}. Members: ${created.members.map((m) => `${m.account} (${m.roles.join(', ')})`).join('; ')}.`);
      console.log(`Change it in the panel (Teams) or with a JSON file and "a2a-panel teams new <id> --file".`);
      return;
    }

    if (sub === 'new') {
      if (!id) throw new Error('Usage: a2a-panel teams new <id> --file <team.json>');
      const filePath = option('--file');
      if (!filePath) throw new Error('--file <path> or --template <template> is required');
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
      }
      const created = teams.createTeam({ ...data, id });
      console.log(`Created team "${created.id}" (${created.name}).`);
      return;
    }

    if (sub === 'delete') {
      if (!id) throw new Error('Usage: a2a-panel teams delete <id>');
      teams.deleteTeam(id);
      console.log(`Deleted team "${id}".`);
      return;
    }

    if (sub === 'runs') {
      const runs = teams.listRuns();
      if (!runs.length) {
        console.log('No team runs found.');
        return;
      }
      console.log('\n--- Recent Team Runs ---');
      console.log('-------------------------------------------------------------------------------------------------');
      console.log(`${'RUN ID'.padEnd(25)} ${'TEAM'.padEnd(16)} ${'STATUS'.padEnd(12)} ${'TOKENS'.padEnd(10)} GOAL`);
      console.log('-------------------------------------------------------------------------------------------------');
      for (const r of runs) {
        console.log(`${r.id.padEnd(25)} ${r.teamId.padEnd(16)} ${r.status.padEnd(12)} ${String(r.usage?.total_tokens || 0).padEnd(10)} ${r.goal.slice(0, 30)}`);
      }
      console.log('-------------------------------------------------------------------------------------------------\n');
      return;
    }

    if (sub === 'execute') {
      if (!id) throw new Error('Usage: a2a-panel teams execute <runId>');
      let run = teams.executeRun(id);
      console.log(`\nExecuting team run "${id}" (team: ${run.teamName})...`);
      await followTeamRun(id);
      return;
    }

    if (sub === 'run') {
      if (!id) throw new Error('Usage: a2a-panel teams run <id> "<goal>" [--workspace <path>] [--plan]');
      const goal = rest.find((arg, index) => !arg.startsWith('-') && rest[index - 1] !== '--workspace') || '';
      if (!goal) throw new Error('Goal is required');
      const workspace = option('--workspace');
      const isPlan = rest.includes('--plan');
      const mode = isPlan ? 'plan' : 'accept-edits';

      const initialRun = teams.startRun({ teamId: id, goal, workspace, mode });
      console.log(`\nStarted team run "${initialRun.id}" for team "${initialRun.teamName}" (mode: ${mode}).`);
      await followTeamRun(initialRun.id);
      return;
    }

    throw new Error(`Unknown teams command "${sub}". Use list, show, new, delete, run, runs or execute.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function handleUsage(args = []) {
  let days = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 90) {
        days = parsed;
      }
      i++;
    }
  }
  const totals = readUsageTotals();
  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');
  console.log(`\nAntigravity usage across ${fmt(totals.tasks)} task(s)`);
  console.log(`  total     ${fmt(totals.total_tokens)}`);
  console.log(`  input     ${fmt(totals.input_tokens)}`);
  console.log(`  output    ${fmt(totals.output_tokens)}`);
  console.log(`  thinking  ${fmt(totals.thinking_tokens)}`);
  console.log(`  cached    ${fmt(totals.cache_read_tokens)}`);
  const roles = Object.entries(totals.byRole).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
  if (roles.length) {
    console.log('\nBy role');
    for (const [role, info] of roles) {
      console.log(`  ${role.padEnd(26)} ${String(info.tasks).padStart(4)} task(s)  ${fmt(info.total_tokens)} tokens`);
    }
  }
  const { getAccountsUsageReport } = require('./usage');
  const report = getAccountsUsageReport(days);
  if (report.accounts && report.accounts.length) {
    console.log(`\nBy account (${days} days: ${report.from} to ${report.to})`);
    for (const a of report.accounts) {
      const pName = (providers.PROVIDERS[a.provider] && providers.PROVIDERS[a.provider].name) || a.provider;
      console.log(`  ${a.id.padEnd(16)} (${pName}, ${a.label})`);
      console.log(`    today: ${fmt(a.today.total_tokens)} tokens · 7 days: ${fmt(a.last7d.total_tokens)} tokens · ${days} days: ${fmt(a.totals.total_tokens)} tokens`);
      if (a.limits && a.limits.windows && a.limits.windows.length) {
        const winStrs = a.limits.windows.map((w) => {
          let s = `${w.label}: ${w.usedPercent}%`;
          if (w.resetsAt) {
            const d = new Date(w.resetsAt);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            s += ` (resets ${hh}:${mm})`;
          }
          return s;
        });
        console.log(`    quota:   ${winStrs.join(', ')}`);
      } else if (a.limits && a.limits.status === 'limited') {
        console.log(`    quota:   LIMITED (${a.limits.detail || 'limit reached'})`);
      }
      if (a.budget) {
        const bUsed = a.budgetUsed ? `${a.budgetUsed.percent}% (${fmt(a.budgetUsed.tokens)} / ${fmt(a.budget.tokens)})` : `0% (0 / ${fmt(a.budget.tokens)})`;
        console.log(`    budget:  ${bUsed} per ${a.budget.period}${a.budget.stop ? ' [enforced: stop on limit]' : ''}`);
      }
    }
  }
  console.log('\nThese tokens ran on Antigravity, not in your Claude context. Claude only paid for the short result it read back.\n');
}

async function handleLogs(args) {
  const logsDir = path.join(DATA_DIR, 'logs');
  let follow = false;
  let targetId = null;

  for (const arg of args) {
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (!arg.startsWith('-')) {
      targetId = arg;
    }
  }

  let logPath = null;
  if (targetId) {
    const directPath = path.join(logsDir, targetId.endsWith('.log') ? targetId : `${targetId}.log`);
    if (fs.existsSync(directPath)) {
      logPath = directPath;
    } else {
      console.error(`Task log not found for ID "${targetId}". Check available tasks with "a2a tasks".`);
      return;
    }
  } else {
    // Find latest log in logsDir or fallback to server.log
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ name: f, time: fs.statSync(path.join(logsDir, f)).mtime }))
        .sort((a, b) => b.time - a.time);

      if (files.length > 0) {
        logPath = path.join(logsDir, files[0].name);
        console.log(`\x1b[90m[Showing latest task log: ${files[0].name}]\x1b[0m\n`);
      }
    }
    if (!logPath) {
      logPath = path.join(DATA_DIR, 'server.log');
      console.log(`\x1b[90m[Showing A2A server log]\x1b[0m\n`);
    }
  }

  if (follow) {
    console.log(`\x1b[36mStreaming ${path.basename(logPath)} (Ctrl+C to stop)...\x1b[0m\n`);
    const tailProc = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    process.on('SIGINT', () => {
      tailProc.kill();
      process.exit(0);
    });
  } else {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      console.log(content || '(Log is empty)');
    } else {
      console.log('Log file does not exist yet.');
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    showHelp();
    return;
  }

  if (cmd === 'list') {
    await handleList();
    return;
  }

  if (cmd === 'status') {
    await handleStatus();
    return;
  }

  if (cmd === 'tasks' || cmd === 'ps') {
    await handleTasks();
    return;
  }

  if (cmd === 'doctor') {
    const { runDoctor, printDoctor } = require('./setup');
    process.exit(printDoctor(runDoctor()) ? 0 : 1);
  }

  if (cmd === 'init') {
    const { runInit } = require('./setup');
    process.exit(runInit({ dryRun: args.includes('--dry-run') }) ? 0 : 1);
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(require('../package.json').version);
    return;
  }

  if (cmd === 'usage') {
    handleUsage(args.slice(1));
    return;
  }

  if (cmd === 'logs') {
    await handleLogs(args.slice(1));
    return;
  }

  if (cmd === 'dashboard') {
    const panelUrl = `http://${HOST}:${PORT}/dashboard`;
    console.log(panelUrl);
    if (!args.includes('--no-open')) spawn(OPEN_COMMAND, [panelUrl], { stdio: 'ignore', detached: true }).unref();
    return;
  }

  if (cmd === 'server') {
    await handleServer(args[1] || 'start');
    return;
  }

  if (cmd === 'mcp') {
    require('./mcp-server');
    return;
  }

  if (cmd === 'autostart') {
    await handleAutostart(args.slice(1));
    return;
  }

  if (cmd === 'accounts' || cmd === 'account') {
    await handleAccounts(args.slice(1));
    return;
  }

  if (cmd === 'teams' || cmd === 'team') {
    await handleTeams(args.slice(1));
    return;
  }

  if (cmd === 'presets' || cmd === 'preset') {
    handlePresets(args.slice(1));
    return;
  }

  if (cmd === 'run') {
    await handleRun(args.slice(1));
    return;
  }

  console.error(`Unknown command: "${cmd}". Run "a2a-panel help" for usage.`);
  process.exit(1);
}

main();

