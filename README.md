# shmakk

AI-supervised terminal wrapper — command correction, tool-driven task execution, safety confirmations, and profile-based runtime modes.

Your terminal, supercharged by AI.

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
export AITERM_BASE_URL="https://your-provider.example/v1"
export AITERM_API_KEY="your-api-key"
export AITERM_MODEL="gpt-4o-mini"
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

- **Correct mistakes** — typo in `gti status`? shmakk suggests `git status`
- **Execute tasks** — ask "set up a new React project" and shmakk handles the steps
- **Keep you safe** — confirms risky commands before running them

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

## Environment variables

| Variable | Description |
|----------|-------------|
| `AITERM_BASE_URL` | OpenAI-compatible base URL |
| `AITERM_API_KEY` | API key |
| `AITERM_MODEL` | Default model |
| `AITERM_CORRECTION_MODEL` | Model for command correction |
| `AITERM_AGENT_MODEL` | Model for task execution |
| `AITERM_CHAT_MODEL` | Model for chat |
| `AITERM_SECONDARY_BASE_URL` | Secondary provider (optional) |
| `AITERM_SECONDARY_API_KEY` | Secondary API key (optional) |
| `AITERM_HEADERS` | Extra headers (k=v,k=v) |

## Useful commands

| Command | What it does |
|---------|-------------|
| `shmakk --help` | Show help |
| `shmakk --status` | Check if inside shmakk |
| `shmakk --stats` | Session statistics |
| `shmakk --compact` | Clear conversation history |
| `shmakk --load-skill <name>` | Load a skill |
| `shmakk --list-skills` | List loaded skills |
| `shmakk --reset` | Reset conversation + task journal |
| `shmakk --restart` | Restart the inner shell |
| `shmakk --exit` | Exit shmakk |
| `shmakk --review` | Confirm every AI action |
| `shmakk --yes-files` | Auto-accept file writes |
| `shmakk --no-correction` | Disable command correction |
| `shmakk --colors true\|false` | Toggle colored output |

## Safety

- shmakk prompts you before running commands flagged as risky (writes, deletes, network, installs)
- Secrets (`.env`, keys, tokens) are never sent to the AI
- Workspace root is enforced — tools can't access files outside it

## How it works

shmakk wraps your shell in a PTY (pseudo-terminal). Every command you type is optionally checked by an AI model for correction. You can also give task instructions in natural language — shmakk uses tools to read files, write code, list directories, and run commands, all constrained to your workspace.

## License

MIT
