const fs = require('fs');
const path = require('path');

function shmakkStateDir(projectDir) {
  return path.join(projectDir, '.shmakk', 'state');
}

function vibeditState(projectDir) {
  const stateDir = shmakkStateDir(projectDir);
  return {
    stateDir,
    specsDir: path.join(stateDir, 'vibedit-specs'),
    pendingSpecFile: path.join(stateDir, 'vibedit-specs', 'pending'),
    sessionsDir: path.join(stateDir, 'vibedit-sessions'),
    automationsDir: path.join(stateDir, 'browser-automations'),
    pageStateFile: path.join(stateDir, 'vibedit-page-state.json'),
  };
}

function ensureVibeditState(projectDir) {
  const state = vibeditState(projectDir);
  fs.mkdirSync(state.specsDir, { recursive: true });
  fs.mkdirSync(state.sessionsDir, { recursive: true });
  fs.mkdirSync(state.automationsDir, { recursive: true });
  return state;
}

module.exports = {
  shmakkStateDir,
  vibeditState,
  ensureVibeditState,
};
