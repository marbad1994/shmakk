# Backend scope and success criteria: shared-browser pane switching

## Problem

When the AI drives the shared browser, a `browser show` call is supposed to
auto-switch the web UI's right-hand inspector to the "live browser" pane. That
hand-off is broken: the pane switch only exists as dead code and never fires on
the path that actually runs the `browser` tool.

Concretely, in `src/webui/chat.js`:

- `_broadcastBrowserOpen` (chat.js:887) is the intended single place for the
  behaviour, with the correct mode gate (skip `design`, which renders its own
  live preview). It is never called.
- The only live broadcast is an inline copy inside `_plainChat`
  (chat.js:1166), but that mode filters the tool set to `web_search` and
  `fetch_url` (chat.js:1121), so `browser show` can never run there. The
  check is dead code.
- The code-agent path (the mode that does have the `browser` tool) streams
  tool events through `_eventSink`, whose `tool_end` handler (chat.js:944)
  records the result but does not broadcast `browser.open`.

Net effect: `browser show` in Code/Agent mode navigates the shared page but the
user's pane does not switch to the live browser, so the user never sees it.

## Users

- Web UI users in Code and Agent modes who ask the AI to browse a URL and expect
  the live-browser pane to open automatically.
- Web UI users who manually open the live browser pane and reload the shared
  page.
- Design-mode users are explicitly out of scope: design renders its own live
  preview, so no browser pane switch should occur there.

## Boundaries

### In scope

- Make the `browser.open` broadcast fire for every `browser show` call that
  succeeds, across all agent/code paths, while still suppressing it in design
  mode.
- Replace the duplicated broadcast logic with the single `_broadcastBrowserOpen`
  helper so the mode gate lives in one place.
- Keep the wire contract (`{ t: 'browser.open', url: string }`,
  types.ts:178) and the client handler (`setRightPane('live')`,
  store/app.ts:235) unchanged.

### Out of scope

- Design mode preview switching (unchanged).
- Making `browser navigate` auto-switch the pane. Only `show` is the
  pane-switching command; `navigate` stays a silent navigation.
- Link interception in Markdown: opening a markdown link in the shared browser
  is a frontend concern and is not part of this backend task.
- Any change to the `browser` tool schema, `src/browser.js`, or the live
  screencast stream (`src/core/browser-live.js`).

## Assumptions

- `runAgent` (src/agent.js) emits a `tool_end` event with `{ name, args,
  result }` for every dispatched tool call (agent.js:569); `_eventSink` is the
  single sink for those events in the web UI.
- `_eventSink` has access to the conversation record (`conv.mode`) where it is
  invoked, so the design-mode gate can be evaluated at broadcast time.
- `browser show` returns `{ ok: true, url, title }` on success
  (browser.js:289, core/browser-live.js:120); `ok` is the only success signal
  the broadcast relies on.
- The client already handles `browser.open` by switching the pane, so no
  frontend change is required for this task.

## Constraints

- No new dependencies.
- No change to the WebSocket message shape or to `web/src/lib/types.ts`.
- Design mode must keep its own preview and receive no `browser.open`.
- The change must be limited to `src/webui/chat.js` unless a review uncovers an
  additional sink that bypasses `_eventSink`.

## Success criteria

Each item is measurable; target values are 100% unless stated.

1. Broadcast coverage: every successful `browser show` result that flows through
   `_eventSink` in a non-design conversation emits exactly one
   `{ t: 'browser.open', url }` broadcast. Verified by a unit test that feeds a
   synthetic `tool_end` event through the sink and asserts the broadcast.
   Baseline: 0 broadcasts on the agent path (current). Target: 1 per successful
   `show`.

2. Design suppression: a `browser show` in a design-mode conversation emits
   zero `browser.open` broadcasts. Baseline: not exercised (helper unused).
   Target: 0. Verified by a unit test with `conv.mode === 'design'`.

3. Single source of truth: exactly one broadcast call site for `browser.open`
   remains in `src/webui/chat.js` after the change (the `_broadcastBrowserOpen`
   helper), with the duplicated inline check removed. Verified by
   `grep -c "browser.open" src/webui/chat.js` equalling the helper's single
   `ctx.broadcast` call plus the docstring references.

4. Test pass rate: the existing `node test/units.js` suite and the new
   assertions pass with no new failures. Target: 100% green.

5. No contract drift: `web/src/lib/types.ts` and `web/src/store/app.ts` are
   unchanged by this task; `git diff --stat` shows edits only under
   `src/webui/chat.js` and the test file.

## Verification plan

- `node test/units.js` after adding focused assertions for the `browser.open`
  broadcast (success path, design suppression, failure path).
- `grep -n "browser.open" src/webui/chat.js` to confirm a single broadcast site.
- `git diff --check` and `git diff --stat` to confirm scope boundaries and no
  whitespace errors.

## Sign-off

Scope and success criteria are accepted only after a reviewer confirms the
measurability of items 1-5 and agreement that the design-mode exclusion matches
the product intent.
