// Vision analysis for show-and-tell recordings.
//
// Turns the key frames + timestamped transcript produced by the capture and
// frames services into a structured understanding of what the user showed and
// said. The recording is a person pointing at a screen while describing what
// needs to change, so the primary output is a list of "findings": each one
// records what the user said, anchored to the page and element it is about.
// The frames are context for locating things on screen, not instructions.
//
// Action "steps" are emitted separately and only when the narration is
// imperative. They feed the automation stage (src/services/showtell.js), where
// the spoken words really are commands to replay.
//
// The heavy lifting is a single multimodal call to a vision-capable model. The
// prompt asks for a rigid JSON shape, but parseAnalysis() tolerates the usual
// formatting noise (markdown fences, surrounding prose, arrays) so a slightly
// non-compliant model still yields a usable result.

const fs = require('fs');
const path = require('path');
const llm = require('../llm');
const { getModelRegistry, getVisionSupport } = require('../endpoints');

// ── structured output contract ─────────────────────────────────────────────
// The "action" enum here is the source of truth; showtell.js maps it onto
// executable automation steps. Keep the two in sync.

const ANALYSIS_INSTRUCTIONS = `You are analyzing a screen recording with spoken narration. The user is showing a screen and telling you what needs to change. Record WHAT they said needs changing and WHERE it is on screen, so they can refer back to it without replaying the video.

The frames are CONTEXT. Use them to identify the page and the element being discussed. They are NOT instructions to perform, and you must not turn what you see into a to-do list of actions.

You are given:
1. A transcript (optional) of what the user said, with timestamps.
2. Key frames extracted at the moments the user was most likely pointing at something. The frames are numbered and attached in the same order as the "FRAMES" list below.

Respond with ONLY a single JSON object, no markdown fences, no commentary:

{
  "summary": "a concise sentence stating what is on screen and what needs to change, in the voice of the person recording, e.g. the Save button is too small and needs a bigger font",
  "app": "the application or window in use, if identifiable, otherwise null",
  "page": "the page, view or screen being shown, e.g. Settings > Appearance, otherwise null",
  "findings": [
    {
      "index": 1,
      "page": "the page or view this finding is on",
      "element": "the specific UI element being discussed, described so it can be found again, e.g. the Save button in the top-right toolbar",
      "note": "what the user said needs to change, in their own words, phrased as a statement about the element, e.g. the Save button is too small and needs a bigger font",
      "kind": "bug | change | feature | chore",
      "quote": "the transcript words this came from, verbatim, or null",
      "frames": [1],
      "confidence": 0.9
    }
  ],
  "steps": [
    {
      "index": 1,
      "action": "click",
      "target": "short description of the UI element or location acted on",
      "value": "text typed or option selected, when relevant, otherwise null",
      "key": "keyboard key pressed, when relevant, otherwise null",
      "detail": "a complete, self-contained instruction sentence, e.g. Click the Save button to persist the changes",
      "transcript": "the transcript text this step is most supported by, or null",
      "frames": [1],
      "confidence": 0.9
    }
  ],
  "uncertain": ["anything you are unsure about"],
  "notes": ["any extra observations"]
}

Rules:
- Write every field in the voice of the person recording, never as third-person narration about "the user". Do not begin summary, notes, or findings with "The user", "They", or report the narration as "the user says". State the point directly: what is on screen and what should change.
- "findings" is the primary output. Emit one finding for each distinct thing the user points out: a problem, a desired change, or a question.
- "page" and "element" must locate the finding on screen so the user can find it again. Be specific ("the Email field in the Sign-in form") but never fabricate details you cannot see.
- "note" must preserve the user's meaning and wording. Phrase it as what is wrong or what should change, NOT as an instruction and NOT as reported speech: "the button is too small", not "Click Save" and not "the user says the button is too small". Never turn a finding into a how-to step.
- The frames are context for locating the page and element. Do not invent actions or changes the user did not mention.
- "steps" are ONLY for automation. Emit a step only when the narration is explicitly imperative and describes an action to perform ("click X, then type Y"). Otherwise leave "steps" empty.
- "action" MUST be one of: click, type, press, select, scroll, hover, drag, navigate, wait, other.
- If a user-supplied task description is provided, treat it as the authoritative intent and reconcile every finding and step against it.
- Use 1-based frame numbers (matching the "FRAMES" list) in "frames" to cite the context for each finding or step.
- If the transcript is empty or missing, rely on the frames alone and record only what is visibly being pointed at.
- If you cannot determine something, lower "confidence" and add an "uncertain" entry rather than guessing.`;

// The automation prompt inverts the one above on purpose. There the frames are
// context for a bug report; here the frames ARE the spec, and the job is to
// name every action that moved the screen from one state to the next, with or
// without narration.
const AUTOMATION_INSTRUCTIONS = `You are reconstructing a workflow from a screen recording so it can be replayed by a computer. You are given numbered frames in the order they happened, and optionally a transcript of what was said.

Write the actions back out in order. Each step is one thing the person did that changed the screen.

How to read the frames:
- Each frame is a state. Compare it with the frame before it and ask what changed: a menu opened, a dialog appeared, a field filled in, a checkbox got checked, a list scrolled, a page loaded, a value was picked.
- The action that caused the change happened between the two frames. Cite the frame that shows the result.
- The transcript is optional and is only a hint about intent. If there is no transcript, infer the steps from the frames alone. If the transcript and the frames disagree, trust the frames.
- Do not describe a step you cannot see evidence for. No looking ahead, no "probably then".
- Do not describe typing character by character. One step per field, with the final text.

Naming a target (this is what makes replay possible):
- "name" is the control's accessible name: the visible label or text on it, copied exactly as it appears ("Save", "Email address", "Invoice #"). Never a description of where it is.
- "role" is the kind of control, guessed from how it looks: button, link, textbox, searchbox, combobox, checkbox, radio, switch, tab, menuitem, option, slider, listitem.
- "target" is a short human label used when no exact text is visible ("the avatar in the top right").
- "app" is the window or application name. For a browser, name the browser and give the URL from the address bar.

Surface:
- "browser" when the screen is a web page in a browser: tab strip, address bar, or a recognisably web UI.
- "desktop" for native application windows.

Respond with ONLY a single JSON object, no markdown fences, no commentary:

{
  "surface": "browser | desktop",
  "app": "the application or browser in use, e.g. Firefox, Dolphin, VS Code, otherwise null",
  "url": "the page URL visible in the address bar, or null",
  "goal": "one short sentence: what this workflow accomplishes",
  "summary": "two or three sentences describing what happens from start to finish",
  "inputs": [
    {
      "name": "snake_case variable name, e.g. email, search_term",
      "label": "what the field is called on screen",
      "example": "the exact value that was typed in this recording"
    }
  ],
  "steps": [
    {
      "index": 1,
      "action": "navigate | click | dblclick | rightclick | type | press | select | scroll | hover | drag | launch | focus | wait",
      "target": "short label for the element or place acted on",
      "name": "the control's visible label, exactly as shown, or null",
      "role": "button | link | textbox | searchbox | combobox | checkbox | tab | menuitem | option | slider | listitem | null",
      "value": "text typed, option selected, URL opened, or null",
      "key": "key or chord pressed, in Playwright or AT-SPI spelling (Enter, Tab, Ctrl+S), or null",
      "input_name": "for type and select steps, the snake_case name of the input this value comes from, or null when the value never changes",
      "expected": "what the screen shows once this step worked, one short clause",
      "frames": [1],
      "confidence": 0.9
    }
  ],
  "uncertain": ["anything you could not read from the frames"],
  "notes": ["anything worth knowing before replaying this"]
}

Rules:
- Order matters. Emit steps in the order they happened, and never merge two controls into one step.
- "inputs" lists every value that could differ on another run. Give each one the recorded text as "example", and set "input_name" on the steps that use it.
- A click step needs a name or a role. A click on empty space is not a step.
- If the screen shows a native app, "action": "launch" with the application command in "value" is a good first step when the window opening is visible.
- If a step is real but you cannot name the control, still emit it with what detail you have and a low confidence. Never invent a name.
- Use 1-based frame numbers matching the FRAMES list.
- Keep "goal" to one sentence and "summary" under 60 words.`;

// ── vision client discovery ────────────────────────────────────────────────
// Prefer the explicit visionSupport endpoint, then any model flagged
// vision:true, then the active endpoint if it supports vision natively.

function findVisionClient() {
  if (getVisionSupport()) {
    const c = llm.makeClientForEndpoint('visionSupport');
    if (c) return c;
  }
  const registry = getModelRegistry();
  for (const [name, cfg] of Object.entries(registry.models || {})) {
    if (name === 'visionSupport') continue;
    if (cfg.vision) {
      const c = llm.makeClientForEndpoint(name);
      if (c) return c;
    }
  }
  if (llm.supportsVision()) {
    return { name: 'active', model: llm.modelFor(), client: llm.makeClient() };
  }
  return null;
}

// ── frame → vision block conversion ────────────────────────────────────────

/**
 * Read extracted frame files into { name, mimeType, data } blocks, carrying the
 * frame metadata through so it survives image normalisation (normalizeImage
 * spreads the input object) and can be referenced in the prompt labels.
 */
function framesToImages(frames) {
  const images = [];
  for (const f of Array.isArray(frames) ? frames : []) {
    const p = f && (f.path || f.file);
    if (!p || !fs.existsSync(p)) continue;
    let data;
    try { data = fs.readFileSync(p).toString('base64'); } catch { continue; }
    images.push({
      name: f.file || path.basename(p),
      mimeType: /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png',
      data,
      frameIndex: f.index,
      t: Number(f.t) || 0,
      transcript: f.transcript || null,
      cue: f.cue || null,
      reason: f.reason || null,
    });
  }
  return images;
}

// ── prompt assembly (pure) ─────────────────────────────────────────────────

function transcriptBlock(transcript) {
  if (!transcript || typeof transcript !== 'object') return '';
  const lines = [];
  if (typeof transcript.text === 'string' && transcript.text.trim()) {
    lines.push(`Full transcript: "${transcript.text.trim()}"`);
  }
  const segs = Array.isArray(transcript.segments) ? transcript.segments : [];
  if (segs.length) {
    lines.push('Timestamped segments:');
    for (const s of segs) {
      if (!s) continue;
      lines.push(`  [${Number(s.start).toFixed(2)}s] ${String(s.text || '').trim()}`);
    }
  }
  return lines.join('\n');
}

function frameLabels(images) {
  const list = Array.isArray(images) ? images : [];
  return list.map((img, i) => {
    const t = Number(img.t).toFixed(2);
    const tx = img.transcript ? `: "${img.transcript}"` : '';
    return `Frame ${i + 1} @ ${t}s${tx}`;
  }).join('\n');
}

/**
 * Build the text block that precedes the attached frame images.
 *
 * @param {object} transcript
 * @param {Array} images
 * @param {string} [instructions] user task description, authoritative intent
 * @param {'tasks'|'automation'} [mode] picks the contract; automation reads
 *        the frames as the spec rather than as context for a bug report
 */
function buildAnalysisText(transcript, images, instructions, mode) {
  const auto = mode === 'automation';
  const parts = [auto ? AUTOMATION_INSTRUCTIONS : ANALYSIS_INSTRUCTIONS];
  const instr = instructions ? String(instructions).trim() : '';
  if (instr) parts.push(`${auto ? 'GOAL (authoritative)' : 'TASK DESCRIPTION (authoritative user intent)'}\n${instr}`);
  const tb = transcriptBlock(transcript);
  if (tb) parts.push(`TRANSCRIPT\n${tb}`);
  else if (auto) parts.push('TRANSCRIPT\n(none: infer the steps from the frames alone)');
  const labels = frameLabels(images);
  if (labels) parts.push(`FRAMES (numbered, in the order they were recorded and as attached below)\n${labels}`);
  return parts.join('\n\n');
}

// ── response parsing (pure) ────────────────────────────────────────────────

function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('empty response');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* fall through */ }
  }
  const fa = s.indexOf('[');
  const la = s.lastIndexOf(']');
  if (fa !== -1 && la > fa) {
    try { return JSON.parse(s.slice(fa, la + 1)); } catch { /* fall through */ }
  }
  throw new Error('no valid JSON found');
}

/** Parse a raw model response into the analysis object, or null when unusable. */
function parseAnalysis(text) {
  try {
    const obj = extractJson(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    if (Array.isArray(obj)) return { steps: obj };
    return null;
  } catch {
    return null;
  }
}

// ── orchestrator ────────────────────────────────────────────────────────────

/**
 * Run the vision model over extracted frames + transcript.
 *
 * @param {object} opts
 * @param {Array}  opts.frames      extracted frame objects ({ path, t, transcript, ... })
 * @param {object} [opts.transcript] transcript ({ text, segments })
 * @param {string} [opts.instructions] optional user task description treated as authoritative intent
 * @param {'tasks'|'automation'} [opts.mode] what the frames are being read for
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.visionClient] injectable { name, model, client } for tests
 * @returns {Promise<object>} { model, endpoint, raw, analysis, imagesSent, skipped }
 */
async function analyzeRecording(opts = {}) {
  const frames = Array.isArray(opts.frames) ? opts.frames : [];
  const mode = opts.mode === 'automation' ? 'automation' : 'tasks';
  const vision = opts.visionClient || findVisionClient();
  if (!vision) {
    throw new Error('no vision-capable model configured (set a visionSupport endpoint or mark a model vision:true in endpoints.json)');
  }

  const rawImages = framesToImages(frames);
  const { images, skipped } = await llm.normalizeImages(rawImages);
  if (!images.length) {
    throw new Error(`no usable frames to analyze${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  }

  const promptText = buildAnalysisText(opts.transcript, images, opts.instructions, mode);
  const params = {
    model: vision.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'auto' },
        })),
      ],
    }],
    max_tokens: mode === 'automation' ? 6000 : 4096,
    temperature: 0.2,
    stream: false,
  };

  // DeepSeek models default to chain-of-thought "thinking" at high effort, and
  // those reasoning tokens count against max_tokens. For a structured JSON
  // extraction the CoT is pure overhead and can swallow the whole budget,
  // leaving message.content empty. Disable it so the model emits JSON directly.
  if (/deepseek/i.test(`${vision.model} ${vision.name}`)) {
    params.thinking = { type: 'disabled' };
  }

  const resp = await vision.client.chat.completions.create(params, { signal: opts.signal });

  const raw = String((resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '').trim();

  // A vision model that silently returns no content usually means either the
  // model cannot process image input at all, or a reasoning model spent its
  // whole token budget on internal thinking. Fail loudly instead of letting it
  // bubble up as a confusing "no structured understanding" error downstream.
  if (!raw) {
    const err = new Error(
      `Vision model "${vision.model}" returned an empty response. ` +
      'This usually means the model cannot process image input, or a reasoning model consumed its entire output budget on internal thinking.'
    );
    err.code = 'VISION_EMPTY_RESPONSE';
    throw err;
  }

  const analysis = parseAnalysis(raw);
  if (!analysis) {
    const err = new Error(
      `Vision model "${vision.model}" returned a response that could not be parsed as structured JSON: ${raw.slice(0, 300)}`
    );
    err.code = 'VISION_UNPARSEABLE';
    throw err;
  }

  return {
    model: vision.model,
    endpoint: vision.name,
    raw,
    analysis,
    mode,
    framesRequested: frames.length,
    imagesSent: images.length,
    skipped: skipped.map((s) => ({ name: s.name, reason: s.reason })),
  };
}

module.exports = {
  ANALYSIS_INSTRUCTIONS,
  AUTOMATION_INSTRUCTIONS,
  findVisionClient,
  framesToImages,
  transcriptBlock,
  frameLabels,
  buildAnalysisText,
  extractJson,
  parseAnalysis,
  analyzeRecording,
};
