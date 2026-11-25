---
goal: Shared-browser pane switching — final task plan
version: 1.0
date_created: 2026-11-17
last_updated: 2026-11-17
owner: Infra
status: 'Planned'
tags: [planning, bug, webui, browser]
---

# Shared-browser pane switching: final task plan

Status: Planned

This is the finalized, review-checked plan for the shared-browser pane
switching fix. It consolidates the objective (`task-plan-objective-scope.md`),
the sequenced steps (`task-plan-steps.md`), and the three upstream inputs
(`backend-scope-and-success.md`, `backend-architecture-and-workstreams.md`,
`roadmap.md`) into one execution document. Section 1 records the validation of
the draft against the success criteria and the gaps that were corrected.

## 1. Validation against success criteria

Checked the sequenced draft (`task-plan-steps.md`) against each success
criterion in `task-plan-objective-scope.md`.

| Criterion | Draft status | Correction applied here |
|-----------|--------------|--------------------------|
| 1. Dependency ordering, no forward references, single root | Met. 12 tasks, all edges forward, single root S1, acyclic (verified by script). | None. |
| 2. Owner and size on every task | Met for owner and size, but no calendar timeline. | Added a start-offset timeline in section 3 so each step has both an owner and a scheduled window. |
| 3. Explicit milestones and review points with exit criteria | Met (M0-M4, R1-R4). | Preserved; cross-referenced to the timeline. |
| 4. Executable granularity, no placeholders | Partial. The draft named files and commands but did not include the actual test or implementation code, so an engineer still had to re-read source. | Section 4 now contains the complete test and the exact edit for each code step. |
| 5. Consistency with inputs | Gap found. The draft's verification used `grep -n` "shows exactly one call site", but success criterion 3 in `backend-scope-and-success.md` defines the check as `grep -c "browser.open"` equalling the helper's single `ctx.broadcast` call plus docstring references. The two checks disagree. | S9 below uses the criterion's exact `grep -c` definition, and states the expected count rather than asserting "exactly one". |

Additional gap corrected: the draft had no stated rollback or no stated
prerequisite that the working tree is clean before S6. Both are added (section
6 and the S6 prerequisite note), since a dirty tree would make the S10
`git diff --stat` scope check meaningless.

## 2. Requirements and constraints (from the objective)

- **REQ-001**: Every successful `browser show` through `_eventSink` in a
  non-design conversation emits exactly one `{ t: 'browser.open', url }`.
- **REQ-002**: A `browser show` in design mode emits zero broadcasts.
- **REQ-003**: Exactly one `ctx.broadcast` call site for `browser.open` remains
  (the `_broadcastBrowserOpen` helper); the inline copy is removed.
- **CON-001**: No new dependencies, no schema change, no wire-contract change.
- **CON-002**: Edits limited to `src/webui/chat.js` and `test/units.js`.
- **CON-003**: Owners drawn only from backend, frontend, infra, reviewer.
- **CON-004**: No emoji or non-ASCII status glyphs; completion tracked by
  checkbox.

## 3. Timeline

Assumes one backend engineer, start date D0, sequential execution (the chain
has no parallelism). Windows are in working days from D0.

| Step | Owner | Window | Depends on |
|------|-------|--------|------------|
| S1 Confirm baseline | Backend | D0 | none |
| S2 Failing success test | Backend | D0 | S1 |
| S3 Failing design test | Backend | D1 | S2 |
| S4 Failing no-op test | Backend | D1 | S3 |
| S5 Confirm tests fail | Backend | D1 | S4 |
| S6 Wire the helper | Backend | D1-D2 | S5 |
| S7 Confirm tests pass | Backend | D2 | S6 |
| S8 Remove dead broadcast | Backend | D2 | S7 |
| S9 Confirm single site | Backend | D2 | S8 |
| S10 Full verification | Backend | D2-D3 | S9 |
| S11 Frontend contract review | Frontend | D3 | S10 |
| S12 Reviewer sign-off | Reviewer | D3 | S11 |

Total: 4 working days (D0-D3). Milestones land at: M0 end of D0, M1 end of D1,
M2/M3 during D2-D3, M4 end of D3.

## 4. Steps

### S1: Confirm the baseline is green

- Owner: Backend. Window: D0. Depends on: none.

- [ ] Run `node test/units.js`.
- [ ] Expected: exit code 0, no failures.
- [ ] Confirm `test/units.js:1656` constructs `ChatManager` with a `broadcast`
      stub, so the new tests can capture broadcasts the same way.

### S2: Write the failing success-path test

- Owner: Backend. Window: D0. Depends on: S1.

- [ ] Add to `test/units.js`, after the existing chat tests:

```js
test('webui chat: browser show tool_end broadcasts browser.open once', () => withTempHome(async (dir) => {
  const { ChatManager } = require('../src/webui/chat');
  const broadcasts = [];
  const chat = new ChatManager({
    settings: { modes: {} }, saveSettings() {}, broadcast(m) { broadcasts.push(m); },
    mcpManager: null, getWorkspace: () => dir, onProviderChanged() {},
  });
  const conv = chat.create();
  try {
    const sink = chat._eventSink(conv);
    sink({ type: 'tool_end', name: 'browser', args: { command: 'show', url: 'https://example.com' }, result: { ok: true, url: 'https://example.com' } });
    const opens = broadcasts.filter((m) => m.t === 'browser.open');
    assert.strictEqual(opens.length, 1);
    assert.strictEqual(opens[0].url, 'https://example.com');
  } finally {
    chat.remove(conv.id);
  }
}));
```

### S3: Write the failing design-suppression test

- Owner: Backend. Window: D1. Depends on: S2.

- [ ] Add a test identical in setup to S2, but set the conversation mode to
      design before sinking the event and assert zero broadcasts:

```js
test('webui chat: design mode suppresses browser.open', () => withTempHome(async (dir) => {
  const { ChatManager } = require('../src/webui/chat');
  const broadcasts = [];
  const chat = new ChatManager({
    settings: { modes: {} }, saveSettings() {}, broadcast(m) { broadcasts.push(m); },
    mcpManager: null, getWorkspace: () => dir, onProviderChanged() {},
  });
  const conv = chat.create();
  conv.mode = 'design';
  try {
    chat._eventSink(conv)({ type: 'tool_end', name: 'browser', args: { command: 'show', url: 'https://example.com' }, result: { ok: true, url: 'https://example.com' } });
    assert.strictEqual(broadcasts.filter((m) => m.t === 'browser.open').length, 0);
  } finally {
    chat.remove(conv.id);
  }
}));
```

### S4: Write the failing no-op test

- Owner: Backend. Window: D1. Depends on: S3.

- [ ] Add a test asserting that a non-`show` command and a failed result each
      emit zero broadcasts:

```js
test('webui chat: non-show and failed browser results do not broadcast', () => withTempHome(async (dir) => {
  const { ChatManager } = require('../src/webui/chat');
  const broadcasts = [];
  const chat = new ChatManager({
    settings: { modes: {} }, saveSettings() {}, broadcast(m) { broadcasts.push(m); },
    mcpManager: null, getWorkspace: () => dir, onProviderChanged() {},
  });
  const conv = chat.create();
  try {
    const sink = chat._eventSink(conv);
    sink({ type: 'tool_end', name: 'browser', args: { command: 'navigate', url: 'https://example.com' }, result: { ok: true, url: 'https://example.com' } });
    sink({ type: 'tool_end', name: 'browser', args: { command: 'show', url: 'https://example.com' }, result: { ok: false } });
    assert.strictEqual(broadcasts.filter((m) => m.t === 'browser.open').length, 0);
  } finally {
    chat.remove(conv.id);
  }
}));
```

### S5: Confirm the new tests fail

- Owner: Backend. Window: D1. Depends on: S4. Review: R1 (backend) after this
  step, before S6.

- [ ] Run `node test/units.js`.
- [ ] Expected: the three new tests fail (the broadcast is not yet wired) and
      every pre-existing test still passes. If a new test passes, it is not
      guarding anything; fix it before continuing.

### S6: Wire the helper into the tool_end case

- Owner: Backend. Window: D1-D2. Depends on: S5.
- Prerequisite: `git status --porcelain` shows a clean tree apart from the
  `test/units.js` edits from S2-S4, so the S10 scope check is meaningful.

- [ ] In `src/webui/chat.js`, at the top of the `tool_end` case (chat.js:945),
      add one line:

```js
      case 'tool_end': {
        this._broadcastBrowserOpen(ev.name, ev.args, ev.result, conv.mode);
        // ...existing transcript recording unchanged...
```

- [ ] Do not alter the existing transcript recording in that case.

### S7: Confirm the tests pass

- Owner: Backend. Window: D2. Depends on: S6.

- [ ] Run `node test/units.js`.
- [ ] Expected: exit code 0, including the three new tests.

### S8: Remove the dead inline broadcast

- Owner: Backend. Window: D2. Depends on: S7.

- [ ] Delete the inline `browser.open` broadcast block in `_plainChat`
      (chat.js:1166-1168). Leave the surrounding chat logic untouched.

### S9: Confirm a single broadcast site

- Owner: Backend. Window: D2. Depends on: S8. Review: R2 (backend) after this
  step.

- [ ] Run `grep -c "browser.open" src/webui/chat.js`.
- [ ] Expected: the count equals the helper's single `ctx.broadcast({ t:
      'browser.open', ... })` call plus any docstring/comment references, and
      the deleted inline block no longer contributes. Record the count.
- [ ] Confirm the `tool_end` call passes `conv.mode`, not a hardcoded value.

### S10: Run the full verification gate

- Owner: Backend. Window: D2-D3. Depends on: S9. Review: R3 (frontend) after
  this step.

- [ ] `node test/units.js` exits 0.
- [ ] `git diff --check` exits 0.
- [ ] `git diff --stat` lists only `src/webui/chat.js` and `test/units.js`.

### S11: Frontend contract review

- Owner: Frontend. Window: D3. Depends on: S10. Review: R4 (reviewer) after
  this step.

- [ ] Confirm `web/src/lib/types.ts:178` and `web/src/store/app.ts:235` have no
      diff (`git diff -- web/src/lib/types.ts web/src/store/app.ts` is empty).
- [ ] Confirm the wire shape is still `{ t: 'browser.open', url: string }`.
- [ ] Record the confirmation in the review notes. No code change.

### S12: Reviewer sign-off

- Owner: Reviewer. Window: D3. Depends on: S11.

- [ ] Confirm success criteria 1-5 in `backend-scope-and-success.md` are each
      met and measurable: coverage (S2/S7), design suppression (S3/S7), single
      source of truth (S9), test pass rate (S10), no contract drift (S11).
- [ ] This is the only accept point. Do not merge before it.

## 5. Milestones

| Milestone | After | Exit criterion | Window |
|-----------|-------|----------------|--------|
| M0 Ready | S1 | Baseline suite green, harness confirmed | end D0 |
| M1 Tests guarding the fix | S5 | Three new tests exist and fail; rest green | end D1 |
| M2 Behaviour implemented | S9 | Success broadcast, design suppression, dead code removed, single site confirmed | D2 |
| M3 Verified | S10 | Full suite green, scope audit clean | D2-D3 |
| M4 Accepted | S12 | Reviewer confirms all five criteria | end D3 |

## 6. Risks, assumptions, rollback

- **RISK-001**: Line numbers drift if `chat.js` changes before execution.
  Mitigation: locate the `tool_end` case and `_plainChat` block by content, not
  solely by the line numbers cited (chat.js:945, chat.js:1166).
- **RISK-002**: Team mode is not covered. Team sub-agents run `runAgent` with
  no `onEvent` sink (`src/team.js:509`), so a team `browser show` navigates but
  does not switch the pane. Out of scope; tracked as a follow-up, not a step.
- **ASSUMPTION-001**: `browser show` returns `{ ok: true, url }` on success
  (browser.js:289, core/browser-live.js:120) and `result.ok` is the only
  success signal.
- **Rollback**: the change is one file plus tests, no schema or persistence
  change. `git revert` of the commit restores prior behaviour; no migration.

## 7. Out of scope

- Implementing anything beyond `src/webui/chat.js` and `test/units.js`.
- Team-mode pane switching (follow-up, see RISK-002).
- Changes to `src/browser.js`, `src/core/browser-live.js`, the `browser` tool
  schema, `web/src/lib/types.ts`, or `web/src/store/app.ts`.
- Design-mode preview behaviour and markdown link interception.
- Re-scoping the feature or editing the three upstream input documents.

## 8. Related documents

- `docs/plans/task-plan-objective-scope.md` — objective and scope (task 1).
- `docs/plans/task-plan-steps.md` — sequenced draft this plan finalizes (task 2).
- `docs/plans/backend-scope-and-success.md` — success criteria 1-5.
- `docs/plans/backend-architecture-and-workstreams.md` — components C1-C6.
- `docs/plans/roadmap.md` — milestone and review-checkpoint source.
