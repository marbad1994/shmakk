#!/usr/bin/env node
// Standalone test: capture the screen (and microphone) for N seconds, then
// finalize and print a summary of the recorded media.
//
// Usage: node scripts/test-capture.js [seconds]
// Examples:
//   node scripts/test-capture.js            # record 5 seconds
//   node scripts/test-capture.js 10         # record 10 seconds
//
// On Wayland this drives the ScreenCast portal (PipeWire + gstreamer), the only
// correct way to capture a composited desktop. The FIRST capture shows a
// one-time KDE "Share" dialog; the choice is remembered via a restore token, so
// every run after that is fully automatic.

const { detect, createSession, captureDir } = require('../src/services/capture');

const args = process.argv.slice(2);
let seconds = 5;
for (const a of args) {
  const n = Number(a);
  if (!Number.isNaN(n) && n > 0) seconds = n;
}

(async () => {
  const info = detect();
  console.log('capture detect');
  console.log(`  available : ${info.available}`);
  console.log(`  platform  : ${info.platform} (session ${info.sessionType || 'unknown'})`);
  console.log(`  video     : ${info.video ? `${info.video.backend} - ${info.video.label}` : '(none)'}`);
  console.log(`  audio     : ${info.audio ? `${info.audio.backend} - ${info.audio.label}` : '(none)'}`);
  if (info.reasons && info.reasons.length) console.log(`  reasons   : ${info.reasons.join('; ')}`);
  console.log('');

  if (!info.available || !info.video) {
    console.error('Capture is not available on this machine.');
    process.exit(1);
  }

  if (info.video.backend === 'pipewire') {
    const tokenPath = `${captureDir()}/screencast.restore`;
    if (!require('fs').existsSync(tokenPath)) {
      console.log('NOTE: the first PipeWire capture shows a KDE "Share" dialog.');
      console.log('      Approve it once; it will be remembered for later runs.\n');
    }
  }

  const session = createSession({});
  console.log(`Recording ${seconds}s...`);
  const t0 = Date.now();
  await session.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await session.stop();
  const manifest = await session.finalize();
  const elapsed = Math.round((Date.now() - t0) / 100) / 10;

  console.log(`\nDone in ${elapsed}s`);
  console.log(`  state     : ${manifest.state}`);
  console.log(`  id        : ${manifest.id}`);
  const streams = (manifest.media && manifest.media.streams) || [];
  for (const st of streams) {
    const dims = st.codec_type === 'video'
      ? `${st.width || '?'}x${st.height || '?'}`
      : `${st.sample_rate || '?'}Hz`;
    console.log(`  stream    : ${st.codec_type} ${st.codec_name || '?'} ${dims}`);
  }
  if (manifest.media && manifest.media.format && manifest.media.format.duration) {
    console.log(`  duration  : ${manifest.media.format.duration}s`);
  }
  console.log(`  frames    : ${manifest.frameCount}  audioBlocks: ${manifest.audioBlocks}`);
  console.log(`  output    : ${manifest.paths.muxed}`);
  if (manifest.error) console.log(`  error     : ${manifest.error}`);

  process.exit(manifest.state === 'error' ? 1 : 0);
})().catch((err) => {
  console.error('Capture failed:', err.message);
  process.exit(1);
});
