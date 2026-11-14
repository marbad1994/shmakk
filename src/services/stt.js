// Speech-to-text via Whisper ONNX using @huggingface/transformers.
// No Python, no server — 100% JS, runs locally in-process.
// Model auto-downloads on first use (~45MB quantized whisper-tiny).

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

    // Quantized whisper-tiny by default (~45MB) — far faster on CPU than the
    // FP32 whisper-base the code previously loaded. Override via env if needed.
    // NOTE: dtype must be passed to pipeline() — env.dtype is not read by it.
    const dtype = process.env.SHMAKK_STT_DTYPE || 'q8';

    _instance = await _pipeline(
      'automatic-speech-recognition',
      process.env.SHMAKK_STT_MODEL || 'Xenova/whisper-tiny',
      { dtype },
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

  // Give visible feedback — transcription can take a second or two on CPU.
  process.stderr.write('\r\x1b[36m🎤 transcribing…\x1b[0m');

  // Decode WAV to Float32Array — pipeline can't use AudioContext in Node.js.
  // See https://huggingface.co/docs/transformers.js/guides/node-audio-processing
  const audioData = _wavToFloat32(audioPath);

  const kwargs = { language: opts.language || 'english' };

  const result = await transcriber(audioData, kwargs);
  return (result.text || '').trim();
}

/**
 * Check if the STT model files are already cached locally.
 * Used for pre-flight warnings.
 */
function isCached() {
  try {
    // @huggingface/transformers caches under <package>/.cache by default.
    const base = process.env.SHMAKK_HF_CACHE
      || path.join(
        path.dirname(path.dirname(require.resolve('@huggingface/transformers'))),
        '.cache',
      );
    const [org, name] = (process.env.SHMAKK_STT_MODEL || 'Xenova/whisper-tiny').split('/');
    const onnxDir = path.join(base, org, name, 'onnx');
    return (
      fs.existsSync(path.join(onnxDir, 'encoder_model.onnx'))
      || fs.existsSync(path.join(onnxDir, 'encoder_model_quantized.onnx'))
    );
  } catch {
    return false;
  }
}

module.exports = { transcribe, isCached, _ensureModel };
