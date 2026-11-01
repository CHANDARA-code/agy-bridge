const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'c'.repeat(64);
const FAKE_AGY = path.join(__dirname, 'fake-agy.sh');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.sh');
const FAKE_CODEX = path.join(__dirname, 'fake-codex.sh');
const instances = [];

function authed(extra = {}) {
  return { 'X-A2A-Token': TOKEN, 'Content-Type': 'application/json', ...extra };
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

async function startInstance(extraEnv = {}) {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-team-test-'));
  const logsDir = path.join(sandbox, 'logs');
  const tokenFile = path.join(sandbox, 'token');
  const workspace = path.join(sandbox, 'ws');
  const presetsDir = path.join(sandbox, 'presets');
  const accountsDir = path.join(sandbox, 'accounts');
  const teamsDir = path.join(sandbox, 'teams');
  const realHome = path.join(sandbox, 'home');
  const argsFile = path.join(sandbox, 'fake_args.log');

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(presetsDir, { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(teamsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(realHome, { recursive: true });
  fs.writeFileSync(tokenFile, TOKEN + '\n');

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      HOME: realHome,
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
      CODEX_BIN: FAKE_CODEX,
      FAKE_ARGS_FILE: argsFile,
      FAKE_AGY_MODE: 'stream',
      FAKE_CLAUDE_MODE: 'stream',
      FAKE_CODEX_MODE: 'stream',
      ...extraEnv
    },
    stdio: 'ignore'
  });

  const instance = {
    port,
    base: `http://127.0.0.1:${port}`,
    sandbox,
    logsDir,
    workspace,
    presetsDir,
    accountsDir,
    teamsDir,
    realHome,
    argsFile,
    proc
  };
  instances.push(instance);

  await waitFor(async () => {
    try {
      return (await fetch(`${instance.base}/health`)).ok;
    } catch (err) {
      return false;
    }
  });

  return instance;
}

let main;

before(async () => {
  main = await startInstance();
  process.env.HOME = main.realHome;
  process.env.A2A_ACCOUNTS_DIR = main.accountsDir;
  process.env.A2A_REAL_HOME = main.realHome;
  process.env.A2A_TEAMS_DIR = main.teamsDir;
  process.env.A2A_LOGS_DIR = main.logsDir;
  process.env.A2A_PRESETS_DIR = main.presetsDir;
  process.env.AGY_BIN = FAKE_AGY;
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_AGY_MODE = 'stream';
  process.env.FAKE_CLAUDE_MODE = 'stream';
  process.env.FAKE_CODEX_MODE = 'stream';
});

after(() => {
  for (const instance of instances) {
    try {
      instance.proc.kill('SIGKILL');
    } catch (err) {}
    try {
      fs.rmSync(instance.sandbox, { recursive: true, force: true });
    } catch (err) {}
  }
});

function writeClaudeReplay(accountId, lines) {
  let dir;
  if (accountId === 'claude') {
    dir = path.join(main.realHome, '.claude');
  } else {
    dir = path.join(main.accountsDir, accountId, 'claude');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-replay'), lines.join('\n') + '\n');
}

function writeAgyReplay(accountId, lines) {
  let dir;
  if (accountId === 'agy') {
    dir = main.realHome;
  } else {
    dir = path.join(main.accountsDir, accountId, 'home');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.agy-replay'), lines.join('\n') + '\n');
}

function clearReplays() {
  const tryUnlink = (p) => {
    try { fs.unlinkSync(p); } catch (e) {}
  };
  tryUnlink(path.join(main.realHome, '.agy-replay'));
  tryUnlink(path.join(main.realHome, '.claude', '.claude-replay'));
}

function planReplay(plan) {
  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-plan' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 10, output_tokens: 10 }
    })
  ];
}

function setClaudeMode(accountId, mode) {
  const dir = path.join(main.accountsDir, accountId, 'claude');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.unlinkSync(path.join(dir, '.claude-replay')); } catch (e) {}
  fs.writeFileSync(path.join(dir, '.claude-mode'), mode + '\n');
}

async function createClaudeAccounts(ids) {
  for (const id of ids) {
    const res = await fetch(`${main.base}/api/accounts`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ id, provider: 'claude', label: id })
    });
    assert.strictEqual(res.status, 201);
  }
}

async function createTeamOverHttp(body) {
  const res = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify(body)
  });
  assert.strictEqual(res.status, 201);
}

function oneTaskPlan(assignee) {
  return {
    summary: 'One step',
    tasks: [
      {
        id: 't1',
        title: 'Only step',
        assignee,
        role: 'web-engineer',
        prompt: 'Do the only step',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      }
    ]
  };
}

function taskCountFor(accountId) {
  return fs.readdirSync(main.logsDir)
    .filter((f) => f.endsWith('.log'))
    .filter((f) => fs.readFileSync(path.join(main.logsDir, f), 'utf-8').includes(`\nAccount: ${accountId}\n`))
    .length;
}

function nodeScript(body) {
  return [
    `const teams = require(${JSON.stringify(path.join(ROOT, 'src', 'teams.js'))});`,
    'setTimeout(() => process.exit(3), 20000).unref();',
    body
  ].join('\n');
}

function untilRunEnds(runIdExpression) {
  return [
    'const timer = setInterval(() => {',
    `  if (['completed', 'failed', 'cancelled'].includes(teams.getRun(${runIdExpression}).status)) clearInterval(timer);`,
    '}, 50);'
  ].join('\n');
}

function spawnNode(script) {
  const child = spawn(process.execPath, ['-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.closed = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return child;
}

test('team validation and CRUD via HTTP and CLI', async () => {
  const badIdRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'default',
      name: 'Bad Team',
      leader: { account: 'agy' },
      members: [{ account: 'agy', roles: [] }]
    })
  });
  assert.strictEqual(badIdRes.status, 400);

  const unknownLeaderRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'team-bad-leader',
      name: 'Bad Leader',
      leader: { account: 'non-existent' },
      members: [{ account: 'agy', roles: [] }]
    })
  });
  assert.strictEqual(unknownLeaderRes.status, 400);

  const unknownRoleRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'team-bad-role',
      name: 'Bad Role',
      leader: { account: 'agy' },
      members: [{ account: 'agy', roles: ['non-existent-role'] }]
    })
  });
  assert.strictEqual(unknownRoleRes.status, 400);

  const dupMemberRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'team-dup',
      name: 'Dup Member',
      leader: { account: 'agy' },
      members: [
        { account: 'agy', roles: [] },
        { account: 'agy', roles: [] }
      ]
    })
  });
  assert.strictEqual(dupMemberRes.status, 400);

  const badMaxRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'team-bad-max',
      name: 'Bad Max',
      leader: { account: 'agy' },
      members: [{ account: 'agy', roles: [] }],
      maxParallel: 5
    })
  });
  assert.strictEqual(badMaxRes.status, 400);

  const badPresetRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'team-bad-preset',
      name: 'Bad Preset',
      leader: { account: 'agy' },
      members: [{ account: 'agy', roles: [] }],
      preset: 'unknown-preset-xyz'
    })
  });
  assert.strictEqual(badPresetRes.status, 400);

  const createRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'alpha-team',
      name: 'Alpha Team',
      description: 'The core alpha engineering squad',
      leader: {
        account: 'claude',
        model: null,
        effort: 'high',
        instructions: 'Plan meticulously.'
      },
      members: [
        { account: 'agy', roles: ['web-engineer', 'api-engineer'], notes: 'Frontend/backend dev' },
        { account: 'codex', roles: ['test-engineer'], notes: 'QA' }
      ],
      preset: null,
      workspace: null,
      maxParallel: 2,
      review: true
    })
  });
  assert.strictEqual(createRes.status, 201);
  const created = (await createRes.json()).team;
  assert.strictEqual(created.id, 'alpha-team');
  assert.strictEqual(created.name, 'Alpha Team');
  assert.strictEqual(created.maxParallel, 2);
  assert.strictEqual(created.review, true);

  const listRes = await fetch(`${main.base}/api/teams`);
  assert.strictEqual(listRes.status, 200);
  const list = (await listRes.json()).teams;
  assert.ok(list.some((t) => t.id === 'alpha-team'));

  const getRes = await fetch(`${main.base}/api/teams/alpha-team`);
  assert.strictEqual(getRes.status, 200);
  const fetched = (await getRes.json()).team;
  assert.strictEqual(fetched.name, 'Alpha Team');

  const updateRes = await fetch(`${main.base}/api/teams/alpha-team`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({
      name: 'Alpha Squad Updated',
      maxParallel: 3
    })
  });
  assert.strictEqual(updateRes.status, 200);
  const updated = (await updateRes.json()).team;
  assert.strictEqual(updated.name, 'Alpha Squad Updated');
  assert.strictEqual(updated.maxParallel, 3);

  const cliOut = execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'teams', 'show', 'alpha-team'], {
    env: { ...process.env, A2A_TEAMS_DIR: main.teamsDir, A2A_ACCOUNTS_DIR: main.accountsDir },
    encoding: 'utf-8'
  });
  assert.ok(cliOut.includes('Alpha Squad Updated'));
  assert.ok(cliOut.includes('MaxParallel: 3'));

  const deleteRes = await fetch(`${main.base}/api/teams/alpha-team`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(deleteRes.status, 200);
  assert.deepStrictEqual(await deleteRes.json(), { deleted: 'alpha-team' });

  const getAfterDel = await fetch(`${main.base}/api/teams/alpha-team`);
  assert.strictEqual(getAfterDel.status, 404);
});

test('deleting an account used by a team returns 409', async () => {
  const accRes = await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'team-dev-acc',
      provider: 'agy',
      label: 'Team Specialist'
    })
  });
  assert.strictEqual(accRes.status, 201);

  const teamRes = await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'beta-team',
      name: 'Beta Team',
      leader: { account: 'claude' },
      members: [{ account: 'team-dev-acc', roles: [] }]
    })
  });
  assert.strictEqual(teamRes.status, 201);

  const delAccRes = await fetch(`${main.base}/api/accounts/team-dev-acc`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(delAccRes.status, 409);
  const body = await delAccRes.json();
  assert.strictEqual(body.error, 'Account "team-dev-acc" is used by team(s): Beta Team. Change those teams first.');

  await fetch(`${main.base}/api/teams/beta-team`, { method: 'DELETE', headers: authed() });

  const delAfterTeam = await fetch(`${main.base}/api/accounts/team-dev-acc`, {
    method: 'DELETE',
    headers: authed()
  });
  assert.strictEqual(delAfterTeam.status, 200);
});

test('leader prompt contains members, roles and goal and runs read-only', async () => {
  clearReplays();
  fs.writeFileSync(main.argsFile, '');

  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'prompt-test-team',
      name: 'Prompt Inspection Team',
      description: 'Inspects prompts thoroughly',
      leader: { account: 'claude', effort: 'medium', instructions: 'Always return valid JSON.' },
      members: [
        { account: 'agy', roles: ['web-engineer'], notes: 'Frontend specialist' },
        { account: 'codex', roles: [], notes: 'Generalist' }
      ]
    })
  });

  const plan = {
    summary: 'Test plan summary',
    tasks: [
      {
        id: 't1',
        title: 'Initial task',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Do task 1',
        acceptance_criteria: ['check1'],
        verification_command: null,
        depends_on: []
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan, null, 2) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-p1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 80, output_tokens: 40 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/prompt-test-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Build an ultra-fast search bar',
      workspace: main.workspace,
      mode: 'plan'
    })
  });
  assert.strictEqual(runRes.status, 202);
  const run = (await runRes.json()).run;

  const finishedRun = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${run.id}`)).json();
    return r.run.status === 'planned' ? r.run : null;
  });
  assert.strictEqual(finishedRun.status, 'planned');

  const argsLogged = fs.readFileSync(main.argsFile, 'utf-8');
  assert.ok(argsLogged.includes('--permission-mode dontAsk'));
  assert.ok(argsLogged.includes('Bash(git status:*)'));
  assert.ok(argsLogged.includes('### YOUR ROLE'));
  assert.ok(argsLogged.includes('You are the team leader of "Prompt Inspection Team". Inspects prompts thoroughly'));
  assert.ok(argsLogged.includes('Always return valid JSON.'));
  assert.ok(argsLogged.includes('### YOUR TEAM'));
  assert.ok(argsLogged.includes('- agy (Antigravity, Default Antigravity sign-in): roles web-engineer. Frontend specialist'));
  assert.ok(argsLogged.includes('Role ids:'));
  assert.ok(argsLogged.includes('### GOAL\nBuild an ultra-fast search bar'));
  assert.ok(argsLogged.includes(`### WORKSPACE\n${main.workspace}`));

  clearReplays();
});

test('plan mode -> planned with tasks and no developer task started, then execute', async () => {
  clearReplays();
  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'plan-mode-team',
      name: 'Plan Mode Team',
      leader: { account: 'claude' },
      members: [{ account: 'agy', roles: [] }]
    })
  });

  const plan = {
    summary: 'Two step plan',
    tasks: [
      {
        id: 't1',
        title: 'Step 1',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Step 1 prompt',
        acceptance_criteria: ['step1 ok'],
        verification_command: null,
        depends_on: []
      },
      {
        id: 't2',
        title: 'Step 2',
        assignee: 'agy',
        role: 'api-engineer',
        prompt: 'Step 2 prompt',
        acceptance_criteria: ['step2 ok'],
        verification_command: null,
        depends_on: ['t1']
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-pm' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 50, output_tokens: 30 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/plan-mode-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Plan only run',
      workspace: main.workspace,
      mode: 'plan'
    })
  });
  const runId = (await runRes.json()).run.id;

  const planned = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'planned' ? r.run : null;
  });

  assert.strictEqual(planned.status, 'planned');
  assert.strictEqual(planned.tasks.length, 2);
  assert.strictEqual(planned.tasks[0].status, 'pending');
  assert.strictEqual(planned.tasks[0].taskId, null);
  assert.strictEqual(planned.tasks[1].status, 'pending');
  assert.strictEqual(planned.tasks[1].taskId, null);

  const execRes = await fetch(`${main.base}/api/team-runs/${runId}/execute`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(execRes.status, 200);

  const runningRun = (await execRes.json()).run;
  assert.ok(['running', 'completed'].includes(runningRun.status));

  const secondExec = await fetch(`${main.base}/api/team-runs/${runId}/execute`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(secondExec.status, 409);

  const completed = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'completed' ? r.run : null;
  });
  assert.strictEqual(completed.status, 'completed');
  assert.strictEqual(completed.tasks[0].status, 'completed');
  assert.strictEqual(completed.tasks[1].status, 'completed');

  clearReplays();
});

test('t2 depends on t1 -> t2 starts only after t1 completed and prompt includes t1 output', async () => {
  clearReplays();
  fs.writeFileSync(main.argsFile, '');

  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'dep-test-team',
      name: 'Dependency Test Team',
      leader: { account: 'claude' },
      members: [{ account: 'agy', roles: [] }]
    })
  });

  const plan = {
    summary: 'Chained tasks',
    tasks: [
      {
        id: 't1',
        title: 'Task One',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'First implementation',
        acceptance_criteria: ['t1 passes'],
        verification_command: null,
        depends_on: []
      },
      {
        id: 't2',
        title: 'Task Two',
        assignee: 'agy',
        role: 'test-engineer',
        prompt: 'Second implementation',
        acceptance_criteria: ['t2 passes'],
        verification_command: null,
        depends_on: ['t1']
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-dep' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 50, output_tokens: 30 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/dep-test-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'End to end chaining test',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runId = (await runRes.json()).run.id;

  const finished = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'completed' ? r.run : null;
  });

  assert.strictEqual(finished.status, 'completed');
  assert.ok(new Date(finished.tasks[1].startedAt) >= new Date(finished.tasks[0].finishedAt));

  const argsLogged = fs.readFileSync(main.argsFile, 'utf-8');
  assert.ok(argsLogged.includes('### RESULTS OF EARLIER TASKS'));
  assert.ok(argsLogged.includes('#### t1: Task One (completed)'));
  assert.ok(argsLogged.includes('### YOUR TASK\nSecond implementation'));

  clearReplays();
});

test('a failed t1 -> t2 skipped and run failed', async () => {
  clearReplays();
  await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'failing-dev',
      provider: 'claude',
      label: 'Failing Dev'
    })
  });

  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'fail-chain-team',
      name: 'Fail Chain Team',
      leader: { account: 'claude' },
      members: [
        { account: 'failing-dev', roles: ['web-engineer'] },
        { account: 'agy', roles: ['api-engineer'] }
      ]
    })
  });

  const plan = {
    summary: 'Plan with failure',
    tasks: [
      {
        id: 't1',
        title: 'Step 1 Fail',
        assignee: 'failing-dev',
        role: 'web-engineer',
        prompt: 'Fail me',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      },
      {
        id: 't2',
        title: 'Step 2 Dep',
        assignee: 'agy',
        role: 'api-engineer',
        prompt: 'Should be skipped',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: ['t1']
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fc-lead' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 50, output_tokens: 30 }
    })
  ]);

  writeClaudeReplay('failing-dev', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fc-fail' }),
    JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Dev build crashed',
      error: 'Simulated dev crash',
      usage: { input_tokens: 20, output_tokens: 5 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/fail-chain-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Trigger failure chain',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runId = (await runRes.json()).run.id;

  const finished = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'failed' ? r.run : null;
  });

  assert.strictEqual(finished.status, 'failed');
  assert.strictEqual(finished.tasks[0].status, 'failed');
  assert.strictEqual(finished.tasks[1].status, 'skipped');
  assert.strictEqual(finished.tasks[1].error, 'Skipped because t1 did not complete');
  assert.strictEqual(finished.error, '2 of 2 tasks did not complete');

  clearReplays();

  const reversedPlan = {
    summary: 'Plan with reversed dependencies',
    tasks: [
      {
        id: 't3',
        title: 'Step 3 Dep 2',
        assignee: 'agy',
        role: 'api-engineer',
        prompt: 'Should be skipped too',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: ['t2']
      },
      {
        id: 't2',
        title: 'Step 2 Dep 1',
        assignee: 'agy',
        role: 'api-engineer',
        prompt: 'Should be skipped',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: ['t1']
      },
      {
        id: 't1',
        title: 'Step 1 Fail',
        assignee: 'failing-dev',
        role: 'web-engineer',
        prompt: 'Fail me',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      }
    ]
  };
  const reversedPlanText = '```json\n' + JSON.stringify(reversedPlan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fc-rev-lead' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reversedPlanText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: reversedPlanText,
      usage: { input_tokens: 50, output_tokens: 30 }
    })
  ]);

  writeClaudeReplay('failing-dev', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fc-rev-fail' }),
    JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Dev build crashed',
      error: 'Simulated dev crash',
      usage: { input_tokens: 20, output_tokens: 5 }
    })
  ]);

  const runResRev = await fetch(`${main.base}/api/teams/fail-chain-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Trigger reversed failure chain',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runIdRev = (await runResRev.json()).run.id;

  const finishedRev = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runIdRev}`)).json();
    return r.run.status === 'failed' ? r.run : null;
  }, 4000);

  assert.strictEqual(finishedRev.status, 'failed');
  const t1 = finishedRev.tasks.find((t) => t.id === 't1');
  const t2 = finishedRev.tasks.find((t) => t.id === 't2');
  const t3 = finishedRev.tasks.find((t) => t.id === 't3');
  assert.strictEqual(t1.status, 'failed');
  assert.strictEqual(t2.status, 'skipped');
  assert.strictEqual(t3.status, 'skipped');
  assert.strictEqual(finishedRev.error, '3 of 3 tasks did not complete');

  clearReplays();
});

test('invalid plan -> run failed with leader taskId kept', async () => {
  clearReplays();
  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'invalid-plan-team',
      name: 'Invalid Plan Team',
      leader: { account: 'claude' },
      members: [{ account: 'agy', roles: [] }]
    })
  });

  const invalidPlanText = '```json\n{"summary": "Broken", "tasks": []}\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-invalid-p' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: invalidPlanText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: invalidPlanText,
      usage: { input_tokens: 40, output_tokens: 15 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/invalid-plan-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Should fail validation',
      workspace: main.workspace,
      mode: 'plan'
    })
  });
  const runId = (await runRes.json()).run.id;

  const failedRun = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'failed' ? r.run : null;
  });

  assert.strictEqual(failedRun.status, 'failed');
  assert.ok(failedRun.error.includes('between 1 and 12 tasks'));
  assert.ok(typeof failedRun.leader.taskId === 'string' && failedRun.leader.taskId.startsWith('a2a_'));

  clearReplays();
});

test('cancel stops running developer task and cancels pending ones', async () => {
  clearReplays();
  await fetch(`${main.base}/api/accounts`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'stubborn-dev',
      provider: 'claude',
      label: 'Stubborn Dev'
    })
  });

  const stubbornDir = path.join(main.accountsDir, 'stubborn-dev', 'claude');
  fs.mkdirSync(stubbornDir, { recursive: true });
  fs.writeFileSync(path.join(stubbornDir, '.claude-mode'), 'stubborn\n');

  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'cancel-test-team',
      name: 'Cancel Test Team',
      leader: { account: 'claude' },
      members: [
        { account: 'stubborn-dev', roles: [] },
        { account: 'agy', roles: [] }
      ]
    })
  });

  const plan = {
    summary: 'Plan to cancel',
    tasks: [
      {
        id: 't1',
        title: 'Running long',
        assignee: 'stubborn-dev',
        role: 'web-engineer',
        prompt: 'Run long',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      },
      {
        id: 't2',
        title: 'Pending task',
        assignee: 'agy',
        role: 'api-engineer',
        prompt: 'Will be cancelled before run',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: ['t1']
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-c-plan' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 50, output_tokens: 25 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/cancel-test-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Cancel test goal',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runId = (await runRes.json()).run.id;

  const devTask = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.tasks && r.run.tasks[0] && r.run.tasks[0].status === 'running' ? r.run.tasks[0] : null;
  });

  const pidFile = path.join(main.logsDir, `${devTask.taskId}.pid`);
  let devPid = null;
  if (fs.existsSync(pidFile)) {
    try {
      devPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    } catch (e) {}
  }
  assert.ok(devPid && devPid > 1);

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  };
  assert.strictEqual(isAlive(devPid), true);

  const cancelRes = await fetch(`${main.base}/api/team-runs/${runId}/cancel`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(cancelRes.status, 200);

  const cancelledRun = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'cancelled' ? r.run : null;
  });

  assert.strictEqual(cancelledRun.status, 'cancelled');
  assert.strictEqual(cancelledRun.tasks[0].status, 'cancelled');
  assert.strictEqual(cancelledRun.tasks[1].status, 'cancelled');

  await waitFor(() => !isAlive(devPid), 10000);
  assert.strictEqual(isAlive(devPid), false);

  clearReplays();
});

test('review runs when enabled', async () => {
  clearReplays();
  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'review-team',
      name: 'Review Team',
      review: true,
      leader: { account: 'claude' },
      members: [{ account: 'agy', roles: [] }]
    })
  });

  const plan = {
    summary: 'Plan for review',
    tasks: [
      {
        id: 't1',
        title: 'Simple task',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Build simple page',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-rev-plan' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 40, output_tokens: 20 }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/review-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Test review trigger',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runId = (await runRes.json()).run.id;

  const finished = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'completed' && r.run.review ? r.run : null;
  }, 10000);

  assert.strictEqual(finished.status, 'completed');
  assert.ok(finished.review);
  assert.strictEqual(finished.review.status, 'completed');
  assert.ok(typeof finished.review.taskId === 'string');

  clearReplays();
});

test('a run with a dead pid reads stale without rewriting the file', async () => {
  const teamsModule = require('../src/teams');
  const runId = 'run_1000000000_deadpid';
  const file = teamsModule.runFile(runId);
  const data = {
    id: runId,
    teamId: 'stale-team',
    teamName: 'Stale Team',
    goal: 'Test stale behavior',
    workspace: main.workspace,
    mode: 'plan',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    leader: { account: 'agy', taskId: null },
    summary: null,
    tasks: [],
    review: null,
    usage: { total_tokens: 0 },
    pid: 999999
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

  const getRes = await fetch(`${main.base}/api/team-runs/${runId}`);
  assert.strictEqual(getRes.status, 200);
  const fetched = (await getRes.json()).run;
  assert.strictEqual(fetched.status, 'stale');

  const rawOnDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(rawOnDisk.status, 'running');

  try { fs.unlinkSync(file); } catch (e) {}
});

test('usage.total_tokens sums leader, developer and review tasks', async () => {
  clearReplays();
  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'tokens-team',
      name: 'Tokens Team',
      review: true,
      leader: { account: 'claude' },
      members: [{ account: 'agy', roles: [] }]
    })
  });

  const plan = {
    summary: 'Tokens sum plan',
    tasks: [
      {
        id: 't1',
        title: 'Token task',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Use tokens',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      }
    ]
  };

  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tok-lead' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 70, output_tokens: 30 }
    })
  ]);

  writeAgyReplay('agy', [
    JSON.stringify({ event: 'init', conversation_id: 'conv-tok-dev', init: { cwd: main.workspace } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Dev work done' } }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-tok-dev',
        status: 'SUCCESS',
        response: 'Dev work done',
        usage: { input_tokens: 150, output_tokens: 50, total_tokens: 200 }
      }
    })
  ]);

  const runRes = await fetch(`${main.base}/api/teams/tokens-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Check tokens summation',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runId = (await runRes.json()).run.id;

  const finished = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId}`)).json();
    return r.run.status === 'completed' && r.run.review ? r.run : null;
  });

  assert.strictEqual(finished.status, 'completed');
  assert.ok(finished.review);
  assert.strictEqual(finished.review.status, 'completed');
  assert.strictEqual(finished.usage.total_tokens, 400);

  clearReplays();
});

test('MCP tools/list includes the four team tools', async () => {
  const mcpProc = spawn(process.execPath, [path.join(ROOT, 'mcp-server.js')], {
    env: { ...process.env, A2A_TEAMS_DIR: main.teamsDir, A2A_ACCOUNTS_DIR: main.accountsDir }
  });

  const sendReq = (msg) => {
    mcpProc.stdin.write(JSON.stringify(msg) + '\n');
  };

  const responsePromise = new Promise((resolve) => {
    let buf = '';
    mcpProc.stdout.on('data', (d) => {
      buf += d.toString('utf-8');
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 42) {
            resolve(parsed.result);
          }
        } catch (e) {}
      }
    });
  });

  sendReq({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} });
  const result = await responsePromise;
  mcpProc.kill('SIGTERM');

  assert.ok(result && Array.isArray(result.tools));
  const toolNames = result.tools.map((t) => t.name);
  assert.ok(toolNames.includes('a2a_list_teams'));
  assert.ok(toolNames.includes('a2a_run_team'));
  assert.ok(toolNames.includes('a2a_get_team_run'));
  assert.ok(toolNames.includes('a2a_cancel_team_run'));
  assert.strictEqual(toolNames[0], 'a2a_dispatch_to_antigravity');
});

test('defect 1: verification command runs only for approved plan-first runs, not accept-edits', async () => {
  clearReplays();
  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'verify-guard-team',
      name: 'Verify Guard Team',
      leader: { account: 'claude' },
      members: [{ account: 'agy', roles: [] }]
    })
  });

  const planApproved = {
    summary: 'Plan with verification',
    tasks: [
      {
        id: 't1',
        title: 'Task with verification',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Build something',
        acceptance_criteria: [],
        verification_command: 'echo approved_check',
        depends_on: []
      }
    ]
  };
  const planApprovedText = '```json\n' + JSON.stringify(planApproved) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-v1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planApprovedText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planApprovedText,
      usage: { input_tokens: 30, output_tokens: 20 }
    })
  ]);

  const runRes1 = await fetch(`${main.base}/api/teams/verify-guard-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Approved verification run',
      workspace: main.workspace,
      mode: 'plan'
    })
  });
  const runId1 = (await runRes1.json()).run.id;

  await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId1}`)).json();
    return r.run.status === 'planned' ? r.run : null;
  });

  const execRes = await fetch(`${main.base}/api/team-runs/${runId1}/execute`, {
    method: 'POST',
    headers: authed()
  });
  assert.strictEqual(execRes.status, 200);

  const completed1 = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId1}`)).json();
    return r.run.status === 'completed' ? r.run : null;
  });
  assert.strictEqual(completed1.status, 'completed');
  const task1Id = completed1.tasks[0].taskId;
  const logText1 = await (await fetch(`${main.base}/api/tasks/${task1Id}/log`)).text();
  assert.ok(logText1.includes('=== VERIFICATION (run by a2a-panel, not the agent)'));
  assert.ok(completed1.tasks[0].verification);
  assert.strictEqual(completed1.tasks[0].verification.passed, true);

  clearReplays();

  const planUnapproved = {
    summary: 'Plan unapproved',
    tasks: [
      {
        id: 't1',
        title: 'Task unapproved verification',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Build something else',
        acceptance_criteria: [],
        verification_command: 'echo unapproved_check',
        depends_on: []
      }
    ]
  };
  const planUnapprovedText = '```json\n' + JSON.stringify(planUnapproved) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-v2' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planUnapprovedText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planUnapprovedText,
      usage: { input_tokens: 30, output_tokens: 20 }
    })
  ]);

  const runRes2 = await fetch(`${main.base}/api/teams/verify-guard-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      goal: 'Accept-edits verification run',
      workspace: main.workspace,
      mode: 'accept-edits'
    })
  });
  const runId2 = (await runRes2.json()).run.id;

  const completed2 = await waitFor(async () => {
    const r = await (await fetch(`${main.base}/api/team-runs/${runId2}`)).json();
    return r.run.status === 'completed' ? r.run : null;
  });
  assert.strictEqual(completed2.status, 'completed');
  assert.strictEqual(completed2.tasks[0].verification_command, 'echo unapproved_check');
  const task2Id = completed2.tasks[0].taskId;
  const task2Record = (await (await fetch(`${main.base}/api/tasks/${task2Id}`)).json()).task;
  assert.strictEqual(completed2.tasks[0].verification || null, null);
  const logText2 = await (await fetch(`${main.base}/api/tasks/${task2Id}/log`)).text();
  assert.strictEqual(logText2.includes('=== VERIFICATION (run by a2a-panel, not the agent)'), false);
  assert.ok(task2Record.prompt.includes('### CHECK BEFORE YOU FINISH\nRun `echo unapproved_check` in the workspace and report its result.'));

  clearReplays();
});

test('defect 2: validate run id pattern against path traversal and malformed ids', async () => {
  const teamsModule = require('../src/teams');
  const badIds = ['../../teams/x', 'run_1/../x', ''];
  for (const badId of badIds) {
    assert.throws(
      () => teamsModule.getRun(badId),
      (err) => err instanceof teamsModule.TeamError && err.code === 400 && err.message === 'Invalid run id'
    );
    assert.throws(
      () => teamsModule.getRawRun(badId),
      (err) => err instanceof teamsModule.TeamError && err.code === 400 && err.message === 'Invalid run id'
    );
    assert.throws(
      () => teamsModule.cancelRun(badId),
      (err) => err instanceof teamsModule.TeamError && err.code === 400 && err.message === 'Invalid run id'
    );
    assert.throws(
      () => teamsModule.executeRun(badId),
      (err) => err instanceof teamsModule.TeamError && err.code === 400 && err.message === 'Invalid run id'
    );
    assert.throws(
      () => teamsModule.runFile(badId),
      (err) => err instanceof teamsModule.TeamError && err.code === 400 && err.message === 'Invalid run id'
    );
  }

  const validId = 'run_1700000000000_abc12';
  assert.strictEqual(typeof teamsModule.runFile(validId), 'string');
  assert.ok(teamsModule.runFile(validId).endsWith(`${validId}.json`));
  assert.throws(
    () => teamsModule.getRun(validId),
    (err) => err instanceof teamsModule.TeamError && err.code === 404
  );
});

test('defect 4: stale overwrites with parallel tasks', async () => {
  clearReplays();
  const teamsModule = require('../src/teams');

  await fetch(`${main.base}/api/teams`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({
      id: 'parallel-team',
      name: 'Parallel Team',
      maxParallel: 2,
      leader: { account: 'claude' },
      members: [
        { account: 'agy', roles: [] },
        { account: 'codex', roles: [] }
      ]
    })
  });

  const plan = {
    summary: 'Parallel tasks',
    tasks: [
      {
        id: 't1',
        title: 'Task 1',
        assignee: 'agy',
        role: 'web-engineer',
        prompt: 'Run task 1',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      },
      {
        id: 't2',
        title: 'Task 2',
        assignee: 'codex',
        role: 'api-engineer',
        prompt: 'Run task 2',
        acceptance_criteria: [],
        verification_command: 'sleep 0.3',
        depends_on: []
      }
    ]
  };
  const planText = '```json\n' + JSON.stringify(plan) + '\n```';
  writeClaudeReplay('claude', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-par-lead' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: planText,
      usage: { input_tokens: 30, output_tokens: 20 }
    })
  ]);

  const started = teamsModule.startRun({
    teamId: 'parallel-team',
    goal: 'Parallel run test in process',
    workspace: main.workspace,
    mode: 'plan'
  });
  const inMemory1 = teamsModule.getRawRun(started.id);
  const inMemory2 = teamsModule.getRawRun(started.id);
  assert.strictEqual(inMemory1, inMemory2);

  await waitFor(async () => {
    const r = teamsModule.getRun(started.id);
    return r.status === 'planned' ? r : null;
  });

  teamsModule.executeRun(started.id);

  const completed = await waitFor(async () => {
    const r = teamsModule.getRun(started.id);
    return r.status === 'completed' ? r : null;
  });

  assert.strictEqual(completed.status, 'completed');
  const diskRun = JSON.parse(fs.readFileSync(teamsModule.runFile(started.id), 'utf-8'));
  assert.strictEqual(diskRun.status, 'completed');
  assert.ok(typeof diskRun.tasks[0].taskId === 'string' && diskRun.tasks[0].taskId.startsWith('a2a_'));
  assert.ok(typeof diskRun.tasks[1].taskId === 'string' && diskRun.tasks[1].taskId.startsWith('a2a_'));
  assert.strictEqual(diskRun.tasks[0].status, 'completed');
  assert.strictEqual(diskRun.tasks[1].status, 'completed');

  const cancelRunData = teamsModule.startRun({
    teamId: 'parallel-team',
    goal: 'Cross process cancel test',
    workspace: main.workspace,
    mode: 'plan'
  });
  const cancelFile = teamsModule.runFile(cancelRunData.id);
  const cancelDisk = JSON.parse(fs.readFileSync(cancelFile, 'utf-8'));
  cancelDisk.status = 'cancelled';
  fs.writeFileSync(cancelFile, JSON.stringify(cancelDisk, null, 2) + '\n');
  const fetchedAfterExternalCancel = teamsModule.getRawRun(cancelRunData.id);
  assert.strictEqual(fetchedAfterExternalCancel.status, 'cancelled');

  clearReplays();
});

test('defect 5: corrupt files are skipped in list functions only', async () => {
  const teamsModule = require('../src/teams');
  const teamsDir = teamsModule.getTeamsDir();
  const runsDir = teamsModule.getRunsDir();

  const validTeamFile = path.join(teamsDir, 'defect5-valid-team.json');
  const validRunFile = path.join(runsDir, 'run_1111111111_valid5.json');
  const corruptTeamFile = path.join(teamsDir, 'defect5-corrupt-team.json');
  const corruptRunFile = path.join(runsDir, 'run_9999999999_corrupt5.json');

  const now = new Date().toISOString();
  fs.writeFileSync(
    validTeamFile,
    JSON.stringify({
      id: 'defect5-valid-team',
      name: 'Defect 5 Valid Team',
      description: '',
      leader: { account: 'claude', model: null, effort: 'medium', instructions: '' },
      members: [{ account: 'agy', roles: [], notes: '' }],
      preset: null,
      workspace: null,
      maxParallel: 1,
      review: false,
      createdAt: now,
      updatedAt: now
    }, null, 2) + '\n'
  );

  fs.writeFileSync(
    validRunFile,
    JSON.stringify({
      id: 'run_1111111111_valid5',
      teamId: 'defect5-valid-team',
      goal: 'Valid run for defect 5',
      workspace: main.workspace,
      status: 'planned',
      mode: 'plan',
      planApproved: false,
      startedAt: now,
      finishedAt: null,
      tasks: [],
      error: null
    }, null, 2) + '\n'
  );

  fs.writeFileSync(corruptTeamFile, '{ invalid json team content');
  fs.writeFileSync(corruptRunFile, '{ invalid json run content');

  try {
    const teams = teamsModule.listTeams();
    assert.ok(Array.isArray(teams));
    assert.ok(teams.some((t) => t.id === 'defect5-valid-team'));
    assert.ok(!teams.some((t) => t.id === 'defect5-corrupt-team'));

    const runs = teamsModule.listRuns();
    assert.ok(Array.isArray(runs));
    assert.ok(runs.some((r) => r.id === 'run_1111111111_valid5'));
    assert.ok(!runs.some((r) => r.id === 'run_9999999999_corrupt5'));

    const httpTeamsRes = await fetch(`${main.base}/api/teams`, { headers: authed() });
    assert.strictEqual(httpTeamsRes.status, 200);
    const httpTeams = (await httpTeamsRes.json()).teams;
    assert.ok(httpTeams.some((t) => t.id === 'defect5-valid-team'));
    assert.ok(!httpTeams.some((t) => t.id === 'defect5-corrupt-team'));

    const httpRunsRes = await fetch(`${main.base}/api/team-runs`, { headers: authed() });
    assert.strictEqual(httpRunsRes.status, 200);
    const httpRuns = (await httpRunsRes.json()).runs;
    assert.ok(httpRuns.some((r) => r.id === 'run_1111111111_valid5'));
    assert.ok(!httpRuns.some((r) => r.id === 'run_9999999999_corrupt5'));

    const usingAccount = teamsModule.teamsUsingAccount('claude');
    assert.ok(Array.isArray(usingAccount));

    assert.throws(
      () => teamsModule.getTeam('defect5-corrupt-team'),
      (err) => {
        assert.strictEqual(err.code, 500);
        assert.ok(err.message.includes('is not valid JSON'));
        return true;
      }
    );

    assert.throws(
      () => teamsModule.getRun('run_9999999999_corrupt5'),
      (err) => {
        assert.strictEqual(err.code, 500);
        assert.ok(err.message.includes('is not valid JSON'));
        return true;
      }
    );

    assert.throws(
      () =>
        teamsModule.createTeam({
          id: 'defect5-corrupt-team',
          name: 'Overwrite Corrupt',
          leader: { account: 'claude' },
          members: [{ account: 'agy' }]
        }),
      (err) => {
        assert.strictEqual(err.code, 409);
        return true;
      }
    );
    assert.strictEqual(fs.readFileSync(corruptTeamFile, 'utf-8'), '{ invalid json team content');

    assert.throws(
      () => teamsModule.updateTeam('defect5-corrupt-team', { name: 'Update Corrupt' }),
      (err) => {
        assert.strictEqual(err.code, 500);
        return true;
      }
    );
    assert.strictEqual(fs.readFileSync(corruptTeamFile, 'utf-8'), '{ invalid json team content');
  } finally {
    if (fs.existsSync(validTeamFile)) fs.unlinkSync(validTeamFile);
    if (fs.existsSync(validRunFile)) fs.unlinkSync(validRunFile);
    if (fs.existsSync(corruptTeamFile)) fs.unlinkSync(corruptTeamFile);
    if (fs.existsSync(corruptRunFile)) fs.unlinkSync(corruptRunFile);
  }
});

test('H2: a plan made in one process and built in another reads as built there and cannot be built again', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['h2-lead', 'h2-dev']);
  await createTeamOverHttp({
    id: 'h2-team',
    name: 'H2 Team',
    leader: { account: 'h2-lead' },
    members: [{ account: 'h2-dev', roles: [] }]
  });
  writeClaudeReplay('h2-lead', planReplay(oneTaskPlan('h2-dev')));

  const started = teamsModule.startRun({
    teamId: 'h2-team',
    goal: 'Plan here and build in another process',
    workspace: main.workspace,
    mode: 'plan'
  });
  await waitFor(() => teamsModule.getRun(started.id).status === 'planned');

  const builder = spawnNode(nodeScript([
    `teams.executeRun(${JSON.stringify(started.id)});`,
    untilRunEnds(JSON.stringify(started.id))
  ].join('\n')));
  const built = await builder.closed;
  assert.strictEqual(built.code, 0, built.stderr);

  const seen = teamsModule.getRun(started.id);
  assert.strictEqual(seen.status, 'completed');
  assert.strictEqual(seen.tasks[0].status, 'completed');
  assert.throws(
    () => teamsModule.executeRun(started.id),
    (err) => err instanceof teamsModule.TeamError && err.code === 409
  );
  assert.strictEqual(taskCountFor('h2-dev'), 1);
});

test('H2: two processes building the same plan at the same time start it only once', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['h2-race-lead', 'h2-race-dev']);
  await createTeamOverHttp({
    id: 'h2-race-team',
    name: 'H2 Race Team',
    leader: { account: 'h2-race-lead' },
    members: [{ account: 'h2-race-dev', roles: [] }]
  });
  writeClaudeReplay('h2-race-lead', planReplay(oneTaskPlan('h2-race-dev')));

  const started = teamsModule.startRun({
    teamId: 'h2-race-team',
    goal: 'Build the same plan from two processes',
    workspace: main.workspace,
    mode: 'plan'
  });
  await waitFor(() => teamsModule.getRun(started.id).status === 'planned');

  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-h2-race-'));
  const paused = path.join(markers, 'paused');
  const resume = path.join(markers, 'resume');
  const runId = JSON.stringify(started.id);
  const first = spawnNode(nodeScript([
    'const fs = require(\'fs\');',
    'const rename = fs.renameSync;',
    'let held = false;',
    'fs.renameSync = function (from, to) {',
    `  if (!held && to === ${JSON.stringify(teamsModule.runFile(started.id))} && JSON.parse(fs.readFileSync(from, 'utf-8')).status === 'running') {`,
    '    held = true;',
    `    fs.writeFileSync(${JSON.stringify(paused)}, '');`,
    '    const deadline = Date.now() + 10000;',
    `    while (!fs.existsSync(${JSON.stringify(resume)}) && Date.now() < deadline) {}`,
    '  }',
    '  return rename.apply(fs, arguments);',
    '};',
    `teams.executeRun(${runId});`,
    untilRunEnds(runId)
  ].join('\n')));

  try {
    await waitFor(() => fs.existsSync(paused));
    const second = spawnNode(nodeScript([
      'try {',
      `  teams.executeRun(${runId});`,
      '  console.log(JSON.stringify({ started: true }));',
      '} catch (err) {',
      '  console.log(JSON.stringify({ code: err.code }));',
      '}'
    ].join('\n')));
    const raced = await second.closed;
    assert.deepStrictEqual(JSON.parse(raced.stdout), { code: 409 });
    assert.throws(
      () => teamsModule.executeRun(started.id),
      (err) => err instanceof teamsModule.TeamError && err.code === 409
    );
  } finally {
    fs.writeFileSync(resume, '');
    await first.closed;
    fs.rmSync(markers, { recursive: true, force: true });
  }

  const winner = await first.closed;
  assert.strictEqual(winner.code, 0, winner.stderr);
  const done = teamsModule.getRun(started.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.tasks[0].status, 'completed');
  assert.strictEqual(taskCountFor('h2-race-dev'), 1);
});

test('H3: a run whose team file disappears mid-run finishes from its team snapshot without crashing its process', async () => {
  const teamsModule = require('../src/teams');
  const { cancelTask } = require('../src/dispatcher');
  await createClaudeAccounts(['h3-lead', 'h3-dev']);
  await createTeamOverHttp({
    id: 'h3-vanish-team',
    name: 'H3 Vanish Team',
    leader: { account: 'h3-lead' },
    members: [{ account: 'h3-dev', roles: [] }]
  });
  writeClaudeReplay('h3-lead', planReplay(oneTaskPlan('h3-dev')));
  setClaudeMode('h3-dev', 'hang');

  const runner = spawnNode(nodeScript([
    'const run = teams.startRun({',
    '  teamId: \'h3-vanish-team\',',
    '  goal: \'Outlive the team file\',',
    `  workspace: ${JSON.stringify(main.workspace)},`,
    '  mode: \'accept-edits\'',
    '});',
    untilRunEnds('run.id')
  ].join('\n')));

  try {
    const running = await waitFor(() => {
      const run = teamsModule.listRuns({ teamId: 'h3-vanish-team' })[0];
      return run && run.tasks[0] && run.tasks[0].status === 'running' && run.tasks[0].taskId ? run : null;
    });
    fs.unlinkSync(teamsModule.teamFile('h3-vanish-team'));
    assert.strictEqual(cancelTask(running.tasks[0].taskId).ok, true);

    const exited = await runner.closed;
    assert.strictEqual(exited.code, 0, exited.stderr);
    const finished = teamsModule.getRun(running.id);
    assert.strictEqual(finished.status, 'failed');
    assert.strictEqual(finished.tasks[0].status, 'cancelled');
    assert.strictEqual(finished.error, '1 of 1 tasks did not complete');
  } finally {
    runner.kill('SIGKILL');
  }
});

test('H3: deleting a team is refused with 409 while it has a live run, and stale or finished runs do not block it', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['h3b-lead', 'h3b-dev']);
  await createTeamOverHttp({
    id: 'h3-busy-team',
    name: 'H3 Busy Team',
    leader: { account: 'h3b-lead' },
    members: [{ account: 'h3b-dev', roles: [] }]
  });
  writeClaudeReplay('h3b-lead', planReplay(oneTaskPlan('h3b-dev')));
  setClaudeMode('h3b-dev', 'hang');

  const deleteTeam = () => fetch(`${main.base}/api/teams/h3-busy-team`, { method: 'DELETE', headers: authed() });
  const runRes = await fetch(`${main.base}/api/teams/h3-busy-team/runs`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ goal: 'Keep the team busy', workspace: main.workspace, mode: 'plan' })
  });
  assert.strictEqual(runRes.status, 202);
  const runId = (await runRes.json()).run.id;
  const readRun = async () => (await (await fetch(`${main.base}/api/team-runs/${runId}`)).json()).run;

  const staleFiles = [];
  try {
    await waitFor(async () => (await readRun()).status === 'planned');
    const refusedPlanned = await deleteTeam();
    assert.strictEqual(refusedPlanned.status, 409);
    assert.ok((await refusedPlanned.json()).error.includes(runId));

    const execRes = await fetch(`${main.base}/api/team-runs/${runId}/execute`, { method: 'POST', headers: authed() });
    assert.strictEqual(execRes.status, 200);
    await waitFor(async () => {
      const run = await readRun();
      return run.tasks[0].status === 'running' && run.tasks[0].taskId;
    });
    const refusedRunning = await deleteTeam();
    assert.strictEqual(refusedRunning.status, 409);
    assert.throws(
      () => teamsModule.deleteTeam('h3-busy-team'),
      (err) => err instanceof teamsModule.TeamError && err.code === 409
    );

    const cancelRes = await fetch(`${main.base}/api/team-runs/${runId}/cancel`, { method: 'POST', headers: authed() });
    assert.strictEqual(cancelRes.status, 200);
    await waitFor(async () => (await readRun()).status === 'cancelled');

    ['planning', 'planned', 'running', 'reviewing'].forEach((status, index) => {
      const staleId = `run_1700000000000_h3stale${index}`;
      const file = teamsModule.runFile(staleId);
      staleFiles.push(file);
      fs.writeFileSync(file, JSON.stringify({
        id: staleId,
        teamId: 'h3-busy-team',
        teamName: 'H3 Busy Team',
        goal: 'Left behind by a process that died',
        workspace: main.workspace,
        mode: 'plan',
        status,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        leader: { account: 'h3b-lead', taskId: null },
        summary: null,
        tasks: [],
        review: null,
        usage: { total_tokens: 0 },
        pid: 999999
      }, null, 2) + '\n');
    });

    const deleted = await deleteTeam();
    assert.strictEqual(deleted.status, 200);
    assert.strictEqual((await fetch(`${main.base}/api/teams/h3-busy-team`)).status, 404);
  } finally {
    await fetch(`${main.base}/api/team-runs/${runId}/cancel`, { method: 'POST', headers: authed() });
    for (const file of staleFiles) {
      try { fs.unlinkSync(file); } catch (e) {}
    }
  }
});

test('H3: an error thrown while a task finishes fails the run with that error instead of crashing its process', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['h3c-lead', 'h3c-dev']);
  await createTeamOverHttp({
    id: 'h3-crash-team',
    name: 'H3 Crash Team',
    leader: { account: 'h3c-lead' },
    members: [{ account: 'h3c-dev', roles: [] }]
  });
  writeClaudeReplay('h3c-lead', planReplay(oneTaskPlan('h3c-dev')));

  const runner = spawnNode(nodeScript([
    'const fs = require(\'fs\');',
    'const rename = fs.renameSync;',
    'let thrown = false;',
    'fs.renameSync = function (from, to) {',
    '  if (!thrown && to.startsWith(teams.getRunsDir()) && JSON.parse(fs.readFileSync(from, \'utf-8\')).tasks.some((t) => t.status === \'completed\')) {',
    '    thrown = true;',
    '    throw new Error(\'injected write failure\');',
    '  }',
    '  return rename.apply(fs, arguments);',
    '};',
    'const run = teams.startRun({',
    '  teamId: \'h3-crash-team\',',
    '  goal: \'Survive a failing write\',',
    `  workspace: ${JSON.stringify(main.workspace)},`,
    '  mode: \'accept-edits\'',
    '});',
    untilRunEnds('run.id')
  ].join('\n')));

  try {
    const exited = await runner.closed;
    assert.strictEqual(exited.code, 0, exited.stderr);
    const failed = teamsModule.listRuns({ teamId: 'h3-crash-team' })[0];
    assert.strictEqual(failed.status, 'failed');
    assert.ok(failed.error && failed.error.includes('injected write failure'), failed.error);
    assert.ok(failed.finishedAt);
  } finally {
    runner.kill('SIGKILL');
  }
});

test('M3: a developer task that cannot start leaves the run reviewing until its review ends', async () => {
  const teamsModule = require('../src/teams');
  const { cancelTask } = require('../src/dispatcher');
  await createClaudeAccounts(['m3-lead', 'm3-dev', 'm3-broke']);
  const budgetRes = await fetch(`${main.base}/api/accounts/m3-broke/budget`, {
    method: 'PUT',
    headers: authed(),
    body: JSON.stringify({ period: 'day', tokens: 1000, stop: true })
  });
  assert.strictEqual(budgetRes.status, 200);
  fs.appendFileSync(path.join(main.logsDir, 'usage.jsonl'), JSON.stringify({
    at: new Date().toISOString(),
    taskId: 'a2a_m3_seed',
    account: 'm3-broke',
    provider: 'claude',
    usage: { total_tokens: 5000 }
  }) + '\n');
  await createTeamOverHttp({
    id: 'm3-review-team',
    name: 'M3 Review Team',
    review: true,
    leader: { account: 'm3-lead' },
    members: [
      { account: 'm3-dev', roles: [] },
      { account: 'm3-broke', roles: [] }
    ]
  });
  writeClaudeReplay('m3-lead', planReplay({
    summary: 'Two steps',
    tasks: [
      {
        id: 't1',
        title: 'First step',
        assignee: 'm3-dev',
        role: 'web-engineer',
        prompt: 'Do the first step',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: []
      },
      {
        id: 't2',
        title: 'Second step',
        assignee: 'm3-broke',
        role: 'api-engineer',
        prompt: 'Do the second step',
        acceptance_criteria: [],
        verification_command: null,
        depends_on: ['t1']
      }
    ]
  }));

  const started = teamsModule.startRun({
    teamId: 'm3-review-team',
    goal: 'Review after a refused task',
    workspace: main.workspace,
    mode: 'plan'
  });
  await waitFor(() => teamsModule.getRun(started.id).status === 'planned');
  setClaudeMode('m3-lead', 'hang');
  teamsModule.executeRun(started.id);

  let reviewTaskId = null;
  try {
    const reviewing = await waitFor(() => {
      const run = teamsModule.getRun(started.id);
      return run.review && run.review.taskId ? run : null;
    });
    reviewTaskId = reviewing.review.taskId;
    assert.strictEqual(reviewing.tasks[0].status, 'completed');
    assert.strictEqual(reviewing.tasks[1].status, 'failed');
    assert.ok(reviewing.tasks[1].error.includes('budget'), reviewing.tasks[1].error);
    assert.strictEqual(reviewing.status, 'reviewing');
    assert.strictEqual(reviewing.finishedAt, null);
    assert.strictEqual(reviewing.review.status, 'running');
    assert.strictEqual(JSON.parse(fs.readFileSync(teamsModule.runFile(started.id), 'utf-8')).status, 'reviewing');

    assert.strictEqual(cancelTask(reviewTaskId).ok, true);
    const finished = await waitFor(() => {
      const run = teamsModule.getRun(started.id);
      return run.status === 'failed' ? run : null;
    });
    assert.strictEqual(finished.review.status, 'cancelled');
    assert.ok(finished.finishedAt);
    assert.strictEqual(finished.error, '1 of 2 tasks did not complete');
  } finally {
    if (reviewTaskId) cancelTask(reviewTaskId);
  }
});

function independentTasks(assignees) {
  return {
    summary: 'Independent steps',
    tasks: assignees.map((assignee, index) => ({
      id: `t${index + 1}`,
      title: `Step ${index + 1}`,
      assignee,
      role: 'web-engineer',
      prompt: `Do step ${index + 1}`,
      acceptance_criteria: [],
      verification_command: null,
      depends_on: []
    }))
  };
}

async function blockAccountByBudget(accountId) {
  await fetch(`${main.base}/api/accounts/${accountId}/budget`, { method: 'PUT', headers: authed(), body: JSON.stringify({ period: 'day', tokens: 1000, stop: true }) });
  fs.appendFileSync(path.join(main.logsDir, 'usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), taskId: `a2a_seed_${accountId}`, account: accountId, provider: 'claude', usage: { total_tokens: 5000 } }) + '\n');
}

test('the parallel limit holds when a task cannot start', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['mp-lead', 'mp-dev', 'mp-broke']);
  await blockAccountByBudget('mp-broke');
  await createTeamOverHttp({ id: 'mp-team', name: 'Parallel limit team', maxParallel: 2, leader: { account: 'mp-lead' }, members: [{ account: 'mp-dev', roles: [] }, { account: 'mp-broke', roles: [] }] });
  writeClaudeReplay('mp-lead', planReplay(independentTasks(['mp-broke', 'mp-dev', 'mp-dev', 'mp-dev'])));
  const started = teamsModule.startRun({ teamId: 'mp-team', goal: 'Four steps', workspace: main.workspace, mode: 'plan' });
  await waitFor(() => teamsModule.getRun(started.id).status === 'planned');
  setClaudeMode('mp-dev', 'hang');
  teamsModule.executeRun(started.id);
  try {
    await waitFor(() => teamsModule.getRun(started.id).tasks[0].status === 'failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const run = teamsModule.getRun(started.id);
    const running = run.tasks.filter((t) => t.status === 'running').length;
    assert.ok(running <= 2, `${running} tasks running with maxParallel 2: ${run.tasks.map((t) => `${t.id}=${t.status}`).join(' ')}`);
    assert.strictEqual(running, 2);
  } finally {
    teamsModule.cancelRun(started.id);
  }
});

test('a cancel from another process keeps every task of the run cancelled', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['xc-lead', 'xc-dev']);
  await createTeamOverHttp({ id: 'xc-team', name: 'Cross-process cancel team', leader: { account: 'xc-lead' }, members: [{ account: 'xc-dev', roles: [] }] });
  const plan = independentTasks(['xc-dev', 'xc-dev']);
  plan.tasks[1].depends_on = ['t1'];
  writeClaudeReplay('xc-lead', planReplay(plan));
  const started = teamsModule.startRun({ teamId: 'xc-team', goal: 'Two steps in a row', workspace: main.workspace, mode: 'plan' });
  await waitFor(() => teamsModule.getRun(started.id).status === 'planned');
  setClaudeMode('xc-dev', 'hang');
  teamsModule.executeRun(started.id);
  await waitFor(() => teamsModule.getRun(started.id).tasks[0].taskId);
  const other = spawnNode(nodeScript(`teams.cancelRun(${JSON.stringify(started.id)}); process.exit(0);`));
  assert.strictEqual((await other.closed).code, 0);
  const onDisk = () => JSON.parse(fs.readFileSync(teamsModule.runFile(started.id), 'utf-8'));
  await waitFor(() => onDisk().tasks[0].output !== undefined, 15000);
  const run = onDisk();
  assert.strictEqual(run.status, 'cancelled');
  assert.deepStrictEqual(run.tasks.map((t) => t.status), ['cancelled', 'cancelled']);
});

test('a claim left behind by a killed process does not block building the plan', async () => {
  const teamsModule = require('../src/teams');
  await createClaudeAccounts(['sc-lead', 'sc-dev']);
  await createTeamOverHttp({ id: 'sc-team', name: 'Stale claim team', leader: { account: 'sc-lead' }, members: [{ account: 'sc-dev', roles: [] }] });
  writeClaudeReplay('sc-lead', planReplay(oneTaskPlan('sc-dev')));
  const started = teamsModule.startRun({ teamId: 'sc-team', goal: 'One step', workspace: main.workspace, mode: 'plan' });
  await waitFor(() => teamsModule.getRun(started.id).status === 'planned');
  const claim = `${teamsModule.runFile(started.id)}.execute-claim`;
  fs.mkdirSync(claim);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(claim, old, old);
  setClaudeMode('sc-dev', 'hang');
  try {
    assert.strictEqual(teamsModule.executeRun(started.id).status, 'running');
  } finally {
    teamsModule.cancelRun(started.id);
  }
});

test('a leader plan whose task prompts contain code fences and braces is read correctly', () => {
  const { parsePlan } = require('../src/teams');
  const plan = {
    summary: 'Two tasks: a settings view model and its tests.',
    tasks: [
      { id: 't1', title: 'View model', assignee: 'claude', role: 'mobile-engineer', prompt: 'Create the view model:\n```swift\nfinal class SettingsViewModel { var isDark = false }\n```\n\n1. Delete nothing.', depends_on: [] },
      { id: 't2', title: 'Tests', assignee: 'claude', role: 'test-engineer', prompt: 'Test it with ```swift\nXCTAssertFalse(vm.isDark)\n``` and a "quoted } brace".', depends_on: ['t1'] }
    ]
  };
  const output = 'I read the workspace {it is empty}.\n```json\n' + JSON.stringify(plan) + '\n```';
  assert.deepStrictEqual(parsePlan(output), plan);
  assert.deepStrictEqual(parsePlan(JSON.stringify(plan)), plan);
  assert.throws(() => parsePlan('No plan here.'), /Could not find JSON/);
  assert.throws(() => parsePlan('```json\n{"summary": "x", "tasks": [}\n```'), /Invalid JSON in leader output/);
});
