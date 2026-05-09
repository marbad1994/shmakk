# aiterm

## Vibe coded, it's a tool and it works for me, dont care.

AI-supervised terminal wrapper with:

- command correction
- tool-driven task execution
- safety confirmations
- profile-based runtime modes for small/large projects

## Requirements

- Node.js 18+
- Linux/macOS shell environment

## Install

```bash
npm install
```

Run locally:

```bash
npm start
```

or:

```bash
node bin/aiterm.js
```

Automated first-time setup:

```bash
npm run setup
```

## AI configuration

Set provider values (OpenAI-compatible endpoint):

```bash
export AITERM_BASE_URL="https://..."
export AITERM_API_KEY="..."
export AITERM_MODEL="..."
```

Optional model overrides:

- `AITERM_CORRECTION_MODEL`
- `AITERM_AGENT_MODEL`
- `AITERM_CHAT_MODEL`

You can start from the provided template:

```bash
cp .env.example .env
```

Then fill in real values in your local `.env`.

## Secrets policy

- Never commit real secrets (API keys, tokens, private keys).
- `.env` is ignored by git and should stay local-only.
- Commit `.env.example` with placeholder values only.
- If a secret is accidentally committed, rotate it immediately.

## Profiles (recommended)

Use profiles instead of many tuning env vars:

- `tiny` → minimal context/loop budget (fastest)
- `balanced` → default
- `deep` → larger tasks/investigations

Start with profile:

```bash
aiterm --profile tiny
```

Switch profile from inside a running session (auto restart/reload):

```bash
aiterm --profile-set deep
```

## Global usage (automated)

Install globally from local source:

```bash
npm run global:install
```

Or create a live dev link:

```bash
npm run global:link
```

Then use anywhere:

```bash
aiterm --help
```

Reinstall globally after changes:

```bash
npm run global:reinstall
```

Remove global install/link:

```bash
npm run global:unlink
```

## End-to-end workflow (recommended)

For a fresh machine/repo clone:

```bash
npm run setup
npm run global:install
aiterm --help
```

For day-to-day development updates:

```bash
npm run check
npm test
npm run global:reinstall
```

## All npm scripts

- `npm start` – run aiterm
- `npm run dev` – run aiterm with `--debug`
- `npm test` – run unit tests
- `npm run check` – sanity-load core modules
- `npm run mock-llm` – run local mock llm test server/tooling
- `npm run setup` – install deps + check + tests
- `npm run global:install` – global install from current source
- `npm run global:reinstall` – refresh global install after changes
- `npm run global:link` – npm link for live development
- `npm run global:unlink` – remove global link/install

## Profiles in practice

- `tiny` for fast/low-overhead work on big repositories
- `balanced` for normal daily usage (default)
- `deep` for larger multi-step tasks and investigations

Examples:

```bash
aiterm --profile tiny
aiterm --profile balanced
aiterm --profile deep
```

Switch during a running session:

```bash
aiterm --profile-set tiny
```

This triggers a full restart/reload of the parent aiterm process with the new profile.

## Phase 2 indexing details

aiterm now maintains a lightweight incremental workspace index at:

```text
.aiterm/state/index.json
```

What it stores per file:
- relative path
- mtime/size
- lightweight symbol/import hints

Why it helps:
- better first-pass file targeting
- less blind exploration
- fewer repeated heavy reads on large projects

## Useful commands

- `aiterm --help`
- `aiterm --status`
- `aiterm --restart`
- `aiterm --reset` (clear conversation history)
- `aiterm --exit`

## Safety UX

Prompts support:

- `y` / `yes`
- `n` / `no`
- `?` for **why this action** before deciding

## Project layout

- `bin/aiterm.js` – executable entry
- `src/index.js` – CLI dispatcher
- `src/orchestrator.js` – PTY + AI flow
- `src/agent.js` – tool loop + fallback parsing + context controls
- `src/workspace-index.js` – incremental workspace index (Phase 2)
- `src/profiles.js` – runtime profiles

## Tests

```bash
npm test
```

## Notes for first commit

- package is marked `private` for safe local iteration
- runtime/index/temp artifacts are ignored via `.gitignore`
