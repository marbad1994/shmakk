// Returns { args, env, cleanup } for spawning fish with markers wired up.
// fish supports `-C COMMAND` to run init code after config.fish.
//
// base64 encoding: try `-w0` (GNU coreutils), fall back to `-b 0` (BSD/macOS),
// then plain `base64` as last resort. `tr -d '\n'` strips any line wrapping
// so the OSC marker payload stays on one line.

const INIT = `
function __shmakk_pre --on-event fish_preexec
    set -l c (printf '%s' "$argv" | base64 -w0 2>/dev/null || base64 -b 0 2>/dev/null || base64 | tr -d '\n')
    printf '\\e]6973;B;%s\\a' "$c"
end
function __shmakk_post --on-event fish_postexec
    set -l ec $status
    set -l p (printf '%s' "$PWD" | base64 -w0 2>/dev/null || base64 -b 0 2>/dev/null || base64 | tr -d '\n')
    printf '\\e]6973;C;%s\\a' $ec
    printf '\\e]6973;D;%s\\a' "$p"
end
# Override shmakk binary inside a session so "shmakk <cmd>" routes to
# local self-commands instead of forking a nested shmakk process.
# Passes through --flags to the real shmakk binary.
function shmakk
    if set -q argv[1]; and string match -qr '^--' -- "$argv[1]"
        command shmakk $argv
        return $status
    end
    set -l raw (printf '%s' "shmakk $argv" | base64 -w0 2>/dev/null || base64 -b 0 2>/dev/null || base64 | tr -d '\n')
    set -l pwd_b64 (printf '%s' "$PWD" | base64 -w0 2>/dev/null || base64 -b 0 2>/dev/null || base64 | tr -d '\n')
    printf '\\e]6973;B;%s\\a' "$raw"
    printf '\\e]6973;C;127\\a'
    printf '\\e]6973;D;%s\\a' "$pwd_b64"
    return 127
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
