// Agent overview — live tracking registry for multi-agent team execution.
//
// Maintains an in-memory registry of all agents (active and completed) during
// a team run. Provides query methods for the overview self-commands so users
// can see which agents are working, which skills they use, and drill into
// specific agents for detailed output.
//
// Architecture:
//   team.js → agentOverview.register(id, meta)   when an agent starts
//   team.js → agentOverview.update(id, patch)     when an agent finishes
//   self-commands → agentOverview.getAll()        for overview display
//   self-commands → agentOverview.get(id)         for detailed drill-down

const MAX_HISTORY = 50;  // keep at most N completed entries after reset

// In-memory state — one registry per process lifetime.
// Keys: agent id (string). Values: entry object.
const registry = new Map();

// Stable order of registration (for overview listing).
const order = [];

let teamRunActive = false;
let teamRunId = null;

// ── Public API ────────────────────────────────────────────────────────────────

function startTeamRun(id) {
  teamRunActive = true;
  teamRunId = id || `team-${Date.now()}`;
}

function endTeamRun() {
  teamRunActive = false;
  teamRunId = null;
}

function isTeamRunActive() {
  return teamRunActive;
}

function register(id, meta) {
  if (!id) id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const entry = {
    id,
    role: meta.role || 'unknown',
    skill: meta.skill || null,
    skillSource: meta.skillSource || null,
    task: meta.task || '',
    fileScope: meta.fileScope || null,
    topology: meta.topology || 'unknown',
    status: meta.status || 'pending',   // pending | running | done | error
    startTime: meta.startTime || Date.now(),
    endTime: null,
    toolCount: 0,
    error: null,
    output: '',       // truncated on store; full accessed via separate buffer
    outputPreview: '', // first 2000 chars for quick display
  };

  registry.set(id, entry);
  order.push(id);
  return id;
}

function update(id, patch) {
  const entry = registry.get(id);
  if (!entry) return false;

  if (patch.status) entry.status = patch.status;
  if (patch.endTime) entry.endTime = patch.endTime;
  if (patch.toolCount !== undefined) entry.toolCount = patch.toolCount;
  if (patch.error !== undefined) entry.error = patch.error;
  if (patch.skill !== undefined) entry.skill = patch.skill;
  if (patch.skillSource !== undefined) entry.skillSource = patch.skillSource;

  if (patch.output !== undefined) {
    const stripped = stripAnsi(String(patch.output));
    entry.outputPreview = stripped.slice(0, 2000);
    entry.output = stripped.slice(0, 8000); // keep reasonable cap
  }

  return true;
}

// Mark an agent as running (transitions from pending → running).
function markRunning(id) {
  return update(id, { status: 'running', startTime: Date.now() });
}

// Mark an agent as completed with result data.
function markDone(id, { toolCount, output, skill, skillSource } = {}) {
  return update(id, {
    status: 'done',
    endTime: Date.now(),
    toolCount: toolCount || 0,
    output: output || '',
    skill: skill || undefined,
    skillSource: skillSource || undefined,
  });
}

// Mark an agent as errored.
function markError(id, error) {
  return update(id, { status: 'error', endTime: Date.now(), error: String(error || '') });
}

// ── Query API ─────────────────────────────────────────────────────────────────

function get(id) {
  const entry = registry.get(id);
  if (!entry) return null;
  return { ...entry };  // defensive copy
}

function getAll() {
  // Return entries in registration order, newest last.
  return order.map(id => {
    const e = registry.get(id);
    return e ? { ...e } : null;
  }).filter(Boolean);
}

function getActive() {
  return getAll().filter(e => e.status === 'running' || e.status === 'pending');
}

function getCompleted() {
  return getAll().filter(e => e.status === 'done' || e.status === 'error');
}

// Find by role name (case-insensitive partial match).
function findByRole(role) {
  const lower = String(role).toLowerCase();
  return getAll().filter(e => e.role.toLowerCase().includes(lower));
}

// Find by skill name.
function findBySkill(skill) {
  const lower = String(skill).toLowerCase();
  return getAll().filter(e => e.skill && e.skill.toLowerCase().includes(lower));
}

// ── Reset ─────────────────────────────────────────────────────────────────────

// Called at the end of a team run to clear state for the next run.
// Keeps a small history window for post-run inspection.
function reset() {
  const completed = getCompleted();
  // Trim to MAX_HISTORY, keeping most recent.
  const toKeep = completed.slice(-MAX_HISTORY);

  registry.clear();
  order.length = 0;

  for (const e of toKeep) {
    registry.set(e.id, e);
    order.push(e.id);
  }

  teamRunActive = false;
  teamRunId = null;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

function statusIcon(status) {
  switch (status) {
    case 'pending': return '\x1b[2m○\x1b[0m';     // dim circle
    case 'running': return '\x1b[36m◉\x1b[0m';     // cyan filled circle
    case 'done': return '\x1b[32m●\x1b[0m';        // green filled circle
    case 'error': return '\x1b[31m●\x1b[0m';       // red filled circle
    default: return '\x1b[2m?\x1b[0m';
  }
}

// Build a compact overview table as an array of strings.
function formatOverview(agents) {
  if (!agents || agents.length === 0) {
    return ['\x1b[2mNo agents registered.\x1b[0m'];
  }

  const now = Date.now();
  const lines = [];

  // Header
  const teamTag = teamRunId ? ` \x1b[2m(team: ${teamRunId.slice(-8)})\x1b[0m` : '';
  lines.push(`\x1b[1mAgent Overview${teamTag}\x1b[0m`);
  lines.push('');

  // Column widths
  const roleWidth = Math.max(8, ...agents.map(a => a.role.length));
  const skillWidth = Math.max(5, ...agents.map(a => (a.skill || '—').length));
  const taskWidth = Math.min(60, Math.max(4, ...agents.map(a => (a.task || '').length)));

  for (const a of agents) {
    const icon = statusIcon(a.status);
    const role = a.role.padEnd(roleWidth);
    const skill = (a.skill || '\x1b[2m—\x1b[0m').padEnd(skillWidth + (a.skill ? 0 : 9)); // +9 for ANSI codes
    const task = (a.task || '').slice(0, taskWidth);
    const elapsed = a.endTime
      ? formatDuration(a.endTime - a.startTime)
      : formatDuration(now - a.startTime);
    const tools = a.toolCount > 0 ? `${a.toolCount} tools` : '';

    lines.push(` ${icon} \x1b[36m${role}\x1b[0m  \x1b[2m${skill.trim()}\x1b[0m  ${task}`);
    const infoParts = [];
    if (elapsed) infoParts.push(elapsed);
    if (tools) infoParts.push(tools);
    if (a.error) infoParts.push(`\x1b[31m${a.error}\x1b[0m`);
    lines.push(`   \x1b[2m${' '.repeat(roleWidth)}  ${infoParts.join(' · ')}\x1b[0m`);
  }

  // Summary line
  const active = agents.filter(a => a.status === 'running' || a.status === 'pending').length;
  const done = agents.filter(a => a.status === 'done').length;
  const errors = agents.filter(a => a.status === 'error').length;
  const summaryParts = [];
  if (active) summaryParts.push(`\x1b[36m${active} active\x1b[0m`);
  if (done) summaryParts.push(`\x1b[32m${done} done\x1b[0m`);
  if (errors) summaryParts.push(`\x1b[31m${errors} errors\x1b[0m`);
  lines.push('');
  lines.push(`\x1b[2m${agents.length} total${summaryParts.length ? ' · ' + summaryParts.join(' · ') : ''}\x1b[0m`);

  return lines;
}

// Build a detailed single-agent view.
function formatAgentDetail(agent) {
  if (!agent) return ['\x1b[31mAgent not found.\x1b[0m'];

  const now = Date.now();
  const lines = [];

  lines.push(`\x1b[1m${agent.role}\x1b[0m  ${statusIcon(agent.status)} ${agent.status}`);
  lines.push(`\x1b[2mid: ${agent.id}\x1b[0m`);
  lines.push('');

  if (agent.task) {
    lines.push(`\x1b[1mTask\x1b[0m`);
    lines.push(`  ${agent.task}`);
    lines.push('');
  }

  lines.push(`\x1b[1mDetails\x1b[0m`);
  lines.push(`  Role:      ${agent.role}`);
  lines.push(`  Skill:     ${agent.skill || '\x1b[2m(none — using roster hint)\x1b[0m'}`);
  if (agent.skillSource) lines.push(`  Source:    \x1b[2m${agent.skillSource}\x1b[0m`);
  lines.push(`  Topology:  ${agent.topology}`);
  if (agent.fileScope) lines.push(`  Scope:     ${agent.fileScope}`);

  const elapsed = agent.endTime
    ? formatDuration(agent.endTime - agent.startTime)
    : `\x1b[36m${formatDuration(now - agent.startTime)} (running)\x1b[0m`;
  lines.push(`  Duration:  ${elapsed}`);
  lines.push(`  Tools:     ${agent.toolCount}`);

  if (agent.error) {
    lines.push(`  Error:     \x1b[31m${agent.error}\x1b[0m`);
  }
  lines.push('');

  if (agent.outputPreview) {
    lines.push(`\x1b[1mOutput\x1b[0m (first 2000 chars)`);
    lines.push('\x1b[2m──────────────────────────────────────────────────────\x1b[0m');
    lines.push(agent.outputPreview);
    lines.push('\x1b[2m──────────────────────────────────────────────────────\x1b[0m');
    if (agent.output && agent.output.length >= 2000) {
      lines.push(`\x1b[2m... output truncated (${agent.output.length} total)\x1b[0m`);
    }
  }

  return lines;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // lifecycle
  startTeamRun,
  endTeamRun,
  isTeamRunActive,
  reset,

  // mutation
  register,
  update,
  markRunning,
  markDone,
  markError,

  // query
  get,
  getAll,
  getActive,
  getCompleted,
  findByRole,
  findBySkill,

  // formatting
  formatOverview,
  formatAgentDetail,
  statusIcon,
  formatDuration,
};
