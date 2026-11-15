---
name: video-script
description: Turn a user's video description into a timed JSON storyboard with narration text and visual cues per segment. Use when the task is to produce a structured script that will feed downstream voice-over and visual agents.
category: media
---

# Video Scripting

Convert a user's natural-language video request into a structured, timed JSON storyboard. This is the first stage of the video production pipeline — your output is handed off to the voice and visual agents.

## When to use

- User asks to create, produce, or script a video
- User provides a narrative, product description, tutorial, or explainer that needs a timed storyboard
- User gives a rough outline and asks for pacing / timing

## When not to use

- The user already has a complete, timestamped JSON storyboard
- The task is editing an existing video (skip to compositor)
- The user only wants a single image or audio clip (use imagegen or voice directly)

## Output format

Produce a JSON array of segments. Each segment is a temporal slice of the video:

```json
{
  "segments": [
    {
      "index": 0,
      "durationSec": 5.0,
      "startSec": 0.0,
      "narration": "Text for the voice-over to speak during this segment.",
      "visualDesc": "Concise, keyword-rich image prompt describing what appears on screen. Include style, mood, composition, and color cues.",
      "transition": "fade" | "cut" | "dissolve" | "wipe-left" | null
    }
  ]
}
```

### Segment field reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `index` | integer | Yes | Zero-based segment number |
| `durationSec` | number | Yes | Duration in seconds. Minimum 2.0, maximum 30.0. Must match the time the narration needs at a comfortable speaking pace (~150 words/min). |
| `startSec` | number | Yes | Cumulative start time from beginning of video |
| `narration` | string | Yes | Exact text the voice agent will speak. Keep each segment under 75 words. Use natural sentence breaks. |
| `visualDesc` | string | Yes | Visual description for the image generator. Include subject, scene, style, lighting, color palette, mood, and composition. Be specific enough that the image agent needs no clarification. |
| `transition` | string | No | How to transition INTO this segment. First segment should be `null`. Options: `"cut"`, `"fade"`, `"dissolve"`, `"wipe-left"`, `"wipe-right"`, `"wipe-up"`, `"wipe-down"`. Defaults to `"cut"`. |

## Workflow

### Step 1: Understand the user's intent

Ask yourself:
- What is the video's purpose? (demo, explainer, ad, tutorial, social media post)
- What tone does the user want? (professional, casual, energetic, calm)
- What is the target duration? If not specified, ask or infer from scope
- Is there a specific visual style? (photorealistic, 2D illustration, 3D render, flat UI mockups)
- Any brand colors, logos, or recurring motifs?

If the user provides incomplete information, ask clarifying questions before generating the storyboard. Getting the intent right here prevents rework downstream.

### Step 2: Structure the narrative arc

Map the video into a narrative flow:

1. **Hook** (first 3-5 seconds): capture attention
2. **Setup** (~15-20% of total): introduce the problem or context
3. **Solution/body** (~50-60% of total): the core content
4. **Payoff** (~15-20% of total): show the result or benefit
5. **Call to action** (last 3-5 seconds): what should the viewer do next

For very short videos (< 15 seconds), collapse this into hook → body → CTA.

### Step 3: Allocate time

- Total duration should match the user's request (default: 60 seconds if unspecified)
- Each segment duration = time needed to speak its narration at ~150 words/minute
- Round segment durations to one decimal place
- The sum of all `durationSec` values must equal the total video duration
- `startSec` must be a running total: segment N's startSec = sum of durations of segments 0 through N-1

Example timing calculation:
- Narration: "Welcome to our new productivity dashboard" (7 words)
- At 150 words/min = 2.5 words/sec → 7 words / 2.5 = ~2.8 seconds
- Round up to 3.0 seconds minimum

### Step 4: Write narration and visuals

For each segment:

**Narration rules:**
- Write natural, spoken language — not essay prose
- Each segment should be one or two complete sentences
- Avoid words that are hard to synthesize (uncommon acronyms, special symbols)
- Break at natural pause points between segments
- Maximum 75 words per segment

**Visual description rules:**
- Be specific: "A modern glass-walled office interior, natural daylight streaming through floor-to-ceiling windows, warm oak desk in foreground, minimalist decor, shallow depth of field, 4K cinematic still" — not "an office"
- Include composition cues: wide shot, close-up, overhead, split-screen
- Include mood/lighting: golden hour, moody shadows, bright and clean, neon-lit
- Include color direction: muted earth tones, vibrant neon palette, monochrome blue
- If text overlays are needed (titles, labels), explicitly include them in visualDesc: "Overlay text in bottom third: 'Introducing Dashboard v3'"
- Maintain visual consistency — all segments should feel like they belong to the same video

### Step 5: Assign transitions

- First segment: `null` (no transition into the opening)
- Between segments of the same scene/topic: `"cut"`
- For scene changes or time jumps: `"fade"` or `"dissolve"`
- For directional movement (before/after, left/right comparison): `"wipe-left"` or `"wipe-right"`
- Use sparingly. Most segments should use `"cut"` unless the transition carries meaning.

### Step 6: Validate the storyboard

Before output, check:
1. Sum of `durationSec` equals the requested total duration
2. All `startSec` values are the correct running totals
3. Every `narration` is under 75 words
4. Every `visualDesc` is sufficiently specific (25+ characters, includes style/mood cues)
5. Transitions are appropriate for the narrative flow
6. Indices are consecutive and zero-based

### Step 7: Output

Output the complete JSON as the handoff payload. Include a brief summary comment before the JSON explaining the video's narrative arc and total duration. The downstream agents expect this exact JSON structure.

## Example

User: "Create a 30-second product teaser for a new note-taking app called Scribble"

```json
{
  "segments": [
    {
      "index": 0,
      "durationSec": 3.5,
      "startSec": 0.0,
      "narration": "Your best ideas don't wait for the right moment.",
      "visualDesc": "Cinematic close-up of a person staring at a blank notebook page, soft morning light, shallow depth of field, muted warm tones, contemplative mood",
      "transition": null
    },
    {
      "index": 1,
      "durationSec": 5.0,
      "startSec": 3.5,
      "narration": "They arrive in the shower, on a walk, or right before you fall asleep.",
      "visualDesc": "Montage split into three panels: shower steam silhouette, tree-lined walking path at golden hour, bedroom with nightstand clock showing 2:47 AM. Soft transitions between panels. Warm consistent palette.",
      "transition": "dissolve"
    },
    {
      "index": 2,
      "durationSec": 6.0,
      "startSec": 8.5,
      "narration": "Scribble captures them instantly. One tap, speak your thought, and it is saved, organized, and searchable forever.",
      "visualDesc": "Phone screen mockup showing the Scribble app interface. Hand taps the record button, voice waveform animates, the transcribed note appears organized in a clean list. Modern flat UI design, navy and coral color scheme, bright clean lighting.",
      "transition": "cut"
    },
    {
      "index": 3,
      "durationSec": 5.0,
      "startSec": 14.5,
      "narration": "No folders. No friction. Just your mind, unblocked.",
      "visualDesc": "Overhead shot of a desk with a phone displaying Scribble app, a coffee cup, and a plant. The phone glows softly. Clean minimalist composition, natural daylight, warm wood textures.",
      "transition": "dissolve"
    },
    {
      "index": 4,
      "durationSec": 4.5,
      "startSec": 19.5,
      "narration": "Your ideas deserve better than a forgotten notes app. Try Scribble today.",
      "visualDesc": "App icon centered on screen with the Scribble logo, coral gradient background. Text overlay bottom third: 'Available on iOS and Android'. Clean product-hero composition, bright and inviting.",
      "transition": "fade"
    },
    {
      "index": 5,
      "durationSec": 3.0,
      "startSec": 24.0,
      "narration": "",
      "visualDesc": "Scribble logo on clean white background with tagline 'Capture everything.' centered below. Fade to black at end.",
      "transition": "cut"
    }
  ]
}
```

## Edge cases

- **Very short video (< 10 seconds):** Limit to 2-3 segments. Combine hook and CTA into the same segment.
- **No voice-over (music-only):** Set `narration` to empty string `""` for all segments. Still allocate time for the visual pacing.
- **Multiple speakers / dialogue:** Note the speaker in the narration field like `"[Interviewer]: Tell us about your process."` and `"[Speaker]: I start with research."` — the voice agent can assign different voices to different speaker labels.
- **Text-heavy video (titles, captions only):** Include all text in `visualDesc` as overlay instructions. Set `narration` to empty if there is no spoken audio.

## Budget awareness

This agent is a scripting role — it does not consume budget for image generation or TTS. It only costs the LLM call. However, be mindful:
- More segments = more downstream tool calls (each segment triggers at least one `image_gen` and one `tts_generate` call)
- For a 60-second video, aim for 6-12 segments
- For a 30-second video, aim for 4-8 segments
- Each segment adds ~2 budget points downstream (image + voice), so keep the segment count proportional to the video length
