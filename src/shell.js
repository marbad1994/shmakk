const fs = require('fs');
const path = require('path');

function detectShell() {
  const env = process.env.SHELL;
  if (env && fs.existsSync(env)) {
    return { path: env, name: path.basename(env) };
  }
  const fallbacks = ['/bin/bash', '/usr/bin/bash', '/bin/sh'];
  for (const f of fallbacks) {
    if (fs.existsSync(f)) return { path: f, name: path.basename(f) };
  }
  return { path: '/bin/sh', name: 'sh' };
}

function shellArgs(name) {
  // Login + interactive so the user's normal init runs.
  // We deliberately keep this minimal: do NOT inject rc files,
  // do NOT alter prompt. Phase 2 will add hooks for command metadata.
  switch (name) {
    case 'fish':
      return ['-i', '-l'];
    case 'zsh':
      return ['-i', '-l'];
    case 'bash':
      return ['-i', '-l'];
    default:
      return ['-i'];
  }
}

module.exports = { detectShell, shellArgs };
