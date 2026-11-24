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
    planSignoff: true,
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
    globalSkills: false,
    resumeStatus: false,
    showPlan: false,
    newSession: false,
    mcpStatus: false,
    consolidateWorkspace: false,
    exitNow: false,
    restart: false,
    profile: null,
    profileSet: null,
    effort: null,
    colors: null,
    markdown: null,
    endpoint: null,
    modelRecommendation: false,
    vim: 'vi',
    vimEditor: null,
    vimReal: null,
    vimAi: null,
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
    notify: true,
    completion: null,
    web: false,
    desktop: false,
    port: null,
    host: null,
    noOpen: false,
    helpCategory: null,
    shell: null,
    browserDaemon: false,
    browserDaemonPort: null,
    // windows-daemon subcommand; remaining args go to src/cli/windowsDaemon.js
    windowsDaemon: false,
    windowsDaemonArgs: [],
    screensWidget: false,
    screensWidgetArgs: [],
    // connect-browser subcommand
    connectBrowser: false,
    connectBrowserPort: null,
    connectBrowserDisconnect: false,
    connectBrowserStatus: false,
    unknown: [],
  };
  const setVoiceCliMode = (mode) => {
    opts.sts = false;
    opts.stt = false;
    opts.tts = false;
    opts.voice = false;
    if (mode === 'stt') {
      opts.stt = true;
      opts.voice = true;
    } else if (mode === 'tts') {
      opts.tts = true;
    } else if (mode === 'sts') {
      opts.sts = true;
      opts.voice = true;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--':
        opts.unknown.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      case '--review': opts.review = true; break;
      case '--yes-files': opts.yesFiles = true; break;
      case '--update-command-glossary': opts.updateGlossary = true; break;
      case '-h':
      case '--help':
        opts.help = true;
        // Capture optional category: shmakk --help voice
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          opts.helpCategory = argv[++i];
        }
        break;
      case '--debug': opts.debug = true; break;
      case '--no-ai': opts.noAi = true; break;
      case '--no-correction': opts.noCorrection = true; break;
      case '--no-plan-signoff': opts.planSignoff = false; break;
      case '--print-config': opts.printConfig = true; break;
      case '--workspace': opts.workspace = argv[++i] || null; break;
      case '--status': opts.status = true; break;
      case '--stats': opts.stats = true; break;
      case '--compact': opts.compact = true; break;
      case '-G':
      case '--global': opts.globalSkills = true; break;
      case '--load-skill': opts.loadSkill = argv[++i] || null; break;
      case '--list-skills': opts.listSkills = true; break;
      case '--skill-status': opts.skillStatus = true; break;
      case '--unload-skill': opts.unloadSkill = argv[++i] || null; break;
      case '--install-skill': opts.installSkill = argv[++i] || null; break;
      case '--resume-status': opts.resumeStatus = true; break;
      case '--show-plan': opts.showPlan = true; break;
      case '--new-session': opts.newSession = true; break;
      case '--mcp-status': opts.mcpStatus = true; break;
      case '--consolidate-workspace': opts.consolidateWorkspace = true; break;
      case '--exit': opts.exitNow = true; break;
      case '--restart': opts.restart = true; break;
      case '--reset': opts.reset = true; break;
      case '--profile': opts.profile = argv[++i] || null; break;
      case '--profile-set': opts.profileSet = argv[++i] || null; break;
      case '--effort': opts.effort = argv[++i] || null; break;
      case '--build-history':
        opts.buildHistory = [];
        // Collect remaining args as file paths until next flag
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          opts.buildHistory.push(argv[++i]);
        }
        if (!opts.buildHistory.length) opts.buildHistory = null; // flag with no files = auto-detect
        break;
      case '--stt': setVoiceCliMode('stt'); break;
      case '--tts': setVoiceCliMode('tts'); break;
      case '--sts': setVoiceCliMode('sts'); break;
      case '--voice': setVoiceCliMode('stt'); break;
      case '--voice-language': opts.voiceLanguage = argv[++i] || null; break;
      case '--voice-max-sec': opts.voiceMaxDuration = parseInt(argv[++i], 10) || null; break;
      case '--voice-silence-sec': opts.voiceSilenceSec = argv[++i] || null; break;
      case '--voice-silence-threshold': opts.voiceSilenceThreshold = argv[++i] || null; break;
      case '--voice-silence-start-sec': opts.voiceSilenceStartSec = argv[++i] || null; break;
      case '--voice-pad-start-sec': opts.voicePadStartSec = argv[++i] || null; break;
      case '--tts-voice': opts.ttsVoice = argv[++i] || null; break;
      case '--notify': opts.notify = true; break;
      case '--completion': opts.completion = argv[++i] || null; break;
      case '--colors': opts.colors = argv[++i] || null; break;
      case '--markdown': opts.markdown = argv[++i] || null; break;
      case '--endpoint': opts.endpoint = argv[++i] || null; break;
      case '--web': opts.web = true; break;
      case '--desktop': opts.desktop = true; break;
      case '--port': { const n = parseInt(argv[++i], 10); opts.port = Number.isFinite(n) ? n : null; break; }
      case '--host': opts.host = argv[++i] || null; break;
      case '--no-open': opts.noOpen = true; break;
      case '--new-token': opts.newToken = true; break;
      case '--model-recommendation': opts.modelRecommendation = true; break;
      case '--vim':
        {
          const v = (argv[++i] || 'vi').toLowerCase();
          if (!['vi', 'vim', 'disable', 'enable'].includes(v)) {
            process.stderr.write('[shmakk] invalid --vim. Use: vi|vim|disable\n');
            process.exit(2);
          }
          opts.vim = v === 'enable' ? 'vim' : v;
        }
        break;
      case '--vim-editor': opts.vimEditor = argv[++i] || null; break;
      case '--vim-real': opts.vimReal = argv[++i] || null; break;
      case '--vim-ai': opts.vimAi = argv[++i] || null; break;
      case '--shell':
        {
          const v = argv[++i];
          if (!v || !['fish', 'bash', 'zsh'].includes(v)) {
            process.stderr.write('[shmakk] invalid --shell. Use: fish|bash|zsh\n');
            process.exit(2);
          }
          opts.shell = v;
        }
        break;
      case 'connect-browser':
        opts.connectBrowser = true;
        // Consume subsequent flags that belong to connect-browser
        while (i + 1 < argv.length) {
          const n = argv[i + 1];
          if (n === '--port' || n === '-p') {
            i++;
            opts.connectBrowserPort = parseInt(argv[++i], 10);
            if (isNaN(opts.connectBrowserPort)) {
              process.stderr.write(`[shmakk] connect-browser: invalid port: ${argv[i]}\n`);
              process.exit(2);
            }
          } else if (n === '--disconnect' || n === '-d') {
            i++;
            opts.connectBrowserDisconnect = true;
          } else if (n === '--status' || n === '-s') {
            i++;
            opts.connectBrowserStatus = true;
          } else if (n === '--help' || n === '-h') {
            i++;
            opts.help = true;
            opts.helpCategory = 'mcp';
          } else {
            break; // unknown or next subcommand
          }
        }
        break;
      case 'browser-daemon':
        opts.browserDaemon = true;
        while (i + 1 < argv.length) {
          const n = argv[i + 1];
          if (n === '--port' || n === '-p') {
            i++;
            opts.browserDaemonPort = parseInt(argv[++i], 10);
            if (isNaN(opts.browserDaemonPort)) {
              process.stderr.write(`[shmakk] browser-daemon: invalid port: ${argv[i]}\n`);
              process.exit(2);
            }
          } else if (n === '--help' || n === '-h') {
            i++;
            opts.help = true;
            opts.helpCategory = 'mcp';
          } else {
            break;
          }
        }
        break;
      case 'windows-daemon':
        opts.windowsDaemon = true;
        opts.windowsDaemonArgs = argv.slice(i + 1);
        i = argv.length;
        break;
      case 'screens':
        opts.screensWidget = true;
        opts.screensWidgetArgs = argv.slice(i + 1);
        i = argv.length;
        break;
      default: opts.unknown.push(a);
    }
  }
  return opts;
}

// ── Help: category-based navigation ──────────────────────────────────────────

const HELP_SUMMARY = `shmakk - AI-supervised terminal wrapper

  Launch shmakk, then type commands as usual. shmakk watches the shell, catches
  failures, and calls an LLM to fix them, plan tasks, and edit files.

Graphical interface:
  shmakk --web                    Start the web UI (chat, terminal, skills, plans, settings…)
                                  on http://127.0.0.1:4317 and open it in your browser
  shmakk --desktop                Open the same interface as a desktop app (Electron)
  --port <n>                      Port for --web (default 4317; 0 = any free port)
  --host <addr>                   Bind address for --web (default 127.0.0.1; use 0.0.0.0 to
                                  open it from your phone — the UI is touch-first and installable)
  --new-token                     Rotate the access token (signs out other devices)
  --no-open                       Don't open the browser automatically

Control (run from inside an shmakk session):
  shmakk --status                 Show whether this terminal is inside shmakk
  shmakk --stats                  Show session/task stats (journal, audit, active skill)
  shmakk --compact                Compact context by clearing conversation + task journal
  shmakk --load-skill <name>      Load a Claude/Codex-style skill into shmakk workspace state
  shmakk --install-skill <url>    Download skill markdown from URL, validate, and load
  shmakk -G, --global             With --load-skill or --install-skill, use global (~/.config/shmakk) instead of workspace
  shmakk --list-skills            List all registered skills (workspace + global)
  shmakk --skill-status           Show active skill and registry status (workspace + global)
  shmakk --unload-skill <name>    Remove skill from whichever registry has it
  shmakk --show-plan              Show current plan status (tasks and progress)
  shmakk --mcp-status             Show configured MCP servers and their tools
  shmakk --resume-status          Show task journal summary for resume continuity
  shmakk --exit                   Cleanly exit the parent shmakk
  shmakk --restart                Restart the inner shell (preserves window)
  shmakk --reset                  Clear the AI conversation history (keep session)
  shmakk --profile-set <name>     Switch profile and restart (tiny|balanced|deep|builder|large-app)
  shmakk --effort <level>         Reasoning effort (minimal|low|medium|high|xhigh|max; SHMAKK_EFFORT)
  shmakk --colors <true|false>    Enable or disable ANSI colors + code highlighting

  Type "help" inside a session to see this same text.

  Usage: shmakk [--flag ...]
         shmakk --help [category]

Categories (shmakk --help <name> for details):

  launch       Startup modes, profiles, tuning flags
  session      Status, stats, restart, exit, control signals
  skills       Skill discovery, loading, listing, management
  models       Provider configuration, endpoint presets
  vim          Vim/vi integration and AI suggestions
  voice        Speech-to-Text / Text-to-Speech options
  env          Environment variable reference
  mcp          MCP servers and browser automation
  ssh          Remote host execution
  vibedit      Visual editing overlay (web + Electron)
  self         Natural-language self-commands (inside a session)

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
  SHMAKK_MODELS                   Comma-separated list of models for the active endpoint

Web interface environment (shmakk --web / Docker):
  SHMAKK_WEB_TOKEN                Access token (generated and saved if unset)
  SHMAKK_PUBLIC_URL               Public address(es) of the app, comma-separated
  SHMAKK_TRUST_PROXY              1 when behind a reverse proxy (honours X-Forwarded-*)
  SHMAKK_TLS_CERT / SHMAKK_TLS_KEY  Serve HTTPS directly
  SHMAKK_GITHUB_TOKEN             GitHub token for cloud sessions (or connect in the UI)
  SHMAKK_GITHUB_CLIENT_ID         OAuth app client id to enable "Sign in with GitHub"
  SHMAKK_WORKSPACES_DIR           Where GitHub sessions are cloned
`;

const HELP_SECTIONS = {};

HELP_SECTIONS.launch = `═══════════════════════════════════════════════════════════════════════════
  LAUNCH OPTIONS  (shmakk --flag  from outside a session)
═══════════════════════════════════════════════════════════════════════════

  These flags only apply when starting a new shmakk session. They are
  ignored if you are already inside shmakk (SHMAKK=1).

  shmakk                           Launch in auto mode (AI acts on failures)
  shmakk --review                  Launch in review mode (confirm every AI action)
  shmakk --yes-files               Auto-accept file writes, edits, mkdir

  shmakk --help                    Show overview (this text)
  shmakk --help <category>         Show detailed help for a category
  shmakk --build-history [files]   Parse shell history for better corrections
  shmakk --update-command-glossary Scan PATH and build local command glossary

  --shell <fish|bash|zsh>          Use a specific shell (default: current $SHELL)
  --no-ai                          Disable AI entirely (pure passthrough)
  --no-correction                  Disable command correction
  --no-plan-signoff                Mark plan tasks done once review passes (no y/n sign-off)
  --debug                          Verbose logging to stderr
  --print-config                   Print resolved configuration and exit

  --workspace <path>               Override workspace root
  --new-session                    Force a new session instead of resuming
  --profile <name>                 Startup profile: tiny|balanced|deep|builder|large-app
  --colors <true|false>            Enable or disable ANSI colors
  --markdown <true|false>          Enable or disable markdown rendering
  --effort <level>                 Reasoning effort: minimal|low|medium|high|xhigh|max
                                   (default: provider decides; env SHMAKK_EFFORT)
  --vim <vi|vim|disable>           Intercept vi/vim inside shmakk (default: vi)
  --notify                         Desktop notifications for Y/n prompts
`;

HELP_SECTIONS.models = `═══════════════════════════════════════════════════════════════════════════
  MODEL PROVIDERS
═══════════════════════════════════════════════════════════════════════════

  --endpoint <name>                Use model preset from ~/.config/shmakk/endpoints.json
  --model-recommendation           Main model chooses best model per call

  Providers: openai-compatible | codex | anthropic | google | nvidia
  Configure in ~/.config/shmakk/endpoints.json:
    {
      "main": "claude",
      "fast": "flash",
      "models": {
        "claude":       { "provider":"anthropic", "model":"claude-sonnet-4-5-...", "api_key":"..." },
        "flash":        { "provider":"google",    "model":"gemini-flash",       "api_key":"..." },
        "gpt5":         { "provider":"codex",     "model":"gpt-5-codex",        "api_key":"..." },
        "kimi":         { "provider":"nvidia",    "model":"moonshotai/kimi-k2.6", "api_key":"nvapi-..." },
        "local-qwen":   { "provider":"openai-compatible", "base_url":"http://127.0.0.1:1234/v1",
                          "model":"qwen/qwen3.5-9b" }
      }
    }

  main is used for normal agent work. fast is used for low-latency paths such
  as Vim suggestions. Override with SHMAKK_FAST_ENDPOINT or
  SHMAKK_VIM_SUGGEST_ENDPOINT.
`;

HELP_SECTIONS.vim = `═══════════════════════════════════════════════════════════════════════════
  VIM / VI
═══════════════════════════════════════════════════════════════════════════

  --vim <vi|vim|disable>           Intercept vi/vim inside shmakk (default: vi)

  When enabled, shmakk puts a temporary vi or vim shim at the front of PATH
  inside the shmakk shell. The shim launches your real editor, loads your
  normal vimrc/plugins/colors first, then sources a small shmakk plugin.

  Commands inside Vim:
    :G <prompt>                    Generate code at the cursor
    :Tw <prompt>                   Write prose or documentation at the cursor
    :Cmd <command>                 Run a shell command in a scratch buffer
    :ShmakkSuggest                 Ask for a full-block suggestion
    :ShmakkAccept                  Preview and accept pending auto-suggestion
    :ShmakkPreview                 Preview pending auto-suggestion
    :ShmakkDeny                    Clear pending auto-suggestion

  Mappings:
    <C-Space>                      Manual full-block suggestion with preview
    <leader>sa                     Accept pending auto-suggestion
    <leader>sp                     Preview pending auto-suggestion
    <leader>sd                     Deny pending auto-suggestion

  Lowercase :g is not overridden; it remains Vim's native :global command.
  Use :G for shmakk generation. Native commands such as :%s/foo/bar/g still
  work normally.

  Optional auto-suggest in vimrc:
    let g:shmakk_auto_suggest = 1
    let g:shmakk_auto_suggest_delay_ms = 2000
    let g:shmakk_auto_suggest_min_chars = 20

  Suggestions prefer SHMAKK_VIM_SUGGEST_ENDPOINT, then SHMAKK_FAST_ENDPOINT,
  then the endpoint registry's fast model, then the current model.
`;

HELP_SECTIONS.session = `═══════════════════════════════════════════════════════════════════════════
  SESSION CONTROL  (shmakk --flag  from another terminal)
═══════════════════════════════════════════════════════════════════════════

  shmakk --status                  Is this terminal inside shmakk?
  shmakk --stats                   Session/task stats (journal, audit, skill)
  shmakk --show-plan               Current plan: tasks and progress
  shmakk --resume-status           Task journal summary for continuity
  shmakk --mcp-status              MCP servers and their tools

  shmakk --compact                 Clear conversation + task journal
  shmakk --consolidate-workspace   Merge nested .shmakk dirs into root
  shmakk --reset                   Clear AI conversation history (keep session)
  shmakk --restart                 Restart the inner shell (keeps window)
  shmakk --exit                    Cleanly exit the parent shmakk

  shmakk --profile-set <name>      Switch profile and restart
`;

HELP_SECTIONS.skills = `═══════════════════════════════════════════════════════════════════════════
  SKILLS
═══════════════════════════════════════════════════════════════════════════

  shmakk --load-skill <name>       Load a skill into workspace state
  shmakk --install-skill <url>     Download skill markdown from URL, validate, load
  shmakk -G, --global              Use global (~/.config/shmakk) with --load-skill / --install-skill
  shmakk --list-skills             List all registered skills (workspace + global)
  shmakk --skill-status            Active skill and registry status
  shmakk --unload-skill <name>     Remove skill from whichever registry has it
`;

HELP_SECTIONS.voice = `═══════════════════════════════════════════════════════════════════════════
  VOICE  (Speech-to-Text / Text-to-Speech)
═══════════════════════════════════════════════════════════════════════════

  --sts                            Speech-to-Speech: always-on mic + TTS
  --stt                            Speech-to-Text: mic input, text output
  --tts                            Text-to-Speech: text input, spoken output
                                  These modes are exclusive; the last one wins.

  --voice-language <code>          Language hint (e.g. en, es, fr)
  --voice-max-sec <sec>            Max recording seconds (default: 30)
  --voice-silence-sec <sec>        Silence before stopping (default: 1.0)
  --voice-silence-threshold <%>    VAD amplitude threshold (default: 1%)
  --voice-silence-start-sec <sec>  Sound required before start (default: 0.5)
  --voice-pad-start-sec <sec>      Padding at start of recording (default: 0.3)
  --tts-voice <name>               Override daily voice rotation

  STT: Whisper-base ONNX in-process. No Python, no server, no API key.
  TTS: kokoro-js (Kokoro-82M ONNX, ~334MB fp16). Auto-download on first use.
  Requires aplay, paplay, or afplay for audio. 28 voices, rotated daily.
`;

HELP_SECTIONS.env = `═══════════════════════════════════════════════════════════════════════════
  ENVIRONMENT
═══════════════════════════════════════════════════════════════════════════

  SHMAKK_BASE_URL                  OpenAI-compatible base URL
  SHMAKK_API_KEY                   API key
  SHMAKK_MODEL                     Default model
  SHMAKK_FAST_ENDPOINT             Named endpoint for low-latency tasks
  SHMAKK_VIM_SUGGEST_ENDPOINT      Named endpoint for Vim suggestions
  SHMAKK_PROVIDER                  Provider: openai-compatible|codex|anthropic|google|nvidia
  SHMAKK_HEADERS                   Extra headers: k=v,k=v
  SHMAKK_REGISTRY                  Model registry filter (comma-separated)
  SHMAKK_MODEL_RECOMMENDATION      Set to 1 to let main model choose per call
  SHMAKK_VIM_SHIM_DIR              Internal PATH shim for enhanced vi/vim
  SHMAKK_REAL_PATH                 Original PATH before shmakk vim shims
  SHMAKK_VIM_SUGGEST_MAX_CHARS     Max context chars sent for Vim suggestions
  SHMAKK_VIM_SUGGEST_BEFORE_LINES  Lines before cursor for Vim suggestions
  SHMAKK_VIM_SUGGEST_AFTER_LINES   Lines after cursor for Vim suggestions

  SHMAKK_HF_CACHE                  HuggingFace cache directory (voice models)
  SHMAKK_TTS_VOICE                 Pin a specific TTS voice
  SHMAKK_TTS_DTYPE                 Kokoro dtype: fp32|fp16|q8|q4|q4f16 (default: fp16)
  SHMAKK_VOICE_LANGUAGE            Language hint for STT
  SHMAKK_VOICE_MAX_SEC             Max recording seconds
  SHMAKK_VOICE_SILENCE_SEC         VAD silence threshold seconds
  SHMAKK_VOICE_SILENCE_THRESHOLD   VAD amplitude threshold
  SHMAKK_VOICE_PAD_START_SEC       Start-of-recording padding
`;

HELP_SECTIONS.mcp = `═══════════════════════════════════════════════════════════════════════════
  MCP & BROWSER
═══════════════════════════════════════════════════════════════════════════

  MCP servers: configure in ~/.config/shmakk/mcp.json or .shmakk/mcp.json
    {
      "mcpServers": {
        "name": {
          "command": "...",
          "args": ["..."],
          "env": { "TOKEN": "\${TOKEN}" },
          "safety": "uncertain",
          "safeTools": ["read"],
          "unsafeTools": ["delete"],
          "timeout": 30000,
          "disabled": false
        }
      }
    }

  Agent browser tool: headless Playwright for non-interactive browsing.
    npm install playwright && npx playwright install chromium
  Tools: navigate, click, type, read_page, screenshot, evaluate, select,
  wait, scroll, close.

  Extension automation for the current Chrome tab:
    shmakk browser-daemon                  run global extension backend
    shmakk browser-daemon --port 3947      use a custom extension port

  CDP connection is for live debugging / Electron-style targets:
    shmakk connect-browser                 auto-detect and connect
    shmakk connect-browser --port 9222     connect to specific port
    shmakk connect-browser --status        show connection status
    shmakk connect-browser --disconnect    disconnect

  Desktop window awareness (KDE Plasma, docs/windows.md):
    shmakk windows-daemon --install-kwin   install the KWin watcher script
    shmakk windows-daemon                  record window focus and layout
    shmakk windows-daemon --status         store and daemon status
    shmakk screens                          click screens into a priority order
  Tools: window_list, window_usage, window_predict, window_layout,
  window_proactive (suggestions: shmakk windows-daemon --proactive auto).

  shmakk --mcp-status              Show configured servers and discovered tools
`;

HELP_SECTIONS.ssh = `═══════════════════════════════════════════════════════════════════════════
  REMOTE HOSTS (SSH)
═══════════════════════════════════════════════════════════════════════════

  The agent can run commands on remote hosts and transfer files via SSH.
  Configure hosts in .shmakk/hosts.json or ~/.config/shmakk/hosts.json:

    {
      "hosts": {
        "devbox": {
          "host": "user@192.168.1.100",
          "port": 22,
          "auto_approve": false,
          "timeout_sec": 30
        }
      },
      "allow_ssh_config": false,
      "default_timeout_sec": 30
    }

  Agent tools: ssh_run (run command), ssh_push (upload), ssh_pull (download).
  For persistent connections, use ControlMaster in ~/.ssh/config:
    Host *
      ControlMaster auto
      ControlPath ~/.ssh/controlmasters/%r@%h:%p
      ControlPersist 600
`;

HELP_SECTIONS['vibedit'] = `═══════════════════════════════════════════════════════════════════════════
  VIBEDIT  (web + Electron)
═══════════════════════════════════════════════════════════════════════════

  Vibedit is the visual editing overlay. It opens a Chromium browser tab,
  injects a chat panel with a shadow-DOM overlay, captures screenshots for
  vision-model analysis, and applies code changes directly to your project.

  ── Web mode ──

  Inside a session:
    /vibedit <url | file | package.json | dir>

  Opens a Playwright Chromium browser, injects the overlay, and auto-starts
  a dev server if given a package.json or project directory. The overlay
  appears as a puck in the bottom-right corner.

  ── Electron mode ──

  Inside a session:
    /vibedit-electron <debug-port>
    /ve <debug-port>              (short alias)

  Connects to an already-running Electron app via Chrome DevTools Protocol.
  The app must be launched with --remote-debugging-port=<port>.
  No new browser window is opened — the overlay is injected into the
  existing Electron window.

  ── Specs ──

  Use the overlay's Save button to capture a spec (screenshot + description).
  The spec is immediately sent to the agent for implementation. If the
  agent is already busy, the spec is queued and applied on the next run.

  ── Dependencies ──

  Both modes require:  npm install playwright && npx playwright install chromium
  Electron mode also needs the target app's debug port accessible.

  Project-local state: .shmakk/state/vibedit-*
  Extension daemon state: ~/.config/shmakk/browser-daemon.json
  Vibedit control port: auto-assigned per overlay session
`;

HELP_SECTIONS.self = `═══════════════════════════════════════════════════════════════════════════
  SELF-COMMANDS  (type inside an shmakk session)
═══════════════════════════════════════════════════════════════════════════

  Self-commands work with a prefix — /cmd or shmakk cmd.
  Bare words like "status" or "stats" go to the shell, not shmakk.

  -- Session --
  /status  |  shmakk status         Show session status
  /stats   |  shmakk stats          Show session/task statistics
  /sessions  |  shmakk sessions     Show recent sessions
  show sessions  |  last sessions   (same as /sessions)
  resume status                     Show task journal for resume continuity
  show plan                         Display current plan and progress
  /compact  |  shmakk compact       Clear conversation + task journal
  /reset  |  shmakk reset           Clear AI conversation history

  -- Skills --
  list skills                       List all registered skills
  list skills <category>            List skills in a specific category
  list skill categories             Show available skill categories
  find skills <query>               Search skills by name/description
  load skill <name>                 Load a skill into the active workspace
  unload skill <name>               Remove a skill from its registry
  skill status                      Show active skill and registry state

  -- Agents & Team --
  agent overview                    Show all agents and their specialisms
  agent skills                      List all agent skills
  agent <name>                      Show detail for a specific agent
  list agents                       Alias for agent overview

  -- Memory & Search --
  recall <query>                    Search past sessions by content
  find session <query>              Find a session by topic
  search db status                  Display session search DB info
  show memory                       List stored memories
  forget <query>                    Remove matching memories

  -- Configuration --
  show config                       Print resolved configuration
  mcp status                        Show MCP servers and tools
  show rules                        Display active workspace rules
  list endpoints                    List configured model endpoints
  use endpoint <name>               Switch to a named model endpoint
  set model to <name>               Change the active model
  set url to <url>                  Change the base URL
  set api key to <key>              Change the API key

  -- Toggles --
  enable review  |  disable review
  enable correction  |  disable correction
  enable yes-files  |  disable yes-files
  enable colors  |  disable colors
  enable debug  |  disable debug
  enable stt  |  disable stt        Ctrl+O voice input; disables TTS/STS
  enable tts  |  disable tts        Spoken agent replies; disables STT/STS
  enable sts  |  disable sts        Always-on speech-to-speech; disables STT/TTS

  -- Vibedit --
  /vibedit <url | path>            Launch visual editing overlay on a web app
  /vibedit-electron <port>         Connect overlay to an Electron app via CDP
  /ve <port>                       Short alias for /vibedit-electron
  shmakk browser-daemon            Run Chrome extension automation backend

  -- Workflows --
  list workflows                    Show available automation workflows
  run workflow <name>               Execute a named workflow

  -- Edits --
  review edits                      Step through pending file changes

  -- Meta --
  sidebar <query>                   Out-of-band agent query (not added to history)
  help                              Show this help
`;

// Resolve: returns the full old HELP string for backward compat, or the category
// text, or the summary.
function resolveHelp(category) {
  if (category) {
    const key = category.toLowerCase();
    if (HELP_SECTIONS[key]) return HELP_SECTIONS[key];
    // Unknown category: show summary + available categories
    const available = Object.keys(HELP_SECTIONS).join(', ');
    return HELP_SUMMARY + `Unknown category "${category}". Available: ${available}\n`;
  }
  return HELP_SUMMARY;
}

// Help text shown INSIDE a session (no launch flags — you're already running)
const HELP_SESSION_SUMMARY = `shmakk — inside a session

  Type commands as usual. shmakk watches the shell, catches failures, and
  calls an LLM to fix them, plan tasks, and edit files.

  Self-commands use a prefix: /cmd  or  shmakk cmd
  Examples:  /status   /sessions   shmakk status   shmakk show sessions

  Multi-word natural language also works:  "show help"  "list skills"

  For the full reference: shmakk --help self (from outside the session)
  For launch flags:        shmakk --help launch

`;

// Full legacy HELP for backward compat
const HELP = HELP_SUMMARY + Object.values(HELP_SECTIONS).join('\n');

module.exports = { parseArgs, HELP, resolveHelp, HELP_SUMMARY, HELP_SESSION_SUMMARY };
