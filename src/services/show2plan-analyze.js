// Show & tell analysis: one vision call from recording to finished tasks.
//
// Ported from the standalone show2plan prototype (src/lib/analyze.ts), which
// produced far better tasks than a findings → second-model pipeline: the model
// that looks at the screenshots is the one that writes the tasks, so nothing
// it saw is lost in a hand-off. Every task must stand alone in text: a
// description of where, what happens, what is wrong and what should happen,
// plus a text reconstruction of the UI (visualContext). Screenshots are only
// supporting evidence.
//
// shmakk additions: the model also says which layer the change lives in
// (frontend / backend / database ...), since the tasks go straight to a coding
// agent, and question-type tasks become open questions rather than work.

const MAX_MODEL_FRAMES = Math.max(4, parseInt(process.env.SHMAKK_SHOW2PLAN_FRAMES || '20', 10));

const SYSTEM_PROMPT = `You are an expert product manager and technical writer.

You receive:
1. A transcript of a user narrating over a screen recording (with approximate timing).
2. Numbered screenshot frames from that recording (each with a timestamp).

Your job is to turn the walkthrough into clear, implementable tasks. The tasks go straight to a coding agent working in the product's codebase, one task at a time.

## Critical: text must stand alone

Screenshots are OPTIONAL supporting evidence only. Every task must be fully understandable and implementable from text alone, as if the reader never sees the images or the video.

Use vision carefully: look at the frames, then TRANSLATE what you see into precise prose.

For each task you MUST write:
1. **description**: a complete standalone write-up (usually 1-3 short paragraphs) covering:
   - Where in the product this is (page, dialog, flow step, component)
   - What currently happens or looks like
   - What is wrong, missing, or requested (from the narrator + what you see)
   - The desired outcome / proposed change
2. **visualContext**: a pure text reconstruction of the relevant UI from the frames: page/title if visible, main regions, button/link labels, form fields, error messages, empty states, highlighted elements, data on screen, etc. Someone who cannot open the screenshot should still picture the UI. Quote visible labels exactly, in double quotes.

Never write descriptions like "see screenshot" or "as shown in the image". Never rely on the reader noticing something only visible in a frame.

## Other rules
- Prefer several focused tasks over one giant task.
- Detect whether the user is walking a sequential user flow or listing independent issues.
- For user flows, set group="userflow", give a shared flowName, and order steps with step=1,2,3...
- For standalone bugs/requests, set group="independent".
- Write titles in imperative mood ("Fix checkout validation", "Add empty-state illustration").
- Acceptance criteria must be concrete and testable without screenshots.
- Pick 0-3 frameIndices as optional illustration. Prefer frames near when the issue is mentioned.
- If the user only shows one issue, still produce a complete task.
- Do not invent product requirements that are not supported by the transcript or screenshots.
- If something is unclear, create a "question" type task asking for clarification.
- Keep priorities realistic: reserve "critical" for blockers.
- layer: where the change most likely lives: "frontend" (UI, styling, client logic), "backend" (API, server logic, auth, validation on the server), "database" (schema, migrations, stored data), "infra" (build, deploy, config) or "tests". If one request needs several layers (e.g. a new field that must be stored, served and shown), split it into one task per layer.

Respond with ONLY one JSON object, no markdown fences:
{
  "title": "short name for this planning session",
  "summary": "2-4 sentence overview of what the user demonstrated",
  "tasks": [
    {
      "title": "imperative title",
      "description": "standalone write-up",
      "visualContext": "text reconstruction of the relevant UI",
      "acceptanceCriteria": ["..."],
      "priority": "critical | high | medium | low",
      "type": "bug | feature | ux | chore | question",
      "layer": "frontend | backend | database | infra | tests",
      "group": "userflow | independent",
      "flowName": "only for userflow",
      "step": 1,
      "timestampSeconds": 12.5,
      "quote": "short direct quote from the speaker, or empty",
      "frameIndices": [0]
    }
  ]
}`;

const fmtTime = (sec) => { const s = Math.max(0, Number(sec) || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

/** Timed transcript in ~8 s buckets, or the plain text when there is no timing. */
function timedTranscript(transcript) {
  const segs = (transcript && Array.isArray(transcript.segments) ? transcript.segments : []).filter((s) => s && s.text);
  if (!segs.length) return (transcript && transcript.text) || '(No speech detected in the recording.)';
  // One segment spanning everything (hosted ASR without timing): say so.
  if (segs.length === 1 && segs[0].start <= 0.01 && transcript.durationSec && segs[0].end >= transcript.durationSec - 0.5) {
    return `[timing not available] ${segs[0].text}`;
  }
  const out = [];
  let bucket = [];
  let start = segs[0].start;
  for (const s of segs) {
    if (bucket.length && s.start - start >= 8) {
      out.push(`[${fmtTime(start)}-${fmtTime(bucket[bucket.length - 1].end)}] ${bucket.map((b) => b.text).join(' ')}`);
      bucket = [];
      start = s.start;
    }
    bucket.push(s);
  }
  if (bucket.length) out.push(`[${fmtTime(start)}-${fmtTime(bucket[bucket.length - 1].end)}] ${bucket.map((b) => b.text).join(' ')}`);
  return out.join('\n');
}

/** Evenly sample frames over time; always keeps the first and last. */
function selectFrames(frames, max = MAX_MODEL_FRAMES) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && f.file).slice().sort((a, b) => a.t - b.t);
  if (list.length <= max) return list;
  const out = [];
  const step = (list.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
  return [...new Map(out.map((f) => [f.file, f])).values()];
}

function buildUserContent(transcript, frames, images, { instructions = '', durationSec = 0 } = {}) {
  const text = [
    'Turn this screen-recording walkthrough into well-written tasks.',
    '',
    images.length
      ? 'IMPORTANT: Study the screenshots with vision, then write tasks whose description and visualContext are fully self-contained in text. A developer who never opens an image must still understand exactly what to change.'
      : 'No screenshots could be attached (the configured model cannot read images). Work from the narration; leave visualContext empty unless the narration describes the screen.',
    '',
    `Recording duration: ~${Math.round(durationSec || (frames.length ? frames[frames.length - 1].t : 0))}s`,
    instructions ? `\nNote from the person before recording: ${instructions}` : '',
    '',
    '=== TRANSCRIPT (timed) ===',
    timedTranscript(transcript),
  ];
  if (images.length) {
    text.push('', `=== FRAMES (${images.length}) ===`, ...images.map((img, i) => `FRAME ${i} @ ${fmtTime(img.t)} (${Number(img.t).toFixed(1)}s)`), '', 'Screenshots follow in the same order as FRAME indices above. Describe their relevant UI in visualContext; do not tell the reader to look at them.');
  }
  const content = [{ type: 'text', text: text.join('\n') }];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `FRAME ${i} @ ${fmtTime(img.t)}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'high' } });
  });
  return content;
}

const PRIORITY = { critical: 'high', high: 'high', medium: 'normal', normal: 'normal', low: 'low' };
const KIND = { bug: 'bug', feature: 'feature', ux: 'change', chore: 'chore', change: 'change' };
const LAYERS = ['frontend', 'backend', 'database', 'infra', 'tests'];

function str(v, max = 8000) { return v == null ? '' : String(v).trim().slice(0, max); }

/**
 * Validate the model's answer and shape it for shmakk:
 *   tasks (for Plans) and questions (type "question", kept out of the plan).
 * frameFiles maps the model's 0-based FRAME index to an uploaded frame file.
 */
function normalizeAnalysis(raw, { frameFiles = [], frameTimes = [] } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(r.tasks) ? r.tasks : [];
  const questions = [];
  const tasks = [];
  const nearest = (t) => {
    if (!frameFiles.length || !Number.isFinite(Number(t))) return null;
    let best = 0;
    frameTimes.forEach((ft, i) => { if (Math.abs(ft - t) < Math.abs(frameTimes[best] - t)) best = i; });
    return frameFiles[best];
  };
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const title = str(t.title, 160);
    const description = str(t.description, 8000);
    if (!title && !description) return;
    if (String(t.type).toLowerCase() === 'question') { questions.push([title, description].filter(Boolean).join(': ')); return; }
    const visual = str(t.visualContext, 4000);
    const group = t.group === 'userflow' ? 'userflow' : 'independent';
    const flow = group === 'userflow' && t.flowName ? `${str(t.flowName, 120)}${Number.isFinite(Number(t.step)) ? `, step ${Number(t.step)}` : ''}` : null;
    const quote = str(t.quote, 600) || null;
    let frames = (Array.isArray(t.frameIndices) ? t.frameIndices : []).map((n) => frameFiles[Number(n)]).filter(Boolean);
    if (!frames.length) { const n = nearest(t.timestampSeconds); if (n) frames = [n]; }
    const instructions = [
      flow ? `_Part of the user flow "${flow}"._` : null,
      description,
      visual ? `**On screen:** ${visual}` : null,
      quote ? `**In their words:** "${quote}"` : null,
    ].filter(Boolean).join('\n\n');
    tasks.push({
      key: `t${i + 1}`,
      title: title || description.split(/[.\n]/)[0].slice(0, 80),
      kind: KIND[String(t.type).toLowerCase()] || 'change',
      layer: LAYERS.includes(t.layer) ? t.layer : null,
      priority: PRIORITY[String(t.priority).toLowerCase()] || 'normal',
      instructions,
      description,
      visualContext: visual,
      acceptance: (Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : Array.isArray(t.acceptance) ? t.acceptance : []).map((a) => str(a, 400)).filter(Boolean).slice(0, 10),
      files: [],
      dependsOn: [],
      questions: [],
      group,
      flowName: group === 'userflow' ? str(t.flowName, 120) || null : null,
      step: Number.isFinite(Number(t.step)) ? Number(t.step) : null,
      timestampSeconds: Number.isFinite(Number(t.timestampSeconds)) ? Number(t.timestampSeconds) : null,
      evidence: { frames: [...new Set(frames)].slice(0, 3), quote },
    });
  });
  // Flows stay together and in step order; independent issues keep the
  // model's order (which follows the recording).
  const firstSeen = new Map();
  const order = new Map();
  tasks.forEach((t, i) => {
    const k = t.flowName || `#${i}`;
    if (!firstSeen.has(k)) firstSeen.set(k, i);
    order.set(t, [firstSeen.get(k), t.flowName ? (t.step ?? i) : 0, i]);
  });
  tasks.sort((a, b) => {
    const x = order.get(a);
    const y = order.get(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return { title: str(r.title, 160), summary: str(r.summary, 2000), tasks, questions };
}

/** Exact UI labels the model quoted, for finding the code that renders them. */
function quotedLabels(task) {
  const text = `${task.visualContext || ''}\n${task.description || ''}`;
  const out = new Set();
  for (const m of text.matchAll(/["“]([^"”\n]{3,60})["”]/g)) {
    const s = m[1].trim();
    if (s.split(/\s+/).length <= 8) out.add(s);
  }
  return [...out].slice(0, 6);
}

/**
 * Point each task at the code: exact-text search for the labels it quotes,
 * plus a keyword layer guess when the model gave none. Never rewrites text.
 */
function groundTasks(root, tasks) {
  const intake = require('./intake');
  for (const t of tasks) {
    if (!t.layer) t.layer = intake.guessLayer(`${t.title} ${t.description}`, true);
    const seen = new Set();
    const isDoc = (f) => /\.(md|mdx|txt)$|(^|\/)(docs?|skills|research)\//i.test(f);
    for (const label of quotedLabels(t)) {
      for (const h of intake.grep(root, label, { maxHits: 4 })) {
        if (isDoc(h.file) || seen.has(h.file)) continue;
        seen.add(h.file);
        t.files.push({ path: h.file, why: `renders "${label}" (line ${h.line})` });
      }
      if (t.files.length >= 4) break;
    }
  }
  return tasks;
}

/**
 * Run the analysis.
 * opts: { frames: [{file, path, t}], transcript, instructions, durationSec,
 *         client?: {client, model, vision:boolean}, signal }
 */
async function analyzeShowAndTell(opts = {}) {
  const fs = require('fs');
  const llm = require('../llm');
  let c = opts.client || null;
  if (!c) {
    const vision = require('./vision');
    const v = vision.findVisionClient();
    if (v) c = { client: v.client, model: v.model, vision: true };
    else if (llm.isConfigured()) c = { client: llm.makeClient(), model: llm.modelFor(), vision: false };
  }
  if (!c) throw new Error('No AI provider is configured. Add one in Settings.');

  const selected = selectFrames(opts.frames || []);
  let images = [];
  if (c.vision && selected.length) {
    const raw = selected.map((f) => {
      try {
        const data = fs.readFileSync(f.path).toString('base64');
        return { name: f.file, file: f.file, t: f.t, mimeType: /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg', data };
      } catch { return null; }
    }).filter(Boolean);
    const norm = await llm.normalizeImages(raw);
    images = norm.images.map((img, i) => ({ ...raw.find((r) => r.name === img.name) || raw[i], ...img }));
  }

  const params = {
    model: c.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(opts.transcript, selected, images, { instructions: opts.instructions, durationSec: opts.durationSec }) },
    ],
    temperature: 0.2,
    max_tokens: 8000,
    stream: false,
  };
  if (/deepseek/i.test(String(c.model))) params.thinking = { type: 'disabled' };

  const resp = await c.client.chat.completions.create(params, { signal: opts.signal });
  const raw = String((resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '').trim();
  if (!raw) throw new Error(`The model "${c.model}" returned nothing. If it is a reasoning model, it may have spent its whole budget thinking.`);
  const { extractJson } = require('./vision');
  let parsed;
  try { parsed = extractJson(raw); } catch { throw new Error(`The model's answer was not valid JSON: ${raw.slice(0, 300)}`); }

  const frameFiles = images.length ? images.map((i) => i.file) : [];
  const frameTimes = images.length ? images.map((i) => i.t) : [];
  const out = normalizeAnalysis(parsed, { frameFiles, frameTimes });
  return { ...out, model: c.model, sawImages: images.length, framesSent: images.map((i) => ({ file: i.file, t: i.t })) };
}

module.exports = { SYSTEM_PROMPT, timedTranscript, selectFrames, normalizeAnalysis, quotedLabels, groundTasks, analyzeShowAndTell, MAX_MODEL_FRAMES };
