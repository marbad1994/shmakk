// Control commands run from *inside* an aiterm session (the orchestrator
// puts its own PID in AITERM_PID for the child shell's environment).

function getParentPid() {
  const pid = parseInt(process.env.AITERM_PID || '0', 10);
  return pid > 0 ? pid : 0;
}

function profileSignalPath(pid) {
  return `/tmp/aiterm-profile-${pid}.txt`;
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

module.exports = { status, exitParent, restartParent, resetConversation, setProfileAndRestart, profileSignalPath };
