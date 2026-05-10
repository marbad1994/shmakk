const fs = require('fs');
const os = require('os');
const path = require('path');

const ZSHRC = `
# preserve real ZDOTDIR so user config is sourced
if [ -n "$SHMAKK_REAL_ZDOTDIR" ]; then
    [ -f "$SHMAKK_REAL_ZDOTDIR/.zshrc" ] && source "$SHMAKK_REAL_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi

__shmakk_preexec() {
    local cmd
    cmd=$(printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64)
    printf '\\e]6973;B;%s\\a' "$cmd"
}
__shmakk_precmd() {
    local ec=$?
    local p
    p=$(printf '%s' "$PWD" | base64 -w0 2>/dev/null || printf '%s' "$PWD" | base64)
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
  fs.writeFileSync(path.join(dir, '.zshrc'), ZSHRC, { mode: 0o600 });
  const realZ = process.env.ZDOTDIR || '';
  return {
    args: ['-i'],
    env: { ZDOTDIR: dir, SHMAKK_REAL_ZDOTDIR: realZ },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

module.exports = { configure };
