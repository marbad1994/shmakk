# shmakk voice

Always-on speech-to-speech mode for shmakk. Speak naturally — shmakk listens, transcribes, responds, and reads its answer aloud. No push-to-talk, no hotkeys.

## How it works

- **STT** — Whisper-base ONNX via `@huggingface/transformers`. Runs fully in-process, no Python, no server, no API key. Model (~75MB) auto-downloads on first use.
- **VAD** — `sox` silence detection. Recording starts when you speak, stops automatically after 1 second of silence. No button to push.
- **TTS** — Kokoro-82M ONNX via `kokoro-js`. Runs fully in-process. Model (~165MB) auto-downloads on first use. Sentences stream sentence-by-sentence so the first words play immediately.
- **Voice rotation** — All 28 Kokoro voices rotate on a deterministic daily schedule (changes every 2–5 hours, varied per day). Feels random, fully reproducible.

## Requirements

### System packages

**Arch / EndeavourOS:**
```bash
sudo pacman -S sox
```

**Debian / Ubuntu:**
```bash
sudo apt install sox
```

**macOS:**
```bash
brew install sox
```

Sox provides the `rec` command used for VAD-based microphone capture. A working PulseAudio or PipeWire setup is also required (standard on any modern Linux desktop).

### Node.js optional dependencies

Voice deps are optional — base shmakk works without them.

```bash
npm install --include=optional
```

Or use the setup script which installs deps and runs a full preflight check:

```bash
npm run setup:voice
```

## Usage

```bash
shmakk --sts          # speech-to-speech: always-on mic + TTS responses
shmakk --stt          # mic input only, text responses
shmakk --tts          # text input, spoken responses
```

Just speak. shmakk will:
1. Detect your voice via VAD
2. Transcribe it (shown in cyan on stderr)
3. Send it as input
4. Speak the response aloud, sentence by sentence

## Interrupting

Say any of these to stop TTS mid-sentence:

> stop · quiet · shut up · silence · enough · cancel

The current playback stops immediately and shmakk goes back to listening.

## Tuning VAD for your microphone

The default settings work well for USB headsets with a clean noise floor. If speech is cut off or recordings don't stop, tune these env vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `SHMAKK_VOICE_SILENCE_SEC` | `1.0` | Seconds of silence before stopping |
| `SHMAKK_VOICE_SILENCE_THRESHOLD` | `1%` | Amplitude threshold for silence |
| `SHMAKK_VOICE_SILENCE_START_SEC` | `0.5` | Seconds of sound before starting |
| `SHMAKK_VOICE_PAD_START_SEC` | `0.3` | Padding added to start of recording |
| `SHMAKK_VOICE_MAX_SEC` | `30` | Hard maximum recording duration |

Add to your `.env`:
```bash
SHMAKK_VOICE_SILENCE_SEC=1.5
SHMAKK_VOICE_SILENCE_THRESHOLD=2%
```

To find your microphone's noise floor:
```bash
rec -q -r 16000 -c 1 /tmp/silence.wav trim 0 3 && sox /tmp/silence.wav -n stat 2>&1 | grep RMS
```

Set `SHMAKK_VOICE_SILENCE_THRESHOLD` to roughly 3× the RMS amplitude percentage.

## Voice settings

| Variable | Default | Description |
|----------|---------|-------------|
| `SHMAKK_TTS_VOICE` | *(scheduled)* | Pin a specific voice (e.g. `am_michael`) |
| `SHMAKK_TTS_DTYPE` | `fp16` | Model precision: `fp32`, `fp16`, `q8`, `q4` |

**Available voices (28 total):**

| ID | Language | Gender |
|----|----------|--------|
| `af_bella`, `af_sarah`, `af_sky`, `af_nicole`, `af_heart`, `af_aoede`, `af_river` | American English | Female |
| `am_adam`, `am_michael`, `am_echo`, `am_liam` | American English | Male |
| `bf_emma`, `bf_isabella` | British English | Female |
| `bm_george`, `bm_lewis`, `bm_daniel` | British English | Male |
| `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro` | Japanese | Female |
| `jm_kumo` | Japanese | Male |
| `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi` | Chinese | Female |
| `zm_yunjian`, `zm_yunxia` | Chinese | Male |

To see today's voice schedule:
```bash
node -e "
const tts = require('./src/services/tts');
tts.listVoices().then(voices => {
  const now = new Date();
  const day = now.getFullYear() * 10000 + (now.getMonth()+1)*100 + now.getDate();
  const daySeed = (day * 2654435761) >>> 0;
  let t = 0, b = 0, seed = daySeed;
  const ids = voices.map(v => v.id);
  console.log('Today schedule:');
  while (t < 1440) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const mins = 120 + (seed % 180);
    const voiceSeed = (daySeed ^ (b * 2246822519)) >>> 0;
    const v = ids[voiceSeed % ids.length];
    const h = String(Math.floor(t/60)).padStart(2,'0');
    const m = String(t%60).padStart(2,'0');
    console.log(h+':'+m, '->', v, '('+Math.round(mins/60*10)/10+'h)');
    t += mins; b++;
  }
});
"
```

## Language

STT defaults to English. Override:
```bash
shmakk --sts --voice-language sv    # Swedish
shmakk --sts --voice-language de    # German
```

Or set permanently:
```bash
export SHMAKK_VOICE_LANGUAGE=en
```

## Troubleshooting

**Voice not detected / recording doesn't start**
```bash
# Check mic level
rec -q -r 16000 -c 1 /tmp/test.wav trim 0 3 && sox /tmp/test.wav -n stat 2>&1 | grep RMS
# Lower the start threshold if RMS is low
export SHMAKK_VOICE_SILENCE_THRESHOLD=0.5%
```

**Recording doesn't stop**
```bash
# Raise the stop threshold — background noise is above it
export SHMAKK_VOICE_SILENCE_THRESHOLD=3%
```

**No TTS sound**
```bash
# Check player
which paplay aplay
pactl info
```

**Slow first response**
Models download on first use. After that they're cached in `~/.cache/huggingface`. Subsequent starts load from cache in seconds.

**Run the full preflight check:**
```bash
npm run setup:voice
```
