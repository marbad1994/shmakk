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
      case '--colors': opts.colors = argv[++i] || null; break;
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
  --colors <true|false>           Toggle colored logs and code-block highlighting
  --debug                         Verbose logging to stderr
  --print-config                  Print resolved configuration and exit

Environment:
  SHMAKK_BASE_URL                 OpenAI-compatible base URL
  SHMAKK_API_KEY                  API key
  SHMAKK_MODEL                    Default model
  SHMAKK_HEADERS                  Comma-separated extra headers (k=v,k=v)
`;

module.exports = { parseArgs, HELP };
