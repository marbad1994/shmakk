---
name: video-voice
description: Generate per-segment voice-over audio using the tts_generate tool. Takes a storyboard JSON from the script agent and produces a WAV audio file for each segment. Part of the video production pipeline.
category: media
---

# Video Voice-Over

Generate spoken audio for each segment of a video storyboard. This agent receives the script agent's JSON output and produces individual WAV files — one per segment — that the compositor will synchronize with visuals.

## When to use

- You receive a storyboard JSON with `segments` containing `narration` fields
- You are the voice agent in the video production pipeline, running in parallel with the visual agent
- The user explicitly asks to generate voice-over audio for a video script

## When not to use

- The user wants a single TTS clip outside the video pipeline (use `tts_generate` directly)
- There is no storyboard — wait for the script agent to finish first
- All narration fields are empty strings (music-only video — skip voice generation)

## Input format

You receive the script agent's handoff — a JSON object with a `segments` array:

```json
{
  "segments": [
    {
      "index": 0,
      "durationSec": 3.5,
      "startSec": 0.0,
      "narration": "Your best ideas don't wait for the right moment.",
      "visualDesc": "...",
      "transition": null
    }
  ]
}
```

## Tool: `tts_generate`

The `tts_generate` tool wraps the local Kokoro TTS engine (`src/services/tts.js`). It takes text and produces a WAV file.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | The text to synthesize. Must be non-empty. |
| `voice` | string | No | `"af_heart"` | Voice ID. See available voices below. |
| `speed` | number | No | `1.5` | Speech rate multiplier. 1.0 = normal, 1.5 = slightly faster (good for video). Range: 0.5–3.0. |
| `outputPath` | string | No | auto-generated temp path | Where to save the WAV file. Always provide an explicit path in `$SHMAKK_OUTPUT_DIR/voice/` so the compositor can find the files. |

### Returns

```json
{
  "audioPath": "/path/to/output.wav",
  "voice": "af_heart",
  "durationSec": 3.4
}
```

### Available voices

Kokoro provides multiple voices. Run `tts.listVoices()` to get the full list. Common voices:

| Voice ID | Language | Gender | Character |
|----------|----------|--------|-----------|
| `af_heart` | en-us | female | Warm, natural, good default for narration |
| `af_bella` | en-us | female | Energetic, younger sounding |
| `af_nicole` | en-us | female | Calm, professional |
| `af_sarah` | en-us | female | Bright, articulate |
| `af_sky` | en-us | female | Soft, gentle |
| `am_adam` | en-us | male | Deep, authoritative |
| `am_michael` | en-us | male | Neutral, clear |
| `am_eric` | en-us | male | Friendly, casual |
| `am_jesse` | en-us | male | Relaxed, conversational |

### Voice selection strategy

- **Single narrator:** Pick one voice for all segments and use it consistently. `af_heart` (female) or `am_michael` (male) are solid defaults unless the user specifies a preference.
- **Multiple speakers:** If the storyboard narration fields contain speaker labels like `[Interviewer]: ...` and `[Speaker]: ...`, assign different voices to each role. Extract the speaker label, strip it from the text sent to TTS, and apply the assigned voice.
- **User preference:** If the user specifies a voice (e.g., "use a British female voice" or "deep male voice"), map that to the closest available Kokoro voice. If no match exists, pick the closest and note the choice in the output.

## Workflow

### Step 1: Receive the storyboard

Extract the `segments` array from the script agent's handoff. Validate that it is an array with at least one segment and that segments have non-empty `narration` fields (skip segments where narration is empty).

### Step 2: Choose voice(s)

- If the storyboard uses speaker labels, identify all unique speakers
- Assign a distinct voice to each speaker role
- If no speaker labels, pick a single voice based on:
  1. User's explicit request (if any)
  2. Content tone: energetic → `af_bella`, professional → `af_nicole`, warm → `af_heart`, authoritative → `am_adam`
  3. Default: `af_heart`

### Step 3: Create output directory

Use `make_dir` to create the output directory. The convention is:

```
output/voice/
```

All audio files go here so the compositor can reference them by path.

### Step 4: Generate audio per segment

For each segment with non-empty narration:

1. **Extract text:** If narration contains a speaker label like `"[Speaker]: text here"`, strip the label and only pass the text after the colon to TTS.
2. **Call `tts_generate`:** Pass the text, voice, and explicit output path.
3. **Name files predictably:** Use the pattern `segment-{index}.wav` (e.g., `segment-0.wav`, `segment-1.wav`). This makes it trivial for the compositor to match audio to segments.

For segments with empty narration, skip generation and mark the segment with `audioPath: null`.

### Step 5: Collect results

After all TTS calls complete, assemble the output payload:

```json
{
  "voice": "af_heart",
  "speed": 1.5,
  "segments": [
    {
      "index": 0,
      "audioPath": "output/voice/segment-0.wav",
      "durationSec": 3.4,
      "voice": "af_heart"
    },
    {
      "index": 1,
      "audioPath": "output/voice/segment-1.wav",
      "durationSec": 5.1,
      "voice": "af_heart"
    }
  ]
}
```

### Step 6: Hand off

Return this payload. The compositor will merge it with the visual agent's output to assemble the final video. Include the `durationSec` for each segment (from `tts_generate` return value) — the compositor uses this to verify timing alignment.

## Budget awareness

`tts_generate` costs 1 budget point per call. However, TTS runs locally on Kokoro (no API cost). Be mindful of:
- Each non-empty narration segment = 1 `tts_generate` call
- A 12-segment video with all narration = 12 budget points
- If budget is tight, consider whether segments with very short narration (< 10 words) can be merged with adjacent segments (coordinate with script agent — but if you already have the storyboard, proceed as-is; script changes are the script agent's responsibility)

## Edge cases

- **Empty narration (music-only segment):** Skip `tts_generate`. Set `audioPath: null` and `durationSec: null` in the output for that segment. The compositor will use the visual duration for timing.
- **Very long narration (> 75 words):** Kokoro handles it fine, but video pacing may suffer. Flag in a note but generate the audio anyway.
- **Speaker label with no colon:** Treat the entire string as narration text. If the label pattern is ambiguous, generate as-is.
- **TTS generation fails:** If a single segment fails, retry once with `speed: 1.0` (some voices handle slower speeds more reliably). If it still fails, log the error and set `audioPath: null` for that segment — the compositor can still assemble the video with silence for that segment.
- **Voice not found:** Run `tts.listVoices()` to get the available voice list. Pick the closest match by gender/language. If the user specified a voice that does not exist, explain and pick a fallback.

## Example

```bash
# After receiving storyboard, create output directory and generate audio:
make_dir output/voice/

# For each segment with narration:
tts_generate --text "Your best ideas don't wait for the right moment." \
  --voice af_heart \
  --speed 1.5 \
  --outputPath output/voice/segment-0.wav

tts_generate --text "They arrive in the shower, on a walk, or right before you fall asleep." \
  --voice af_heart \
  --speed 1.5 \
  --outputPath output/voice/segment-1.wav
```

Note: The actual `tts_generate` tool is invoked via the LLM function call interface, not shell commands. The examples above illustrate the parameter values, not the invocation syntax.
