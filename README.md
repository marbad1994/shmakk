# shmakk

AI-supervised terminal wrapper — command correction, tool-driven task execution, safety confirmations, and profile-based runtime modes.

Your terminal, supercharged by AI. Optionally: talk to it.

**[Live demo →](https://marbad1994.github.io/shmakk/)**

## Requirements

- **Node.js 18+**
- **Linux or macOS** shell environment

## Install

```bash
npm install -g shmakk
```

That's it. Once installed, use `shmakk` anywhere:

```bash
shmakk --help
```

## Quick start

### 1. Set up an AI provider

```bash
export SHMAKK_BASE_URL="https://your-provider.example/v1"
export SHMAKK_API_KEY="your-api-key"
export SHMAKK_MODEL="gpt-4o-mini"
```

Or configure multiple native model providers in `~/.config/shmakk/endpoints.json`:

```json
{
  "main": "claude",
  "fast": "flash",
  "models": {
    "claude": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5-20250929",
      "api_key": "ANTHROPIC_API_KEY"
    },
    "flash": {
      "provider": "google",
      "model": "gemini-flash",
      "api_key": "GOOGLE_API_KEY"
    },
    "gpt5": {
      "provider": "codex",
      "model": "gpt-5-codex",
      "api_key": "OPENAI_API_KEY"
    },
    "kimi": {
      "provider": "nvidia",
      "model": "moonshotai/kimi-k2.6",
      "api_key": "nvapi-..."
    },
    "local-qwen": {
      "provider": "openai-compatible",
      "base_url": "http://127.0.0.1:1234/v1",
      "model": "qwen/qwen3.5-9b"
    }
  }
}
```

Providers: `openai-compatible` | `codex` | `anthropic` | `google` | `nvidia`

```bash
shmakk --endpoint claude
shmakk --model-recommendation    # main model chooses best model per call
```

### 2. Launch

```bash
shmakk
```

You're now in an AI-supervised terminal. Type commands as normal. shmakk will:

- **Correct mistakes** — typo in `gti status`? shmakk suggests `git status`. If the correction succeeds, shmakk follows up with the agent using your *original* intent, not just the fixed command.
- **Execute tasks** — ask "set up a new React project" and shmakk handles the steps
- **Keep you safe** — confirms risky commands before running them

## Web & desktop app

Prefer a window to a prompt? The same engine has a full graphical interface — everything the CLI can do, plus things a terminal can't show well (streaming markdown, inline diffs, approval cards, a plan checklist).

```bash
shmakk --web              # http://127.0.0.1:4317, opens your browser
shmakk --desktop          # the same UI as a desktop app (Electron)
```

It has four modes, each its own space — **Chat** (plain conversation), **Code** (the agent in your workspace), **Design** (interfaces with a live preview and version history) and **Cowork** (tasks and automations on a schedule or webhook) — and **Projects** that hold chats from all four, with a per-project switch for whether they share context.

In Code mode you get:

- **Chat** with streaming replies, a live tool timeline, inline diffs, and one-tap **Allow / Deny** for anything risky
- **Shell mode** (`$ git status`) — failed commands go through the same correction engine, then to the agent
- **A real terminal** docked at the bottom running the full `shmakk` CLI (or a plain shell)
- **Skills, memory & rules, plans, changes (with revert), session recall, agents & workflows, MCP servers, audit log, settings** — each a page of its own
- **`/` commands and a `Ctrl/⌘ K` palette** covering every CLI flag and self-command
- **Voice** — mic input, read-aloud replies, hands-free mode
- **Mobile** — fully responsive and installable to your home screen; use `shmakk --web --host 0.0.0.0` and open the printed "phone" link

| Flag | |
|------|---|
| `--port <n>` | Port for `--web` (default 4317, `0` = any free port) |
| `--host <addr>` | Bind address (default `127.0.0.1`) |
| `--no-open` | Don't open the browser |
| `--new-token` | Rotate the access token |

The server only listens on your machine by default and every request needs the access token from the launch URL. Running from a git checkout? Build the front-end once with `npm run build:web`. Desktop setup: `cd desktop && npm install` (one time), then `shmakk --desktop`.

→ Details: [docs/web.md](docs/web.md)

### GitHub cloud sessions

Connect your GitHub account (**GitHub sessions** in the sidebar), pick a repository, and shmakk clones it on the server into a session of its own. Each session has its own clone and branch, a source-control bar with **Commit & push** and **Open PR**, and can be driven from any device.

### Self-hosting with Docker

```bash
cp .env.docker.example .env      # set SHMAKK_WEB_TOKEN and your model provider
docker compose up -d --build     # serves on port 1029
docker compose logs shmakk       # prints the sign-in link
```

→ Reverse proxy, TLS and hardening: [docs/deploy.md](docs/deploy.md)

## Launch options

| Flag | What it does |
|------|-------------|
| `shmakk` | Auto mode (AI acts on failures) |
| `shmakk --review` | Review mode (confirm every AI action) |
| `shmakk --yes-files` | Auto-accept file writes, edits, mkdir |
| `shmakk --no-ai` | Disable AI entirely (pure passthrough) |
| `shmakk --no-correction` | Disable command correction |
| `shmakk --debug` | Verbose logging to stderr |
| `shmakk --profile <name>` | Startup profile: `tiny`, `balanced`, `deep`, `builder`, `large-app` |
| `shmakk --workspace <path>` | Override workspace root |
| `shmakk --new-session` | Force a new session instead of resuming |
| `shmakk --shell <shell>` | Use a specific shell (default: current `$SHELL`) |
| `shmakk --print-config` | Print resolved configuration and exit |
| `shmakk --colors true\|false` | Enable/disable ANSI colors |
| `shmakk --markdown true\|false` | Enable/disable markdown rendering |
| `shmakk --notify` | Desktop notifications for Y/n prompts |

## Profiles

Choose a profile to match your workflow:

| Profile | Use case |
|---------|----------|
| `tiny` | Minimal context, fastest responses |
| `balanced` | Default — good for daily work |
| `deep` | Larger investigations, multi-step tasks |
| `builder` / `large-app` | Editing and building large projects |

```bash
shmakk --profile builder
```

Switch profiles mid-session:

```bash
shmakk --profile-set deep
```

## Vim / vi mode

By default, shmakk intercepts `vi` inside a shmakk session. Use `--vim vim` to intercept `vim`, or `--vim disable` to leave both commands untouched.

The shim launches your real Vim with your normal config, then loads shmakk commands:

| Vim command | What it does |
|-------------|--------------|
| `:G <prompt>` | Generate code at the cursor |
| `:Tw <prompt>` | Write prose or documentation |
| `:Cmd <command>` | Run a shell command in a scratch buffer |
| `<C-Space>` / `:ShmakkSuggest` | Full-block AI suggestion with preview + Accept/Deny |
| `:ShmakkAccept` / `:ShmakkPreview` / `:ShmakkDeny` | Handle pending auto-suggestions |

Mappings: `<leader>sa` (accept), `<leader>sp` (preview), `<leader>sd` (deny).

Lowercase `:g` remains Vim's native `:global`; use uppercase `:G` for shmakk.

Optional automatic suggestions:

```vim
let g:shmakk_auto_suggest = 1
let g:shmakk_auto_suggest_delay_ms = 2000
let g:shmakk_auto_suggest_min_chars = 20
```

→ Full Vim documentation: [docs/vim.md](docs/vim.md)

## Voice (optional)

Speak naturally — shmakk listens, transcribes, responds, and reads its answer aloud. No push-to-talk.

```bash
# Install system dependency
sudo pacman -S sox        # Arch/EndeavourOS
sudo apt install sox      # Debian/Ubuntu
brew install sox          # macOS

# Launch in speech-to-speech mode
shmakk --sts
```

Say **"stop"** or **"quiet"** to interrupt TTS mid-sentence.

| Mode | What it does |
|------|-------------|
| `--sts` | Speech-to-Speech: always-on mic + TTS |
| `--stt` | Speech-to-Text: mic input, text output |
| `--tts` | Text-to-Speech: text input, spoken output |

STT uses Whisper-base ONNX in-process. TTS uses kokoro-js (Kokoro-82M ONNX, ~334MB). 28 voices, rotated daily.

→ Full voice documentation: [docs/voice.md](docs/voice.md)

## Skills

Skills are task-specific markdown files loaded into the agent's context on demand. The package ships 500+ built-in skills covering code review, backend, frontend, devops, databases, business, design, and more.

```bash
shmakk --load-skill <name>         # load a built-in skill for this session
shmakk --install-skill <url>       # download skill markdown from URL, validate, load
shmakk -G --load-skill <name>      # use global registry (~/.config/shmakk)
shmakk --list-skills               # list all registered skills
shmakk --skill-status              # active skill and registry status
shmakk --unload-skill <name>       # remove skill from its registry
```

In-session commands:

```
list skills                          # list all registered skills
list skills <category>               # list skills in a category
find skills <query>                  # search by name/description
load skill <name>                    # load into active workspace
unload skill <name>                  # remove from registry
skill status                         # active skill and registry state
```

## Vibedit — visual editing overlay

Vibedit opens a Chromium browser tab, injects a chat panel overlay, captures screenshots for vision-model analysis, and applies code changes directly to your project.

```bash
# Inside a session:
/vibedit <url | file | package.json | dir>
/vibedit-electron <debug-port>       # connect to running Electron app via CDP
/ve <debug-port>                     # short alias
```

The overlay appears as a puck in the bottom-right corner. Click to open the chat panel. Use the Save button to capture a spec (screenshot + description); the agent receives it for implementation.

Dependencies: `npm install playwright && npx playwright install chromium`

→ Full vibedit documentation: [docs/vibedit-analysis.md](docs/vibedit-analysis.md)

## Browser automation

shmakk can control headless Playwright browsers for non-interactive browsing (navigate, click, type, screenshot, evaluate, scroll). Install `playwright` and `chromium` first.

For live Chrome tabs, use the extension daemon:

```bash
shmakk browser-daemon                  # run global extension backend
shmakk browser-daemon --port 3947      # custom port
shmakk connect-browser                 # auto-detect and connect to CDP
shmakk connect-browser --port 9222     # specific port
```

## Remote SSH

The agent can run commands and transfer files on remote hosts via SSH. Configure hosts in `.shmakk/hosts.json` (per-project) or `~/.config/shmakk/hosts.json` (global):

```json
{
  "hosts": {
    "devbox": {
      "host": "marcus@192.168.1.100",
      "port": 22,
      "auto_approve": false,
      "timeout_sec": 30
    }
  },
  "allow_ssh_config": false,
  "default_timeout_sec": 30
}
```

| Tool | Description |
|------|-------------|
| `ssh_run` | Run a shell command on a remote host |
| `ssh_push` | Copy a local workspace file to a remote host |
| `ssh_pull` | Copy a remote file into the local workspace |

For persistent connections, use `ControlMaster` in `~/.ssh/config`.

→ Full SSH documentation: [docs/ssh.md](docs/ssh.md)

## MCP servers

Connect to Model Context Protocol servers over stdio. Configure in `.shmakk/mcp.json` (workspace) or `~/.config/shmakk/mcp.json` (global):

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["server.js"],
      "env": { "TOKEN": "${TOKEN}" },
      "safety": "uncertain",
      "safeTools": ["read_status"],
      "unsafeTools": ["delete_item"],
      "timeout": 30000,
      "disabled": false
    }
  }
}
```

Use `shmakk --mcp-status` or the in-session `mcp status` command to inspect servers and tools.

→ Full MCP documentation: [docs/mcp.md](docs/mcp.md)

## Self-commands (inside a session)

Type these inside an shmakk session. Prefix with `/cmd` or `shmakk cmd`.

| Command | What it does |
|---------|-------------|
| `/status` | Show session status |
| `/stats` | Show session/task statistics |
| `/sessions` | Show recent sessions |
| `show plan` | Display current plan and progress |
| `resume status` | Task journal summary for continuity |
| `/compact` | Clear conversation + task journal |
| `/reset` | Clear AI conversation history |
| `list skills` | List registered skills |
| `load skill <name>` | Load a skill |
| `agent overview` | Show all agents and their specialisms |
| `recall <query>` | Search past sessions |
| `find session <query>` | Find a session by topic |
| `show config` | Print resolved configuration |
| `show memory` | List stored memories |
| `mcp status` | Show MCP servers and tools |
| `/vibedit <url>` | Open visual editing overlay |

## Environment variables

| Variable | Description |
|----------|-------------|
| `SHMAKK_BASE_URL` | OpenAI-compatible base URL |
| `SHMAKK_API_KEY` | API key |
| `SHMAKK_MODEL` | Default model |
| `SHMAKK_PROVIDER` | `openai-compatible`, `codex`, `anthropic`, `google`, `nvidia` |
| `SHMAKK_HEADERS` | Extra headers: `k=v,k=v` |
| `SHMAKK_FAST_ENDPOINT` | Named endpoint for low-latency tasks |
| `SHMAKK_VIM_SUGGEST_ENDPOINT` | Named endpoint for Vim suggestions |
| `SHMAKK_REGISTRY` | Model registry filter (comma-separated) |
| `SHMAKK_MODEL_RECOMMENDATION` | Set to `1` to let main model choose per call |
| `SHMAKK_VIM_SUGGEST_MAX_CHARS` | Max context chars for Vim suggestions |
| `SHMAKK_VIM_SUGGEST_BEFORE_LINES` | Context lines before cursor |
| `SHMAKK_VIM_SUGGEST_AFTER_LINES` | Context lines after cursor |
| `SHMAKK_HF_CACHE` | HuggingFace cache dir (voice models) |
| `SHMAKK_TTS_VOICE` | Pin a specific TTS voice |
| `SHMAKK_TTS_DTYPE` | Kokoro dtype: `fp32`, `fp16`, `q8`, `q4`, `q4f16` |
| `SHMAKK_VOICE_LANGUAGE` | Language hint for STT |
| `SHMAKK_VOICE_MAX_SEC` | Max recording seconds |
| `SHMAKK_VOICE_SILENCE_SEC` | VAD silence threshold |
| `SHMAKK_VOICE_SILENCE_THRESHOLD` | VAD amplitude threshold |
| `SHMAKK_VOICE_PAD_START_SEC` | Start-of-recording padding |

## Help categories

```bash
shmakk --help              # overview
shmakk --help launch       # startup modes, profiles, tuning
shmakk --help session      # status, stats, restart, exit
shmakk --help skills       # skill discovery, loading, listing
shmakk --help models       # provider configuration, endpoint presets
shmakk --help vim          # Vim/vi integration
shmakk --help voice        # Speech-to-Text / Text-to-Speech
shmakk --help env          # environment variable reference
shmakk --help mcp          # MCP servers and browser automation
shmakk --help ssh          # remote host execution
shmakk --help vibedit      # visual editing overlay
shmakk --help self         # natural-language self-commands
```

## Safety

- Prompts before risky commands (writes, deletes, network, installs)
- Secrets (`.env`, keys, tokens) are never sent to the AI
- Workspace root is enforced — tools can't access files outside it

## How it works

shmakk wraps your shell in a PTY (pseudo-terminal). Every command that fails is checked against a deterministic correction engine (no LLM, no API call). If a correction matches and the fixed command succeeds, shmakk feeds the agent your **original input** (not the fixed command) so the agent can address your full intent — not just the typo. You can also give task instructions in natural language — shmakk uses tools to read files, write code, list directories, and run commands, all constrained to your workspace.

## License

MIT
