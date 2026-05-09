// Control commands run from *inside* an aiterm session (the orchestrator
// puts its own PID in AITERM_PID for the child shell's environment).

function getParentPid() {
  const pid = parseInt(process.env.AITERM_PID || '0', 10);
  return pid > 0 ? pid : 0;
}

function profileSignalPath(pid) {
  return `/tmp/aiterm-profile-${pid}.txt`;
}

function taskJournalPath(cwd = process.cwd()) {
  return require('path').join(cwd, '.aiterm', 'state', 'task-journal.json');
}

function activeSkillMetaPath(cwd = process.cwd()) {
  return require('path').join(cwd, '.aiterm', 'state', 'active-skill.json');
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function status() {
  const pid = getParentPid();
  if (!pid) {
    process.stdout.write('aiterm: not running (this terminal is not inside aiterm)\n');
    return 1;
  }
  if (!isAlive(pid)) {
    process.stdout.write(`aiterm: stale AITERM_PID=${pid} (parent not alive)\n`);
    return 2;
  }
  process.stdout.write(`aiterm: running, parent pid ${pid}\n`);
  return 0;
}

function exitParent() {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('aiterm --exit: not inside an aiterm session\n');
    return 1;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) {
    process.stderr.write(`aiterm --exit: ${e.message}\n`); return 1;
  }
  return 0;
}

function restartParent() {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('aiterm --restart: not inside an aiterm session\n');
    return 1;
  }
  try { process.kill(pid, 'SIGUSR1'); } catch (e) {
    process.stderr.write(`aiterm --restart: ${e.message}\n`); return 1;
  }
  return 0;
}

function resetConversation() {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('aiterm --reset: not inside an aiterm session\n');
    return 1;
  }
  try { process.kill(pid, 'SIGUSR2'); } catch (e) {
    process.stderr.write(`aiterm --reset: ${e.message}\n`); return 1;
  }
  return 0;
}

function setProfileAndRestart(profileName) {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('aiterm --profile-set: not inside an aiterm session\n');
    return 1;
  }
  const name = String(profileName || '').trim().toLowerCase();
  if (!name) {
    process.stderr.write('aiterm --profile-set: missing profile name\n');
    return 1;
  }
  try {
    require('fs').writeFileSync(profileSignalPath(pid), name + '\n', 'utf8');
    process.kill(pid, 'SIGUSR1');
  } catch (e) {
    process.stderr.write(`aiterm --profile-set: ${e.message}\n`);
    return 1;
  }
  return 0;
}

function resumeStatus() {
  const p = taskJournalPath();
  try {
    const fs = require('fs');
    if (!fs.existsSync(p)) {
      process.stdout.write('aiterm: no resume journal found\n');
      return 0;
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    process.stdout.write('aiterm resume status\n');
    process.stdout.write('--------------------\n');
    process.stdout.write(`status: ${j.status || 'unknown'}\n`);
    process.stdout.write(`profile: ${j.profile || 'unknown'}\n`);
    process.stdout.write(`updated: ${j.updatedAt || 'unknown'}\n`);
    process.stdout.write(`input: ${String(j.input || '').slice(0, 120)}\n`);
    process.stdout.write(`touched_files: ${Array.isArray(j.touchedFiles) ? j.touchedFiles.length : 0}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`aiterm --resume-status: ${e.message}\n`);
    return 1;
  }
}

function compactContext() {
  const pid = getParentPid();
  if (pid && isAlive(pid)) {
    try { process.kill(pid, 'SIGUSR2'); } catch (e) {
      process.stderr.write(`aiterm --compact: ${e.message}\n`);
      return 1;
    }
    process.stdout.write('aiterm: compact requested (conversation + task journal cleared)\n');
    return 0;
  }

  try {
    const fs = require('fs');
    fs.rmSync(taskJournalPath(), { force: true });
    process.stdout.write('aiterm: compacted local task journal (no active session)\n');
    return 0;
  } catch (e) {
    process.stderr.write(`aiterm --compact: ${e.message}\n`);
    return 1;
  }
}

function stats() {
  const fs = require('fs');
  const audit = require('./audit');
  const pid = getParentPid();
  const running = !!(pid && isAlive(pid));
  let journal = null;
  let activeSkill = null;
  let auditLines = 0;

  try {
    const p = taskJournalPath();
    if (fs.existsSync(p)) journal = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  try {
    const p = activeSkillMetaPath();
    if (fs.existsSync(p)) activeSkill = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  try {
    const p = audit.logPath();
    if (fs.existsSync(p)) auditLines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch {}

  process.stdout.write('aiterm stats\n');
  process.stdout.write('-----------\n');
  process.stdout.write(`session_running: ${running ? 'yes' : 'no'}\n`);
  process.stdout.write(`session_pid: ${running ? pid : 'n/a'}\n`);
  process.stdout.write(`resume_status: ${journal?.status || 'none'}\n`);
  process.stdout.write(`resume_updated: ${journal?.updatedAt || 'n/a'}\n`);
  process.stdout.write(`resume_touched_files: ${Array.isArray(journal?.touchedFiles) ? journal.touchedFiles.length : 0}\n`);
  process.stdout.write(`profile: ${journal?.profile || 'n/a'}\n`);
  process.stdout.write(`active_skill: ${activeSkill?.name || 'none'}\n`);
  process.stdout.write(`active_skill_loaded_at: ${activeSkill?.loadedAt || 'n/a'}\n`);
  process.stdout.write(`audit_events_total: ${auditLines}\n`);
  process.stdout.write('token_stats: unavailable (provider usage streaming not persisted yet)\n');
  return 0;
}

function loadSkill(name) {
  const { loadSkillToWorkspace } = require('./skills');
  const res = loadSkillToWorkspace(name, process.cwd());
  if (!res.ok) {
    process.stderr.write(`aiterm --load-skill: ${res.error}\n`);
    if (res.searched) process.stderr.write(`searched:\n- ${res.searched.join('\n- ')}\n`);
    return 1;
  }
  process.stdout.write(`aiterm: loaded skill '${res.name}'\n`);
  process.stdout.write(`source: ${res.source}\n`);
  process.stdout.write(`local: ${res.localPath}\n`);
  return 0;
}

module.exports = { status, exitParent, restartParent, resetConversation, setProfileAndRestart, profileSignalPath, resumeStatus, compactContext, stats, loadSkill };
