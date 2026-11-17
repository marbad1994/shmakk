// Show & tell analysis: recording → topics → code investigation → tasks.
//
// One call that turns a whole recording into tasks at once does three things
// badly: separate requests blur together, every task carries screenshots that
// were merely nearby in time, and the model never sees the code, so its
// "files" are guesses. So the analysis runs in two passes:
//
//   1. Topics. One vision pass over low-resolution thumbnails and the
//      transcript does nothing but separate the recording into the distinct
//      things the person wants, each with its time range, its words, and the
//      1-3 screenshots in which it is actually visible.
//   2. Investigation. For each topic, an agent with read-only repository
//      tools (list, find, search, read; see repo-tools.js) gets only that
//      topic's screenshots at full resolution and its part of the narration.
//      It finds and reads the code behind what is on screen, follows data to
//      the backend and database when the request touches data, and then
//      submits tasks: standalone descriptions (as in the show2plan
//      prototype), code-level instructions, acceptance criteria, layer, and
//      the files it actually read. Files it never opened are dropped.

const fs = require('fs');

const MAX_THUMBS = Math.max(4, parseInt(process.env.SHMAKK_SHOW2PLAN_FRAMES || '30', 10));
const MAX_TOPIC_FRAMES = 3;
const MAX_TOOL_ROUNDS = Math.max(4, parseInt(process.env.SHMAKK_SHOW2PLAN_TOOL_ROUNDS || '16', 10));
const TOPIC_CONCURRENCY = 2;

const fmtTime = (sec) => { const s = Math.max(0, Number(sec) || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
function str(v, max = 8000) { return v == null ? '' : String(v).trim().slice(0, max); }

function hasTiming(transcript) {
  const segs = (transcript && transcript.segments) || [];
  if (!segs.length) return false;
  return !(segs.length === 1 && segs[0].start <= 0.01 && transcript.durationSec && segs[0].end >= transcript.durationSec - 0.5);
}

/** Timed transcript in ~8 s buckets, or the plain text when there is no timing. */
function timedTranscript(transcript, { from = -Infinity, to = Infinity } = {}) {
  const all = (transcript && Array.isArray(transcript.segments) ? transcript.segments : []).filter((s) => s && s.text);
  if (!all.length) return (transcript && transcript.text) || '(No speech detected in the recording.)';
  if (!hasTiming(transcript)) return `[timing not available] ${all[0].text}`;
  const segs = all.filter((s) => s.end >= from && s.start <= to);
  if (!segs.length) return '(nothing was said in this part)';
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
function selectFrames(frames, max = MAX_THUMBS) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && f.file).slice().sort((a, b) => a.t - b.t);
  if (list.length <= max) return list;
  const out = [];
  const step = (list.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
  return [...new Map(out.map((f) => [f.file, f])).values()];
}

async function loadImages(frames) {
  const llm = require('../llm');
  const raw = frames.map((f) => {
    try { return { name: f.file, file: f.file, t: f.t, mimeType: /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg', data: fs.readFileSync(f.path).toString('base64') }; } catch { return null; }
  }).filter(Boolean);
  if (!raw.length) return [];
  const norm = await llm.normalizeImages(raw);
  return norm.images.map((img, i) => ({ ...(raw.find((r) => r.name === img.name) || raw[i]), ...img }));
}

function imageBlock(img, detail) {
  return { type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail } };
}

function withThinkingOff(params, model) {
  if (/deepseek/i.test(String(model))) params.thinking = { type: 'disabled' };
  return params;
}

function resolveClient(opts) {
  if (opts.client) return opts.client;
  const llm = require('../llm');
  const vision = require('./vision');
  const v = vision.findVisionClient();
  if (v) return { client: v.client, model: v.model, vision: true };
  if (llm.isConfigured()) return { client: llm.makeClient(), model: llm.modelFor(), vision: false };
  return null;
}

// ── pass 1: topics ──────────────────────────────────────────────────────────

const TOPIC_PROMPT = `You split a narrated screen recording into the distinct things the person wants done.

You get the transcript (timed when available) and numbered low-resolution screenshots taken while they talked. Your ONLY job here is to separate and locate the requests; another step investigates each one in the code.

Rules:
- One topic per distinct request: a bug, a change, a feature, or a question. Two things that would be fixed or built independently are two topics, even if they are on the same screen or said in one sentence.
- The same thing mentioned twice is one topic (use the earliest start and the latest end).
- Navigating, thinking aloud and filler ("let me go to settings", "so, yeah") are not topics.
- summary: what they want, precisely and in their terms, 1-3 sentences, written as the request itself (never "the user says").
- quote: their most telling words for it, verbatim from the transcript.
- start / end: seconds in the recording where they discuss it (approximate if the transcript has no timing, using the screenshots' timestamps).
- frames: 0-3 screenshot numbers in which the thing being discussed is actually visible, best first. Not frames that only show navigation or a different screen. Use fewer rather than more; an empty list is fine.
- kind: "bug" (something is broken), "change" (adjust existing behaviour or looks), "feature" (something new), "question" (they ask something that needs an answer, not work).

Respond with ONLY one JSON object, no markdown fences:
{"title":"short name for the whole session","summary":"one or two sentences","topics":[{"title":"short imperative title","kind":"bug|change|feature|question","summary":"...","quote":"...","start":0,"end":12,"frames":[3]}]}`;

function normalizeTopics(raw, { frameCount = 0, durationSec = 0 } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const topics = (Array.isArray(r.topics) ? r.topics : []).map((t) => {
    if (!t || typeof t !== 'object') return null;
    const title = str(t.title, 160);
    const summary = str(t.summary, 2000);
    if (!title && !summary) return null;
    let start = Number(t.start);
    let end = Number(t.end);
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end < start) end = durationSec || start;
    const frames = [...new Set((Array.isArray(t.frames) ? t.frames : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < frameCount))].slice(0, MAX_TOPIC_FRAMES);
    return {
      title: title || summary.split(/[.\n]/)[0].slice(0, 80),
      kind: ['bug', 'change', 'feature', 'question'].includes(t.kind) ? t.kind : 'change',
      summary: summary || title,
      quote: str(t.quote, 600) || null,
      start, end, frames,
    };
  }).filter(Boolean).sort((a, b) => a.start - b.start);
  return { title: str(r.title, 160), summary: str(r.summary, 1000), topics };
}

async function findTopics({ client, thumbs, images, transcript, instructions, durationSec, signal }) {
  const text = [
    `Recording duration: ~${Math.round(durationSec || 0)}s`,
    instructions ? `Note from the person before recording: ${instructions}` : null,
    '',
    '=== TRANSCRIPT ===',
    timedTranscript(transcript),
    '',
    images.length ? `=== SCREENSHOTS (${images.length}) ===\n${images.map((img, i) => `#${i} @ ${fmtTime(img.t)}`).join('\n')}\nThey follow in this order.` : '(No screenshots: the model cannot read images. Leave frames empty.)',
  ].filter((x) => x !== null).join('\n');
  const content = [{ type: 'text', text }];
  images.forEach((img, i) => { content.push({ type: 'text', text: `#${i} @ ${fmtTime(img.t)}` }); content.push(imageBlock(img, 'low')); });
  const resp = await client.client.chat.completions.create(withThinkingOff({
    model: client.model,
    messages: [{ role: 'system', content: TOPIC_PROMPT }, { role: 'user', content: images.length ? content : text }],
    temperature: 0.1,
    max_tokens: 4000,
    stream: false,
  }, client.model), { signal });
  const raw = str(resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content, 100000);
  if (!raw) throw new Error(`The model "${client.model}" returned nothing while separating the topics.`);
  const { extractJson } = require('./vision');
  let parsed;
  try { parsed = extractJson(raw); } catch { throw new Error(`The topic list was not valid JSON: ${raw.slice(0, 300)}`); }
  const out = normalizeTopics(parsed, { frameCount: images.length || thumbs.length, durationSec });
  // Screenshot numbers → frame files.
  for (const t of out.topics) t.frames = t.frames.map((n) => (images[n] || thumbs[n] || {}).file).filter(Boolean);
  return out;
}

// ── pass 2: investigate one topic in the code ───────────────────────────────

const INVESTIGATE_PROMPT = `You are shmakk's analyst: a senior engineer and technical writer. A person recorded their screen and asked for ONE thing (below). Your output goes straight to a coding agent that implements it task by task, and a reviewer checks its diff against your acceptance criteria.

You have read-only tools for the repository: list_dir, find_files, search, read_file. Investigate BEFORE you write:
1. Find the code behind what is on screen: search for visible labels, headings, component and route names; find the component that renders it and read it.
2. If the request touches data (shown, stored, filtered, validated), follow it: where it is fetched, the API route or handler, and the schema/model/migration that stores it.
3. Read enough to say exactly what has to change and where. Search before reading; read targeted line ranges of large files.

Then call submit_tasks once. Rules for the tasks:
- One task per layer that must change (database, backend, frontend, infra, tests), in dependency order; one task is fine when only one layer changes. Do not pad.
- description: a standalone write-up: where in the product, what happens today, what is wrong or wanted, the desired outcome. Never "see the screenshot".
- visualContext: a text reconstruction of the relevant UI from the screenshots (labels in double quotes, layout, states).
- instructions: concrete code-level steps naming the files, components, functions and fields you read, and what to change in each. Say what you verified in the code.
- acceptance: 1-5 concrete, checkable criteria.
- files: ONLY files you opened or saw in search results, each with why it changes.
- dependsOn: keys of tasks in this list that must be done first.
- questions: anything the code could not answer that the person must decide.
- If the code shows it already works as asked, still submit one task explaining what you found, with acceptance criteria that verify it.`;

const SUBMIT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_tasks',
    description: 'Submit the finished tasks for this request. Call exactly once, after investigating the code.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              title: { type: 'string' },
              layer: { type: 'string', enum: ['database', 'backend', 'frontend', 'infra', 'tests'] },
              kind: { type: 'string', enum: ['bug', 'change', 'feature', 'chore'] },
              priority: { type: 'string', enum: ['high', 'normal', 'low'] },
              description: { type: 'string' },
              visualContext: { type: 'string' },
              instructions: { type: 'string' },
              acceptance: { type: 'array', items: { type: 'string' } },
              files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, why: { type: 'string' } }, required: ['path'] } },
              dependsOn: { type: 'array', items: { type: 'string' } },
              questions: { type: 'array', items: { type: 'string' } },
            },
            required: ['key', 'title', 'layer', 'description', 'instructions', 'acceptance'],
          },
        },
      },
      required: ['tasks'],
    },
  },
};

function repoOverview(root) {
  const intake = require('./intake');
  const stack = intake.detectStack(root);
  const lines = [];
  const add = (label, arr) => { if (arr && arr.length) lines.push(`${label}: ${arr.join(', ')}`); };
  add('Frontend', stack.frontend);
  add('Backend', stack.backend);
  add('Database', stack.database);
  add('Languages', stack.languages);
  if (stack.packages.length > 1) lines.push(`Packages: ${stack.packages.map((p) => p.dir).join(', ')}`);
  add('Database code', stack.dbFiles);
  add('API code', stack.apiDirs);
  lines.push('', 'Tree:', intake.outline(root, { maxDepth: 3, maxLines: 90 }));
  return lines.join('\n');
}

/** Shape submitted tasks for Plans; keep only files the agent actually saw. */
function normalizeSubmitted(raw, topic, { seen = new Set(), prefix = 'a' } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.tasks) ? raw.tasks : [];
  const keyMap = new Map();
  const tasks = [];
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const title = str(t.title, 160);
    const description = str(t.description, 6000);
    const how = str(t.instructions, 8000);
    if (!title && !description && !how) return;
    const key = `${prefix}${i + 1}`;
    keyMap.set(str(t.key, 40) || key, key);
    const visual = str(t.visualContext, 3000);
    const files = (Array.isArray(t.files) ? t.files : [])
      .map((f) => (typeof f === 'string' ? { path: f } : f))
      .filter((f) => f && f.path)
      .map((f) => ({ path: str(f.path, 300).replace(/^\.?\//, ''), why: str(f.why, 200) || null }))
      .filter((f) => seen.has(f.path))
      .slice(0, 8);
    tasks.push({
      key,
      title: title || description.split(/[.\n]/)[0].slice(0, 80),
      kind: ['bug', 'change', 'feature', 'chore'].includes(t.kind) ? t.kind : (topic.kind === 'question' ? 'chore' : topic.kind || 'change'),
      layer: ['database', 'backend', 'frontend', 'infra', 'tests'].includes(t.layer) ? t.layer : 'unknown',
      priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
      description,
      visualContext: visual,
      instructions: [
        description,
        how ? `**What to change**\n\n${how}` : null,
        visual ? `**On screen:** ${visual}` : null,
        topic.quote ? `**In their words:** "${topic.quote}"` : null,
      ].filter(Boolean).join('\n\n'),
      acceptance: (Array.isArray(t.acceptance) ? t.acceptance : []).map((a) => str(a, 400)).filter(Boolean).slice(0, 8),
      files,
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => str(d, 40)),
      questions: (Array.isArray(t.questions) ? t.questions : []).map((q) => str(q, 400)).filter(Boolean).slice(0, 5),
      evidence: { frames: topic.frames.slice(0, MAX_TOPIC_FRAMES), quote: topic.quote },
    });
  });
  for (const t of tasks) t.dependsOn = [...new Set(t.dependsOn.map((d) => keyMap.get(d)).filter((d) => d && d !== t.key))];
  return tasks;
}

/** A task straight from the topic, when the investigation could not run. */
function topicAsTask(topic, prefix) {
  const intake = require('./intake');
  return [{
    key: `${prefix}1`,
    title: topic.title,
    kind: topic.kind === 'question' ? 'chore' : topic.kind,
    layer: intake.guessLayer(`${topic.title} ${topic.summary}`, true),
    priority: 'normal',
    description: topic.summary,
    visualContext: '',
    instructions: [topic.summary, topic.quote ? `**In their words:** "${topic.quote}"` : null].filter(Boolean).join('\n\n'),
    acceptance: [],
    files: [],
    dependsOn: [],
    questions: [],
    evidence: { frames: topic.frames, quote: topic.quote },
  }];
}

async function investigateTopic({ topic, index, total, frames, transcript, root, overview, client, signal, onStep = () => {}, maxRounds = MAX_TOOL_ROUNDS }) {
  const { createRepoTools } = require('./repo-tools');
  const repo = createRepoTools(root);
  const images = client.vision ? await loadImages(frames) : [];
  const timed = hasTiming(transcript);
  const excerpt = timed ? timedTranscript(transcript, { from: topic.start - 4, to: topic.end + 4 }) : timedTranscript(transcript);
  const text = [
    `REQUEST ${index + 1} of ${total} from this recording (the others are handled separately; ignore them):`,
    `Title: ${topic.title}`,
    `Kind: ${topic.kind}`,
    `What they want: ${topic.summary}`,
    topic.quote ? `Their words: "${topic.quote}"` : null,
    `When: ${fmtTime(topic.start)}-${fmtTime(topic.end)}`,
    '',
    timed ? 'NARRATION AROUND IT' : 'FULL NARRATION (no timing; use only the part about this request)',
    excerpt,
    '',
    images.length ? `SCREENSHOTS: ${images.length}, taken while they talked about it, attached below.` : 'No screenshots for this request.',
    '',
    'REPOSITORY',
    overview,
  ].filter((x) => x !== null).join('\n');
  const content = [{ type: 'text', text }];
  for (const img of images) { content.push({ type: 'text', text: `Screenshot @ ${fmtTime(img.t)}` }); content.push(imageBlock(img, 'high')); }

  const messages = [{ role: 'system', content: INVESTIGATE_PROMPT }, { role: 'user', content: images.length ? content : text }];
  const tools = [...repo.defs, SUBMIT_TOOL];
  const { extractJson } = require('./vision');
  let calls = 0;
  for (let round = 0; round < maxRounds + 2; round++) {
    const last = round >= maxRounds;
    const resp = await client.client.chat.completions.create(withThinkingOff({
      model: client.model,
      messages,
      tools: last ? [SUBMIT_TOOL] : tools,
      tool_choice: last ? { type: 'function', function: { name: 'submit_tasks' } } : 'auto',
      temperature: 0.1,
      max_tokens: 6000,
      stream: false,
    }, client.model), { signal });
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw new Error('empty response');
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      // Some models answer in text; accept JSON tasks, otherwise ask again.
      try {
        const parsed = extractJson(msg.content || '');
        const tasks = normalizeSubmitted(parsed, topic, { seen: repo.seen, prefix: `${String.fromCharCode(97 + (index % 26))}` });
        if (tasks.length) return { tasks, filesRead: [...repo.read], toolCalls: calls };
      } catch { /* not JSON */ }
      messages.push({ role: 'assistant', content: msg.content || '' });
      messages.push({ role: 'user', content: 'Continue investigating with the tools, or call submit_tasks if you are done.' });
      continue;
    }
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function && tc.function.name;
      let args = {};
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { args = {}; }
      if (name === 'submit_tasks') {
        const tasks = normalizeSubmitted(args, topic, { seen: repo.seen, prefix: `${String.fromCharCode(97 + (index % 26))}` });
        if (tasks.length) return { tasks, filesRead: [...repo.read], toolCalls: calls };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: 'error: no valid tasks; each needs a title, description and instructions' });
        continue;
      }
      calls += 1;
      onStep({ tool: name, args });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: repo.call(name, args).slice(0, 24000) });
    }
  }
  throw new Error('the investigation did not submit tasks');
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * opts: { frames: [{file, path, t}], transcript, instructions, durationSec,
 *         root, client?, signal, onProgress?({ step, done, total, topic, note }) }
 */
async function analyzeShowAndTell(opts = {}) {
  const c = resolveClient(opts);
  if (!c) throw new Error('No AI provider is configured. Add one in Settings.');
  const progress = opts.onProgress || (() => {});
  const warnings = [];

  progress({ step: 'topics' });
  const thumbs = selectFrames(opts.frames || []);
  const images = c.vision ? await loadImages(thumbs) : [];
  const found = await findTopics({ client: c, thumbs, images, transcript: opts.transcript, instructions: opts.instructions, durationSec: opts.durationSec, signal: opts.signal });
  const all = found.topics;
  // Without vision the model cannot pick screenshots; use the topic's time range.
  if (!images.length && hasTiming(opts.transcript)) {
    for (const t of all) t.frames = thumbs.filter((f) => f.t >= t.start && f.t <= t.end + 1).slice(0, 2).map((f) => f.file);
  }
  const questions = all.filter((t) => t.kind === 'question').map((t) => (t.summary && t.summary !== t.title ? `${t.title}: ${t.summary}` : t.title));
  const work = all.filter((t) => t.kind !== 'question');

  const frameByFile = new Map((opts.frames || []).map((f) => [f.file, f]));
  const overview = repoOverview(opts.root);
  const results = new Array(work.length);
  let done = 0;
  let cursor = 0;
  const runOne = async (i) => {
    const topic = work[i];
    const prefix = String.fromCharCode(97 + (i % 26));
    progress({ step: 'investigating', done, total: work.length, topic: topic.title });
    try {
      const r = await investigateTopic({
        topic, index: i, total: work.length,
        frames: topic.frames.map((f) => frameByFile.get(f)).filter(Boolean),
        transcript: opts.transcript, root: opts.root, overview, client: c, signal: opts.signal,
        onStep: ({ tool, args }) => progress({ step: 'investigating', done, total: work.length, topic: topic.title, note: `${tool} ${args.path || args.query || args.pattern || ''}`.trim() }),
      });
      results[i] = { ...topic, tasks: r.tasks, filesRead: r.filesRead, toolCalls: r.toolCalls };
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      warnings.push(`"${topic.title}" could not be investigated in the code (${e.message}); it is a single task without files. Review it before starting.`);
      results[i] = { ...topic, tasks: topicAsTask(topic, prefix), filesRead: [], toolCalls: 0 };
    }
    done += 1;
    progress({ step: 'investigating', done, total: work.length, topic: topic.title });
  };
  await Promise.all(Array.from({ length: Math.min(TOPIC_CONCURRENCY, work.length) }, async () => {
    while (cursor < work.length) { const i = cursor++; await runOne(i); }
  }));

  return {
    title: found.title || (work[0] && work[0].title) || 'Show & tell',
    summary: found.summary,
    topics: results,
    questions,
    warnings,
    model: c.model,
    sawImages: images.length,
  };
}

module.exports = {
  TOPIC_PROMPT,
  INVESTIGATE_PROMPT,
  SUBMIT_TOOL,
  hasTiming,
  timedTranscript,
  selectFrames,
  normalizeTopics,
  normalizeSubmitted,
  topicAsTask,
  repoOverview,
  findTopics,
  investigateTopic,
  analyzeShowAndTell,
};
