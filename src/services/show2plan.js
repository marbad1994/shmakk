// Show & tell sessions recorded in the browser.
//
// The person records their screen and talks: a bug, a change, a task. The
// browser does the capture (getDisplayMedia + microphone) so it works the same
// on a laptop and against a shmakk running in Docker, where the server has no
// screen at all. While recording, the browser samples frames whenever the
// picture changes (and at least every few seconds), and uploads them with the
// microphone audio when the recording stops.
//
// Processing turns that into shmakk tasks:
//   1. transcript  — xAI or DeepSeek speech-to-text when configured, else
//                    local Whisper, else the browser's live transcript;
//   2. tasks       — one vision call over ~20 frames spread across the whole
//                    recording plus the timed transcript writes standalone
//                    tasks directly (show2plan-analyze.js);
//   3. grounding   — labels the tasks quote are searched in the workspace to
//                    point at the files that render them.
// The result is reviewed in the UI and sent to Plans as a review-gated plan.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FRAMES = 360;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_BUDGET = Math.max(3, parseInt(process.env.SHMAKK_SHOW2PLAN_BUDGET || '10', 10));
const SESSION_TTL_MS = 24 * 3600e3;

function baseDir() {
  return path.resolve(process.env.SHMAKK_SHOW2PLAN_DIR || path.join(os.tmpdir(), 'shmakk-show2plan'));
}
const validId = (id) => /^s2p_[a-z0-9]{6,40}$/.test(String(id || ''));
const validFrame = (f) => /^frame_\d{4}\.(jpg|png|webp)$/.test(String(f || ''));

// ── frame selection (pure) ──────────────────────────────────────────────────

/**
 * Choose the frames worth sending to the vision model.
 *
 * candidates: [{ file, t, mark, score }] as sampled by the browser (score is
 * the visual change against the previous kept frame, 0..1).
 * Priority: marked moments, then frames nearest to speech-cue timestamps,
 * then the largest visual changes, spread across the recording.
 */
function pickFrames(candidates, segments, { durationSec = 0, budget = DEFAULT_BUDGET } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.file && Number.isFinite(Number(c.t))).map((c) => ({ ...c, t: Number(c.t) })).sort((a, b) => a.t - b.t);
  if (!list.length) return [];
  const chosen = new Map();
  // Marked moments always count; anything else must be 1.5 s from a pick.
  const take = (c, reason) => {
    if (!c || chosen.has(c.file) || chosen.size >= budget) return;
    if (reason !== 'marked' && [...chosen.values()].some((x) => Math.abs(x.t - c.t) < 1.5)) return;
    chosen.set(c.file, { ...c, reason });
  };
  const nearest = (t, within = 3) => {
    let best = null;
    for (const c of list) {
      // Prefer the frame just after the cue: the screen reflects what was said.
      const d = c.t >= t ? c.t - t : (t - c.t) * 1.6;
      if (d <= within && (!best || d < best.d)) best = { c, d };
    }
    return best ? best.c : null;
  };

  for (const c of list.filter((x) => x.mark)) take(c, 'marked');

  const { selectTimestamps } = require('./frames');
  const dur = durationSec || list[list.length - 1].t;
  const cues = selectTimestamps(segments || [], { durationSec: dur, budget: budget * 2, minGapSec: 1.5 });
  for (const cue of cues.filter((c) => c.reason === 'cue')) take(nearest(cue.t), 'speech cue');
  for (const cue of cues.filter((c) => c.reason !== 'cue')) take(nearest(cue.t), 'speech');

  // Fill with the biggest visual changes, at least ~4 s apart.
  const byChange = [...list].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  for (const c of byChange) {
    if (chosen.size >= budget) break;
    if ([...chosen.values()].some((x) => Math.abs(x.t - c.t) < 4)) continue;
    take(c, 'visual change');
  }
  // Always include the opening frame for context when there is room.
  take(list[0], 'start');

  return [...chosen.values()].sort((a, b) => a.t - b.t);
}

/** Segments from the browser's live transcript, coerced and clamped. */
function coerceLiveTranscript(live, durationSec) {
  const segs = (live && Array.isArray(live.segments) ? live.segments : []).map((s) => ({
    start: Math.max(0, Number(s.start) || 0),
    end: Math.max(0, Number(s.end != null ? s.end : s.start) || 0),
    text: String(s.text || '').trim(),
  })).filter((s) => s.text);
  for (const s of segs) { if (durationSec) { s.start = Math.min(s.start, durationSec); s.end = Math.min(Math.max(s.end, s.start), durationSec); } }
  const text = segs.map((s) => s.text).join(' ').trim() || String((live && live.text) || '').trim();
  return { text, segments: segs, durationSec: durationSec || (segs.length ? segs[segs.length - 1].end : 0), source: 'browser' };
}

// What Whisper "hears" in silence, tones and room noise.
const HALLUCINATION = /^[\s.,!?]*(thank you( (so much|for watching))?|thanks( for watching)?|you|bye|okay|so|\[?(music|silence|blank_audio|applause)\]?|\.{2,}|subtitles by .*)[\s.,!?]*$/i;

const wordCount = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * Pick the transcript that actually carries the narration. Whisper is more
 * accurate and better timed, but on silence or noise it invents phrases;
 * those are dropped, and the browser's live transcript wins when Whisper is
 * left with clearly less speech.
 */
function chooseTranscript(whisper, live) {
  const clean = whisper && Array.isArray(whisper.segments)
    ? { ...whisper, segments: whisper.segments.filter((x) => x && x.text && !HALLUCINATION.test(x.text)) }
    : null;
  if (clean) clean.text = clean.segments.map((x) => x.text).join(' ').trim();
  const w = clean ? wordCount(clean.text) : 0;
  const l = live ? wordCount(live.text) : 0;
  if (!clean || !w) return { transcript: live, dropped: !!(whisper && whisper.text) };
  if (l >= 4 && w < l * 0.5) return { transcript: live, dropped: true };
  return { transcript: clean, dropped: false };
}

/** Requests for intake from vision findings (or, without vision, from speech). */
function requestsFromFindings(findings, frameFiles) {
  return (Array.isArray(findings) ? findings : []).map((f, i) => ({
    id: `f${i + 1}`,
    text: f.note || f.quote || '',
    quote: f.quote || null,
    kind: f.kind || null,
    frames: (f.frames || []).map((n) => frameFiles[n - 1]).filter(Boolean),
    where: { page: f.page || null, element: f.element || null },
  })).filter((r) => r.text);
}

/** Without a vision model: one request per spoken sentence group. */
function requestsFromTranscript(transcript, selected, instructions) {
  const segs = (transcript && transcript.segments) || [];
  const reqs = [];
  let cur = null;
  for (const s of segs) {
    // A pause of more than 2.5 s starts a new point.
    if (!cur || s.start - cur.end > 2.5) { cur = { start: s.start, end: s.end, text: s.text }; reqs.push(cur); } else { cur.text += ` ${s.text}`; cur.end = s.end; }
  }
  const out = reqs.filter((r) => r.text.trim().split(/\s+/).length >= 4).map((r, i) => {
    const near = selected.filter((f) => f.t >= r.start - 1 && f.t <= r.end + 2).map((f) => f.file).slice(0, 3);
    return { id: `s${i + 1}`, text: r.text.trim(), quote: r.text.trim(), frames: near, where: {} };
  });
  if (!out.length && instructions) out.push({ id: 's1', text: instructions, quote: null, frames: selected.slice(0, 3).map((f) => f.file), where: {} });
  return out;
}

// ── sessions ────────────────────────────────────────────────────────────────

function createShow2PlanManager({ getWorkspace, broadcast = () => {}, getModel = () => null } = {}) {
  const sessions = new Map();

  // Old recordings are throwaway: clear anything older than a day.
  try {
    for (const name of fs.readdirSync(baseDir())) {
      const d = path.join(baseDir(), name);
      const st = fs.statSync(d);
      if (Date.now() - st.mtimeMs > SESSION_TTL_MS) fs.rmSync(d, { recursive: true, force: true });
    }
  } catch {}

  const notFound = () => Object.assign(new Error('recording not found'), { status: 404 });
  const dirOf = (id) => path.join(baseDir(), id);
  const get = (id) => {
    if (!validId(id)) throw notFound();
    const s = sessions.get(id);
    if (!s) throw notFound();
    return s;
  };
  const publicView = (s) => ({
    id: s.id, createdAt: s.createdAt, stage: s.stage, progress: s.progress, error: s.error,
    warnings: s.warnings, frames: s.frames.length, hasAudio: s.hasAudio, result: s.result,
  });
  const emit = (s) => broadcast({ t: 'show2plan', id: s.id, stage: s.stage });

  function create() {
    const id = `s2p_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(path.join(dirOf(id), 'frames'), { recursive: true });
    const s = { id, createdAt: Date.now(), stage: 'recording', progress: null, error: null, warnings: [], frames: [], hasAudio: false, result: null, ctrl: null };
    sessions.set(id, s);
    return publicView(s);
  }

  function addFrame(id, buf, { t, mark, score, type } = {}) {
    const s = get(id);
    if (s.stage !== 'recording') throw Object.assign(new Error('the recording is already being processed'), { status: 409 });
    if (!buf || buf.length < 200) throw Object.assign(new Error('empty frame'), { status: 400 });
    if (buf.length > MAX_FRAME_BYTES) throw Object.assign(new Error('frame too large'), { status: 413 });
    if (s.frames.length >= MAX_FRAMES) return { ok: false, dropped: true };
    const ext = /png/.test(type || '') ? 'png' : /webp/.test(type || '') ? 'webp' : 'jpg';
    const file = `frame_${String(s.frames.length).padStart(4, '0')}.${ext}`;
    fs.writeFileSync(path.join(dirOf(id), 'frames', file), buf);
    s.frames.push({ file, t: Math.max(0, Number(t) || 0), mark: !!mark, score: Math.max(0, Math.min(1, Number(score) || 0)) });
    return { ok: true, file };
  }

  function setAudio(id, buf) {
    const s = get(id);
    if (!buf || buf.length < 1000) return { ok: false };
    fs.writeFileSync(path.join(dirOf(id), 'audio.wav'), buf);
    s.hasAudio = true;
    return { ok: true, bytes: buf.length };
  }

  function framePath(id, file) {
    if (!validId(id) || !validFrame(file)) return null;
    const abs = path.join(dirOf(id), 'frames', file);
    return fs.existsSync(abs) ? abs : null;
  }

  async function transcribe(s, opts) {
    const wav = path.join(dirOf(s.id), 'audio.wav');
    const live = coerceLiveTranscript(opts.liveTranscript, opts.durationSec);
    // Server transcription: DeepSeek's hosted ASR when configured, else local Whisper.
    let canStt = false;
    try { require.resolve('@huggingface/transformers'); canStt = true; } catch {}
    try { const stt = require('./stt'); if (!canStt && (stt._xaiSttConfig() || stt._deepseekAsrConfig())) canStt = true; } catch {}
    if (s.hasAudio && canStt) {
      try {
        const { transcribeTimestamped } = require('./stt');
        const r = await transcribeTimestamped(wav, { language: opts.language });
        const pick = chooseTranscript({ ...r, source: r.engine === 'deepseek-asr' ? 'deepseek' : r.engine === 'xai-stt' ? 'xai' : 'whisper' }, live);
        if (pick.dropped && pick.transcript === live && live.text) s.warnings.push('Server transcription heard little or no speech, so the live browser transcript was used.');
        if (pick.transcript && pick.transcript.text) return pick.transcript;
      } catch (e) {
        s.warnings.push(`Server speech-to-text failed (${e.message}); using the browser transcript.`);
      }
    } else if (s.hasAudio && !live.text) {
      s.warnings.push('Server speech-to-text is not installed (npm run setup:voice) and the browser gave no live transcript, so the narration could not be transcribed.');
    }
    return live;
  }

  async function runPipeline(s, opts) {
    const stage = (name, progress = null) => { s.stage = name; s.progress = progress; emit(s); };
    const instructions = String(opts.instructions || '').trim().slice(0, 4000);

    stage('transcribing');
    const transcript = await transcribe(s, opts);
    fs.writeFileSync(path.join(dirOf(s.id), 'transcript.json'), JSON.stringify(transcript, null, 2));
    if (s.ctrl.signal.aborted) throw new Error('cancelled');

    const durationSec = Number(opts.durationSec) || transcript.durationSec || 0;
    if (opts.mode === 'automation') return runAutomation(s, opts, transcript, durationSec, instructions, stage);

    // Tasks: one vision call writes the tasks directly from the frames and the
    // timed transcript (see show2plan-analyze.js). No second model rewrites them.
    stage('analyzing');
    const analyze = require('./show2plan-analyze');
    const frames = s.frames.map((f) => ({ ...f, path: path.join(dirOf(s.id), 'frames', f.file) }));
    if (!transcript.text && !frames.length) throw new Error('Nothing was captured: no narration and no screenshots. Keep the shared window visible and talk while you record.');
    const out = await analyze.analyzeShowAndTell({ frames, transcript, instructions, durationSec, signal: s.ctrl.signal });
    if (!out.sawImages && frames.length) s.warnings.push(`The model "${out.model}" cannot read images, so the tasks were written from the narration only. Configure a vision-capable model for much better tasks.`);
    if (!out.tasks.length && !out.questions.length) throw new Error('The model found nothing to turn into tasks. Record again and say what should change while you show it.');

    stage('planning');
    analyze.groundTasks(getWorkspace(), out.tasks);

    const segmentAt = (t) => (transcript.segments || []).find((x) => t >= x.start - 0.5 && t <= x.end + 1.5);
    s.result = {
      mode: 'tasks',
      title: out.title || (out.tasks[0] && out.tasks[0].title) || 'Show & tell',
      summary: out.summary,
      app: null,
      transcript: { text: transcript.text, segments: transcript.segments, source: transcript.source },
      frames: out.framesSent.map((f) => ({ file: f.file, t: f.t, reason: 'sent to the model', transcript: (segmentAt(f.t) || {}).text || null })),
      allFrames: s.frames.length,
      tasks: out.tasks,
      via: 'model',
      model: out.model,
      uncertain: out.questions,
    };
    fs.writeFileSync(path.join(dirOf(s.id), 'result.json'), JSON.stringify(s.result, null, 2));
    stage('done');
  }

  // Automation: the narration is a sequence of steps to replay, not changes
  // to the code. That needs the vision model to see what was acted on.
  async function runAutomation(s, opts, transcript, durationSec, instructions, stage) {
    stage('analyzing');
    const vision = require('./vision');
    if (!vision.findVisionClient()) throw new Error('An automation needs a vision-capable model to see what you clicked. Configure one (a visionSupport endpoint, or a model marked vision:true), or record Tasks instead.');
    const selected = pickFrames(s.frames, transcript.segments, { durationSec, budget: Number(opts.budget) || DEFAULT_BUDGET });
    const segmentAt = (t) => (transcript.segments || []).find((x) => t >= x.start - 0.5 && t <= x.end + 1.5);
    const frameObjs = selected.map((f, i) => ({ index: i, file: f.file, path: path.join(dirOf(s.id), 'frames', f.file), t: f.t, reason: f.reason, transcript: (segmentAt(f.t) || {}).text || null }));
    const a = await vision.analyzeRecording({ frames: frameObjs, transcript, instructions, signal: s.ctrl.signal });
    const { normalizeAnalysis, toAutomation } = require('./showtell');
    const analysis = normalizeAnalysis(a.analysis);
    s.result = {
      mode: 'automation',
      title: analysis.goal || analysis.summary || 'Recorded automation',
      summary: analysis.summary || '',
      app: analysis.app,
      transcript: { text: transcript.text, segments: transcript.segments, source: transcript.source },
      frames: frameObjs.map((f) => ({ file: f.file, t: f.t, reason: f.reason, transcript: f.transcript })),
      allFrames: s.frames.length,
      tasks: [],
      automation: toAutomation(a.analysis),
      via: 'model',
      uncertain: analysis.uncertain || [],
    };
    fs.writeFileSync(path.join(dirOf(s.id), 'result.json'), JSON.stringify(s.result, null, 2));
    stage('done');
  }

  function processSession(id, opts = {}) {
    const s = get(id);
    if (s.stage !== 'recording' && s.stage !== 'error' && s.stage !== 'done') throw Object.assign(new Error('already processing'), { status: 409 });
    s.stage = 'queued';
    s.error = null;
    s.warnings = [];
    s.result = null;
    s.ctrl = new AbortController();
    runPipeline(s, opts).catch((e) => { s.stage = 'error'; s.error = String(e.message || e); emit(s); });
    return publicView(s);
  }

  function status(id) { return publicView(get(id)); }

  function remove(id) {
    const s = sessions.get(id);
    if (s && s.ctrl) s.ctrl.abort();
    sessions.delete(id);
    if (validId(id)) { try { fs.rmSync(dirOf(id), { recursive: true, force: true }); } catch {} }
    return true;
  }

  function shutdown() { for (const s of sessions.values()) if (s.ctrl) s.ctrl.abort(); }

  return { create, addFrame, setAudio, framePath, process: processSession, status, remove, shutdown };
}

module.exports = { pickFrames, coerceLiveTranscript, chooseTranscript, requestsFromFindings, requestsFromTranscript, createShow2PlanManager, DEFAULT_BUDGET };
