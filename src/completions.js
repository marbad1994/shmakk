// Shell tab-completion scripts for shmakk.
//
// Generate with:
//   shmakk --completion bash  > ~/.shmakk-completion.bash && source ~/.shmakk-completion.bash
//   shmakk --completion zsh   > ~/.shmakk-completion.zsh  && source ~/.shmakk-completion.zsh
//   shmakk --completion fish  > ~/.config/fish/completions/shmakk.fish
//
// For permanent install:
//   bash: echo 'source ~/.shmakk-completion.bash' >> ~/.bashrc
//   zsh:  echo 'source ~/.shmakk-completion.zsh'  >> ~/.zshrc

// All known flags in one place so the completion scripts stay in sync.
const FLAGS = [
  // booleans (no argument)
  { flag: '--review', arg: false, desc: 'Review mode (confirm every AI action)' },
  { flag: '--yes-files', arg: false, desc: 'Auto-accept AI file writes/edits' },
  { flag: '--no-ai', arg: false, desc: 'Disable AI entirely (pure passthrough)' },
  { flag: '--no-correction', arg: false, desc: 'Disable command correction' },
  { flag: '--help', arg: false, desc: 'Show help' },
  { flag: '--debug', arg: false, desc: 'Verbose logging' },
  { flag: '--print-config', arg: false, desc: 'Print resolved config and exit' },
  { flag: '--update-command-glossary', arg: false, desc: 'Scan PATH and build command glossary' },
  { flag: '--status', arg: false, desc: 'Show whether inside shmakk' },
  { flag: '--stats', arg: false, desc: 'Show session/task stats' },
  { flag: '--compact', arg: false, desc: 'Clear conversation + task journal' },
  { flag: '--list-skills', arg: false, desc: 'List registered local skills' },
  { flag: '--skill-status', arg: false, desc: 'Show active skill and registry status' },
  { flag: '--resume-status', arg: false, desc: 'Show task journal summary' },
  { flag: '--exit', arg: false, desc: 'Cleanly exit parent shmakk' },
  { flag: '--restart', arg: false, desc: 'Restart inner shell' },
  { flag: '--reset', arg: false, desc: 'Clear AI conversation history' },
  { flag: '--stt', arg: false, desc: 'Speech-to-Text: mic → text input' },
  { flag: '--tts', arg: false, desc: 'Text-to-Speech: spoken responses' },
  { flag: '--sts', arg: false, desc: 'Speech-to-Speech: always-on mic + TTS' },
  { flag: '--voice', arg: false, desc: 'Enable voice input (stt shortcut)' },
  { flag: '--web', arg: false, desc: 'Start the web UI' },
  { flag: '--desktop', arg: false, desc: 'Open the desktop app (Electron)' },
  { flag: '--no-open', arg: false, desc: "Don't open the browser for --web" },
  { flag: '--model-recommendation', arg: false, desc: 'Route each model call via main model recommendation' },

  // flags with arguments
  { flag: '--workspace', arg: '<path>', desc: 'Override workspace root' },
  { flag: '--port', arg: '<n>', desc: 'Port for --web (default 4317)' },
  { flag: '--host', arg: '<addr>', desc: 'Bind address for --web' },
  { flag: '--profile', arg: '<name>', desc: 'Startup profile (tiny|balanced|deep|builder|large-app)' },
  { flag: '--profile-set', arg: '<name>', desc: 'Switch profile and restart' },
  { flag: '--endpoint', arg: '<name>', desc: 'Use model preset from ~/.config/shmakk/endpoints.json' },
  { flag: '--colors', arg: '<true|false>', desc: 'Toggle ANSI colors' },
  { flag: '--vim', arg: '<vi|vim|disable>', desc: 'Intercept vi/vim with shmakk Vim mode' },
  { flag: '--load-skill', arg: '<name>', desc: 'Load a skill into workspace state' },
  { flag: '--unload-skill', arg: '<name>', desc: 'Remove skill from registry' },
  { flag: '--install-skill', arg: '<url>', desc: 'Download and install skill from URL' },
  { flag: '--build-history', arg: '[files...]', desc: 'Parse shell history for frequency map' },
  { flag: '--completion', arg: '<bash|zsh|fish>', desc: 'Output shell completion script' },
  // voice tunables
  { flag: '--voice-language', arg: '<code>', desc: 'Language hint (en, es, fr)' },
  { flag: '--voice-max-sec', arg: '<sec>', desc: 'Max recording seconds' },
  { flag: '--voice-silence-sec', arg: '<sec>', desc: 'VAD silence before stopping' },
  { flag: '--voice-silence-threshold', arg: '<%>', desc: 'VAD amplitude threshold' },
  { flag: '--voice-silence-start-sec', arg: '<sec>', desc: 'Sound before recording starts' },
  { flag: '--voice-pad-start-sec', arg: '<sec>', desc: 'Padding before recording' },
  { flag: '--tts-voice', arg: '<name>', desc: 'Override Kokoro voice' },
  { flag: '--notify', arg: false, desc: 'Send desktop notifications when shmakk needs your attention' },
];

function bash() {
  const lines = [];
  lines.push('# shmakk bash completion');
  lines.push('_shmakk_completion() {');
  lines.push('  local cur prev words cword');
  lines.push('  _init_completion || return');
  lines.push('');
  lines.push('  case $prev in');

  for (const f of FLAGS) {
    if (!f.arg) continue;
    // flags that take an arg
    lines.push(`    ${f.flag})`);
    if (f.flag === '--profile' || f.flag === '--profile-set') {
      lines.push('      COMPREPLY=($(compgen -W "tiny balanced deep builder large-app" -- "$cur"))');
      lines.push('      return');
    } else if (f.flag === '--completion') {
      lines.push('      COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))');
      lines.push('      return');
    } else if (f.flag === '--colors') {
      lines.push('      COMPREPLY=($(compgen -W "true false" -- "$cur"))');
      lines.push('      return');
    } else if (f.flag === '--vim') {
      lines.push('      COMPREPLY=($(compgen -W "vi vim disable" -- "$cur"))');
      lines.push('      return');
    } else {
      lines.push('      COMPREPLY=()');
      lines.push('      return');
    }
    lines.push('      ;;');
  }

  lines.push('  esac');
  lines.push('');
  lines.push('  # complete flags');
  const flagNames = FLAGS.map((f) => f.flag).join(' ');
  lines.push(`  COMPREPLY=($(compgen -W "${flagNames}" -- "$cur"))`);
  lines.push('}');
  lines.push('');
  lines.push('complete -F _shmakk_completion shmakk');
  return lines.join('\n') + '\n';
}

function zsh() {
  const lines = [];
  lines.push('#compdef shmakk');
  lines.push('');
  lines.push('_shmakk() {');
  lines.push('  local -a flags_bool flags_arg');
  lines.push('');

  const bools = FLAGS.filter((f) => !f.arg).map((f) => f.flag);
  lines.push(`  flags_bool=(${bools.map((f) => `"${f}"`).join(' ')})`);

  const withArgs = FLAGS.filter((f) => f.arg);
  lines.push(`  flags_arg=(${withArgs.map((f) => `"${f.flag}"`).join(' ')})`);

  lines.push('');
  lines.push('  _arguments -s \\');
  for (const f of FLAGS) {
    if (!f.arg) {
      lines.push(`    "${f.flag}[${f.desc}]" \\`);
    } else if (f.flag === '--profile' || f.flag === '--profile-set') {
      lines.push(`    "${f.flag}[${f.desc}]:profile:(tiny balanced deep builder large-app)" \\`);
    } else if (f.flag === '--completion') {
      lines.push(`    "${f.flag}[${f.desc}]:shell:(bash zsh fish)" \\`);
    } else if (f.flag === '--colors') {
      lines.push(`    "${f.flag}[${f.desc}]:value:(true false)" \\`);
    } else if (f.flag === '--vim') {
      lines.push(`    "${f.flag}[${f.desc}]:mode:(vi vim disable)" \\`);
    } else {
      lines.push(`    "${f.flag}[${f.desc}]: :" \\`);
    }
  }

  lines.push('    && return 0');
  lines.push('}');
  lines.push('');
  lines.push('_shmakk');
  return lines.join('\n') + '\n';
}

function fish() {
  const lines = [];
  lines.push('# shmakk fish completion');
  lines.push('');

  for (const f of FLAGS) {
    if (!f.arg) {
      lines.push(`complete -c shmakk -l ${f.flag.slice(2)} -d '${f.desc}'`);
    } else if (f.flag === '--profile' || f.flag === '--profile-set') {
      lines.push(`complete -c shmakk -l ${f.flag.slice(2)} -d '${f.desc}' -xa 'tiny balanced deep builder large-app'`);
    } else if (f.flag === '--completion') {
      lines.push(`complete -c shmakk -l ${f.flag.slice(2)} -d '${f.desc}' -xa 'bash zsh fish'`);
    } else if (f.flag === '--colors') {
      lines.push(`complete -c shmakk -l ${f.flag.slice(2)} -d '${f.desc}' -xa 'true false'`);
    } else if (f.flag === '--vim') {
      lines.push(`complete -c shmakk -l ${f.flag.slice(2)} -d '${f.desc}' -xa 'vi vim disable'`);
    } else {
      // arg but no specific completions
      lines.push(`complete -c shmakk -l ${f.flag.slice(2)} -d '${f.desc}' -r`);
    }
  }

  return lines.join('\n') + '\n';
}

function generate(shell) {
  switch (shell) {
    case 'bash': return bash();
    case 'zsh': return zsh();
    case 'fish': return fish();
    default: throw new Error(`unknown shell: ${shell}. Use: bash, zsh, fish`);
  }
}

module.exports = { generate, FLAGS };
