const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATA_DIR, PACKAGE_ROOT } = require('./config');
const { LOGS_DIR, getAgentCard, runTask, cancelTask } = require('./dispatcher');
const presets = require('./presets');
const accounts = require('./accounts');
const providers = require('./providers');

class TeamError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RESERVED_IDS = new Set(['none', 'default']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:-]{0,63}$/;
const RUN_ID_PATTERN = /^run_\d+_[a-z0-9]+$/;
const UNFINISHED_RUN_STATUSES = new Set(['planning', 'planned', 'running', 'reviewing']);
const activeRuns = new Map();

function assertValidRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new TeamError('Invalid run id', 400);
  }
}

function getTeamsDir() {
  const dir = process.env.A2A_TEAMS_DIR || path.join(DATA_DIR, 'teams');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getRunsDir() {
  const dir = path.join(LOGS_DIR, 'team-runs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function teamFile(id) {
  return path.join(getTeamsDir(), `${id}.json`);
}

function runFile(runId) {
  assertValidRunId(runId);
  return path.join(getRunsDir(), `${runId}.json`);
}

function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new TeamError(`Could not read ${file}: ${err.message}`, 500);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new TeamError(`${file} is not valid JSON. Fix or remove it.`, 500);
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function validateTeamData(data) {
  const { name, description, leader, members, preset, workspace, maxParallel, review } = data;

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    throw new TeamError('name is required and must be at most 80 characters', 400);
  }

  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > 300) {
      throw new TeamError('description must be at most 300 characters', 400);
    }
  }

  if (!leader || typeof leader !== 'object') {
    throw new TeamError('leader is required', 400);
  }

  if (typeof leader.account !== 'string' || !accounts.getAccount(leader.account)) {
    throw new TeamError(`Leader account "${leader && leader.account}" does not exist`, 400);
  }

  const effort = leader.effort || 'medium';
  if (!EFFORTS.has(effort)) {
    throw new TeamError(`Invalid leader effort "${leader.effort}"`, 400);
  }

  let model = leader.model || null;
  if (model !== null) {
    if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
      throw new TeamError('Invalid leader model', 400);
    }
  }

  const instructions = leader.instructions || '';
  if (typeof instructions !== 'string' || instructions.length > 8000) {
    throw new TeamError('leader instructions must be at most 8000 characters', 400);
  }

  if (!Array.isArray(members) || members.length < 1 || members.length > 12) {
    throw new TeamError('members must be an array of 1 to 12 members', 400);
  }

  const card = getAgentCard();
  const allRoles = new Set((card.skills || card.roles || []).map((s) => s.id));
  const seenAccounts = new Set();
  const validatedMembers = [];

  for (const m of members) {
    if (!m || typeof m !== 'object' || typeof m.account !== 'string') {
      throw new TeamError('member account is required', 400);
    }
    if (!accounts.getAccount(m.account)) {
      throw new TeamError(`Member account "${m.account}" does not exist`, 400);
    }
    if (seenAccounts.has(m.account)) {
      throw new TeamError(`Duplicate member account "${m.account}"`, 400);
    }
    seenAccounts.add(m.account);

    let roles = [];
    if (m.roles !== undefined && m.roles !== null) {
      if (!Array.isArray(m.roles)) {
        throw new TeamError('member roles must be an array', 400);
      }
      for (const r of m.roles) {
        if (!allRoles.has(r)) {
          throw new TeamError(`Unknown role "${r}" for member "${m.account}"`, 400);
        }
      }
      roles = m.roles;
    }

    let notes = '';
    if (m.notes !== undefined && m.notes !== null) {
      if (typeof m.notes !== 'string' || m.notes.length > 300) {
        throw new TeamError('member notes must be at most 300 characters', 400);
      }
      notes = m.notes;
    }

    validatedMembers.push({ account: m.account, roles, notes });
  }

  let validatedPreset = null;
  if (preset !== undefined && preset !== null) {
    if (preset === 'none') {
      validatedPreset = 'none';
    } else {
      if (typeof preset !== 'string') {
        throw new TeamError('preset must be null, "none" or a preset id', 400);
      }
      try {
        presets.resolvePresetId(preset);
        validatedPreset = preset;
      } catch (err) {
        throw new TeamError(err.message, 400);
      }
    }
  }

  let validatedWorkspace = null;
  if (workspace !== undefined && workspace !== null) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
      throw new TeamError('workspace must be an absolute path or null', 400);
    }
    let stat;
    try {
      stat = fs.statSync(workspace);
    } catch (err) {
      throw new TeamError('workspace directory does not exist', 400);
    }
    if (!stat.isDirectory()) {
      throw new TeamError('workspace is not a directory', 400);
    }
    validatedWorkspace = workspace;
  }

  const effectiveMaxParallel = maxParallel === undefined ? 1 : maxParallel;
  if (!Number.isInteger(effectiveMaxParallel) || effectiveMaxParallel < 1 || effectiveMaxParallel > 4) {
    throw new TeamError('maxParallel must be an integer between 1 and 4', 400);
  }

  const effectiveReview = review === undefined ? false : review;
  if (typeof effectiveReview !== 'boolean') {
    throw new TeamError('review must be a boolean', 400);
  }

  return {
    name: name.trim(),
    description: (description && typeof description === 'string' && description.trim()) || '',
    leader: {
      account: leader.account,
      model,
      effort,
      instructions
    },
    members: validatedMembers,
    preset: validatedPreset,
    workspace: validatedWorkspace,
    maxParallel: effectiveMaxParallel,
    review: effectiveReview
  };
}

const TEAM_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'team-templates');

function listTeamTemplates() {
  let files = [];
  try {
    files = fs.readdirSync(TEAM_TEMPLATES_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    return [];
  }
  const templates = [];
  for (const file of files) {
    try {
      templates.push({ id: file.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(TEAM_TEMPLATES_DIR, file), 'utf-8')) });
    } catch (err) {}
  }
  return templates;
}

function getTeamTemplate(templateId) {
  if (typeof templateId !== 'string' || !/^[\w-]+$/.test(templateId)) throw new TeamError('Invalid template id', 400);
  const template = listTeamTemplates().find((t) => t.id === templateId);
  if (!template) throw new TeamError(`Team template "${templateId}" not found`, 404);
  return template;
}

function draftFromTemplate(templateId) {
  const template = getTeamTemplate(templateId);
  const all = accounts.listAccounts();
  const signedIn = all.filter((a) => a.status && a.status.state === 'signed-in');
  const pool = signedIn.length ? signedIn : all;
  const pick = (provider, taken) => pool.find((a) => a.provider === provider && !taken.has(a.id)) || pool.find((a) => !taken.has(a.id)) || null;
  const leading = new Set(listTeams().map((team) => team.leader.account));
  const leader = pool.find((a) => a.provider === template.leader.provider && !leading.has(a.id))
    || pick(template.leader.provider, new Set())
    || all[0];
  const used = new Set();
  const members = [];
  for (const slot of template.members) {
    const account = pick(slot.provider, new Set([...used, leader.id])) || (used.has(leader.id) ? null : leader);
    if (account) {
      used.add(account.id);
      members.push({ account: account.id, roles: [...slot.roles], notes: slot.notes || '' });
    } else {
      const last = members[members.length - 1];
      last.roles = [...new Set([...last.roles, ...slot.roles])];
      last.notes = [last.notes, slot.notes].filter(Boolean).join('; ').slice(0, 300);
    }
  }
  let id = templateId;
  for (let n = 2; fs.existsSync(teamFile(id)); n++) id = `${templateId}-${n}`;
  return {
    id,
    name: template.title,
    description: template.description,
    leader: { account: leader.id, model: null, effort: template.leader.effort, instructions: template.leader.instructions },
    members,
    maxParallel: Math.min(template.maxParallel, members.length),
    review: template.review,
    template: template.id
  };
}

function listTeams() {
  const dir = getTeamsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp'));
  const teams = [];
  for (const file of files) {
    try {
      const team = readJsonFile(path.join(dir, file));
      if (team) teams.push(team);
    } catch (err) {}
  }
  teams.sort((a, b) => a.id.localeCompare(b.id));
  return teams;
}

function getTeam(id) {
  if (!id || typeof id !== 'string' || !TEAM_ID_PATTERN.test(id)) {
    throw new TeamError(`Invalid team id "${id}"`, 400);
  }
  const file = teamFile(id);
  const team = readJsonFile(file);
  if (!team) {
    throw new TeamError(`Team "${id}" not found`, 404);
  }
  return team;
}

function createTeam(body) {
  if (!body || typeof body !== 'object') throw new TeamError('Invalid team body', 400);
  const { id } = body;
  if (!id || typeof id !== 'string' || !TEAM_ID_PATTERN.test(id) || RESERVED_IDS.has(id)) {
    throw new TeamError('Invalid team id', 400);
  }
  if (fs.existsSync(teamFile(id))) {
    throw new TeamError(`Team "${id}" already exists`, 409);
  }
  const validated = validateTeamData(body);
  const now = new Date().toISOString();
  const team = {
    id,
    ...validated,
    createdAt: now,
    updatedAt: now
  };
  atomicWriteJson(teamFile(id), team);
  return team;
}

function updateTeam(id, body) {
  const existing = getTeam(id);
  if (!body || typeof body !== 'object') throw new TeamError('Invalid team body', 400);
  const merged = {
    ...existing,
    ...body,
    id: existing.id,
    createdAt: existing.createdAt
  };
  const validated = validateTeamData(merged);
  const team = {
    id: existing.id,
    ...validated,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString()
  };
  atomicWriteJson(teamFile(id), team);
  return team;
}

function deleteTeam(id) {
  const existing = getTeam(id);
  const live = listRuns({ teamId: id, limit: Infinity }).find((run) => UNFINISHED_RUN_STATUSES.has(run.status) && isPidAlive(run.pid));
  if (live) {
    throw new TeamError(`Team "${id}" has an unfinished run (${live.id} is ${live.status}). Cancel it or wait for it to finish first.`, 409);
  }
  const file = teamFile(id);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  return existing;
}

function teamSnapshot(team) {
  return {
    name: team.name,
    leader: {
      account: team.leader.account,
      model: team.leader.model || null,
      effort: team.leader.effort
    },
    members: team.members.map((m) => ({ account: m.account, roles: m.roles || [] })),
    preset: team.preset || null,
    maxParallel: team.maxParallel || 1,
    review: Boolean(team.review)
  };
}

function teamsUsingAccount(accountId) {
  const teams = listTeams();
  return teams
    .filter((t) => t.leader.account === accountId || t.members.some((m) => m.account === accountId))
    .map((t) => t.name);
}

function buildLeaderPrompt(team, goal, workspace) {
  let roleText = `### YOUR ROLE\nYou are the team leader of "${team.name}".`;
  if (team.description) roleText += ` ${team.description}`;
  if (team.leader && team.leader.instructions) roleText += `\n${team.leader.instructions}`;

  const memberLines = team.members.map((m) => {
    const acc = accounts.getAccount(m.account) || { provider: 'agy', label: m.account };
    const pName = (providers.PROVIDERS[acc.provider] && providers.PROVIDERS[acc.provider].name) || acc.provider;
    const roleList = m.roles && m.roles.length ? m.roles.join(', ') : 'any';
    const notesPart = m.notes ? `. ${m.notes}` : '';
    return `- ${m.account} (${pName}, ${acc.label}): roles ${roleList}${notesPart}`;
  });

  const card = getAgentCard();
  const allRoles = (card.skills || card.roles || []).map((s) => s.id);
  const anyAllowsAny = team.members.some((m) => !m.roles || m.roles.length === 0);

  let teamSection = `### YOUR TEAM\nAssign every task to one of these developers. Use only these ids and roles.\n${memberLines.join('\n')}`;
  if (anyAllowsAny) {
    teamSection += `\nRole ids: ${allRoles.join(', ')}`;
  }

  return [
    roleText,
    teamSection,
    `### GOAL\n${goal}`,
    `### WORKSPACE\n${workspace}\nRead what you need to plan. Do not edit files.`,
    `### OUTPUT\nReply with one JSON object in a \`\`\`json block, and nothing after it:\n{"summary": "<one paragraph>", "tasks": [{"id": "t1", "title": "<short>", "assignee": "<developer id>", "role": "<role id>", "prompt": "<complete instructions for the developer>", "acceptance_criteria": ["<check>"], "verification_command": null, "depends_on": []}]}\nRules:\n- At most 12 tasks. Prefer fewer, larger tasks over many small ones.\n- Each prompt must stand alone: the developer sees only its prompt, the goal and the results of the tasks it depends on.\n- Tasks without depends_on can run at the same time in the same folder: give them separate files, or chain them with depends_on.\n- Set verification_command only to a command that exists in this workspace.`
  ].join('\n\n');
}

function buildDevPrompt(team, run, task) {
  let text = `Team: ${team.name}. Overall goal: ${run.goal}\n\n`;
  if (task.depends_on && task.depends_on.length > 0) {
    text += '### RESULTS OF EARLIER TASKS\n';
    for (const depId of task.depends_on) {
      const dep = run.tasks.find((t) => t.id === depId);
      const title = dep ? dep.title : depId;
      const status = dep ? dep.status : 'unknown';
      const output = dep && dep.output ? dep.output.slice(-1500) : '';
      text += `#### ${depId}: ${title} (${status})\n${output}\n\n`;
    }
  }
  text += `### YOUR TASK\n${task.prompt}`;
  if (!run.planApproved && task.verification_command) {
    text += `\n\n### CHECK BEFORE YOU FINISH\nRun \`${task.verification_command}\` in the workspace and report its result.`;
  }
  return text;
}

function buildReviewPrompt(team, run, changes) {
  const taskLines = run.tasks.map((t) => {
    return `- ${t.id} ${t.title} -> ${t.assignee} (${t.role}): ${t.status}${t.error ? ': ' + t.error : ''}`;
  });

  return [
    `### YOUR ROLE\nYou lead "${team.name}". Review your team's work.`,
    `### GOAL\n${run.goal}`,
    `### PLAN\n${run.summary || ''}`,
    `### TASK RESULTS\n${taskLines.join('\n')}`,
    `### WORKSPACE CHANGES\n${changes || ''}`,
    `### OUTPUT\nInspect the changes (git diff) and reply with "Verdict: ACCEPTED" or "Verdict: REVISION NEEDED", then at most 10 short findings.`
  ].join('\n\n');
}

function getWorkspaceChanges(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (err) {
      return '';
    }
  };
  const status = run(['status', '--short']);
  if (!status) return '';
  const stat = run(['diff', '--stat']);
  return [status, stat].filter(Boolean).join('\n\n').slice(0, 2000);
}

function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parsePlan(output) {
  if (!output || typeof output !== 'string') throw new Error('No output from team leader');
  let found = false;
  let firstError = null;
  for (let i = output.lastIndexOf('{'); i !== -1; i = i > 0 ? output.lastIndexOf('{', i - 1) : -1) {
    const candidate = balancedObjectAt(output, i);
    if (!candidate) continue;
    found = true;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'tasks')) return parsed;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  if (!found) throw new Error('Could not find JSON in leader output');
  throw new Error(`Invalid JSON in leader output: ${firstError ? firstError.message : 'no object with "tasks"'}`);
}

function memberAllowsRole(member, role) {
  if (!member.roles || member.roles.length === 0) return true;
  return member.roles.includes(role);
}

function validatePlanTasks(plan, team) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks)) {
    throw new Error('Plan must contain a "tasks" array');
  }
  if (plan.tasks.length < 1 || plan.tasks.length > 12) {
    throw new Error('Plan must contain between 1 and 12 tasks');
  }

  const card = getAgentCard();
  const validRoles = new Set((card.skills || card.roles || []).map((s) => s.id));
  const seenIds = new Set();
  const taskMap = new Map();

  for (const t of plan.tasks) {
    if (!t || typeof t !== 'object') throw new Error('Task must be an object');
    if (!t.id || typeof t.id !== 'string' || !/^[\w-]{1,32}$/.test(t.id)) {
      throw new Error(`Invalid task id "${t && t.id}"`);
    }
    if (seenIds.has(t.id)) throw new Error(`Duplicate task id "${t.id}"`);
    seenIds.add(t.id);
  }

  const validatedTasks = [];

  for (const t of plan.tasks) {
    if (!t.role || typeof t.role !== 'string' || !validRoles.has(t.role)) {
      throw new Error(`Invalid role "${t.role}" in task "${t.id}"`);
    }

    let assignee = t.assignee;
    let reassignedNote = null;
    const member = team.members.find((m) => m.account === assignee);

    if (member) {
      if (!memberAllowsRole(member, t.role)) {
        throw new Error(`Member "${assignee}" does not allow role "${t.role}"`);
      }
    } else {
      const fallback = team.members.find((m) => memberAllowsRole(m, t.role));
      if (!fallback) {
        throw new Error(`No team member allows role "${t.role}"`);
      }
      reassignedNote = `Reassigned from ${assignee} (not a member)`;
      assignee = fallback.account;
    }

    if (!t.prompt || typeof t.prompt !== 'string' || !t.prompt.trim() || t.prompt.length > 20000) {
      throw new Error(`Invalid prompt in task "${t.id}"`);
    }

    let criteria = [];
    if (typeof t.acceptance_criteria === 'string') {
      criteria = [t.acceptance_criteria];
    } else if (Array.isArray(t.acceptance_criteria)) {
      criteria = t.acceptance_criteria.filter((c) => typeof c === 'string');
    }

    let verifyCmd = null;
    if (typeof t.verification_command === 'string' && t.verification_command.trim()) {
      if (t.verification_command.length > 2000) {
        throw new Error(`Verification command in task "${t.id}" is too long`);
      }
      verifyCmd = t.verification_command.trim();
    }

    let dependsOn = [];
    if (Array.isArray(t.depends_on)) {
      for (const dep of t.depends_on) {
        if (!seenIds.has(dep)) {
          throw new Error(`Task "${t.id}" depends on unknown task "${dep}"`);
        }
        if (dep === t.id) {
          throw new Error(`Task "${t.id}" cannot depend on itself`);
        }
        dependsOn.push(dep);
      }
    }

    const taskObj = {
      id: t.id,
      title: (typeof t.title === 'string' && t.title.trim()) || t.id,
      assignee,
      role: t.role,
      prompt: t.prompt,
      acceptance_criteria: criteria,
      verification_command: verifyCmd,
      depends_on: dependsOn,
      status: 'pending',
      taskId: null,
      error: reassignedNote,
      startedAt: null,
      finishedAt: null,
      output: null
    };

    validatedTasks.push(taskObj);
    taskMap.set(t.id, taskObj);
  }

  const visited = new Set();
  const recStack = new Set();
  function checkCycle(id) {
    visited.add(id);
    recStack.add(id);
    const deps = taskMap.get(id)?.depends_on || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (checkCycle(dep)) return true;
      } else if (recStack.has(dep)) {
        return true;
      }
    }
    recStack.delete(id);
    return false;
  }

  for (const id of seenIds) {
    if (!visited.has(id)) {
      if (checkCycle(id)) {
        throw new Error('Cycle detected in task dependencies');
      }
    }
  }

  return validatedTasks;
}

function formatRun(run) {
  if (!run) return null;
  const copy = { ...run };
  if (['planning', 'running', 'reviewing'].includes(copy.status) && !isPidAlive(copy.pid)) {
    copy.status = 'stale';
  }
  return copy;
}

function getRawRun(runId) {
  assertValidRunId(runId);
  const file = runFile(runId);
  if (activeRuns.has(runId)) {
    const memRun = activeRuns.get(runId);
    try {
      const diskData = readJsonFile(file);
      if (diskData && diskData.status === 'cancelled' && memRun.status !== 'cancelled') {
        memRun.status = 'cancelled';
        memRun.finishedAt = diskData.finishedAt || new Date().toISOString();
        for (const task of memRun.tasks || []) {
          const onDisk = (diskData.tasks || []).find((t) => t.id === task.id);
          if (onDisk && onDisk.status === 'cancelled' && (task.status === 'pending' || task.status === 'running')) {
            task.status = 'cancelled';
            task.finishedAt = onDisk.finishedAt || memRun.finishedAt;
          }
        }
        if (memRun.review && diskData.review && diskData.review.status === 'cancelled') memRun.review.status = 'cancelled';
      }
    } catch (err) {}
    return memRun;
  }
  return readJsonFile(file);
}

function getRun(runId) {
  assertValidRunId(runId);
  const run = getRawRun(runId);
  if (!run) throw new TeamError(`Run "${runId}" not found`, 404);
  return formatRun(run);
}

const runFileCache = new Map();

function readRunCached(file) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = runFileCache.get(file);
  if (hit && hit.key === key) return hit.run;
  const run = readJsonFile(file);
  if (run) runFileCache.set(file, { key, run });
  return run;
}

function listRuns({ teamId, limit = 50 } = {}) {
  const dir = getRunsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp'));
  const present = new Set(files.map((file) => path.join(dir, file)));
  for (const file of runFileCache.keys()) if (!present.has(file)) runFileCache.delete(file);
  const runs = [];
  for (const file of files) {
    try {
      const run = readRunCached(path.join(dir, file));
      if (!run) continue;
      if (teamId && run.teamId !== teamId) continue;
      runs.push(formatRun(run));
    } catch (err) {}
  }
  runs.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  return runs.slice(0, limit);
}

function startRun({ teamId, goal, workspace, mode = 'plan' }) {
  const team = getTeam(teamId);

  if (typeof goal !== 'string' || !goal.trim() || goal.trim().startsWith('--') || goal.length > 20000) {
    throw new TeamError('Invalid goal', 400);
  }

  const targetWorkspace = workspace || team.workspace;
  if (!targetWorkspace || typeof targetWorkspace !== 'string' || !path.isAbsolute(targetWorkspace)) {
    throw new TeamError('Workspace must be an absolute path', 400);
  }
  let stat;
  try {
    stat = fs.statSync(targetWorkspace);
  } catch (err) {
    throw new TeamError('Workspace directory does not exist', 400);
  }
  if (!stat.isDirectory()) {
    throw new TeamError('Workspace is not a directory', 400);
  }
  if (path.resolve(targetWorkspace) === path.resolve(PACKAGE_ROOT)) {
    throw new TeamError('Workspace cannot be the bridge folder', 400);
  }

  if (mode !== 'plan' && mode !== 'accept-edits') {
    throw new TeamError('Invalid mode: must be "plan" or "accept-edits"', 400);
  }

  const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const run = {
    id: runId,
    teamId: team.id,
    teamName: team.name,
    team: teamSnapshot(team),
    goal: goal.trim(),
    workspace: targetWorkspace,
    mode,
    status: 'planning',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    leader: {
      account: team.leader.account,
      taskId: null
    },
    summary: null,
    tasks: [],
    review: null,
    planApproved: false,
    usage: {
      total_tokens: 0
    },
    pid: process.pid
  };

  activeRuns.set(runId, run);
  atomicWriteJson(runFile(runId), run);

  const leaderPrompt = buildLeaderPrompt(team, run.goal, run.workspace);
  try {
    const leaderProc = runTask({
      account: team.leader.account,
      role: 'team-leader',
      persona: false,
      prompt: leaderPrompt,
      workspace: run.workspace,
      mode: 'plan',
      effort: team.leader.effort,
      model: team.leader.model || undefined,
      preset: 'none',
      onDone: (taskRecord) => {
        guardRun(runId, () => handleLeaderPlanningDone(runId, taskRecord));
      },
      onError: (err) => {
        guardRun(runId, () => handleLeaderPlanningError(runId, err));
      }
    });
    run.leader.taskId = leaderProc.taskId;
    atomicWriteJson(runFile(runId), run);
  } catch (err) {
    run.status = 'failed';
    run.error = err.message;
    run.finishedAt = new Date().toISOString();
    atomicWriteJson(runFile(runId), run);
    activeRuns.delete(runId);
  }

  return formatRun(run);
}

function handleLeaderPlanningDone(runId, taskRecord) {
  const run = getRawRun(runId);
  if (!run) return;
  if (run.status === 'cancelled') {
    activeRuns.delete(runId);
    return;
  }

  run.usage.total_tokens = (run.usage.total_tokens || 0) + (taskRecord.usage?.total_tokens || 0);

  if (taskRecord.status !== 'completed') {
    run.status = 'failed';
    run.error = taskRecord.error || `Leader planning task ${taskRecord.status}`;
    run.finishedAt = new Date().toISOString();
    atomicWriteJson(runFile(runId), run);
    activeRuns.delete(runId);
    return;
  }

  let plan;
  try {
    plan = parsePlan(taskRecord.output);
  } catch (err) {
    run.status = 'failed';
    run.error = `Failed to parse leader plan: ${err.message}`;
    run.finishedAt = new Date().toISOString();
    atomicWriteJson(runFile(runId), run);
    activeRuns.delete(runId);
    return;
  }

  let tasks;
  try {
    tasks = validatePlanTasks(plan, run.team);
  } catch (err) {
    run.status = 'failed';
    run.error = `Invalid plan from leader: ${err.message}`;
    run.finishedAt = new Date().toISOString();
    atomicWriteJson(runFile(runId), run);
    activeRuns.delete(runId);
    return;
  }

  run.summary = (plan.summary && typeof plan.summary === 'string' && plan.summary.trim()) || null;
  run.tasks = tasks;

  if (run.mode === 'plan') {
    run.status = 'planned';
    atomicWriteJson(runFile(runId), run);
    activeRuns.delete(runId);
    return;
  }

  run.status = 'running';
  atomicWriteJson(runFile(runId), run);
  scheduleTasks(runId);
}

function handleLeaderPlanningError(runId, err) {
  const run = getRawRun(runId);
  if (!run) return;
  run.status = 'failed';
  run.error = err.message;
  run.finishedAt = new Date().toISOString();
  atomicWriteJson(runFile(runId), run);
  activeRuns.delete(runId);
}

const STALE_CLAIM_MS = 30000;

function claimRun(file, waitMs) {
  const claim = `${file}.execute-claim`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(claim);
      return claim;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new TeamError(`Could not claim run: ${err.message}`, 500);
    }
    try {
      if (Date.now() - fs.statSync(claim).mtimeMs > STALE_CLAIM_MS) {
        fs.rmdirSync(claim);
        continue;
      }
    } catch (err) {
      continue;
    }
    if (Date.now() >= deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function releaseClaim(claim) {
  if (!claim) return;
  try { fs.rmdirSync(claim); } catch (err) {}
}

function executeRun(runId) {
  assertValidRunId(runId);
  const file = runFile(runId);
  const claim = claimRun(file, 0);
  if (!claim) throw new TeamError(`Run "${runId}" is already being executed`, 409);
  let run;
  try {
    run = readJsonFile(file);
    if (!run) throw new TeamError(`Run "${runId}" not found`, 404);
    if (run.status !== 'planned') {
      throw new TeamError(`Cannot execute run with status "${run.status}" (must be "planned")`, 409);
    }
    run.team = run.team || teamSnapshot(getTeam(run.teamId));
    run.status = 'running';
    run.planApproved = true;
    run.pid = process.pid;
    atomicWriteJson(file, run);
  } finally {
    releaseClaim(claim);
  }
  activeRuns.set(runId, run);
  guardRun(runId, () => scheduleTasks(runId));
  return formatRun(run);
}

function scheduleTasks(runId) {
  const run = getRawRun(runId);
  if (!run) return;
  if (run.status !== 'running') {
    if (run.status === 'cancelled' && !run.tasks.some((t) => t.status === 'running')) activeRuns.delete(runId);
    return;
  }

  const maxParallel = run.team.maxParallel || 1;

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of run.tasks) {
      if (task.status !== 'pending') continue;
      if (!task.depends_on || task.depends_on.length === 0) continue;

      const failedDep = task.depends_on.find((depId) => {
        const dep = run.tasks.find((t) => t.id === depId);
        return dep && (dep.status === 'failed' || dep.status === 'skipped' || dep.status === 'cancelled');
      });

      if (failedDep) {
        task.status = 'skipped';
        task.error = `Skipped because ${failedDep} did not complete`;
        task.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  for (const task of run.tasks) {
    if (run.status !== 'running') break;
    if (run.tasks.filter((t) => t.status === 'running').length >= maxParallel) break;
    if (task.status !== 'pending') continue;

    const depsReady = (task.depends_on || []).every((depId) => {
      const dep = run.tasks.find((t) => t.id === depId);
      return dep && dep.status === 'completed';
    });

    if (!depsReady) continue;

    task.status = 'running';
    task.startedAt = new Date().toISOString();

    startTaskExecution(runId, task);
  }

  atomicWriteJson(runFile(runId), run);

  const unfinished = run.tasks.some((t) => t.status === 'pending' || t.status === 'running');
  if (!unfinished) {
    checkReviewOrFinish(runId);
  }
}

function startTaskExecution(runId, task) {
  const currentRun = getRawRun(runId);
  if (!currentRun || currentRun.status === 'cancelled') return;
  const team = currentRun.team;
  const devPrompt = buildDevPrompt(team, currentRun, task);

  try {
    const proc = runTask({
      account: task.assignee,
      role: task.role,
      prompt: devPrompt,
      workspace: currentRun.workspace,
      mode: 'accept-edits',
      effort: 'high',
      preset: team.preset === null ? undefined : team.preset,
      acceptance_criteria: task.acceptance_criteria,
      verification_command: currentRun.planApproved ? task.verification_command : undefined,
      onDone: (taskRecord) => {
        guardRun(runId, () => handleTaskDone(runId, task.id, taskRecord));
      },
      onError: (err) => {
        guardRun(runId, () => handleTaskError(runId, task.id, err));
      }
    });
    task.taskId = proc.taskId;
    atomicWriteJson(runFile(runId), currentRun);
  } catch (err) {
    if (err.message && err.message.includes('Concurrency limit reached')) {
      task.status = 'pending';
      task.startedAt = null;
      atomicWriteJson(runFile(runId), currentRun);
      setTimeout(() => guardRun(runId, () => scheduleTasks(runId)), 5000).unref();
      return;
    }
    task.status = 'failed';
    task.error = err.message;
    task.finishedAt = new Date().toISOString();
    atomicWriteJson(runFile(runId), currentRun);
    scheduleTasks(runId);
  }
}

function handleTaskDone(runId, taskId, taskRecord) {
  const run = getRawRun(runId);
  if (!run) return;
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task) return;

  if (run.status === 'cancelled') {
    task.status = 'cancelled';
  } else {
    task.status = taskRecord.status;
    task.error = taskRecord.error || null;
  }
  task.output = taskRecord.output || '';
  task.finishedAt = new Date().toISOString();
  if (taskRecord.verification) {
    task.verification = taskRecord.verification;
  }
  run.usage.total_tokens = (run.usage.total_tokens || 0) + (taskRecord.usage?.total_tokens || 0);

  atomicWriteJson(runFile(runId), run);
  scheduleTasks(runId);
}

function handleTaskError(runId, taskId, err) {
  const run = getRawRun(runId);
  if (!run) return;
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = 'failed';
  task.error = err.message;
  task.finishedAt = new Date().toISOString();
  atomicWriteJson(runFile(runId), run);
  scheduleTasks(runId);
}

function checkReviewOrFinish(runId) {
  const run = getRawRun(runId);
  if (!run || run.status !== 'running') return;

  const team = run.team;
  const anyCompleted = run.tasks.some((t) => t.status === 'completed');

  if (team.review && anyCompleted && !run.review) {
    run.status = 'reviewing';
    atomicWriteJson(runFile(runId), run);

    const changes = getWorkspaceChanges(run.workspace);
    const reviewPrompt = buildReviewPrompt(team, run, changes);

    try {
      const revProc = runTask({
        account: team.leader.account,
        role: 'team-leader',
        persona: false,
        prompt: reviewPrompt,
        workspace: run.workspace,
        mode: 'plan',
        effort: team.leader.effort,
        model: team.leader.model || undefined,
        preset: 'none',
        onDone: (revRecord) => {
          guardRun(runId, () => {
            const fresh = getRawRun(runId);
            if (!fresh) return;
            fresh.review = {
              taskId: revRecord.id,
              status: revRecord.status,
              output: (revRecord.output || '').slice(-4000)
            };
            fresh.usage.total_tokens = (fresh.usage.total_tokens || 0) + (revRecord.usage?.total_tokens || 0);
            finalizeRun(fresh);
          });
        },
        onError: (err) => {
          guardRun(runId, () => {
            const fresh = getRawRun(runId);
            if (!fresh) return;
            fresh.review = {
              taskId: null,
              status: 'failed',
              output: err.message
            };
            finalizeRun(fresh);
          });
        }
      });
      run.review = {
        taskId: revProc.taskId,
        status: 'running',
        output: ''
      };
      atomicWriteJson(runFile(runId), run);
      return;
    } catch (err) {
      run.review = {
        taskId: null,
        status: 'failed',
        output: err.message
      };
      finalizeRun(run);
      return;
    }
  }

  finalizeRun(run);
}

function finalizeRun(run) {
  if (run.status === 'cancelled') {
    run.finishedAt = new Date().toISOString();
  } else if (run.status === 'running' || run.status === 'reviewing') {
    const allCompleted = run.tasks.length > 0 && run.tasks.every((t) => t.status === 'completed');
    if (allCompleted) {
      run.status = 'completed';
      run.error = null;
    } else {
      run.status = 'failed';
      const failedCount = run.tasks.filter((t) => t.status !== 'completed').length;
      run.error = `${failedCount} of ${run.tasks.length} tasks did not complete`;
    }
    run.finishedAt = new Date().toISOString();
  }
  atomicWriteJson(runFile(run.id), run);
  activeRuns.delete(run.id);
}

function failRun(runId, err) {
  try {
    const run = getRawRun(runId);
    if (run && UNFINISHED_RUN_STATUSES.has(run.status)) {
      run.status = 'failed';
      run.error = `Team run stopped by an unexpected error: ${err.message}`;
      run.finishedAt = new Date().toISOString();
      atomicWriteJson(runFile(runId), run);
    }
  } catch (recordErr) {}
  activeRuns.delete(runId);
}

function guardRun(runId, fn) {
  try {
    fn();
  } catch (err) {
    failRun(runId, err);
  }
}

function cancelRun(runId) {
  assertValidRunId(runId);
  const claim = claimRun(runFile(runId), 2000);
  try {
    return cancelClaimedRun(runId);
  } finally {
    releaseClaim(claim);
  }
}

function cancelClaimedRun(runId) {
  const run = getRawRun(runId);
  if (!run) throw new TeamError(`Run "${runId}" not found`, 404);

  run.status = 'cancelled';
  run.finishedAt = new Date().toISOString();

  if (run.leader && run.leader.taskId) {
    try { cancelTask(run.leader.taskId); } catch (err) {}
  }
  if (run.review && run.review.taskId) {
    try { cancelTask(run.review.taskId); } catch (err) {}
    run.review.status = 'cancelled';
  }
  for (const t of run.tasks) {
    if (t.status === 'running' && t.taskId) {
      try { cancelTask(t.taskId); } catch (err) {}
      t.status = 'cancelled';
      t.finishedAt = new Date().toISOString();
    } else if (t.status === 'pending') {
      t.status = 'cancelled';
      t.finishedAt = new Date().toISOString();
    }
  }
  atomicWriteJson(runFile(runId), run);
  activeRuns.delete(runId);
  return formatRun(run);
}

module.exports = {
  listTeamTemplates,
  getTeamTemplate,
  draftFromTemplate,
  TeamError,
  RUN_ID_PATTERN,
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  teamsUsingAccount,
  startRun,
  executeRun,
  cancelRun,
  getRun,
  getRawRun,
  listRuns,
  getTeamsDir,
  getRunsDir,
  runFile,
  teamFile,
  buildLeaderPrompt,
  buildDevPrompt,
  buildReviewPrompt,
  parsePlan,
  validatePlanTasks
};
