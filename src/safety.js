const path = require('path');
const os = require('os');

// run-tool / shell-command danger patterns. Matched against the literal cmd
// string the agent passes to `run`. If matched → 'unsafe' (always prompts).
const DANGER_RE = new RegExp([
  // privilege escalation
  '\\bsudo\\b', '\\bsu\\s', '\\bdoas\\b', '\\bpkexec\\b',
  // any deletion (recursive or not — user wants confirmation on every delete)
  '\\brm\\b(?!\\s+--?(version|help))', '\\brmdir\\b', '\\bunlink\\b',
  '\\btrash(-put)?\\b', '\\bgio\\s+trash\\b',
  '\\bchmod\\s+-R\\b', '\\bchown\\s+-R\\b',
  '\\bfind\\b[^\\n]*-delete\\b',
  // disk / fs
  '\\bmkfs\\b', '\\bdd\\s+if=', '\\bshred\\b', '\\bwipe\\b',
  // pipe-to-shell
  '\\|\\s*(sh|bash|zsh|fish)\\b',
  // redirect into system paths
  '>\\s*/(?!tmp|home|var/tmp|dev/null)',
  // personal config / display state mutation (lessons learned)
  '\\bsetxkbmap\\b', '\\blocalectl\\s+set\\b', '\\bgsettings\\s+set\\b',
  '\\bxset\\b', '\\bxrandr\\b', '\\bchsh\\b', '\\bcrontab\\s+-r\\b',
  '\\bsystemctl\\b(?!\\s+(status|cat|show|is-))', // status-y reads ok
  '\\bgit\\s+config\\s+--global\\b',
  // package manager: global / system installs run arbitrary code
  '\\bnpm\\s+(i|install|add)\\s+(-g|--global)\\b',
  '\\bpip\\d?\\s+install\\b', '\\bpipx\\s+install\\b',
  '\\bcargo\\s+install\\b', '\\bgo\\s+install\\b', '\\bgem\\s+install\\b',
  '\\bbrew\\s+install\\b',
  '\\bapt(-get)?\\s+(install|remove|purge|upgrade|dist-upgrade)\\b',
  '\\bdnf\\s+(install|remove|upgrade)\\b',
  '\\bpacman\\s+-[A-Z]*[SR]\\b', '\\byay\\s+-S\\b', '\\bparu\\s+-S\\b',
  '\\bzypper\\s+(in|install|rm|remove)\\b',
].join('|'), 'i');

function classifyRunCommand(cmd) {
  if (!cmd) return 'safe';
  return DANGER_RE.test(cmd) ? 'unsafe' : 'safe';
}

// Paths whose read OR write should always prompt (even in auto mode).
// Match against the *resolved relative path* we present to the agent, plus
// the absolute path so e.g. ~/.ssh works when workspace is ~.
const SECRET_RE = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.gem\/credentials$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.kube\/config(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.config\/gh(\/|$)/,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/,
  /(^|\/)credentials(\.json|\.yaml|\.yml)?$/i,
];

function isSecretPath(p) {
  if (!p) return false;
  return SECRET_RE.some((r) => r.test(p));
}

function workspaceWarning(workspace) {
  if (!workspace) return null;
  const r = path.resolve(workspace);
  const home = os.homedir();
  if (r === '/' || r === '/etc' || r === home) {
    return `workspace is ${r} — that's broad. Consider \`aiterm --workspace <project-dir>\` to keep AI scope smaller.`;
  }
  return null;
}

module.exports = { classifyRunCommand, isSecretPath, workspaceWarning, DANGER_RE };
