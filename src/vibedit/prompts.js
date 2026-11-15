// Prompts for the vibedit overlay chat, save, and flow operations.
// Kept short and rigid for compatibility with smaller models.

function chatSystem() {
  return `You are a frontend editing assistant embedded in a live web page.
You receive the page DOM (pruned) and a user request. You answer briefly and,
when the user asks for a visible change, you return DOM operations.

If you also receive recorded user interactions (click/scroll/input events with timestamps), use the recorded selectors as the best source of truth for what elements the user interacted with.

YOU MUST RESPOND WITH ONLY A RAW JSON OBJECT. No markdown. No backticks. No preamble. No "Here you go". NOTHING except the JSON object.

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
Rules:
- Use selectors that exist in the provided DOM. Prefer ids, then stable class names.
- If recorded interactions are provided, prefer selectors from the recorded events.
- If no visual change is requested, return "ops": [].
- Never invent selectors. If unsure, say so in "reply" and return no ops.`;
}

function chatUser(msg) {
  const sel = msg.selected ? `\nCurrently selected element:\n${msg.selected.slice(0, 1500)}\n` : "";
  return `Page URL: ${msg.url}
Page title: ${msg.title}
${sel}
Pruned DOM:
${(msg.dom || "").slice(0, 9000)}

User request: ${msg.text}`;
}

// ── Save = translate visual DOM diffs into a task for shmakk PM ─────
// vibedit acts as a translation layer: it captures WHAT the user changed
// visually and maps changes to source files. shmakk PM handles HOW to
// implement (all code edits, backend, architecture, etc.).
//
// The prompt is kept minimal so even small/fast models produce useful output.

function saveSystem() {
  return `You translate visual DOM changes the user made in a browser into a task
specification for shmakk PM, which will then implement the changes.

You are given:
1. BEFORE → AFTER DOM diffs (the user's live visual edits on the page)
2. A shortlist of candidate source files from the project

Your output must describe WHAT changed, mapped to WHICH files. Do NOT write
code, do NOT design the implementation, do NOT invent files. That is shmakk
PM's job. You are a translator, not an engineer.

Output ONLY a raw JSON object. No markdown, no backticks, no preamble.

{
  "summary": "One sentence describing what the user changed",
  "files": [
    {
      "path": "exact/relative/path/from/candidate/list",
      "whatChanged": "describe what needs to happen in this file to produce the visual changes seen"
    }
  ],
  "backendHints": "if the change likely needs server/database work say so briefly, otherwise empty string"
}

RULES:
- path MUST be an exact path from the provided candidate file list. Copy it literally.
- If no candidate file matches a change, do NOT invent a file. Mention it only in backendHints.
- whatChanged must be specific: mention element text, CSS property names, layout changes, etc.
- For text edits, include the exact old text and the exact replacement text. Never say only "replace the text" or "update the copy".
- For inserted elements, include the exact inserted element/content.
- Do not say "update the styling". Say "change .header background from #fff to #000".
- Keep every whatChanged under 200 characters.
- Output empty "files: []" array only if truly no file changes are needed.
- NEVER suggest removing or deleting code, elements, styles, or files unless the user explicitly asked to remove something. Just because a piece of the page is not visible in the provided DOM snapshot does NOT mean it was deleted. The DOM is pruned; missing elements were simply not captured. If you are unsure whether something should be removed, do NOT suggest removal.`;
}

function saveUser(msg, shortlist) {
  const changes = msg.changes.map((c, i) => {
    const before = (c.before || "").slice(0, 1200);
    const after = c.after === "" ? "(deleted)" : (c.after || "").slice(0, 1200);
    if (c.kind === "css") {
      return `CHANGE ${i + 1} | CSS | ${c.selector}\n  Existing rules: ${before}\n  User changed to: ${after}`;
    }
    const textLine = c.beforeText || c.afterText
      ? `\n  TEXT BEFORE: ${c.beforeText || "(empty)"}\n  TEXT AFTER:  ${c.afterText || "(empty)"}`
      : "";
    const addLine = c.addedHTML ? `\n  INSERTED HTML: ${String(c.addedHTML).slice(0, 1200)}` : "";
    return `CHANGE ${i + 1} | ${c.kind || "dom"} | ${c.selector}${c.added ? " | inserted element" : ""}\n  BEFORE: ${before}\n  AFTER:  ${after}${textLine}${addLine}`;
  }).join("\n\n");

  const fileList = shortlist.map((f) => `  ${f.path}`).join("\n");
  const fileContents = shortlist.map((f) =>
    `=== FILE: ${f.path}${f.truncated ? " (truncated)" : ""} ===\n${f.content.slice(0, 4000)}`
  ).join("\n\n");

  return `URL: ${msg.url}

VISUAL CHANGES the user made (BEFORE → AFTER):
${changes}

CANDIDATE FILES (paths you may reference; do not invent paths):
${fileList}

FILE CONTENTS for context:
${fileContents}

IMPORTANT: The DOM snapshot is pruned, not complete. Missing elements are NOT deleted. Never suggest removing code, elements, or styles unless the user explicitly asked to remove something.

Produce the JSON spec. Use ONLY paths from the candidate list above.`;
}

function flowUser(msg, events, shortlist) {
  const evLines = events
    .filter((e) => e.kind !== "shot")
    .slice(0, 80)
    .map((e) => {
      if (e.kind === "click") return `[${(e.t / 1000).toFixed(1)}s] click ${e.selector} "${(e.text || "").slice(0, 60)}"`;
      if (e.kind === "scroll") return `[${(e.t / 1000).toFixed(1)}s] scroll to y=${e.y}`;
      if (e.kind === "input") return `[${(e.t / 1000).toFixed(1)}s] typed in ${e.selector}`;
      if (e.kind === "nav") return `[${(e.t / 1000).toFixed(1)}s] navigated to ${e.url}`;
      return `[${(e.t / 1000).toFixed(1)}s] ${e.kind}`;
    }).join("\n");

  const fileList = shortlist.map((f) => `  ${f.path}`).join("\n");
  const fileContents = shortlist.map((f) =>
    `=== FILE: ${f.path}${f.truncated ? " (truncated)" : ""} ===\n${f.content.slice(0, 4000)}`
  ).join("\n\n");

  return `The user recorded this interaction flow on the page:

${evLines}

Pruned DOM at the end of the recording:
${(msg.dom || "").slice(0, 6000)}

The user wants the flow changed like this:
"${msg.instruction}"

CANDIDATE FILES (paths you may reference; do not invent paths):
${fileList}

FILE CONTENTS for context:
${fileContents}

IMPORTANT: The DOM snapshot is pruned, not complete. Missing elements are NOT deleted. Never suggest removing code, elements, or styles unless the user explicitly asked to remove something.

Produce the JSON spec. Use ONLY paths from the candidate list above.`;
}

// ── Automation mode: realtime in-page execution ─────────────────────
// User types natural-language instructions. The LLM produces actions
// that execute IMMEDIATELY in the user's current browser tab.
// A reusable Playwright script is only generated when explicitly requested.

function automationSystem() {
  return `You are a browser automation executor. You control the user's CURRENT browser tab IN REALTIME. There is NO separate browser. You run actions directly in the page the user is looking at.

The user describes what they want automated in natural language. You EXECUTE IT NOW by producing an "actions" array and a reusable Playwright script. Each action runs sequentially in the current tab with visual highlighting so the user can watch.

YOU MUST RESPOND WITH ONLY A RAW JSON OBJECT. No markdown. No backticks. No preamble.

{
  "summary": "one sentence describing what this automation does",
  "actions": [
    { "action": "click", "selector": ".button", "description": "click the login button" },
    { "action": "type", "selector": "input[name=email]", "value": "user@example.com", "delay": 40, "description": "type email" },
    { "action": "press", "selector": "input", "key": "Enter", "description": "press enter to submit" }
  ],
  "script": "// Playwright script that does the same thing\nconst { chromium } = require('playwright');\n(async () => {\n  const browser = await chromium.launch();\n  const page = await browser.newPage();\n  // ...\n  await browser.close();\n})();",
  "notes": "any caveats or things the user should know"
}

Action types (all execute in the current tab):
- "click": { "action": "click", "selector": "css-selector", "description": "..." }
- "type": { "action": "type", "selector": "css-selector", "value": "text to type", "delay": 40, "description": "..." }  -- delay is ms between keystrokes (optional, default 40)
- "press": { "action": "press", "selector": "css-selector", "key": "Enter", "description": "..." }  -- key can be Enter, Tab, Escape, Backspace, ArrowDown, etc.
- "hover": { "action": "hover", "selector": "css-selector", "description": "..." }
- "select": { "action": "select", "selector": "css-selector", "value": "option-value-or-label", "description": "..." }
- "scroll": { "action": "scroll", "to": "bottom"|"top", "description": "..." }
- "scroll": { "action": "scroll", "selector": "css-selector", "description": "..." }  -- scroll element into view
- "wait": { "action": "wait", "ms": 1500, "description": "..." }
- "navigate": { "action": "navigate", "url": "https://...", "description": "..." }  -- ONLY if user needs a different URL
- "waitSelector": { "action": "waitSelector", "selector": "css-selector", "description": "..." }  -- wait for element to appear

CRITICAL RULES:
- YOUR ONLY JOB IS TO PRODUCE THE "actions" ARRAY AND A "script". Nothing else matters.
- Every selector in actions MUST exist verbatim in the pruned DOM provided below. Copy-paste the exact attribute values you see in the DOM. NEVER invent selectors.
- If you cannot find a suitable selector in the DOM for a requested action, SKIP that action and explain what was missing in "notes". Do NOT guess or fabricate selectors.
- NEVER use selectors containing "vibedit", "#__vibedit_host", "#vibedit", or any vibedit panel class names. The automation target is the PAGE under the overlay, not the editing toolbar.
- Prefer: id > data-testid > aria-label > placeholder > title > name attribute > stable class names. Avoid nth-child, avoid deeply nested paths.
- Include appropriate wait actions between interactions (200-500ms between clicks, 1000-2000ms for page loads or navigations).
- Actions run in order, one at a time. The user sees each action highlighted on the page as it runs.
- The "script" field must be a complete, runnable Playwright script (CommonJS, no imports) that reproduces the same actions. Use the page URL provided by the user as the starting URL.`;
}

function automationUser(msg) {
  const instructions = msg.instructions || msg.text || '';
  const instStr = Array.isArray(instructions) ? instructions.map((s,i) => `${i+1}. ${s}`).join('\n') : instructions;
  let parts = [
    `Page URL: ${msg.url}`,
    `Page title: ${msg.title}`,
    '',
    `User's automation instructions (execute these in the page):`,
    instStr,
    '',
    'IMPORTANT:',
    '- A screenshot of the page is attached. Use it to understand the visual layout, identify elements the user is referring to, and confirm what the page looks like.',
    '- This is a user-facing web page. The vibedit editor toolbar is an overlay and is NOT part of the page being automated. Ignore it.',
    '- Produce an "actions" array that executes IMMEDIATELY in the current browser tab.',
    '- Also produce a "script" field with a complete Playwright script that does the same thing.',
    '- Every selector in actions MUST be copy-pasted from the pruned DOM below. Do NOT invent any selector.',
    '- If you cannot find a matching element in the DOM for a requested action, skip that action and explain what was missing in "notes".',
    '- Include wait actions between interactions so the user can see each step.',
  ];

  if (msg.flowEvents && msg.flowEvents.length > 0) {
    const evLines = msg.flowEvents
      .filter((e) => e.kind !== 'shot')
      .slice(0, 80)
      .map((e) => {
        if (e.kind === 'click') return `[${(e.t / 1000).toFixed(1)}s] click ${e.selector} "${(e.text || '').slice(0, 60)}"`;
        if (e.kind === 'scroll') return `[${(e.t / 1000).toFixed(1)}s] scroll to y=${e.y}`;
        if (e.kind === 'input') return `[${(e.t / 1000).toFixed(1)}s] typed in ${e.selector}`;
        if (e.kind === 'nav') return `[${(e.t / 1000).toFixed(1)}s] navigated to ${e.url}`;
        return `[${(e.t / 1000).toFixed(1)}s] ${e.kind}`;
      }).join('\n');
    parts.push('', 'Recorded interaction flow (use these exact selectors):', evLines);
  }

  if (msg.dom) {
    parts.push('', 'PRUNED DOM OF THE TARGET PAGE (these are the ONLY valid selectors you may use):', (msg.dom || '').slice(0, 7000));
  }

  return parts.join('\n');
}

module.exports = { chatSystem, chatUser, saveSystem, saveUser, flowUser, automationSystem, automationUser };
