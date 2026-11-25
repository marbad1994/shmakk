# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **Recorded automations**: a spoken control description is normalized to the accessible name, so the step
  replay looks for is the one the page actually exposes. `the Save button`, `Save button` and `a Save button`
  all become `Save`; the article is dropped only when a role noun was removed or the role is known, so a name
  that merely starts with `the` (`the Netherlands`) survives; a name that is nothing but a role word is never
  stripped to empty, and URLs pass through untouched. `name` and `target` go through the same rule, so they
  cannot disagree about which control a step means.
- Warnings raised by normalization (an action that could not be mapped, a click that names no control, a
  recording with no actions) are still carried on the spec unchanged.

### Added
- `docs/automations.md` — the recorded-automation spec reference: step shape, action vocabulary, spoken-name
  rules, browser and desktop resolution order, inputs, and the replay tuning variables
- `docs/migration-guide.md` — rebuilding a stored spec from its `sourceAnalysis` without another vision pass
- README section for recorded automations
- Unit tests for spoken-name normalization, including the cases that must not change

## [1.3.0] - 2026-11-14

### Added
- **Web interface** (`shmakk --web`) — a React app served by a small built-in server, with feature parity with the CLI:
  chat with streaming markdown, tool timeline with inline diffs, approval cards (review mode / unsafe tools / plans /
  command corrections), shell mode with the correction engine, plan-first and team runs, an integrated terminal running
  the real CLI, and pages for skills, memory & rules, plan & resume journal, changes (with revert), session recall,
  agents & workflows, MCP servers, audit log and settings (provider, endpoints, profile, voice, workspace, theme)
- `/` commands in the composer and a `Ctrl/⌘ K` command palette mapped onto every CLI flag and self-command
- Voice in the browser: mic → local Whisper, replies → local Kokoro, with Web Speech fallbacks; hands-free mode
- **Mobile**: responsive down to phone widths with a bottom tab bar, bottom-sheet dialogs, swipeable drawer,
  safe-area and on-screen-keyboard handling, a terminal key bar, and an installable PWA manifest
- **Desktop app** (`shmakk --desktop`, `desktop/`) — Electron shell with native menus, folder picker and window state
- `--port`, `--host`, `--no-open`, `--new-token` flags; `npm run build:web`, `dev:web`, `test:web`, `web`, `desktop`
- Conversations persist under `~/.local/state/shmakk/web/`; UI settings in `~/.config/shmakk/web.json` (0600)
- `runAgent` and `runTeam` accept an optional `onEvent` sink for structured progress (used by the web UI; the
  terminal output is unchanged when it is not set)

- **Four modes** with a switcher: **Chat** (plain conversation with web search), **Code** (the existing agent),
  **Design** (the agent writes HTML/CSS into a per-chat folder; live sandboxed preview, device sizes, version history
  with restore) and **Cowork** (agent plus automation tools)
- **Automations**: multi-step jobs triggered by schedule (cron with time zones), webhook, or by hand; per-automation
  unattended-permission policy; run history where every run is its own chat; creatable from a Cowork conversation
- **Projects**: group chats from any mode; project instructions, optional workspace folder, and a
  *Share context between chats* setting that gives each chat a digest of its siblings and read access to the
  project's design files
- **GitHub cloud sessions** — connect an account (token, environment variable, or device sign-in), browse
  repositories, and start a session on a fresh clone with its own branch; in-chat source-control bar with
  commit & push and pull-request creation; `/clone owner/repo`; GitHub Enterprise via `SHMAKK_GITHUB_URL` /
  `SHMAKK_GITHUB_API_URL`
- **Docker deployment** — `Dockerfile`, `docker-compose.yml` (port 1029), `.env.docker.example`, `docs/deploy.md`;
  `/healthz`, `SHMAKK_PUBLIC_URL`, `SHMAKK_TRUST_PROXY`, optional built-in TLS, sign-out
- Conversations are bound to a workspace; opening one switches the terminal and pages to it

### Security
- Web server binds to loopback by default, requires a token on every request (HttpOnly, SameSite=Strict cookie or
  Bearer), rejects cross-origin requests and WebSocket upgrades, and ships a strict Content-Security-Policy
- Token guesses are rate-limited per address; the cookie is `Secure` over HTTPS
- GitHub tokens are stored owner-only, never returned by the API, never written into clones or remote URLs
  (git authenticates through a credential helper), and session state (`.shmakk/`) is excluded from commits

## [1.1.0] - 2026-05-12

### Added
- **Voice module** (`--stt`, `--tts`, `--sts`) as optional feature
  - Always-on VAD-based mic input via `sox` — speak naturally, no hotkey
  - STT via Whisper-base ONNX (`@huggingface/transformers`) — fully local, no API
  - TTS via Kokoro-82M ONNX (`kokoro-js`) — 28 voices, fully local, no API
  - Sentence-streaming TTS — first sentence plays immediately, rest pipeline behind it
  - Voice rotation — all 28 voices on a deterministic daily schedule (changes every 2–5h)
  - Stop words — say "stop", "quiet", "shut up" etc to interrupt TTS mid-sentence
  - TTS interrupted automatically when mic detects new speech
- `npm run setup:voice` — installs optional deps and runs full preflight check
- `src/setup-voice.js` — checks sox, paplay, PipeWire/PulseAudio, mic sources
- `docs/voice.md` — full voice documentation with VAD tuning guide
- Cleaner agent output — read/list/search tool calls batched into single dim summary line

### Changed
- `@huggingface/transformers` and `kokoro-js` moved to `optionalDependencies`
- Base install (`npm install`) no longer pulls heavy ONNX models
- Version bump to 1.1.0
- README updated with voice quick-start section

### Fixed (code review hardening)
- `fs.rmSync` calls hardened with `{ force: true }` across skills.js and task-file.js to prevent ENOENT crashes
- `loadSkillToWorkspace` now calls `ensureDirs(cwd)` first — fixes crash on fresh workspace load
- `renderActiveSkillForPrompt` gets mtime-based cache so prompt isn't recomputed every turn
- `runAutoSubagents` sanitizes user input and workspace roots against newline injection
- `within()` (tools.js) resolves paths through `fs.realpathSync` to defeat symlink escapes past workspace roots
- MCP errors now carry `isRetryable` flag so callers can distinguish transport failures from tool failures
- `captureGitSha` (code-review.js) eliminated temp-file roundtrip; computes SHA in memory
- `rmdirSync` in task-file.js replaced with `rmSync({ recursive: true })` for API consistency
- `sanitizeForLLM` now tested; `maxDist` logic now testable via `maxDistForTest` export
- 10 new unit tests added: skills, task-file, code-review, rules, memory, session-search, workflows, subagent, correction, workspace-index

## [0.1.0] - 2026-05-09

### Added
- Runtime profiles: `tiny`, `balanced`, `deep`
- Live profile switching with restart: `shmakk --profile-set <name>`
- Context budgeting and loop-stall protection
- Defensive handling for fallback tool-call formats
- Lightweight incremental workspace index (`.shmakk/state/index.json`)
- Safety prompt `?` option for explanation before confirmation
- Initial project documentation (`README.md`, `CONTRIBUTING.md`)

### Changed
- Improved agent loop behavior for large projects
- Reduced repeated tool calls via per-task cache
- Improved package metadata and scripts

### Removed
- Unrelated artifact files and unused `src/services/store.ts`
