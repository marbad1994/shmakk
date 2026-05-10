// shmakk orchestrator entry point.
// Manages signal-driven lifecycle (restart, exit, profile changes) and
// delegates each session to ./session.js.

const { runOneSession } = require('./session');
const { isConfigured } = require('./llm');
const { normalizeProfile } = require('./profiles');
const { profileSignalPath } = require('./control');

function isAbortError(e) {
  return e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

async function start(opts) {
  let runtimeProfile = normalizeProfile(opts.profile || process.env.SHMAKK_PROFILE) || 'balanced';
  let lastExit = 0;
  let restartRequested = false;
  let exitRequested = false;
  let activeSession = null;

  // Handlers persist across restarts; only installed once.
  const onSigTerm = () => { exitRequested = true; if (activeSession) activeSession.kill(); };
  const onSigUsr1 = () => { restartRequested = true; if (activeSession) activeSession.kill(); };
  // SIGUSR2 = clear conversation history. Hot-replaced per session below.
  let onSigUsr2 = () => {};
  process.on('SIGTERM', onSigTerm);
  process.on('SIGUSR1', onSigUsr1);
  process.on('SIGUSR2', () => onSigUsr2());

  while (true) {
    const signalFile = profileSignalPath(process.pid);
    try {
      const fs = require('fs');
      if (fs.existsSync(signalFile)) {
        const requested = String(fs.readFileSync(signalFile, 'utf8') || '').trim().toLowerCase();
        const normalized = normalizeProfile(requested);
        if (normalized) runtimeProfile = normalized;
        fs.rmSync(signalFile, { force: true });
      }
    } catch {}
    lastExit = await runOneSession({ ...opts, profile: runtimeProfile }, (s, resetFn) => { activeSession = s; onSigUsr2 = resetFn; });
    activeSession = null;
    onSigUsr2 = () => {};
    if (exitRequested) break;
    if (restartRequested) {
      restartRequested = false;
      process.stdout.write('\r\n\x1b[36m[shmakk] restarting...\x1b[0m\r\n');
      continue;
    }
    break;
  }
  process.removeListener('SIGTERM', onSigTerm);
  process.removeListener('SIGUSR1', onSigUsr1);
  return lastExit;
}

module.exports = { start };
