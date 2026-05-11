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
