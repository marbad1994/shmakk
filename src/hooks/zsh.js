const fs = require('fs');
const os = require('os');
const path = require('path');

// zsh under a custom ZDOTDIR sources .zshenv, .zprofile, .zshrc, .zlogin from
// that directory. We create all four so nothing from the user's real ZDOTDIR
// is skipped.

const ZSHENV = `
# Source the real .zshenv so PATH and env vars are available.
if [ -n "$SHMAKK_REAL_ZDOTDIR" ] && [ -f "$SHMAKK_REAL_ZDOTDIR/.zshenv" ]; then
    source "$SHMAKK_REAL_ZDOTDIR/.zshenv"
elif [ -f "$HOME/.zshenv" ]; then
    source "$HOME/.zshenv"
fi
`;

const ZPROFILE = `
# Source the real .zprofile (login shell initialization).
if [ -n "$SHMAKK_REAL_ZDOTDIR" ] && [ -f "$SHMAKK_REAL_ZDOTDIR/.zprofile" ]; then
    source "$SHMAKK_REAL_ZDOTDIR/.zprofile"
elif [ -f "$HOME/.zprofile" ]; then
    source "$HOME/.zprofile"
fi
`;

const ZSHRC = `
# preserve real ZDOTDIR so user config is sourced
if [ -n "$SHMAKK_REAL_ZDOTDIR" ]; then
    [ -f "$SHMAKK_REAL_ZDOTDIR/.zshrc" ] && source "$SHMAKK_REAL_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi

__shmakk_preexec() {
    local cmd
    cmd=$(printf '%s' "$1" | base64 -w0 2>/dev/null || base64 -b 0 2>/dev/null || base64 | tr -d '\n')
    printf '\\e]6973;B;%s\\a' "$cmd"
}
__shmakk_precmd() {
    local ec=$?
    local p
    p=$(printf '%s' "$PWD" | base64 -w0 2>/dev/null || base64 -b 0 2>/dev/null || base64 | tr -d '\n')
    printf '\\e]6973;C;%s\\a' "$ec"
    printf '\\e]6973;D;%s\\a' "$p"
}
typeset -ag preexec_functions precmd_functions
preexec_functions+=(__shmakk_preexec)
precmd_functions+=(__shmakk_precmd)
`;

function configure() {
  const dir = path.join(os.tmpdir(), `shmakk-zsh-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  // zsh under a custom ZDOTDIR sources .zshenv, .zprofile, .zshrc, .zlogin
  // from that directory. We must provide all four so the user's environment
  // is complete.
  fs.writeFileSync(path.join(dir, '.zshenv'), ZSHENV, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.zprofile'), ZPROFILE, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.zshrc'), ZSHRC, { mode: 0o600 });
  // No .zlogin needed — zsh docs say .zlogin is for commands to run at the
  // start of an interactive login shell; .zprofile already covers env setup.
  const realZ = process.env.ZDOTDIR || '';
  return {
    args: ['-i'],
    env: { ZDOTDIR: dir, SHMAKK_REAL_ZDOTDIR: realZ },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

module.exports = { configure };
