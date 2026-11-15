---
name: video-compose
description: Assemble video segments from images, audio, and transitions into a final MP4. Receives the merged outputs from the voice and visual agents and uses video_compose and video_concat to produce the final video file. Part of the video production pipeline.
category: media
---

# Video Compositor

The final stage of the video production pipeline. You receive the merged outputs from the voice and visual agents — a list of segments each with an image path, audio path, duration, and transition. Your job is to turn these into a single, synchronized MP4 video using `video_compose` and `video_concat`.

## When to use

- You receive the merged handoff from the voice and visual agents
- You are the compositor in the video production pipeline
- The user asks to assemble, render, or export the final video

## When not to use

- The script has not been written yet (wait for the script agent)
- Audio or images are still being generated (wait for voice and visual agents)
- The user wants to edit individual assets (that is upstream)

## Input format

You receive a merged segments array where each segment has paths to its audio and image assets:

```json
{
  "segments": [
    {
      "index": 0,
      "durationSec": 3.5,
      "startSec": 0.0,
      "narration": "Your best ideas don't wait for the right moment.",
      "audioPath": "output/voice/segment-0.wav",
      "imagePath": "output/images/segment-0.png",
      "transition": null
    },
    {
      "index": 1,
      "durationSec": 5.0,
      "startSec": 3.5,
      "narration": "They arrive in the shower...",
      "audioPath": "output/voice/segment-1.wav",
      "imagePath": "output/images/segment-1.png",
      "transition": "dissolve"
    }
  ]
}
```

## Tools

### `video_probe`

Get metadata about a media file: duration, codec, resolution, frame rate, sample rate.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the media file (image, audio, or video) |

**Returns:**

```json
{
  "durationSec": 5.03,
  "width": 1920,
  "height": 1080,
  "codec": "h264",
  "fps": 30,
  "audioCodec": "aac",
  "audioSampleRate": 44100,
  "format": "mp4"
}
```

Wraps `ffprobe -v quiet -print_format json -show_format -show_streams <path>`.

**When to use:**
- Before composing: verify all images are consistent resolution. If they vary, the compositor needs to normalize them.
- Before composing: verify audio durations match expected segment durations. If an audio clip is shorter or longer than the segment, adjust accordingly.
- After composing: verify the output video has the expected duration and codec.

### `video_compose`

Assemble a single video segment from an image, optional audio, and optional transition. Builds the ffmpeg filtergraph from structured parameters.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `imagePath` | string | Yes | Path to the still image for this segment |
| `audioPath` | string | No | Path to the WAV audio file. Omit for silent segments. |
| `durationSec` | number | Yes | Duration this segment should last in seconds |
| `outputPath` | string | Yes | Where to write the rendered segment (intermediate MP4) |
| `width` | number | No | Output width in pixels. Default: 1920 |
| `height` | number | No | Output height in pixels. Default: 1080 |
| `fps` | number | No | Frame rate. Default: 30 |
| `transition` | string | No | Transition type to apply at the START of this segment. Options: `"fade-in"`, `"dissolve"`, `"wipe-left"`, `"wipe-right"`, `"wipe-up"`, `"wipe-down"`. Default: none (hard cut). |
| `transitionDurationSec` | number | No | How long the transition lasts. Default: 0.5 seconds. Must be less than `durationSec`. |
| `zoomEffect` | string | No | Apply Ken Burns-style slow zoom. Options: `"in"`, `"out"`. Default: none. |
| `textOverlay` | object | No | Burn text onto the video. Object with `text`, `position` ("top", "bottom", "center"), `fontSize`, `color`. |
| `codec` | string | No | Video codec. Default: `"libx264"`. |
| `crf` | number | No | Quality (0-51, lower is better). Default: 23. |

**What it does internally:**

Builds an ffmpeg command like:

```bash
ffmpeg -loop 1 -i image.png -i audio.wav \
  -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p,fade=t=in:d=0.5[v]" \
  -map "[v]" -map 1:a \
  -t 5.0 -r 30 -c:v libx264 -crf 23 -pix_fmt yuv420p -shortest \
  output.mp4
```

For segments with transitions, it adds the appropriate filter (fade, wipe, etc.) to the filtergraph.

**Returns:**

```json
{
  "outputPath": "output/rendered/segment-0.mp4",
  "durationSec": 5.0,
  "size": 1048576
}
```

### `video_concat`

Concatenate rendered segment MP4s into the final video file. Uses the ffmpeg concat demuxer for lossless joining.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputPaths` | string[] | Yes | Ordered list of segment MP4 paths to concatenate |
| `outputPath` | string | Yes | Where to write the final video |
| `codec` | string | No | Video codec. Default: `"libx264"`. |
| `crf` | number | No | Quality. Default: 23. |
| `addSilentAudio` | boolean | No | If true, adds a silent audio track to segments that have no audio, ensuring consistent stream count. Default: true. |

**What it does internally:**

1. Creates a temporary concat file listing all input paths
2. Runs: `ffmpeg -f concat -safe 0 -i concat-list.txt -c copy output.mp4`
3. If segments have mismatched codecs/resolutions, falls back to re-encoding: `ffmpeg -f concat -safe 0 -i concat-list.txt -c:v libx264 -crf 23 output.mp4`

**Returns:**

```json
{
  "outputPath": "output/final.mp4",
  "durationSec": 30.0,
  "size": 5242880
}
```

## Workflow

### Step 1: Receive and validate input

Check that the merged segments array:
- Is non-empty
- Every segment has at least `imagePath` (audioPath can be null for silent segments)
- All file paths exist on disk (use `video_probe` or `list_dir` to verify)
- Durations are consistent with audio clip lengths

If validation fails, report which segments are missing assets and ask the user or upstream agents to fix them.

### Step 2: Probe and normalize

Run `video_probe` on each image and audio file to collect:
- Image dimensions (width, height)
- Audio duration

**Normalization decisions:**

- **Resolution:** If images vary in size, pick the most common resolution (or user-specified resolution) and note that `video_compose` will scale/pad all images to match.
- **Audio alignment:** If an audio clip is shorter than the segment `durationSec`, the segment will have silence at the end (ffmpeg handles this with `-shortest`). If it is longer, the segment will truncate. Flag segments where audio and planned duration differ by more than 0.5 seconds — this may indicate a timing issue from the script agent.
- **File format:** Ensure all images are PNG or JPG and all audio is WAV. If not, convert them using the `run` tool with ffmpeg before composing.

### Step 3: Compose each segment

For each segment in order:

1. Determine the effective duration. Use `audioDuration` from probe if available, falling back to `durationSec` from the storyboard.
2. Call `video_compose` with:
   - `imagePath`: the segment's image
   - `audioPath`: the segment's audio (omit if null)
   - `durationSec`: the effective duration
   - `transition`: convert the storyboard's `transition` field. The storyboard specifies transitions *entering* a segment, so segment 0 gets no transition, segment 1 with `"dissolve"` gets `transition: "dissolve"` with `transitionDurationSec: 0.5`.
   - `outputPath`: `output/rendered/segment-{index}.mp4`
3. If the user requested a zoom effect (Ken Burns), add `zoomEffect: "in"` or `zoomEffect: "out"` — alternate between segments for visual variety, or use `"in"` for the first segment and `"out"` for the last.
4. If any segment has text overlays (detected from storyboard visualDesc mentioning "text overlay" or "overlay text"), extract the overlay text and position and pass via `textOverlay`.

### Step 4: Concatenate segments

Once all segments are rendered:

1. Collect all rendered segment paths in index order
2. Call `video_concat` with:
   - `inputPaths`: the ordered list of segment MP4s
   - `outputPath`: `output/final.mp4` (or user-specified name)
   - `addSilentAudio`: `true` (ensures segments without audio still play correctly in the concat)

### Step 5: Verify the output

Run `video_probe` on the final video and verify:
- Duration matches the sum of segment durations (within 0.1 seconds tolerance)
- Resolution matches the target
- File size is reasonable (not zero bytes, not absurdly large)

### Step 6: Clean up intermediates

By default, keep intermediate rendered segments so the user can inspect or re-use them. If the user asks to clean up, use `delete_file` to remove the `output/rendered/` directory.

### Step 7: Report the result

Output a summary:

```
Video rendered: output/final.mp4
Duration: 30.0 seconds
Resolution: 1920x1080
Size: 5.2 MB
Segments: 6
```

Include the final output path so the user knows where to find the video.

## Transition mapping

The storyboard uses these transition values. Map them to `video_compose` transitions:

| Storyboard transition | `video_compose` transition | ffmpeg filter |
|-----------------------|---------------------------|---------------|
| `null` or first segment | none | — |
| `"cut"` | none | — |
| `"fade"` | `"fade-in"` | `fade=t=in:d=0.5` |
| `"dissolve"` | `"dissolve"` | `fade=t=in:d=0.5` (applied over crossfade when concatenating) |
| `"wipe-left"` | `"wipe-left"` | custom wipe filter |
| `"wipe-right"` | `"wipe-right"` | custom wipe filter |
| `"wipe-up"` | `"wipe-up"` | custom wipe filter |
| `"wipe-down"` | `"wipe-down"` | custom wipe filter |

## Example

Given a 6-segment storyboard with merged assets:

```bash
# Step 2: Probe assets
video_probe output/images/segment-0.png
# → { "width": 1920, "height": 1080 }

video_probe output/voice/segment-0.wav
# → { "durationSec": 3.48 }

# Step 3: Compose each segment
video_compose \
  --imagePath output/images/segment-0.png \
  --audioPath output/voice/segment-0.wav \
  --durationSec 3.5 \
  --outputPath output/rendered/segment-0.mp4

video_compose \
  --imagePath output/images/segment-1.png \
  --audioPath output/voice/segment-1.wav \
  --durationSec 5.0 \
  --transition dissolve \
  --transitionDurationSec 0.5 \
  --outputPath output/rendered/segment-1.mp4

# ... repeat for remaining segments ...

# Step 4: Concatenate
video_concat \
  --inputPaths output/rendered/segment-0.mp4,output/rendered/segment-1.mp4,... \
  --outputPath output/final.mp4

# Step 5: Verify
video_probe output/final.mp4
# → { "durationSec": 30.0, "width": 1920, "height": 1080, "codec": "h264" }
```

Note: These are illustrative. Actual tool invocation is through the LLM function call interface, not shell commands.

## Resolution and aspect ratio

Unless the user specifies otherwise:
- **Default resolution:** 1920x1080 (16:9 landscape)
- **Social media:** 1080x1920 (9:16 vertical for TikTok/Reels/Shorts), 1080x1080 (1:1 square for Instagram)
- **Presentation:** 1920x1080 (16:9)

`video_compose` automatically scales images to fit the target resolution, adding letterbox/pillarbox padding as needed (`force_original_aspect_ratio=decrease` + `pad`). This means images of any aspect ratio produce a clean result without stretching.

## Budget awareness

- `video_compose` costs 1 budget point per segment
- `video_concat` costs 1 budget point for the final join
- `video_probe` costs 1 budget point per call (use sparingly — probe a few representative files, not every frame)
- All three wrap ffmpeg (local), so no API costs
- A 12-segment video: ~12 compose calls + 1 concat + 2-3 probes = ~16 budget points for compositing alone

## Error recovery

- **Segment compose fails:** Check if the image or audio path is valid. Retry once. If it still fails, skip the segment and note it in the output — the concat will have a gap.
- **Concat fails with codec mismatch:** Re-run `video_concat` with an explicit codec (`codec: "libx264"`) to force re-encoding instead of stream copy.
- **Audio/video duration mismatch:** ffmpeg's `-shortest` flag in `video_compose` handles this automatically — the segment ends when the shorter stream (usually audio) finishes.
- **Out of disk space:** Check available space before starting. A 60-second 1080p video at CRF 23 is roughly 30-80 MB. Warn the user if free space is under 200 MB.

## Coordination with upstream agents

The compositor runs after both voice and visual agents complete. The merged segments arrive via pipeline handoff. If either upstream agent failed for some segments:
- Missing audio: render the segment as silent (video only)
- Missing image: use a black/color background with text overlay showing the segment's narration or index
- Both missing: render a 2-second black frame with the segment index as text so the user can see what to fix
