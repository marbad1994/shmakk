const { parseArgs, HELP } = require('./cli');
const { normalizeProfile, resolveProfile } = require('./profiles');
const { applyEndpoint } = require('./endpoints');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Apply named endpoint preset from .shmakk/endpoints.json before
  // any other module reads SHMAKK_* environment variables.
  if (opts.endpoint) {
    const cwd = opts.workspace || process.cwd();
    if (!applyEndpoint(opts.endpoint, cwd)) {
      process.stderr.write(`[shmakk] endpoint "${opts.endpoint}" not found in ${path.join(cwd, '.shmakk', 'endpoints.json')}\n`);
    }
  }

  if (opts.colors !== null) {
    const v = String(opts.colors).toLowerCase();
    if (v !== 'true' && v !== 'false') {
      process.stderr.write('[shmakk] invalid --colors. Use: true|false\n');
      process.exit(2);
    }
    opts.colors = v === 'true';
  }

  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (opts.completion) {
    const { generate } = require('./completions');
    try {
      process.stdout.write(generate(opts.completion));
      process.exit(0);
    } catch (e) {
      process.stderr.write(`[shmakk] ${e.message}\n`);
      process.exit(1);
    }
  }

  if (opts.printConfig) {
    const profile = resolveProfile(opts.profile || process.env.SHMAKK_PROFILE);
    const cfg = {
      review: opts.review,
      yesFiles: opts.yesFiles,
      noAi: opts.noAi,
      noCorrection: opts.noCorrection,
      workspace: opts.workspace || process.cwd(),
      shell: process.env.SHELL,
      term: process.env.TERM,
      baseUrl: process.env.SHMAKK_BASE_URL || null,
      model: process.env.SHMAKK_MODEL || null,
      endpoint: opts.endpoint || null,
      profile: profile.name,
      colors: opts.colors,
      stt: opts.stt,
      tts: opts.tts,
      sts: opts.sts,
    };
    process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
    process.exit(0);
  }

  if (opts.updateGlossary) {
    const { updateGlossary } = require('./glossary');
    await updateGlossary({ debug: opts.debug });
    process.exit(0);
  }

  if (opts.buildHistory !== null) {
    const hist = require('./history-parser');
    const files = opts.buildHistory && opts.buildHistory.length
      ? opts.buildHistory
      : hist.autoDetectHistoryFiles();
    if (!files.length) {
      process.stderr.write('[shmakk] no history files found. Specify paths: shmakk --build-history ~/.bash_history ...\n');
      process.exit(1);
    }
    process.stdout.write(`[shmakk] parsing ${files.length} history file(s)...\n`);
    for (const f of files) process.stdout.write(`  ${f}\n`);
    const freqMap = hist.buildFreqMap(files);
    const count = Object.keys(freqMap).length;
    const total = Object.values(freqMap).reduce((a, b) => a + b, 0);
    const saved = hist.saveFreqMap(freqMap);
    process.stdout.write(`[shmakk] built frequency map: ${count} unique commands, ${total} total uses\n`);
    process.stdout.write(`[shmakk] saved to: ${saved}\n`);
    process.exit(0);
  }

  if (opts.status || opts.stats || opts.compact || opts.loadSkill || opts.installSkill || opts.listSkills || opts.skillStatus || opts.unloadSkill || opts.resumeStatus || opts.exitNow || opts.restart || opts.reset || opts.profileSet) {
    const ctl = require('./control');
    if (opts.status) process.exit(ctl.status());
    if (opts.stats) process.exit(ctl.stats());
    if (opts.compact) process.exit(ctl.compactContext());
    if (opts.loadSkill) process.exit(ctl.loadSkill(opts.loadSkill));
    if (opts.installSkill) process.exit(await ctl.installSkill(opts.installSkill));
    if (opts.listSkills) process.exit(ctl.listSkills());
    if (opts.skillStatus) process.exit(ctl.skillStatus());
    if (opts.unloadSkill) process.exit(ctl.unloadSkill(opts.unloadSkill));
    if (opts.resumeStatus) process.exit(ctl.resumeStatus());
    if (opts.exitNow) process.exit(ctl.exitParent());
    if (opts.restart) process.exit(ctl.restartParent());
    if (opts.reset) process.exit(ctl.resetConversation());
    if (opts.profileSet) process.exit(ctl.setProfileAndRestart(opts.profileSet));
  }

  if (opts.profile && !normalizeProfile(opts.profile)) {
    process.stderr.write('[shmakk] invalid --profile. Use: tiny|balanced|deep|builder|large-app\n');
    process.exit(2);
  }

  if (opts.unknown.length) {
    process.stderr.write(`[shmakk] unknown args: ${opts.unknown.join(' ')}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  // Lazy-init STT/TTS models if flags are set (model downloads happen on first use)
  if (opts.stt || opts.tts || opts.sts) {
    const initTasks = [];
    if (opts.stt || opts.sts) {
      const { _ensureModel } = require('./services/stt');
      initTasks.push(
        _ensureModel().then(() => process.stdout.write('[shmakk] STT ready (Whisper ONNX)\n')),
      );
    }
    if (opts.tts || opts.sts) {
      const tts = require('./services/tts');
      const voice = opts.ttsVoice || process.env.SHMAKK_TTS_VOICE || 'af_heart';
      initTasks.push(
        tts.listVoices().then(() => process.stdout.write(`[shmakk] TTS ready (Kokoro ONNX, voice=${voice})\n`)),
      );
    }
    // Don't block startup — models download in background
    Promise.allSettled(initTasks).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') {
          process.stderr.write(`[shmakk] voice init: ${r.reason?.message || r.reason}\n`);
        }
      }
    });
  }

  // Pre-seed SHMAKK_VOICE_* env vars from CLI flags before voice module loads.
  // voice.js reads these at require-time; orchestrator → session → getVoiceService().
  if (opts.voiceLanguage) process.env.SHMAKK_VOICE_LANGUAGE = opts.voiceLanguage;
  if (opts.voiceMaxDuration) process.env.SHMAKK_VOICE_MAX_SEC = String(opts.voiceMaxDuration);
  if (opts.voiceSilenceSec) process.env.SHMAKK_VOICE_SILENCE_SEC = opts.voiceSilenceSec;
  if (opts.voiceSilenceThreshold) process.env.SHMAKK_VOICE_SILENCE_THRESHOLD = opts.voiceSilenceThreshold;
  if (opts.voiceSilenceStartSec) process.env.SHMAKK_VOICE_SILENCE_START_SEC = opts.voiceSilenceStartSec;
  if (opts.voicePadStartSec) process.env.SHMAKK_VOICE_PAD_START_SEC = opts.voicePadStartSec;
  if (opts.ttsVoice) process.env.SHMAKK_TTS_VOICE = opts.ttsVoice;

  const { start } = require('./orchestrator');
  const exitCode = await start(opts);
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[shmakk] fatal: ${err && err.stack || err}\n`);
  process.exit(1);
});
