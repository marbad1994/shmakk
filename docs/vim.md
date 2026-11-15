# shmakk Vim / vi

shmakk can wrap your normal `vi` or `vim` command inside a shmakk session and add AI editor commands without replacing your Vim setup.

## Launch modes

```bash
shmakk --vim vi       # default: intercept vi
shmakk --vim vim      # intercept vim
shmakk --vim disable  # no Vim interception
```

When enabled, shmakk creates a temporary executable shim and prepends it to `PATH` inside the shmakk shell. The shim launches your real editor, lets it load your normal vimrc/plugins/colors, then sources a generated shmakk Vim plugin.

## Commands

| Command | Purpose |
|---------|---------|
| `:G <prompt>` | Generate code at the cursor |
| `:Tw <prompt>` | Write prose or documentation at the cursor |
| `:Cmd <command>` | Run a shell command in a scratch buffer |
| `:ShmakkSuggest` | Request a full-block code suggestion |
| `:ShmakkAccept` | Preview and accept a pending auto-suggestion |
| `:ShmakkPreview` | Preview a pending auto-suggestion |
| `:ShmakkDeny` | Clear a pending auto-suggestion |

Mappings:

| Mapping | Purpose |
|---------|---------|
| `<C-Space>` | Manual full-block suggestion with preview + Accept/Deny |
| `<leader>sa` | Accept pending auto-suggestion |
| `<leader>sp` | Preview pending auto-suggestion |
| `<leader>sd` | Deny pending auto-suggestion |

Lowercase `:g` is not overridden because it is Vim's native `:global` command. Use uppercase `:G` for shmakk generation. Normal Vim commands such as `:%s/foo/bar/g` remain native Vim behavior.

## Suggestions

Manual suggestions are available with `<C-Space>` or `:ShmakkSuggest`. shmakk opens a scratch preview buffer and asks whether to accept or deny before inserting.

Automatic suggestions are opt-in:

```vim
let g:shmakk_auto_suggest = 1
let g:shmakk_auto_suggest_delay_ms = 2000
let g:shmakk_auto_suggest_min_chars = 20
```

Auto-suggest uses Vim `job_start()` when available, so the model call runs in the background. When a suggestion is ready, shmakk stores it as a pending suggestion and prints:

```text
[shmakk] suggestion ready: :ShmakkAccept, :ShmakkPreview, or :ShmakkDeny
```

`ShmakkAccept` always previews before inserting.

## Fast model routing

Vim suggestions prefer a fast endpoint:

1. `SHMAKK_VIM_SUGGEST_ENDPOINT`
2. `SHMAKK_FAST_ENDPOINT`
3. the endpoint registry's `"fast"` model
4. the current/main model

Example `~/.config/shmakk/endpoints.json`:

```json
{
  "main": "pro",
  "fast": "flash",
  "models": {
    "pro": {
      "provider": "google",
      "model": "gemini-pro",
      "api_key": "..."
    },
    "flash": {
      "provider": "google",
      "model": "gemini-flash",
      "api_key": "..."
    }
  }
}
```

## Speed tuning

Suggestions send a trimmed context window around the cursor. Tune it with environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SHMAKK_VIM_SUGGEST_BEFORE_LINES` | `80` | Lines before cursor |
| `SHMAKK_VIM_SUGGEST_AFTER_LINES` | `40` | Lines after cursor |
| `SHMAKK_VIM_SUGGEST_MAX_CHARS` | `12000` | Maximum suggestion context chars |

For lower latency, use a fast model and reduce context, for example:

```bash
export SHMAKK_VIM_SUGGEST_ENDPOINT=flash
export SHMAKK_VIM_SUGGEST_MAX_CHARS=4000
export SHMAKK_VIM_SUGGEST_BEFORE_LINES=40
export SHMAKK_VIM_SUGGEST_AFTER_LINES=20
```

## Command execution

`:Cmd` runs shell commands in the current Vim working directory and shows output in a scratch buffer. It removes shmakk session environment variables and blocks running `shmakk` recursively from inside `:Cmd`.

