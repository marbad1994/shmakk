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
    exitNow: false,
    restart: false,
    profile: null,
    profileSet: null,
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
      case '--exit': opts.exitNow = true; break;
      case '--restart': opts.restart = true; break;
      case '--reset': opts.reset = true; break;
      case '--profile': opts.profile = argv[++i] || null; break;
      case '--profile-set': opts.profileSet = argv[++i] || null; break;
      default: opts.unknown.push(a);
    }
  }
  return opts;
}

const HELP = `aiterm - AI-supervised terminal wrapper

Usage:
  aiterm                          Launch in auto mode
  aiterm --review                 Launch in review mode (confirm every AI action)
  aiterm --yes-files              Auto-accept AI file and directory creation
  aiterm --update-command-glossary
                                  Scan PATH and build local command glossary
  aiterm --help                   Show this help

Control (run from inside an aiterm session):
  aiterm --status                 Show whether this terminal is inside aiterm
  aiterm --exit                   Cleanly exit the parent aiterm
  aiterm --restart                Restart the inner shell (preserves window)
  aiterm --reset                  Clear the AI conversation history (keep session)
  aiterm --profile-set <name>     Switch profile and restart (tiny|balanced|deep)

Optional:
  --no-ai                         Disable AI entirely (pure passthrough)
  --no-correction                 Disable command correction
  --yes-files                     Auto-accept write_file and make_dir in auto mode
  --workspace <path>              Override workspace root
  --profile <name>                Startup profile: tiny|balanced|deep
  --debug                         Verbose logging to stderr
  --print-config                  Print resolved configuration and exit

Environment:
  AITERM_BASE_URL                 OpenAI-compatible base URL
  AITERM_API_KEY                  API key
  AITERM_MODEL                    Default model
  AITERM_CORRECTION_MODEL         Model used for command correction
  AITERM_AGENT_MODEL              Model used for tasks
  AITERM_CHAT_MODEL               Model used for chat
  AITERM_HEADERS                  Comma-separated extra headers (k=v,k=v)
`;

module.exports = { parseArgs, HELP };
