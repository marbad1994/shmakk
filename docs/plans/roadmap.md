# Roadmap: shared-browser pane switching

Inputs:
- Scope and success criteria: `backend-scope-and-success.md` (task 1)
- Architecture and workstreams: `backend-architecture-and-workstreams.md`
  (task 2)

This roadmap sequences the work into dependency order with owners, sizes,
milestones, and review checkpoints. It covers execution only; the "who builds
it" and "why" live in the two input documents, which are referenced rather than
repeated here.

## Overview

The change is small and single-file: wire the existing
`_broadcastBrowserOpen` helper into the `tool_end` case of `_eventSink`
(`src/webui/chat.js:945`) and delete the dead inline broadcast in `_plainChat`
(`chat.js:1166`). Everything else (agent emit, WebSocket transport, client
handler, wire type) is confirmed unchanged.

Because the blast radius is one file, the roadmap is intentionally test-first
and short. The dominant risks are regression and scope creep, not design risk.

## Task list

| # | Task | Owner | Size | Depends on | Deliverable |
|---|------|-------|------|------------|-------------|
| T1 | Green baseline + test harness prep | Backend | S (0.5d) | none | `node test/units.js` passes; confirm `ChatManager` test pattern (`test/units.js:1656`) supports capturing a mock `broadcast` |
| T2 | Write failing tests for the broadcast | Backend | S (0.5d) | T1 | Three assertions in `test/units.js`: success emits one `browser.open`; design mode emits zero; non-`show`/error emits zero |
| T3 | Wire `_broadcastBrowserOpen` into `_eventSink` | Backend | S (0.5d) | T2 | One call in the `tool_end` case (`chat.js:945`); tests go green |
| T4 | Remove dead `_plainChat` broadcast | Backend | XS (0.25d) | T3 | `chat.js:1166` inline block deleted; single broadcast site remains |
| T5 | Verification + scope audit | Backend | S (0.5d) | T4 | `node test/units.js` green; `grep`/`git diff --check`/`git diff --stat` clean; diff limited to `src/webui/chat.js` + test file |
| T6 | Frontend contract review (no diff) | Frontend (review only) | XS (0.25d) | T5 | Confirmation that `types.ts:178` and `store/app.ts:235` are unchanged |
| T7 | Reviewer sign-off | Reviewer | XS (0.25d) | T6 | All 5 success criteria confirmed measurable and met |

Dependency chain: T1 → T2 → T3 → T4 → T5 → T6 → T7. No parallelism; each task
is a prerequisite of the next. Estimated total: ~2.75 engineer-days, of which
~2.25 is backend and ~0.5 is frontend/reviewer.

## Milestones

- **M0 — Ready to execute (after T1):** baseline suite green, harness confirmed.
  Exit: `node test/units.js` exits 0 with no new failures.
- **M1 — Behaviour implemented (after T4):** broadcast fires on the success
  path, design suppression holds, and the dead code is gone. Exit: T2 tests
  green and `grep -c "browser.open" src/webui/chat.js` shows a single broadcast
  site (success criterion 3).
- **M2 — Verified and in review (after T6):** full suite green, scope audit
  clean, frontend contract confirmed unchanged. Exit: `git diff --stat` shows
  only `src/webui/chat.js` and `test/units.js` (criterion 5).
- **M3 — Accepted (after T7):** reviewer confirms the diff. This is the only
  accept/merge point.

## Review checkpoints

| Checkpoint | When | Who | What they verify |
|------------|------|-----|------------------|
| R1 | After T2, before T3 | Backend lead | Tests assert the right behaviour and are actually failing (red), so they guard the fix |
| R2 | After T4, before T5 | Backend lead | The `tool_end` call site is the only broadcast source and the design-mode gate (`conv.mode`) is passed, not hardcoded |
| R3 | After T5 | Frontend owner | No contract drift; `types.ts`/`store/app.ts` untouched; wire shape still `{ t: 'browser.open', url }` |
| R4 | After T6 | Reviewer | All five success criteria (coverage, design suppression, single source of truth, test pass rate, no contract drift) are met and measurable |

## Verification gates (automated)

Run at T5 and again at the merge point:
- `node test/units.js` — full suite green (criterion 4).
- `grep -n "browser.open" src/webui/chat.js` — exactly one broadcast site
  (criterion 3).
- `git diff --check` — no whitespace errors.
- `git diff --stat` — edits only under `src/webui/chat.js` and `test/units.js`
  (criterion 5).

## Out of scope for this roadmap (explicit)

- Team-mode pane switching: team sub-agents run `runAgent` without an `onEvent`
  sink (team.js:509), so a `browser show` from a team sub-agent navigates but
  does not switch the pane. Tracked as a follow-up, not sequenced here.
- Any change to `src/browser.js`, `src/core/browser-live.js`, the `browser`
  tool schema, or the wire message type.
- Markdown link interception (frontend concern, separate task).

## Rollback

The change is a one-file edit with no schema or persistence change. Rollback is
`git revert` of the single commit; no data migration or flag flip is needed.
