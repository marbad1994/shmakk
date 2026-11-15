const fs = require('fs');
const path = require('path');

// Map shell name to the preferred executable path.
// Resolve's dctl paths on Arch-like systems can put bash in /usr/bin instead of /bin.
// Map shell name to candidate executable paths.
// Ordered by likelihood on the current platform; first existing path wins.
const SHELL_PATH_CANDIDATES = {
  fish: ['/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/bin/fish'],
  bash: ['/usr/bin/bash', '/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'],
  zsh: ['/usr/bin/zsh', '/bin/zsh', '/opt/homebrew/bin/zsh', '/usr/local/bin/zsh'],
};

function shellPath(name) {
  // Name given explicitly (--shell flag): try known paths first, then PATH.
  const candidates = SHELL_PATH_CANDIDATES[name];
  if (candidates) {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fall back to PATH search for the requested shell.
  const { execSync } = require('child_process');
  try {
    const p = execSync(`command -v ${name}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}

  return null;
}

function detectShell(shellOverride) {
  // Explicit --shell flag overrides everything.
  if (shellOverride) {
    const p = shellPath(shellOverride);
    if (p) return { path: p, name: shellOverride };
    process.stderr.write(`[shmakk] shell "${shellOverride}" not found, falling back to default\n`);
  }

  const env = process.env.SHELL;
  if (env && fs.existsSync(env)) {
    return { path: env, name: path.basename(env) };
  }
  const fallbacks = ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/sh'];
  for (const f of fallbacks) {
    if (fs.existsSync(f)) return { path: f, name: path.basename(f) };
  }
  return { path: '/bin/sh', name: 'sh' };
}

module.exports = { detectShell, shellPath };
