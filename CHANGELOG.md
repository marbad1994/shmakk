# Changelog

All notable changes to this project will be documented in this file.

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

### Security
- Web server binds to loopback by default, requires a token on every request (HttpOnly, SameSite=Strict cookie or
  Bearer), rejects cross-origin requests and WebSocket upgrades, and ships a strict Content-Security-Policy

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
