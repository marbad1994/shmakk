// Key-frame extraction for show-and-tell recordings.
//
// Given a screen recording and a timestamped transcript, pick the moments the
// user is most likely pointing at or acting on, and export a small, ordered set
// of PNG frames for the downstream vision model.
//
// Selection is a two-step, fully testable pipeline:
//   1. selectTimestamps() turns transcript segments into candidate timestamps
//      using speech cues ("click here", "this button", "type", "go to") plus
//      segment boundaries, then dedupes by time gap and caps to a budget.
//   2. extractFramesAt() seeks to each timestamp with ffmpeg (fast keyframe
//      seek + accurate forward seek) and writes one PNG per frame.
//
// No new dependencies: ffmpeg/ffprobe are already required by the capture
// service, and output is plain PNG files the existing image pipeline accepts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// ── configuration ───────────────────────────────────────────────────────────

const DEFAULT_BUDGET = Math.max(1, parseInt(process.env.SHMAKK_FRAME_BUDGET || '12', 10));
const DEFAULT_MIN_GAP = Math.max(0, parseFloat(process.env.SHMAKK_FRAME_MIN_GAP || '0.8'));
const DEFAULT_FALLBACK_INTERVAL = Math.max(1, parseFloat(process.env.SHMAKK_FRAME_FALLBACK_INTERVAL || '4'));
const DEFAULT_MAX_WIDTH = parseInt(process.env.SHMAKK_FRAME_MAX_WIDTH || '1600', 10) || null;
const DEFAULT_CONCURRENCY = Math.max(1, parseInt(process.env.SHMAKK_FRAME_CONCURRENCY || '4', 10));
const DEFAULT_SEEK_BACK = Math.max(0, parseFloat(process.env.SHMAKK_FRAME_SEEK_BACK || '2'));
const DEFAULT_MIN_BYTES = 300;

// Speech cues that signal the user is pointing at or acting on something.
// Higher weight means a stronger "important moment" signal; used to decide
// which of two near-simultaneous candidates to keep when deduping.
const CUES = [
  { re: /\b(click|tap|press|hit|push|double[-\s]?click|right[-\s]?click)\b/i, weight: 3, label: 'action' },
  { re: /\b(type|enter|input|write|paste|key in)\b/i, weight: 3, label: 'type' },
  { re: /\b(this|that|these|those|here|there|like this|like that|this one)\b/i, weight: 3, label: 'deictic' },
  { re: /\b(go to|open|navigate to|select|choose|pick|switch to|launch|start|create|add|save|submit|confirm)\b/i, weight: 2, label: 'navigate' },
  { re: /\b(drag|drop|scroll|swipe|move|resize|zoom|hover|highlight|copy|cut|delete|remove)\b/i, weight: 2, label: 'gesture' },
  { re: /\b(look|watch|see|observe|notice|check out|focus on|point to|show)\b/i, weight: 1, label: 'attention' },
];

// ── pure helpers ────────────────────────────────────────────────────────────

function clamp(t, lo, hi) {
  if (lo != null && t < lo) return lo;
  if (hi != null && t > hi) return hi;
  return t;
}

function countWords(text) {
  const s = String(text || '').trim();
  return s ? s.split(/\s+/).length : 0;
}

/**
 * Find the strongest speech cue in a segment's text.
 * @returns {null|{label:string, weight:number, index:number, wordIndex:number, matched:string}}
 */
function detectCue(text) {
  const s = String(text || '');
  if (!s) return null;
  let best = null;
  for (const cue of CUES) {
    const m = cue.re.exec(s);
    if (!m) continue;
    const before = s.slice(0, m.index);
    const wordIndex = before.trim() ? before.trim().split(/\s+/).length : 0;
    const cand = { label: cue.label, weight: cue.weight, index: m.index, wordIndex, matched: m[0] };
    if (!best || cand.weight > best.weight || (cand.weight === best.weight && cand.index < best.index)) {
      best = cand;
    }
  }
  return best;
}

/**
 * Normalise transcript segments into a uniform { start, end, text } shape.
 * Accepts the capture service's own segments as well as the raw
 * transformers.js chunks ({ text, timestamp: [start, end] }).
 */
function coerceSegments(segments) {
  const out = [];
  if (!Array.isArray(segments)) return out;
  for (const s of segments) {
    if (!s) continue;
    const text = String(s.text || '').trim();
    if (!text) continue;
    let start = null;
    let end = null;
    const ts = s.timestamp;
    if (Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end))) {
      start = Number(s.start);
      end = Number(s.end);
    } else if (Array.isArray(ts)) {
      start = Number(ts[0]);
      end = Number(ts[1] != null ? ts[1] : ts[0]);
    } else if (ts && typeof ts === 'object') {
      start = Number(ts.start);
      end = Number(ts.end != null ? ts.end : ts.start);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start > end) [start, end] = [end, start];
    out.push({ start, end, text });
  }
  return out;
}

/**
 * Turn timestamped transcript segments into an ordered list of candidate
 * frame timestamps.
 *
 * For each segment we consider the start, the end, a cue position (when a
 * strong pointing/action word appears), and the midpoint of long segments.
 * Candidates are clamped to the recording, deduped by minimum time gap, and
 * capped to the budget by cue strength.
 *
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @param {object} [opts]
 * @param {number} [opts.durationSec] recording length, used to clamp + fallback
 * @param {number} [opts.budget] max frames to select
 * @param {number} [opts.minGapSec] minimum seconds between selected frames
 * @param {number} [opts.fallbackIntervalSec] interval when there are no segments
 * @param {number} [opts.longSpanSec] segments longer than this get a midpoint sample
 * @returns {Array<{t:number, segmentIndex:number, cue:string|null, reason:string, weight:number}>}
 */
function selectTimestamps(segments, opts = {}) {
  const durationSec = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 0;
  const budget = Math.max(1, Number(opts.budget) || DEFAULT_BUDGET);
  const minGapSec = Math.max(0, opts.minGapSec != null ? Number(opts.minGapSec) : DEFAULT_MIN_GAP);
  const fallbackIntervalSec = Math.max(1, Number(opts.fallbackIntervalSec) || DEFAULT_FALLBACK_INTERVAL);
  const longSpanSec = Math.max(2, Number(opts.longSpanSec) || 3);

  const valid = coerceSegments(segments);

  // No usable transcript: fall back to fixed-interval sampling.
  if (!valid.length) {
    const out = [];
    if (durationSec <= 0) return out;
    for (let t = Math.min(fallbackIntervalSec / 2, durationSec); t < durationSec && out.length < budget; t += fallbackIntervalSec) {
      out.push({ t: clamp(t, 0, durationSec), segmentIndex: -1, cue: null, reason: 'interval', weight: 0 });
    }
    return out;
  }

  const candidates = [];
  for (let i = 0; i < valid.length; i++) {
    const seg = valid[i];
    if (seg.end < seg.start) continue;
    const span = seg.end - seg.start;
    const cue = detectCue(seg.text);
    const wordCount = countWords(seg.text);

    candidates.push({
      t: seg.start, segmentIndex: i, cue: null, reason: 'segment-start', weight: cue ? 2 : 1,
    });

    if (cue) {
      // Approximate where in the segment the cue word was spoken. For
      // word-level transcripts the segment *is* the word, so this collapses
      // to the segment itself.
      const pos = wordCount > 1 ? cue.wordIndex / Math.max(1, wordCount - 1) : 0;
      candidates.push({
        t: seg.start + span * pos, segmentIndex: i, cue: cue.label, reason: 'cue', weight: 3 + cue.weight,
      });
    }

    if (span >= longSpanSec) {
      candidates.push({
        t: seg.start + span / 2, segmentIndex: i, cue: cue ? cue.label : null, reason: 'segment-mid', weight: cue ? 2 : 1,
      });
    }

    candidates.push({
      t: seg.end, segmentIndex: i, cue: cue ? cue.label : null, reason: 'segment-end', weight: cue ? 3 : 1,
    });
  }

  // Clamp into the recording and drop anything past the end.
  const clamped = candidates
    .map((c) => ({ ...c, t: clamp(c.t, 0, durationSec || null) }))
    .filter((c) => !durationSec || c.t <= durationSec);

  clamped.sort((a, b) => a.t - b.t || b.weight - a.weight);

  // Dedup within minGapSec windows, keeping the strongest candidate.
  const deduped = [];
  for (const c of clamped) {
    const last = deduped[deduped.length - 1];
    if (!last || c.t - last.t >= minGapSec) {
      deduped.push(c);
    } else if (c.weight > last.weight) {
      deduped[deduped.length - 1] = c;
    } else if (c.weight === last.weight && c.reason === 'cue' && last.reason !== 'cue') {
      deduped[deduped.length - 1] = c;
    }
  }

  // Cap to the budget, keeping the strongest cues, then restore time order.
  if (deduped.length > budget) {
    deduped.sort((a, b) => b.weight - a.weight || a.t - b.t);
    deduped.length = budget;
    deduped.sort((a, b) => a.t - b.t);
  }

  return deduped;
}

/**
 * Build the ffmpeg argument list to extract one frame at time `t`.
 * Uses a fast keyframe seek to `t - seekBack` then an accurate forward seek,
 * which is frame-accurate without decoding the whole prefix.
 */
function buildExtractArgs(mediaPath, outPath, t, opts = {}) {
  const back = Math.max(0, Number(opts.seekBackSec) || DEFAULT_SEEK_BACK);
  const pre = Math.max(0, t - back);
  const post = Math.min(t, back);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  args.push('-ss', String(pre), '-i', mediaPath);
  args.push('-ss', String(post));
  if (opts.maxWidth) {
    args.push('-vf', `scale=min(iw\\,${Math.max(16, Math.floor(Number(opts.maxWidth)))}):-2:flags=lanczos`);
  }
  args.push('-frames:v', '1');
  if (opts.format === 'jpg') args.push('-q:v', '2');
  args.push(outPath);
  return args;
}

// ── ffmpeg extraction ───────────────────────────────────────────────────────

function probeDuration(mediaPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', mediaPath,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(stdout);
        const sec = Number(d && d.format && d.format.duration);
        resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function loadTranscriptFile(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && (Array.isArray(data.segments) || typeof data.text === 'string') ? data : null;
  } catch {
    return null;
  }
}

/**
 * Extract one frame to `outPath`. Rejects when the output is missing or too
 * small (blank/corrupt), which callers treat as a skipped frame.
 */
function extractFrameAt(mediaPath, outPath, t, opts = {}) {
  return new Promise((resolve, reject) => {
    const ff = opts.ffmpegBin || 'ffmpeg';
    const minBytes = Number(opts.minBytes) > 0 ? Number(opts.minBytes) : DEFAULT_MIN_BYTES;
    execFile(ff, buildExtractArgs(mediaPath, outPath, t, opts), {
      timeout: opts.timeoutMs || 30000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err) => {
      if (err) return reject(err);
      let st;
      try { st = fs.statSync(outPath); } catch (e) { return reject(e); }
      if (st.size < minBytes) return reject(new Error(`frame too small (${st.size} bytes, likely blank)`));
      resolve({ path: outPath, bytes: st.size });
    });
  });
}

/**
 * Extract a batch of frames with bounded concurrency. Frames are written to
 * `outDir` as frame_000.png, frame_001.png, and so on.
 * @returns {Promise<{frames:Array, skipped:Array}>}
 */
async function extractFramesAt(mediaPath, outDir, timestamps, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const concurrency = Math.max(1, Number(opts.concurrency) || DEFAULT_CONCURRENCY);
  const ext = opts.format === 'jpg' ? 'jpg' : 'png';
  const frames = [];
  const skipped = [];
  const list = Array.isArray(timestamps) ? timestamps : [];
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      const c = list[idx];
      const file = `frame_${String(idx).padStart(3, '0')}.${ext}`;
      const out = path.join(outDir, file);
      try {
        const r = await extractFrameAt(mediaPath, out, c.t, opts);
        frames.push({ index: idx, t: c.t, path: out, file, bytes: r.bytes, ...c });
      } catch (e) {
        skipped.push({ index: idx, t: c.t, reason: String((e && e.message) || e) });
      }
    }
  });

  await Promise.all(workers);
  frames.sort((a, b) => a.index - b.index);
  skipped.sort((a, b) => a.index - b.index);
  return { frames, skipped };
}

// ── orchestrator ────────────────────────────────────────────────────────────

/**
 * Extract key frames from a recording using transcript timing + speech cues.
 *
 * @param {object} opts
 * @param {string} opts.mediaPath recording file (the muxed .mkv)
 * @param {object} [opts.transcript] transcript object ({ segments, durationSec })
 * @param {string} [opts.transcriptPath] path to a transcript JSON file
 * @param {Array} [opts.segments] transcript segments override
 * @param {number} [opts.durationSec] recording length override
 * @param {number} [opts.fps] capture fps (metadata only)
 * @param {string} [opts.outputDir] directory for extracted PNGs
 * @param {number} [opts.budget] max frames to extract
 * @param {number} [opts.minGapSec] minimum seconds between frames
 * @param {number} [opts.maxWidth] downscale frames wider than this
 * @param {number} [opts.width] [opts.height] source dimensions (metadata)
 * @returns {Promise<object>}
 */
async function extractKeyFrames(opts = {}) {
  const mediaPath = opts.mediaPath || opts.muxed;
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    throw new Error(`recording not found: ${mediaPath || '(no mediaPath)'}`);
  }

  const transcript = opts.transcript || loadTranscriptFile(opts.transcriptPath) || {};
  const rawSegments = opts.segments || transcript.segments || [];
  const segments = coerceSegments(rawSegments);

  let durationSec = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 0;
  if (!durationSec && transcript.durationSec > 0) durationSec = Number(transcript.durationSec);
  if (!durationSec) durationSec = (await probeDuration(mediaPath)) || 0;

  const outputDir = opts.outputDir || path.join(os.tmpdir(), 'shmakk-frames', `${Date.now().toString(36)}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const budget = Math.max(1, Number(opts.budget) || DEFAULT_BUDGET);
  const timestamps = selectTimestamps(segments, {
    durationSec,
    budget,
    minGapSec: opts.minGapSec,
    fallbackIntervalSec: opts.fallbackIntervalSec,
    longSpanSec: opts.longSpanSec,
  });

  const { frames, skipped } = await extractFramesAt(mediaPath, outputDir, timestamps, {
    format: opts.format,
    maxWidth: opts.maxWidth == null ? DEFAULT_MAX_WIDTH : opts.maxWidth,
    concurrency: opts.concurrency,
    seekBackSec: opts.seekBackSec,
    minBytes: opts.minBytes,
    timeoutMs: opts.timeoutMs,
  });

  // Enrich each frame with its transcript context.
  for (const f of frames) {
    f.transcript = f.segmentIndex >= 0 && segments[f.segmentIndex] ? segments[f.segmentIndex].text : null;
    f.width = opts.width || null;
    f.height = opts.height || null;
    f.durationSec = durationSec;
  }

  return {
    mediaPath,
    durationSec,
    fps: opts.fps || null,
    budget,
    requested: timestamps.length,
    extracted: frames.length,
    frames,
    skipped,
  };
}

module.exports = {
  CUES,
  detectCue,
  coerceSegments,
  selectTimestamps,
  buildExtractArgs,
  extractFrameAt,
  extractFramesAt,
  probeDuration,
  loadTranscriptFile,
  extractKeyFrames,
};
