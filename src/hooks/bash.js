const fs = require('fs');
const os = require('os');
const path = require('path');

const INIT = `
[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

__aiterm_armed=1
__aiterm_preexec() {
    [ -n "$COMP_LINE" ] && return
    [ -z "$__aiterm_armed" ] && return
    [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
    __aiterm_armed=
    local cmd
    cmd=$(printf '%s' "$BASH_COMMAND" | base64 -w0 2>/dev/null || printf '%s' "$BASH_COMMAND" | base64)
    printf '\\e]6973;B;%s\\a' "$cmd"
}
__aiterm_precmd() {
    local ec=$?
    local p
    p=$(printf '%s' "$PWD" | base64 -w0 2>/dev/null || printf '%s' "$PWD" | base64)
    printf '\\e]6973;C;%s\\a' "$ec"
    printf '\\e]6973;D;%s\\a' "$p"
    __aiterm_armed=1
}
trap '__aiterm_preexec' DEBUG
PROMPT_COMMAND="__aiterm_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
`;

function configure() {
  const dir = path.join(os.tmpdir(), `aiterm-bash-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const rcfile = path.join(dir, 'bashrc');
  fs.writeFileSync(rcfile, INIT, { mode: 0o600 });
  return {
    args: ['--rcfile', rcfile, '-i'],
    env: {},
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

module.exports = { configure };
