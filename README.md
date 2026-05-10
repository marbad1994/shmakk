# aiterm

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
- `builder` / `large-app` → best for editing, building, and maintaining large projects

Start with profile:

```bash
aiterm --profile tiny
aiterm --profile builder
```

Switch profile from inside a running session (auto restart/reload):

```bash
aiterm --profile-set deep
```

## Global usage (automated)

Install globally from local source (recommended):

```bash
npm run global:install
```

This now also runs PATH setup for your shell so `aiterm` works in new terminals.

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

Diagnose global command issues:

```bash
npm run global:doctor
```

Run PATH setup manually (if needed):

```bash
npm run global:setup
```

If `aiterm` is still not found, open a **new terminal** and run:

```bash
aiterm --help
```

If it still fails, run:

```bash
npm run global:doctor
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
- `builder` / `large-app` for implementation/build workflows across many files

Discovery/read budget defaults by profile:

- `tiny` → 1 discovery call per round
- `balanced` → 2 discovery calls per round
- `deep` → 3 discovery calls per round
- `builder` → 4 discovery calls per round
- `large-app` → 4 discovery calls per round

(`discovery` = `read_file`, `list_dir`, `web_search`, `fetch_url`)

Override manually if needed:

```bash
export AITERM_MAX_DISCOVERY_CALLS_PER_ROUND=2
```

Examples:

```bash
aiterm --profile tiny
aiterm --profile balanced
aiterm --profile deep
aiterm --profile builder
aiterm --profile large-app
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

## Long-task reliability and resume

aiterm now includes stronger long-task behavior:

- adaptive tool-round budget during active progress
- progress-aware loop stall detection (less premature stopping)
- forced finalization pass before giving up
- persistent task journal at:

```text
.aiterm/state/task-journal.json
```

Resume behavior:

- if a task is interrupted, the next run can continue with resume context from the journal
- when a task fully completes, the journal is cleared automatically
- if a task pauses mid-way, journal state is kept for continuation
- `aiterm --reset` clears both conversation history and the task journal

Session lifecycle (how resume works):

1. A task starts and journal is set to `running`.
2. After each tool call, journal is updated (input, touched files, timestamps, profile, budget).
3. If interrupted or stalled, journal is kept as `paused`.
4. On next task run, aiterm loads journal and injects a short resume context into the next prompt.
5. If task reaches a normal final answer (or forced finalization answer), journal is deleted.

If you want to hard reset task continuity:

```bash
aiterm --reset
```

## Useful commands

- `aiterm --help`
- `aiterm --status`
- `aiterm --stats` (session/task stats, active skill, audit event count)
- `aiterm --compact` (clear conversation + journal to free context)
- `aiterm --load-skill <name>` (load Claude/Codex compatible local skill)
- `aiterm --list-skills` (list local skill registry)
- `aiterm --skill-status` (show active skill details)
- `aiterm --unload-skill <name>` (remove skill from local registry/cache)
- `aiterm --install-skill <url>` (download + validate + activate in one step)
- `aiterm --resume-status` (print current task journal summary)
- `aiterm --restart`
- `aiterm --reset` (clear conversation history)
- `aiterm --exit`

## Safety UX

## Skill lifecycle (advanced)

aiterm supports a local skill registry with compatibility for both Claude and Codex layouts.

Lookup paths for `--load-skill <name>` include:

- `.claude/skills/<name>.md`
- `.claude/skills/<name>/SKILL.md`
- `.codex/skills/<name>.md`
- `.codex/skills/<name>/SKILL.md`
- same locations under your home directory

Lifecycle commands:

```bash
aiterm --load-skill my-skill
aiterm --install-skill https://example.com/my-skill.md
aiterm --list-skills
aiterm --skill-status
aiterm --unload-skill my-skill
```

State files:

- `.aiterm/state/skills-registry.json`
- `.aiterm/state/active-skill.json`
- `.aiterm/skills/*.md` (local cached skill content)

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
