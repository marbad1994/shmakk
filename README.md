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

Or copy the template and fill it in:

```bash
cp node_modules/shmakk/.env.example .env
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

What you get:

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

## Voice (optional)

speak naturally — shmakk listens, transcribes, responds, and reads its answer aloud. No push-to-talk.

```bash
# Install system dependency
sudo pacman -S sox        # Arch/EndeavourOS
sudo apt install sox      # Debian/Ubuntu
brew install sox          # macOS

# Install voice deps and run preflight check
npm run setup:voice

# Launch in speech-to-speech mode
shmakk --sts
```

Say **"stop"** or **"quiet"** to interrupt TTS mid-sentence.

→ Full voice documentation: [docs/voice.md](docs/voice.md)

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

## Skills

Skills are task-specific markdown files loaded into the agent's context on demand. The `skills/` directory contains 32 built-in skills covering areas like `code-review`, `research`, `backend`, `devops`, `sysmon`, `logs`, and more.

```bash
shmakk --install-skill <name>   # install a skill from the built-in library
shmakk --load-skill <name>      # load an installed skill for this session
shmakk --list-skills            # show currently loaded skills
```

## Coordinator & Multi-step workflows

The coordinator system enables complex, multi-step task execution with plan-first workflows. When tackling large projects or intricate tasks, shmakk breaks them into manageable steps, validates each stage, and maintains context across the entire workflow.

## Environment variables

| Variable | Description |
|----------|-------------|
| `SHMAKK_BASE_URL` | OpenAI-compatible base URL |
| `SHMAKK_API_KEY` | API key |
| `SHMAKK_MODEL` | Default model |
| `SHMAKK_HEADERS` | Extra headers (k=v,k=v) |

## Useful commands

| Command | What it does |
|---------|-------------|
| `shmakk --help` | Show help |
| `shmakk --web` | Open the web interface |
| `shmakk --desktop` | Open the desktop app |
| `shmakk --status` | Check if inside shmakk |
| `shmakk --stats` | Session statistics |
| `shmakk --compact` | Clear conversation history |
| `shmakk --install-skill <name>` | Install a skill from the built-in library |
| `shmakk --load-skill <name>` | Load an installed skill for this session |
| `shmakk --list-skills` | List loaded skills |
| `shmakk --reset` | Reset conversation + task journal |
| `shmakk --restart` | Restart the inner shell |
| `shmakk --exit` | Exit shmakk |
| `shmakk --review` | Confirm every AI action |
| `shmakk --yes-files` | Auto-accept file writes |
| `shmakk --no-correction` | Disable command correction |
| `shmakk --colors true\|false` | Toggle colored output |
| `shmakk --sts` | Speech-to-speech mode |
| `shmakk --stt` | Mic input, text responses |
| `shmakk --tts` | Text input, spoken responses |

## Safety

- shmakk prompts you before running commands flagged as risky (writes, deletes, network, installs)
- Secrets (`.env`, keys, tokens) are never sent to the AI
- Workspace root is enforced — tools can't access files outside it

## How it works

shmakk wraps your shell in a PTY (pseudo-terminal). Every command that fails is checked against a deterministic correction engine (no LLM, no API call). If a correction matches and the fixed command succeeds, shmakk feeds the agent your **original input** (not the fixed command) so the agent can address your full intent — not just the typo. You can also give task instructions in natural language — shmakk uses tools to read files, write code, list directories, and run commands, all constrained to your workspace.

## License

MIT
