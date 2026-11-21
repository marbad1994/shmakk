# Task plan: sequenced steps

Input: `docs/plans/task-plan-objective-scope.md` (objective, success criteria,
constraints, out-of-scope). This document breaks that objective into atomic
tasks, lists each dependency, and orders them into a single execution path with
no cycles. It sequences the plan; it does not implement the fix.

## 1. Task list

Each task is one action with one owner, one size, and one deliverable. "Depends
on" names the upstream task whose deliverable this task consumes. Only the first
task has an empty dependency.

| # | Task | Owner | Size | Depends on | Deliverable |
|---|------|-------|------|------------|-------------|
| S1 | Confirm the baseline suite is green and the harness can capture a mock `broadcast` | Backend | S (0.5d) | none | `node test/units.js` exits 0; note that `test/units.js:1656` already constructs `ChatManager` with a `broadcast` stub |
| S2 | Write the failing success-path test | Backend | S (0.5d) | S1 | One assertion in `test/units.js`: a synthetic `tool_end` for `browser show` with `result.ok` emits exactly one `{ t: 'browser.open', url }` |
| S3 | Write the failing design-suppression test | Backend | XS (0.25d) | S2 | One assertion: the same event with `conv.mode === 'design'` emits zero broadcasts |
| S4 | Write the failing no-op test | Backend | XS (0.25d) | S3 | One assertion: a non-`show` command and a `result.ok === false` event each emit zero broadcasts |
| S5 | Run the new tests and confirm they fail | Backend | XS (0.25d) | S4 | `node test/units.js` shows the three new assertions red and the rest green |
| S6 | Wire `_broadcastBrowserOpen` into the `tool_end` case | Backend | S (0.5d) | S5 | One call `this._broadcastBrowserOpen(ev.name, ev.args, ev.result, conv.mode)` at the top of the `tool_end` case in `src/webui/chat.js:945` |
| S7 | Run the tests and confirm they pass | Backend | XS (0.25d) | S6 | `node test/units.js` exits 0, including the three new assertions |
| S8 | Remove the dead inline broadcast in `_plainChat` | Backend | XS (0.25d) | S7 | The inline `browser.open` block at `src/webui/chat.js:1166` is deleted |
| S9 | Confirm a single broadcast site remains | Backend | XS (0.25d) | S8 | `grep -n "browser.open" src/webui/chat.js` shows exactly one `ctx.broadcast` call site (the helper) |
| S10 | Run the full verification gate | Backend | S (0.5d) | S9 | `node test/units.js` green; `git diff --check` clean; `git diff --stat` shows edits only under `src/webui/chat.js` and `test/units.js` |
| S11 | Frontend contract review (no diff) | Frontend | XS (0.25d) | S10 | Written confirmation that `web/src/lib/types.ts:178` and `web/src/store/app.ts:235` are unchanged and the wire shape is still `{ t: 'browser.open', url }` |
| S12 | Reviewer sign-off | Reviewer | XS (0.25d) | S11 | All five success criteria in `backend-scope-and-success.md` confirmed met and measurable |

## 2. Dependency graph

```
S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12
```

The graph is a single linear chain. Every edge points forward (a task depends
only on a lower-numbered task), so there are no cycles and no task consumes a
deliverable produced by a later task. There is no parallelism: each task's
deliverable is the input of the next.

## 3. Cycle check

- Forward-only edges: each "Depends on" cell references a task with a smaller
  number than its own row. Verified by inspection of the table in section 1.
- Single root: only S1 has an empty dependency, satisfying success criterion 1.
- Single sink: S12 depends on S11 and nothing depends on S12, so the chain
  terminates.
- No cross-edges: no task lists more than one dependency, so no diamond or
  back-edge can form a cycle.

## 4. Milestones

| Milestone | Reached after | Exit criterion |
|-----------|---------------|----------------|
| M0 — Ready to execute | S1 | `node test/units.js` exits 0; harness confirmed |
| M1 — Tests guarding the fix | S5 | Three new assertions exist and fail (red) while the rest of the suite stays green |
| M2 — Behaviour implemented | S9 | Broadcast fires on success, design suppression holds, dead code removed, single broadcast site confirmed |
| M3 — Verified | S10 | Full suite green and scope audit clean (`git diff --stat` limited to two files) |
| M4 — Accepted | S12 | Reviewer confirms all five success criteria; this is the only accept point |

## 5. Review checkpoints

| Checkpoint | When | Who | Verifies |
|------------|------|-----|----------|
| R1 | After S5, before S6 | Backend | The three new tests assert the intended behaviour and are actually failing, so they guard the fix rather than passing vacuously |
| R2 | After S9, before S10 | Backend | The `tool_end` call site is the only broadcast source and `conv.mode` is passed through, not hardcoded |
| R3 | After S10, before S11 | Frontend | No contract drift: `types.ts` and `store/app.ts` untouched, wire shape unchanged |
| R4 | After S11, before S12 | Reviewer | All five success criteria (coverage, design suppression, single source of truth, test pass rate, no contract drift) are met and measurable |

## 6. Size summary

- Backend: S1-S10, ~3.5 engineer-days.
- Frontend: S11, 0.25 engineer-days (review only, no diff).
- Reviewer: S12, 0.25 engineer-days.
- Total: ~4.0 engineer-days. The chain is longer than the roadmap's T1-T7
  because each roadmap task is split into its atomic test-write / test-run /
  implement steps here; the underlying work is identical.

## 7. Out of scope (carried from the objective)

Not sequenced as tasks: implementing anything beyond `src/webui/chat.js` and
`test/units.js`; team-mode pane switching (`src/team.js:509`); changes to
`src/browser.js`, `src/core/browser-live.js`, the `browser` tool schema,
`web/src/lib/types.ts`, or `web/src/store/app.ts`; design-mode preview
behaviour; markdown link interception; re-scoping the feature.
