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
  SHMAKK_SECONDARY_BASE_URL       Optional secondary provider base URL
  SHMAKK_SECONDARY_API_KEY        Optional secondary provider API key
  SHMAKK_SECONDARY_MODEL          Optional secondary provider default model
  SHMAKK_SECONDARY_HEADERS        Optional secondary provider headers (k=v,k=v)
  SHMAKK_CORRECTION_MODEL         Model used for command correction
  SHMAKK_AGENT_MODEL              Model used for tasks
  SHMAKK_CHAT_MODEL               Model used for chat
  SHMAKK_CORRECTION_PROVIDER      Route correction lane: primary|secondary
  SHMAKK_AGENT_PROVIDER           Route agent lane: primary|secondary
  SHMAKK_CHAT_PROVIDER            Route chat lane: primary|secondary
  SHMAKK_HEADERS                  Comma-separated extra headers (k=v,k=v)
`;

module.exports = { parseArgs, HELP };
