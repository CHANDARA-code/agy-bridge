#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const problems = [];
const fail = (message) => problems.push(message);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf-8');
const readJson = (file) => {
  try {
    return JSON.parse(read(file));
  } catch (err) {
    fail(`${file} is missing or is not valid JSON (${err.message})`);
    return null;
  }
};

for (const dir of ['.', 'src']) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const file of fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.js'))) {
    const relative = path.join(dir, file);
    try {
      execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'pipe' });
    } catch (err) {
      fail(`${relative} has a syntax error: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
}

const pkg = readJson('package.json');
if (pkg) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version || '')) fail(`package.json version "${pkg.version}" is not semver`);
  if (!pkg.name) fail('package.json has no name');
  if (!pkg.repository || !pkg.repository.url) fail('package.json has no repository url');
}

const card = readJson('agent-card.json');
const legacy = readJson('agent.json');
const cardRoles = card ? (card.skills || []).map((skill) => skill.id) : [];
const legacyRoles = legacy ? (legacy.roles || []).map((role) => role.id) : [];

const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
if (card && legacy && !sameSet(cardRoles, legacyRoles)) {
  fail(`agent-card.json roles [${cardRoles.join(', ')}] differ from agent.json roles [${legacyRoles.join(', ')}]`);
}

if (card) {
  for (const skill of card.skills || []) {
    if (!skill.description) fail(`role ${skill.id} has no description`);
    if (skill.id === 'lead-software-engineer') continue;
    const persona = skill.agy_agent || skill.id;
    if (!fs.existsSync(path.join(root, 'personas', `${persona}.md`))) fail(`role ${skill.id} has no persona file personas/${persona}.md`);
  }
}

const mcpSource = (() => {
  try {
    return read('src/mcp-server.js');
  } catch (err) {
    fail('src/mcp-server.js is missing');
    return '';
  }
})();
const enumMatch = /role:\s*\{[\s\S]*?enum:\s*\[([\s\S]*?)\]/.exec(mcpSource);
if (!enumMatch) {
  fail('could not find the role enum in src/mcp-server.js');
} else {
  const mcpRoles = [...enumMatch[1].matchAll(/'([\w-]+)'/g)].map((match) => match[1]);
  if (card && !sameSet(cardRoles, mcpRoles)) {
    fail(`src/mcp-server.js role enum [${mcpRoles.join(', ')}] differs from agent-card.json roles [${cardRoles.join(', ')}]`);
  }
}

if (pkg && pkg.version) {
  let changelog = '';
  try {
    changelog = read('CHANGELOG.md');
  } catch (err) {
    fail('CHANGELOG.md is missing');
  }
  if (changelog && !changelog.includes(`## [${pkg.version}]`)) fail(`CHANGELOG.md has no "## [${pkg.version}]" entry for the version in package.json`);
}

let readme = '';
try {
  readme = read('README.md');
} catch (err) {
  fail('README.md is missing');
}
for (const id of cardRoles) {
  if (!readme.includes(id)) fail(`README.md does not mention role ${id}`);
}

const PROVIDERS = ['agy', 'claude', 'codex'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let teamTemplates = 0;
if (fs.existsSync(path.join(root, 'team-templates'))) {
  const knownRoles = new Set(cardRoles);
  for (const file of fs.readdirSync(path.join(root, 'team-templates')).filter((name) => name.endsWith('.json'))) {
    const where = `team-templates/${file}`;
    const t = readJson(where);
    if (!t) continue;
    teamTemplates++;
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 80) fail(`${where}: title must be 1 to 80 characters`);
    if (typeof t.description !== 'string' || t.description.length > 300) fail(`${where}: description must be at most 300 characters`);
    const leader = t.leader || {};
    if (!PROVIDERS.includes(leader.provider)) fail(`${where}: leader.provider must be one of ${PROVIDERS.join(', ')}`);
    if (!EFFORTS.includes(leader.effort)) fail(`${where}: leader.effort must be one of ${EFFORTS.join(', ')}`);
    if (typeof leader.instructions !== 'string' || leader.instructions.length > 8000) fail(`${where}: leader.instructions must be at most 8000 characters`);
    if (!Array.isArray(t.members) || t.members.length < 1 || t.members.length > 12) fail(`${where}: members must list 1 to 12 members`);
    for (const m of t.members || []) {
      if (!PROVIDERS.includes(m.provider)) fail(`${where}: member provider must be one of ${PROVIDERS.join(', ')}`);
      if (!Array.isArray(m.roles) || !m.roles.length) fail(`${where}: every member needs at least one role`);
      for (const role of m.roles || []) if (!knownRoles.has(role)) fail(`${where}: unknown role ${role}`);
      if (typeof m.notes !== 'string' || m.notes.length > 300) fail(`${where}: member notes must be at most 300 characters`);
    }
    if (!Number.isInteger(t.maxParallel) || t.maxParallel < 1 || t.maxParallel > 4) fail(`${where}: maxParallel must be 1 to 4`);
    if (typeof t.review !== 'boolean') fail(`${where}: review must be true or false`);
  }
}

if (problems.length) {
  console.error(`Consistency check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Consistency check passed (${cardRoles.length} roles, ${teamTemplates} team templates).`);
