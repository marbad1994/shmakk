// Returns { args, env, cleanup } for spawning fish with markers wired up.
// fish supports `-C COMMAND` to run init code after config.fish.

const INIT = `
function __shmakk_pre --on-event fish_preexec
    set -l c (printf '%s' "$argv" | base64 -w0 2>/dev/null; or printf '%s' "$argv" | base64)
    printf '\\e]6973;B;%s\\a' "$c"
end
function __shmakk_post --on-event fish_postexec
    set -l ec $status
    set -l p (printf '%s' "$PWD" | base64 -w0 2>/dev/null; or printf '%s' "$PWD" | base64)
    printf '\\e]6973;C;%s\\a' $ec
    printf '\\e]6973;D;%s\\a' "$p"
end
`.trim();

function configure() {
  return {
    args: ['-i', '-l', '-C', INIT],
    env: {},
    cleanup: () => {},
  };
}

module.exports = { configure };
