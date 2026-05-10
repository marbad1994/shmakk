# Changelog

All notable changes to this project will be documented in this file.

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
