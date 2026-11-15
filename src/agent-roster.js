// Additional agent roster entries for media/video production roles.
//
// These extend the main AGENT_ROSTER in src/team.js with specialist roles
// for the video production pipeline: script writing and video compositing.
//
// The voice and visual roles are handled by the existing media-video-voice
// and media-imagegen skills respectively.
//
// Each entry maps to a skill file in the skills/ directory:
//   script     → skills/media-video-script.md
//   compositor → skills/media-video-compose.md

const AGENT_ROSTER_EXTENSIONS = {
  script: {
    profile: 'deep',
    hint: `Specialist: Video Script Writer
Focus: turning user prompts into structured timed storyboards for video production.
Guidelines:
- Output valid JSON: an array of segments, each with startTime, endTime, narration, visualDesc.
- startTime/endTime in seconds (floating-point). Total duration must match user request.
- narration: conversational text suitable for TTS. Keep each segment under 30 seconds of speech (~75 words max).
- visualDesc: detailed visual prompt for image generation. Describe scene, style, composition, color palette.
- Match the user's requested tone, pacing, and style. For explainer videos, prefer clear logical flow. For demos, prefer step-by-step walkthrough.
- If duration or segment count is unclear, ask before finalizing.`,
    skill: 'media-video-script',
  },

  compositor: {
    profile: 'builder',
    hint: `Specialist: Video Compositor
Tools: video_compose (assemble clips/images/audio into a segment), video_concat (join rendered segments), video_probe (inspect metadata).
Focus: assembling audio, images, and transitions into a final video file.
Guidelines:
- Read the script agent's output first — it defines the timeline and assets per segment.
- For each segment: call video_compose with the image path, audio path, startTime, and endTime to render that segment.
- Use video_probe to verify audio duration and image dimensions before composing.
- After all segments are rendered, call video_concat to join them into the final output.
- Transitions: prefer crossfade (0.3–0.5s) between segments unless otherwise specified.
- Output format: H.264 video (libx264), AAC audio, .mp4 container. Match the first segment's resolution.
- If an asset is missing or has wrong duration, report the exact segment and path — do not silently skip.
- Verify the final output with video_probe: check total duration matches expected.`,
    skill: 'media-video-compose',
  },
};

// Role-to-skill mapping for these extensions. Used by src/team.js to look up
// skill files that provide the full agent instructions.
const ROLE_TO_SKILL_EXTENSIONS = {
  script: 'media-video-script',
  compositor: 'media-video-compose',
};

module.exports = { AGENT_ROSTER_EXTENSIONS, ROLE_TO_SKILL_EXTENSIONS };
