function parseArgs(argv) {
  const opts = {
    review: false,
    yesFiles: false,
    updateGlossary: false,
    help: false,
    debug: false,
    workspace: null,
    noAi: false,
    noCorrection: false,
    printConfig: false,
    status: false,
    buildHistory: null,
    stats: false,
    compact: false,
    loadSkill: null,
    listSkills: false,
    skillStatus: false,
    unloadSkill: null,
    installSkill: null,
    resumeStatus: false,
    exitNow: false,
    restart: false,
    profile: null,
    profileSet: null,
    colors: null,
    endpoint: null,
    voice: false,
    stt: false,
    tts: false,
    sts: false,
    voiceLanguage: null,
    voiceMaxDuration: null,
    voiceSilenceSec: null,
    voiceSilenceThreshold: null,
    voiceSilenceStartSec: null,
    voicePadStartSec: null,
    ttsVoice: null,
    completion: null,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--review': opts.review = true; break;
      case '--yes-files': opts.yesFiles = true; break;
      case '--update-command-glossary': opts.updateGlossary = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      case '--debug': opts.debug = true; break;
      case '--no-ai': opts.noAi = true; break;
      case '--no-correction': opts.noCorrection = true; break;
      case '--print-config': opts.printConfig = true; break;
      case '--workspace': opts.workspace = argv[++i] || null; break;
      case '--status': opts.status = true; break;
      case '--stats': opts.stats = true; break;
      case '--compact': opts.compact = true; break;
      case '--load-skill': opts.loadSkill = argv[++i] || null; break;
      case '--list-skills': opts.listSkills = true; break;
      case '--skill-status': opts.skillStatus = true; break;
      case '--unload-skill': opts.unloadSkill = argv[++i] || null; break;
      case '--install-skill': opts.installSkill = argv[++i] || null; break;
      case '--resume-status': opts.resumeStatus = true; break;
      case '--exit': opts.exitNow = true; break;
      case '--restart': opts.restart = true; break;
      case '--reset': opts.reset = true; break;
      case '--profile': opts.profile = argv[++i] || null; break;
      case '--profile-set': opts.profileSet = argv[++i] || null; break;
      case '--build-history':
        opts.buildHistory = [];
        // Collect remaining args as file paths until next flag
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          opts.buildHistory.push(argv[++i]);
        }
        if (!opts.buildHistory.length) opts.buildHistory = null; // flag with no files = auto-detect
        break;
      case '--stt': opts.stt = true; opts.voice = true; break;
      case '--tts': opts.tts = true; break;
      case '--sts': opts.sts = true; opts.stt = true; opts.tts = true; opts.voice = true; break;
      case '--voice': opts.stt = true; opts.voice = true; break;
      case '--voice-language': opts.voiceLanguage = argv[++i] || null; break;
      case '--voice-max-sec': opts.voiceMaxDuration = parseInt(argv[++i], 10) || null; break;
      case '--voice-silence-sec': opts.voiceSilenceSec = argv[++i] || null; break;
      case '--voice-silence-threshold': opts.voiceSilenceThreshold = argv[++i] || null; break;
      case '--voice-silence-start-sec': opts.voiceSilenceStartSec = argv[++i] || null; break;
      case '--voice-pad-start-sec': opts.voicePadStartSec = argv[++i] || null; break;
      case '--tts-voice': opts.ttsVoice = argv[++i] || null; break;
      case '--completion': opts.completion = argv[++i] || null; break;
      case '--colors': opts.colors = argv[++i] || null; break;
      case '--endpoint': opts.endpoint = argv[++i] || null; break;
      default: opts.unknown.push(a);
    }
  }
  return opts;
}

const HELP = `shmakk - AI-supervised terminal wrapper

Usage:
  shmakk                          Launch in auto mode
  shmakk --review                 Launch in review mode (confirm every AI action)
  shmakk --yes-files              Auto-accept AI file writes, edits, and directory creation
  shmakk --update-command-glossary
                                  Scan PATH and build local command glossary
  shmakk --help                   Show this help
  shmakk --build-history [files...]
                                  Parse shell history files and build command
                                  frequency map for better corrections.
                                  Auto-detects bash/zsh/fish history if no
                                  files given.

Control (run from inside an shmakk session):
  shmakk --status                 Show whether this terminal is inside shmakk
  shmakk --stats                  Show session/task stats (journal, audit, active skill)
  shmakk --compact                Compact context by clearing conversation + task journal
  shmakk --load-skill <name>      Load a Claude/Codex-style skill into shmakk workspace state
  shmakk --list-skills            List registered local skills
  shmakk --skill-status           Show active skill and registry status
  shmakk --unload-skill <name>    Remove skill from registry/local cache
  shmakk --install-skill <url>    Download skill markdown from URL, validate, and load
  shmakk --resume-status          Show task journal summary for resume continuity
  shmakk --exit                   Cleanly exit the parent shmakk
  shmakk --restart                Restart the inner shell (preserves window)
  shmakk --reset                  Clear the AI conversation history (keep session)
  shmakk --profile-set <name>     Switch profile and restart (tiny|balanced|deep|builder|large-app)
  shmakk --colors <true|false>    Enable or disable ANSI colors + code highlighting

Optional:
  --no-ai                         Disable AI entirely (pure passthrough)
  --no-correction                 Disable command correction
  --yes-files                     Auto-accept write_file, edit_file, and make_dir in auto mode
  --workspace <path>              Override workspace root
  --profile <name>                Startup profile: tiny|balanced|deep|builder|large-app
  --endpoint <name>               Use endpoint preset from .shmakk/endpoints.json
  --colors <true|false>           Toggle colored logs and code-block highlighting
  --debug                         Verbose logging to stderr
  --print-config                  Print resolved configuration and exit

Speech-to-Text / Text-to-Speech (VAD-based, no hotkeys):
  --sts                           Speech-to-Speech: always-on mic + TTS responses
  --stt                           Speech-to-Text: mic → text input (no TTS)
  --tts                           Text-to-Speech: text input → spoken responses
  --voice-language <code>         Language hint (e.g., en, es, fr)
  --voice-max-sec <sec>           Max recording duration (default: 30)
  --voice-silence-sec <sec>       VAD silence before stopping (default: 1.0)
  --voice-silence-threshold <%>   VAD amplitude threshold (default: 1%)
  --voice-silence-start-sec <sec> Seconds of sound before starting (default: 0.5)
  --voice-pad-start-sec <sec>     Padding added to start of recording (default: 0.3)
  --tts-voice <name>              Override rotated voice schedule (default: af_heart)
  --completion <bash|zsh|fish>    Output shell tab-completion script

  Voice uses Whisper-base ONNX in-process. No Python, no server, no API key.
  Model auto-downloads on first use.

  TTS uses kokoro-js (Kokoro-82M ONNX, ~334MB fp16). Model auto-downloads on first use.
  Requires: aplay, paplay, or afplay for audio playback.
  All 28 Kokoro voices rotate automatically on a daily schedule.

Voice environment:
  SHMAKK_HF_CACHE                 HuggingFace cache directory override
  SHMAKK_TTS_VOICE                Pin a specific TTS voice (default: auto-rotated)
  SHMAKK_TTS_DTYPE                Kokoro dtype: fp32, fp16, q8, q4, q4f16 (default: fp16)
  SHMAKK_VOICE_LANGUAGE           Language hint for STT (e.g., en, es, fr)
  SHMAKK_VOICE_MAX_SEC            Max recording seconds (default: 30)
  SHMAKK_VOICE_SILENCE_SEC        VAD silence threshold seconds (default: 1.0)
  SHMAKK_VOICE_SILENCE_THRESHOLD  VAD amplitude threshold (default: 1%)
  SHMAKK_VOICE_PAD_START_SEC      Padding added to start of recording (default: 0.3)

Environment:
  SHMAKK_BASE_URL                 OpenAI-compatible base URL
  SHMAKK_API_KEY                  API key
  SHMAKK_MODEL                    Default model
  SHMAKK_HEADERS                  Comma-separated extra headers (k=v,k=v)
`;

module.exports = { parseArgs, HELP };
