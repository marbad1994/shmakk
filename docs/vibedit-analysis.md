# vibedit Architecture Analysis

## Overview

vibedit is a visual in-browser editor that lets you click on elements of a live webpage, edit them visually, and map those edits back to source code changes on disk. It runs the target app in a Playwright Chromium instance, injects a shadow-DOM overlay panel, and communicates with an LLM (default: LM Studio running qwen3.5-9b) over an OpenAI-compatible API. Screenshots are captured server-side via Playwright's `page.screenshot()` and sent as base64 JPEGs in multimodal chat requests.

---

## System Architecture (Data Flow)

```
[User browser page]  <--WebSocket-->  [Node control server]  <--HTTP POST-->  [LM Studio /chat/completions]
       |                                       |                                       |
  overlay.js injected                   control.js                              llm.js (OpenAI-compatible)
  (shadow DOM panel)                    (WS message routing,                    (fetch wrapper with
   - DOM editing                         screenshot capture,                      multimodal retry)
   - WS client                           LLM orchestration)
   - flow recording
                                         |
                                    files.js (source file matching + edit block application)
                                    prompts.js (system/user prompt templates)
```

---

## 1. Screenshot Capture

**Where:** `src/control.js:30-34` — `screenshotB64()`

```js
async function screenshotB64() {
  const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
  return buf.toString("base64");
}
```

Uses Playwright's `page.screenshot()` (viewport only, `fullPage: false`). Quality is 60 JPEG. Returns a base64-encoded string. The `page` reference is captured from `index.js:43` when launching the browser.

The screenshots are attached to LLM requests as `images` array entries inside the user message (in OpenAI vision format): base64 data URIs with `data:image/jpeg;base64,${b64}` prefix. See `src/llm.js:17-20`.

**Control flow:** Every `chat`, `save`, and `flowApply` message type triggers a `screenshotB64()` call BEFORE calling the LLM. The screenshot is the current viewport state at the moment the user clicked Send, Save, or Apply. If `ctx.vision` is falsy (i.e., `--vision` flag not passed), screenshot capture is skipped and the request is text-only.

---

## 2. LLM API Endpoint Format

**Where:** `src/llm.js` — the `chat()` function

### Endpoint

```
POST {ctx.lmUrl}/chat/completions
```

Default `ctx.lmUrl` = `http://127.0.0.1:1234/v1` (LM Studio default).

Configurable via:
- `--lm <url>` CLI flag
- `LMSTUDIO_URL` environment variable
- Falls back to the hardcoded default above

### Request Body Shape

```json
{
  "model": "qwen/qwen3.5-9b",
  "temperature": 0.2,
  "max_tokens": 2048,
  "messages": [
    {
      "role": "system",
      "content": "You are a frontend editing assistant..."
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Page URL: http://..." },
        {
          "type": "image_url",
          "image_url": { "url": "data:image/jpeg;base64,<base64>" }
        }
      ]
    }
  ]
}
```

### Key Parameters

| Param | Default | Override |
|-------|---------|----------|
| `model` | `qwen/qwen3.5-9b` | `--model <id>` or `VIBEDIT_MODEL` env |
| `temperature` | `0.2` | Hardcoded in `chat()` call site |
| `max_tokens` | `2048` (chat), `4096` (save/flowApply) | Passed via `opts.maxTokens` |
| `vision` | `false` | `--vision` flag or `VIBEDIT_VISION=1` env |

### Multimodal Handling

Messages carry an `images` array of base64 JPEG strings. If the model rejects multimodal input (non-2xx response), `llm.js` retries once with text-only (`src/llm.js:40-46`).

```js
try { return await call(hasImages); }
catch (err) {
  if (hasImages) {
    console.warn("[vibedit] multimodal request failed, retrying text-only:", err.message);
    return await call(false);
  }
  throw err;
}
```

### Response Parsing

The raw response is extracted as: `data?.choices?.[0]?.message?.content ?? ""`

This string is then parsed differently depending on the message type.

---

## 3. Prompt Design (Three Distinct Prompt Sets)

### 3.1 Chat Prompt (live DOM editing)

**System prompt** (`src/prompts.js:3-21` — `chatSystem()`):

The LLM is told it is a "frontend editing assistant embedded in a live web page." It receives a pruned DOM and a user request, and must respond with ONLY a JSON object in this shape:

```json
{
  "reply": "one or two short sentences for the user",
  "ops": [
    { "selector": "css selector", "action": "setText", "value": "new text" },
    { "selector": "css selector", "action": "setStyle", "style": { "color": "#ff0000" } },
    { "selector": "css selector", "action": "setHTML", "value": "<b>html</b>" },
    { "selector": "css selector", "action": "setAttr", "name": "src", "value": "..." },
    { "selector": "css selector", "action": "remove" }
  ]
}
```

Rules encoded in the system prompt:
- Prefer IDs, then stable class names
- Return `"ops": []` if no visual change requested
- Never invent selectors; say so in `reply` if unsure

**User prompt** (`src/prompts.js:23-28` — `chatUser()`):

```
Page URL: {msg.url}
Page title: {msg.title}
Currently selected element: {msg.selected} (if any)
Pruned DOM: {msg.dom} (truncated to 9000 chars)

User request: {msg.text}
```

The DOM is the pruned outerHTML of `<body>` with `<script>`, `<style>`, `<noscript>`, `<svg>`, metadata stripped, and data- attributes removed or truncated (see `overlay.js:260-273` — `prunedDOM()`).

**Response parsing** (`src/control.js:48-56` — inside `handleChat()`):

```js
let parsed;
try {
  parsed = JSON.parse(stripFences(raw));
} catch {
  parsed = { reply: raw, ops: [] };
}
send(ws, { type: "chatResult", reply: parsed.reply || "", ops: Array.isArray(parsed.ops) ? parsed.ops : [] });
```

`stripFences()` removes leading/trailing markdown code fences (```json ... ```). Graceful fallback: if JSON parse fails, the raw text becomes `reply` and `ops` is empty.

### 3.2 Save Prompt (source code mapping)

**System prompt** (`src/prompts.js:30-53` — `saveSystem()`):

The LLM is told to map live DOM edits back to source code. It outputs edit blocks in SEARCH/REPLACE format:

```
FILE: relative/path/from/project/root
<<<<<<< SEARCH
exact lines copied verbatim from the provided file content
=======
the replacement lines
>>>>>>> REPLACE
```

Rules:
- SEARCH must be character-for-character from the provided file content
- One block per distinct change; multiple blocks per file are fine
- JSX/Vue/Svelte: edit component source, not rendered HTML
- Inline styles should become CSS rule changes
- If a change cannot be located, skip it (do not guess paths)

**User prompt** (`src/prompts.js:55-79` — `saveUser()`):

For each tracked change, shows:
- DOM changes: `CHANGE N (selector: ...)` with BEFORE/AFTER outerHTML
- CSS changes: `CHANGE N (CSS rule for selector ...)` with existing rules and new declarations

Plus candidate source files (up to 5, shortlisted by `shortlistFiles()`).

### 3.3 Flow Prompt (user interaction recording)

**System prompt:** Same `saveSystem()` as Save.

**User prompt** (`src/prompts.js:81-105` — `flowUser()`):

Shows a timestamped event log:
```
[1.2s] click .header "Welcome"
[3.5s] scroll to y=450
[5.1s] typed in #email
```

Plus the pruned DOM at end of recording, the user's instruction, and candidate source files. Three screenshots (first, middle, last) are included as images when vision is enabled.

---

## 4. Response Parsing and Code Modification

### Chat Result (client-side)

The overlay receives `{ type: "chatResult", reply, ops }` via WebSocket. The `ops` array is processed by `applyOps()` in `overlay.js:331-349`:

```js
function applyOps(ops) {
  for (const op of ops) {
    let el = document.querySelector(op.selector);
    if (!el || isOurs(el)) continue;
    trackBefore(el);  // record original state
    if (op.action === "setText") el.textContent = op.value ?? "";
    else if (op.action === "setHTML") el.innerHTML = op.value ?? "";
    else if (op.action === "setStyle" && op.style)
      for (const [k, v] of Object.entries(op.style))
        el.style.setProperty(toKebab(k), v);
    else if (op.action === "setAttr") el.setAttribute(op.name, op.value ?? "");
    else if (op.action === "remove") { el.remove(); }
  }
}
```

Supported DOM actions: `setText`, `setHTML`, `setStyle`, `setAttr`, `remove`.

Each modification is tracked in the `changes` Map (keyed by CSS path of the element) so it can be reverted or saved to source.

### Save Result (server-side)

**Edit block parsing** (`src/files.js:100-128` — `applyEditBlocks()`):

The LLM's raw text output is parsed with regex:

```js
const BLOCK_RE = /FILE:\s*(.+?)\s*\n<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;
```

Two matching strategies:

1. **Exact match** (`exactReplace`): simple `String.indexOf()` check. Fast path.
2. **Fuzzy match** (`fuzzyReplace`): line-trimmed match that tolerates indentation drift. Splits both search and content into lines, trims whitespace, tries to find a contiguous match of the trimmed lines.

Vibedit project-local artifacts are stored under `.shmakk/state/`; generated
specs use `.shmakk/state/vibedit-specs/` and recorded flow media uses
`.shmakk/state/vibedit-sessions/`.

### File Shortlisting

**Where:** `src/files.js:56-97` — `shortlistFiles()`

Before asking the LLM to generate edit blocks, vibedit determines which source files are relevant to the user's changes:

1. Walk the project directory (excluding `node_modules`, `.git`, `dist`, `build`, etc.)
2. Collect all files with source extensions (`.html`, `.js`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.less`, `.mjs`, `.cjs`)
3. Extract "needles" from the change data: text fragments (6-80 chars), class names, IDs, CSS property names, selector parts
4. Score each file by needle occurrence count (weighted by needle length, capped at 5000)
5. Return top 5 files with content trimmed to fit within 16,000 chars total budget; for large files, show windows around hit lines

---

## 5. WebSocket Message Protocol

### Client-to-Server Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `chat` | `text`, `url`, `title`, `dom`, `selected` | Ask LLM about current page |
| `save` | `changes[]`, `url`, `dom` | Map live edits to source files |
| `flowStart` | (none) | Begin recording interaction flow |
| `flowStop` | (none) | End recording |
| `flowEvent` | `ev: { kind, selector, text, x, y, url }` | Log click/scroll/input/nav event |
| `flowApply` | `id`, `instruction`, `dom`, `url` | Apply LLM changes from recorded flow |
| `flowDiscard` | `id` | Delete the recorded session |

### Server-to-Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `hello` | `model`, `vision` | Connection established |
| `status` | `text` | Progress indicator |
| `chatResult` | `reply`, `ops[]` | LLM response for chat |
| `saveResult` | `ok`, `summary`, `applied[]`, `failed[]`, `modelOutput` | Result of source edits |
| `flowStarted` | `id` | Recording started |
| `flowStopped` | `id`, `shots`, `events[]`, `base` | Recording completed |
| `error` | `text` | Error message |

---

## 6. Flow Recording (Interaction Capture)

vibedit has a "userflow" feature that records user interactions (clicks, scrolls, input, navigation) as timed events while capturing screenshots every 1.5 seconds.

**Server-side** (`src/control.js:60-122`):

- `startFlow()`: Creates session dir, takes first screenshot, sets 1.5s interval timer
- `flowEvent`: Appended to `events[]` array in memory
- `stopFlow()`: Writes `events.json`, stops timer
- `handleFlowApply()`: Sends 3 screenshots (first/middle/last) as vision input, plus event timeline, to the LLM for source mapping

**Client-side** (`overlay.js`):

- Click events recorded with CSS path, text content (80 chars), coordinates
- Scroll events debounced at 250ms
- Input events on form fields
- Playback UI shows frames with scrubber and event annotations

---

## 7. Bootstrap & Runtime Flow

1. **`bin/vibedit.js`** parses CLI args, resolves the target (package.json or HTML file)
2. **`src/index.js` — `start()`**:
   a. Starts or detects a dev server (npm/yarn/pnpm/bun `dev` script, or static file server on port 8362)
   b. Launches Chromium via Playwright (headless: false, viewport: null for native size)
   c. Injects `overlay.js` via `context.addInitScript()` so it runs on every page load
   d. Passes the control server port to the overlay via `window.__VIBEDIT__.port`
   e. Navigates to the app URL with retry logic
   f. Starts the control server (WebSocket + HTTP) on port 8417
3. **`src/control.js` — `startControlServer()`**: Handles all WebSocket messages, orchestrates LLM calls, serves session screenshots over HTTP for the playback UI
4. **`src/overlay.js`**: Shadow-DOM panel connects to control server, provides chat UI, element inspector, CSS rule editor, flow recording, and applies AI-generated DOM ops

---

## 8. Key Files Summary

| File | Lines | Role |
|------|-------|------|
| `src/overlay.js` | ~710 | Client-side: shadow-DOM panel, element inspector, chat, flow recording, DOM ops application |
| `src/control.js` | ~185 | Server-side: WebSocket routing, screenshot capture, LLM orchestration, flow session management |
| `src/llm.js` | ~50 | OpenAI-compatible chat client with multimodal support and text-only fallback |
| `src/prompts.js` | ~105 | Prompt templates for chat, save, and flow modes |
| `src/files.js` | ~170 | Source file discovery, needle-based shortlisting, SEARCH/REPLACE edit block parsing and application |
| `src/index.js` | ~90 | Entry point: browser launch, overlay injection, dev server startup, shutdown handling |
| `src/devserver.js` | ~85 | Dev server detection (npm/yarn/pnpm/bun) and static file server |
| `bin/vibedit.js` | ~60 | CLI argument parsing |
| `package.json` | ~20 | Dependencies: `playwright`, `ws` |

---

## 9. Design Observations for shmakk Integration

1. **Prompt rigidity is intentional**: Prompts are kept short and structured because the default model is 9B parameters. Moving to larger models or agent-based workflows (like shmakk's multi-agent system) would benefit from more descriptive prompts and structured output formats.

2. **Screenshot + DOM dual input**: The vision LLM receives BOTH a base64 screenshot AND a text-based pruned DOM. The DOM is the primary source for operations (the LLM cannot "see" class names or selectors from the image alone), while the screenshot gives visual layout context.

3. **DOM ops are simple but powerful**: Five operations cover most UI edits: text, HTML, styles, attributes, remove. No support for create/insert/move operations.

4. **Source mapping is reactive**: Changes tracked in-memory during the editing session are sent to the LLM only when the user clicks "Save." The LLM then maps BEFORE/AFTER DOM blobs back to source files.

5. **LLM has no filesystem access**: The LLM never sees the full project. It sees only up to 5 shortlisted files (determined by text-matching needle extraction). This keeps token usage low but can miss edits in unlisted files.

6. **Model is swappable**: The LM Studio endpoint can point to any OpenAI-compatible API. The model ID defaults to qwen3.5-9b but can be any vision-capable model.

7. **Single-page focus**: The tool is designed for web apps in a single browser page. No multi-tab, no Electron/mobile app support. Extending to Electron or mobile would require a different screenshot capture mechanism (e.g., native screenshot APIs) and potentially a different overlay injection strategy.

8. **Flow recording is time-sampled**: Screenshots at 1.5s intervals + event log. The LLM sees 3 screenshots (first/middle/last) to understand the interaction timeline. This is a clever low-token approach for understanding user flows.
