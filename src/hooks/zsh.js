const fs = require('fs');
const os = require('os');
const path = require('path');

const ZSHRC = `
# preserve real ZDOTDIR so user config is sourced
if [ -n "$AITERM_REAL_ZDOTDIR" ]; then
    [ -f "$AITERM_REAL_ZDOTDIR/.zshrc" ] && source "$AITERM_REAL_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi

__aiterm_preexec() {
    local cmd
    cmd=$(printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64)
    printf '\\e]6973;B;%s\\a' "$cmd"
}
__aiterm_precmd() {
    local ec=$?
    local p
    p=$(printf '%s' "$PWD" | base64 -w0 2>/dev/null || printf '%s' "$PWD" | base64)
    printf '\\e]6973;C;%s\\a' "$ec"
    printf '\\e]6973;D;%s\\a' "$p"
}
typeset -ag preexec_functions precmd_functions
preexec_functions+=(__aiterm_preexec)
precmd_functions+=(__aiterm_precmd)
`;

function configure() {
  const dir = path.join(os.tmpdir(), `aiterm-zsh-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.zshrc'), ZSHRC, { mode: 0o600 });
  const realZ = process.env.ZDOTDIR || '';
  return {
    args: ['-i'],
    env: { ZDOTDIR: dir, AITERM_REAL_ZDOTDIR: realZ },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

module.exports = { configure };
