// Speech-to-text. Primary engine for show-and-tell is DeepSeek's hosted ASR
// (POST /v1/tools/asr), which is far more accurate than the local model and
// accepts the same 16 kHz mono 16-bit PCM WAV the capture service produces.
// Local Whisper ONNX (@huggingface/transformers, Xenova/whisper-base) is the
// offline fallback and runs fully in-process, no Python or server.

const path = require('path');
const fs = require('fs');
const { WaveFile } = require('wavefile');

let _pipeline = null;
let _instance = null;
let _loadPromise = null;
let _env = null;

async function _ensureModel() {
  if (_instance) return _instance;

  // Prevent concurrent loads
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    let mod;
    try {
      mod = await import('@huggingface/transformers');
    } catch {
      throw new Error(
        'Voice deps not installed. Run: npm run setup:voice\n' +
        'Or: npm install --include=optional'
      );
    }
    _pipeline = mod.pipeline;
    _env = mod.env;

    // Allow cache dir override
    if (process.env.SHMAKK_HF_CACHE) {
      _env.cacheDir = process.env.SHMAKK_HF_CACHE;
    }

    // Don't spam progress to stdout
    _env.allowLocalModels = false;

    _instance = await _pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
    );
    return _instance;
  })();

  return _loadPromise;
}

/**
 * Decode a WAV file to a mono 16kHz Float32Array, the format
 * required by the transformers.js Whisper pipeline in Node.js.
 */
function _wavToFloat32(audioPath) {
  const buffer = fs.readFileSync(audioPath);
  const wav = new WaveFile(buffer);

  wav.toBitDepth('32f');
  wav.toSampleRate(16000);

  let audioData = wav.getSamples();

  // If multi-channel, merge to mono
  if (Array.isArray(audioData)) {
    if (audioData.length > 1) {
      const SCALING_FACTOR = Math.sqrt(2);
      for (let i = 0; i < audioData[0].length; ++i) {
        audioData[0][i] =
          (SCALING_FACTOR * (audioData[0][i] + audioData[1][i])) / 2;
      }
    }
    audioData = audioData[0];
  }

  // Ensure Float32Array (getSamples may return a regular Array)
  if (!(audioData instanceof Float32Array)) {
    audioData = new Float32Array(audioData);
  }

  return audioData;
}

// ── DeepSeek ASR (cloud) ────────────────────────────────────────────────────
// The local Whisper-base model is cheap but hallucinates badly on quiet or
// noisy microphone audio. DeepSeek's hosted ASR returns a far more accurate
// transcript. It has no timestamp support, so we emit a single full-duration
// segment; frame selection degrades gracefully to interval + cue sampling.
//
// Used when a DeepSeek endpoint is configured and the clip fits the service
// limits (120 s / 8 MiB). Local Whisper stays as fallback; force it with
// SHMAKK_STT=whisper, or force ASR with SHMAKK_STT=deepseek.

const ASR_PATH = '/v1/tools/asr';
const ASR_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB per request
const ASR_MAX_SECONDS = 120;           // 120 s per request

function _deepseekAsrConfig() {
  const base = process.env.SHMAKK_STT_BASE_URL
    || (/deepseek/i.test(process.env.SHMAKK_BASE_URL || '') ? process.env.SHMAKK_BASE_URL : null);
  const key = process.env.SHMAKK_STT_API_KEY || process.env.SHMAKK_API_KEY || null;
  if (base && key) return { base, key };

  try {
    const { getModelRegistry } = require('../endpoints');
    const registry = getModelRegistry();
    for (const cfg of Object.values(registry.models || {})) {
      if (cfg && cfg.base_url && /deepseek/i.test(cfg.base_url) && cfg.api_key) {
        return { base: cfg.base_url, key: cfg.api_key };
      }
    }
  } catch {}
  return null;
}

function _wavDurationSec(audioPath) {
  try {
    const wav = new WaveFile(fs.readFileSync(audioPath));
    const rate = wav.fmt && Number(wav.fmt.sampleRate);
    const samples = wav.data && wav.data.samples;
    let count = 0;
    if (Array.isArray(samples) && samples.length && Array.isArray(samples[0])) {
      count = samples[0].length;
    } else if (samples && typeof samples.length === 'number') {
      count = samples.length;
    }
    return rate && count ? count / rate : null;
  } catch { return null; }
}

async function _transcribeDeepSeek(audioPath) {
  const cfg = _deepseekAsrConfig();
  if (!cfg) return null;

  const buf = fs.readFileSync(audioPath);
  const durationSec = _wavDurationSec(audioPath);
  if (buf.length > ASR_MAX_BYTES) return null;
  if (durationSec != null && durationSec > ASR_MAX_SECONDS) return null;

  const url = cfg.base.replace(/\/+$/, '') + ASR_PATH;
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}` },
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek ASR failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = String((data && data.text) || '').trim();
  if (!text) throw new Error('DeepSeek ASR returned an empty transcript');
  return { text, durationSec };
}

/**
 * Transcribe a WAV file to text.
 * @param {string} audioPath - path to WAV audio file
 * @param {object} [opts]
 * @param {string} [opts.language] - ISO language code hint (e.g. "en")
 * @returns {Promise<string>} transcribed text
 */
async function transcribe(audioPath, opts = {}) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const transcriber = await _ensureModel();

  // Decode WAV to Float32Array — pipeline can't use AudioContext in Node.js.
  // See https://huggingface.co/docs/transformers.js/guides/node-audio-processing
  const audioData = _wavToFloat32(audioPath);

  const kwargs = { language: opts.language || 'english' };

  const result = await transcriber(audioData, kwargs);
  return (result.text || '').trim();
}

/**
 * Normalise the raw `chunks` returned by transformers.js when
 * `return_timestamps` is enabled into clean, monotonic segments.
 *
 * transformers.js returns:
 *   { text, chunks: [ { text, timestamp: [start, end] } ] }
 * where `timestamp` is in seconds. We tolerate several shapes and clamp to a
 * sane, non-overlapping timeline so downstream frame selection stays stable.
 */
function _normaliseChunks(result, durationSec) {
  const chunks = result && result.chunks;
  const segments = [];
  if (Array.isArray(chunks) && chunks.length) {
    let prevEnd = 0;
    for (const c of chunks) {
      const text = String((c && c.text) || '').trim();
      if (!text) continue;
      let start = null;
      let end = null;
      const ts = c && c.timestamp;
      if (Array.isArray(ts)) {
        start = Number(ts[0]);
        end = Number(ts[1] != null ? ts[1] : ts[0]);
      } else if (ts && typeof ts === 'object') {
        start = Number(ts.start);
        end = Number(ts.end != null ? ts.end : ts.start);
      } else if (typeof ts === 'number') {
        start = ts;
        end = ts;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        start = prevEnd;
        end = prevEnd;
      }
      if (start < 0) start = 0;
      if (end < start) [start, end] = [end, start];
      if (start < prevEnd) start = prevEnd;
      if (end > durationSec) end = durationSec;
      if (start > durationSec) start = durationSec;
      if (end <= start) end = Math.min(durationSec, start + 0.01);
      segments.push({ start, end, text });
      prevEnd = end;
    }
  }

  if (!segments.length) {
    const text = String((result && result.text) || '').trim();
    if (text) segments.push({ start: 0, end: durationSec, text });
  }

  return segments;
}

/**
 * Transcribe a WAV file into a timestamped transcript.
 * @param {string} audioPath - path to WAV audio file
 * @param {object} [opts]
 * @param {string} [opts.language] - ISO language code hint (e.g. "en")
 * @returns {Promise<{text:string, segments:Array<{start:number,end:number,text:string}>, durationSec:number, language:string}>}
 */
async function transcribeTimestamped(audioPath, opts = {}) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const engine = String(opts.engine || process.env.SHMAKK_STT || 'auto').toLowerCase();

  // Prefer DeepSeek ASR unless explicitly forced to local Whisper.
  if (engine !== 'whisper') {
    const asrCfg = _deepseekAsrConfig();
    if (engine === 'deepseek' && !asrCfg) {
      throw new Error('DeepSeek ASR requested but no DeepSeek endpoint is configured');
    }
    if (asrCfg) {
      try {
        const asr = await _transcribeDeepSeek(audioPath);
        if (asr && asr.text) {
          const durationSec = asr.durationSec || _wavDurationSec(audioPath) || 0;
          return {
            text: asr.text,
            segments: [{ start: 0, end: durationSec, text: asr.text }],
            durationSec,
            language: null,
            engine: 'deepseek-asr',
          };
        }
      } catch (e) {
        // Explicit request: surface the error. Otherwise fall back to Whisper.
        if (engine === 'deepseek') throw e;
      }
    }
  }

  const transcriber = await _ensureModel();
  const audioData = _wavToFloat32(audioPath);
  const durationSec = audioData.length / 16000;

  const kwargs = {
    language: opts.language || 'english',
    // `true` -> sentence/segment-level chunks; `'word'` -> word-level chunks.
    return_timestamps: opts.wordLevel ? 'word' : true,
  };

  const result = await transcriber(audioData, kwargs);
  const text = String((result && result.text) || '').trim();
  const segments = _normaliseChunks(result, durationSec);

  return {
    text,
    segments,
    durationSec,
    language: (result && result.language) || kwargs.language || 'english',
    engine: 'whisper',
  };
}

/**
 * Check if the STT model files are already cached locally.
 * Used for pre-flight warnings.
 */
function isCached() {
  try {
    // @huggingface/transformers caches in ~/.cache/huggingface by default
    const hfHome = process.env.HF_HOME
      || process.env.XDG_CACHE_HOME
      || path.join(require('os').homedir(), '.cache', 'huggingface');

    // Whisper-tiny has at minimum the config and quantized ONNX models
    const modelDir = path.join(
      hfHome,
      'transformers',
      'models--Xenova--whisper-base',
    );
    return fs.existsSync(modelDir);
  } catch {
    return false;
  }
}

module.exports = {
  transcribe,
  transcribeTimestamped,
  isCached,
  _normaliseChunks,
  _ensureModel,
  _deepseekAsrConfig,
  _wavDurationSec,
  _transcribeDeepSeek,
};
