# Architecture and workstreams: shared-browser pane switching

Input: the approved scope and success criteria in
`backend-scope-and-success.md`. This document decomposes the work into
components, their data needs, the interfaces between them, and the owners who
execute and review each part. It does not redefine scope; it states how the
accepted fix is built and who builds it.

## 1. Runtime flow (the system as it is today)

```
agent core (src/agent.js)
  dispatchTool('browser', { command: 'show', url }, ...)      // agent.js:563
    └─ dispatchBrowser → liveStream().show(url)               // src/browser.js:289
         └─ { ok: true, url, title }                          // src/core/browser-live.js:120
  emit({ type: 'tool_end', name, args, result })              // agent.js:569
    └─ ChatManager._eventSink(conv).sink(ev)                  // src/webui/chat.js:896
         └─ tool_end → transcript item (chat.js:945)
                         ──[MISSING]── _broadcastBrowserOpen(...)
    └─ ctx.broadcast(msg)                                     // src/webui/server.js:157
         └─ ws.send over /ws (all connected clients)
               └─ web/src/store/app.ts:235 → setRightPane('live')
```

The arrow marked `[MISSING]` is the entire gap. Every other box already exists
and is unchanged by this task.

## 2. Components and responsibilities

### C1. Agent tool runner — unchanged
- File: `src/agent.js` (tool loop `:539-576`), `src/browser.js`, `src/core/browser-live.js`.
- Responsibility: dispatch the `browser show` tool, perform the navigation, and
  emit a `tool_end` event carrying `{ name, args, result, error }`.
- Why it stays out of scope: it already emits the event sink needs; the failure
  is downstream, in the web UI's consumption of that event. Touching it would
  risk the CLI (non-web) path for no benefit.

### C2. Event sink (web UI runtime)
- File: `src/webui/chat.js` `_eventSink` `:896-970`.
- Responsibility: translate agent events into transcript items and into
  side-effect broadcasts. The `tool_end` case `:945-971` is where the
  pane-switch side effect belongs.
- Change: add one call — `this._broadcastBrowserOpen(ev.name, ev.args, ev.result, conv.mode)`
  — at the top of the `tool_end` case.
- Coverage note: this fixes the single-agent and code paths (which stream
  `tool_end` through `_eventSink`). Team mode is a known non-covered case; see
  the risk register.

### C3. Broadcast helper (single source of truth)
- File: `src/webui/chat.js` `_broadcastBrowserOpen` `:887-894`.
- Responsibility: the one place that decides whether a `browser.open` message
  is emitted, and with what URL.
- Decision logic: skip when `mode === 'design'`; skip when the tool is not
  `browser`; skip when `args.command !== 'show'`; skip when `!result.ok`.
  Emit `{ t: 'browser.open', url: result.url || args.url || '' }` otherwise.
- Already correct; only its wiring changes. It becomes the sole broadcast site
  for `browser.open`.

### C4. Broadcast transport (WebSocket fan-out)
- File: `src/webui/server.js` `broadcast` `:157-160`.
- Responsibility: JSON-serialize a message and send it to every connected
  `/ws` client. Unchanged; documented as the interface boundary the helper
  relies on.

### C5. Client message contract and pane handler — unchanged, verify only
- Files: `web/src/lib/types.ts:178` (union member), `web/src/store/app.ts:235`
  (`case 'browser.open'` → `setRightPane('live')`).
- Responsibility: receive the message and switch the right-hand inspector to
  the live browser. Already present and correct; no diff expected here.

### C6. Dead code removal
- File: `src/webui/chat.js` `_plainChat` `:1166-1168`.
- Responsibility: remove the inline `browser.open` broadcast that can never fire
  (chat mode filters the tool set to `web_search` and `fetch_url` at `:1121`,
  so `browser` is unreachable). Removing it leaves C3 as the only broadcast
  site, satisfying success criterion 3.

## 3. Data needs

| Component | Input it needs | Source |
|-----------|----------------|--------|
| C1 | `{ command: 'show', url }` | model tool call |
| C2 | `tool_end` event `{ name, args, result, error }`; `conv.mode` | C1 emit (agent.js:569); ChatManager closure |
| C3 | `name`, `args`, `result`, `mode` | C2 call site |
| C4 | any JSON message `{ t, ... }` | C3 |
| C5 | `{ t: 'browser.open', url: string }` | C4 over `/ws` |

No new persisted state, no schema change, no new module. The only data movement
added is the one in-memory method call from C2 into C3.

## 4. Interfaces (contracts that must hold)

- **Agent → sink (internal, unchanged):** `tool_end` carries `name: 'browser'`,
  `args.command === 'show'`, and a `result` with a boolean `ok`. Success is
  defined solely by `result.ok`; `result.url` is the authoritative URL, falling
  back to `args.url`.
- **Sink → transport (internal, changed):** the call
  `_broadcastBrowserOpen(ev.name, ev.args, ev.result, conv.mode)`. This is the
  only new interface surface and it is a call to an existing method.
- **Transport → client (wire, unchanged):**
  `{ t: 'browser.open', url: string }`, matching `types.ts:178`. URL must be a
  string (possibly empty); the client tolerates an empty URL because the live
  pane falls back to `'No page open yet'`.
- **Mode gate (semantic, unchanged):** `conv.mode === 'design'` suppresses the
  broadcast regardless of tool success. This gate already exists in C3 and is
  the reason the helper accepts `mode` as a parameter.

## 5. Owner and workstream mapping

The work is one backend change plus a test, executed as a single workstream
with a designated reviewer. Sequencing is owned by the infra workstream in
task 3.

| Workstream | Owner | Components | Deliverable |
|------------|-------|------------|-------------|
| Backend — Web UI runtime | Backend owner (chat/agent runtime) | C2, C3, C6 | Wire the helper in `_eventSink`, delete the dead `_plainChat` block; edit `src/webui/chat.js` only |
| Backend — Verification | Backend owner | C1 (test fixtures) | Add focused unit tests: success broadcast, design suppression, failure/no-op; run `node test/units.js` |
| Frontend — Contract review | Frontend owner (review only) | C5 | Confirm `types.ts`/`store/app.ts` stay unchanged; no diff expected |
| Infra — Sequencing | Infra owner | — | Task 3: order the roadmap, including the test-first ordering of this work |

### Execution ordering (for task 3 to sequence)
1. Add failing tests asserting the `tool_end` → `browser.open` broadcast
   (success, design suppression, non-`show`/error no-op).
2. Implement the C2 wiring and C6 removal in `src/webui/chat.js`.
3. Green `node test/units.js`; `git diff --check`; confirm a single
   `browser.open` broadcast site via grep.

## 6. Risk register

- **Component boundary mistake (agent vs web UI):** low — `browser.js` and
  `browser-live.js` are confirmed unchanged; the emit already exists.
- **Team mode does not auto-switch the pane:** known limitation. Team
  sub-agents run `runAgent` with no `onEvent` sink (team.js:509), so their tool
  calls surface only as an aggregate `toolCount` (team.js:660). A `browser show`
  from a team sub-agent will navigate but will not switch the pane. This is out
  of scope; flag it in task 3 sequencing as a follow-up rather than silently
  claiming full coverage.
- **Design mode still getting `browser` tool access:** accepted — the mode gate
  in C3 handles it; do not change tool provisioning as part of this task.
- **Under-specified success signal:** mitigated — `result.ok` is the only
  signal, documented in section 4; `browser show` returns it on success.
