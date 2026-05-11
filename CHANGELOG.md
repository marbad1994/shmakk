# Changelog

All notable changes to this project will be documented in this file.

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
