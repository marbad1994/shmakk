// Session state machine extracted from orchestrator.js.
// Manages one shmakk session: PTY lifecycle, workspace tracking, output
// buffering, command correction, and agent invocation.

const { startSession } = require('./pty');
const { correct } = require('./correction');
const { runAgent, clearTaskJournal } = require('./agent');
const { route: routeToSpecialist } = require('./coordinator');
const { shouldPlan, generatePlan, formatPlan, savePlan, clearPlan } = require('./planner');
const { clearIndex } = require('./workspace-index');
const { loadGlossary } = require('./glossary');
const { isConfigured } = require('./llm');
const { makePrompter, decisionBanner } = require('./review');
const { workspaceWarning } = require('./safety');
const { createMCPManager } = require('./mcp-client');
const { clearEdits } = require('./edit-tracker');
const { matchSelfCommand, executeSelfCommand } = require('./self-commands');
const { runTeam, looksMultiDomain } = require('./team');
const { addPlanTasks, markTaskComplete, markTaskSkipped } = require('./task-file');
const { captureGitSha, runPostPlanReview } = require('./code-reviewer');
const sessionSearch = require('./session-search');
const { HELP } = require('./cli');
const audit = require('./audit');
const { setMaxListeners } = require('events');

// Lazy-loaded voice service — only required when --voice is active
let voiceService = null;
function getVoiceService() {
  if (!voiceService) voiceService = require('./services/voice');
  return voiceService;
}

// Lazy-loaded TTS service — only required when --tts is active
let ttsService = null;
function getTTSService() {
  if (!ttsService) ttsService = require('./services/tts');
  return ttsService;
}

const ALT_SCREEN_RE = /\x1b\[\?(?:1049|47|1047)h/;
const FLUSH_AFTER_MS = 300;
const FLUSH_AFTER_BYTES = 8 * 1024;

// Cap on conversation history kept between agent runs (entries past this
// limit are dropped from the front, preserving the most recent context).
const HISTORY_MAX_ENTRIES = 30;

// Kitty terminal sends \x1b[99;5u instead of \x03 for Ctrl+C.
// Returns the byte index of the first Ctrl+C (either form), or -1.
const KITTY_CTRL_C = Buffer.from([0x1b, 0x5b, 0x39, 0x39, 0x3b, 0x35, 0x75]); // \x1b[99;5u
function findCtrlC(data) {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x03) return i;
    if (data[i] === 0x1b && data.slice(i, i + KITTY_CTRL_C.length).equals(KITTY_CTRL_C)) return i;
  }
  return -1;
}

function isAbortError(e) {
  return e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function dim(text, enabled) {
  return enabled ? `\x1b[2m${text}\x1b[0m` : text;
}

function trimHistory(history) {
  if (history.length <= HISTORY_MAX_ENTRIES) return history;
  // Drop oldest, but keep tool_call/tool pairs intact: walk from the end
  // and stop at HISTORY_MAX_ENTRIES boundary that doesn't split a pair.
  let cut = history.length - HISTORY_MAX_ENTRIES;
  while (cut > 0 && history[cut].role === 'tool') cut--;
  return history.slice(cut);
}

// Returns a confirmTool fn for the agent.
function makeToolConfirm(opts, ask, out, getAbort) {
  return async ({ name, args, safety, description }) => {
    audit.append({ kind: 'tool-proposed', name, args, safety, mode: opts.review ? 'review' : 'auto' });
    const fileCreateAllowed = opts.yesFiles
      && (name === 'write_file' || name === 'edit_file' || name === 'make_dir')
      && safety !== 'unsafe';
    const wouldAuto = safety === 'safe' || fileCreateAllowed;
    if (!opts.review && wouldAuto) {
      audit.append({ kind: 'tool-allowed', name, args, via: fileCreateAllowed ? 'yes-files' : 'auto-safe' });
      return true;
    }
    const lines = [
      '\x1b[36m── shmakk tool ──\x1b[0m',
      `  action:  ${description}`,
      `  path:    ${args.path || '-'}`,
      `  safety:  ${safety}`,
    ];
    if (name === 'run' && args.cmd) {
      lines.push(`  command:`);
      for (const cmdLine of String(args.cmd).split('\n')) {
        lines.push(`    $ ${cmdLine}`);
      }
    }
    if (name === 'write_file' && args.content) {
      const preview = String(args.content).slice(0, 200);
      lines.push(`  preview: ${preview}${preview.length >= 200 ? '…' : ''}`);
    }
    if (name === 'edit_file' && args.old_string) {
      const oldPreview = String(args.old_string).slice(0, 80);
      lines.push(`  replace: "${oldPreview}${oldPreview.length >= 80 ? '…' : ''}"`);
    }
    lines.push('');
    out(lines.join('\r\n'));
    const toolExplain = {
      read_file: 'Reads a file from your workspace to analyze it.',
      list_dir: 'Lists directory contents to explore project structure.',
      write_file: 'Creates or overwrites a file in your workspace.',
      edit_file: 'Makes a precise string replacement in an existing file.',
      make_dir: 'Creates a new directory (with parents if needed).',
      delete_file: 'Deletes a file from your workspace.',
      run: 'Runs a shell command in your workspace directory.',
      web_search: 'Searches the web for current information.',
      fetch_url: 'Fetches content from a URL.',
    };
    const safetyExplain = {
      safe: 'No destructive potential — reads, lists, searches, or safe shell commands.',
      uncertain: 'Could modify files or run commands with side effects.',
      unsafe: 'Potentially destructive — deletes, or commands flagged as dangerous.',
    };
    const showWhy = () => {
      const w = [
        '',
        '\x1b[36m── why this tool? ──\x1b[0m',
        `  tool:   ${name}`,
        `  what:   ${toolExplain[name] || 'Executes the requested action.'}`,
        `  safety: ${safety} — ${safetyExplain[safety] || 'unknown risk level'}`,
      ];
      if (name === 'run' && args.cmd) {
        w.push(`  command:`);
        for (const cmdLine of String(args.cmd).split('\n')) {
          w.push(`    $ ${cmdLine}`);
        }
      }
      if (name === 'write_file' && args.content) {
        const preview = String(args.content).slice(0, 300);
        w.push(`  preview: ${preview}${preview.length >= 300 ? '…' : ''}`);
      }
      if (name === 'edit_file') {
        w.push(`  old: "${String(args.old_string || '').slice(0, 120)}"`);
        w.push(`  new: "${String(args.new_string || '').slice(0, 120)}"`);
      }
      w.push('');
      out(w.join('\r\n'));
    };
    const ok = await ask('Run?', wouldAuto, {
      onCancel: getAbort,
      onWhy: showWhy,
    });
    audit.append({ kind: ok ? 'tool-allowed' : 'tool-declined', name, args });
    return ok;
  };
}

async function runOneSession(opts, registerSession) {
  const session = startSession({ debug: opts.debug, voiceEnabled: !!opts.voice });
  let colorsEnabled = opts.colors !== false;
  const out = (s) => session.stdoutWrite(colorsEnabled ? s : stripAnsi(s));
  const ask = makePrompter(session, out);
  const glossary = loadGlossary();
  // Workspace tracking: explicit --workspace is "pinned"; otherwise cwd
  // floats with the inner shell's `cd`. When both pinned and cwd differ,
  // both are passed as allowed roots.
  const pinnedWorkspace = opts.workspace ? require('path').resolve(opts.workspace) : null;
  let cwd = pinnedWorkspace || process.cwd();

  function currentRoots() {
    if (!pinnedWorkspace) return [require('path').resolve(cwd)];
    const c = require('path').resolve(cwd);
    return c === pinnedWorkspace ? [pinnedWorkspace] : [pinnedWorkspace, c];
  }

  // ── MCP server setup ──
  const mcpManager = createMCPManager();
  const mcpCount = mcpManager.loadConfig(pinnedWorkspace || cwd);
  if (mcpCount > 0) {
    mcpManager.startAll((msg) => out(`\x1b[2m${msg}\x1b[0m\r\n`)).catch(() => {});
  }

  const wsWarn = workspaceWarning(cwd);
  if (wsWarn) out(`\x1b[33m[shmakk] ${wsWarn}\x1b[0m\r\n`);
  if (!isConfigured()) {
    out('\x1b[33m[shmakk] note: SHMAKK_BASE_URL not set — running as plain PTY (no AI).\x1b[0m\r\n');
  } else if (!glossary) {
    out('\x1b[33m[shmakk] tip: run `shmakk --update-command-glossary` for better corrections.\x1b[0m\r\n');
  }
  // Generate a session ID so all turns/files this session produces can be
  // joined together in the search DB. Persists in env so subagents can tag.
  const sessionId = sessionSearch.makeSessionId();
  process.env.SHMAKK_SESSION_ID = sessionId;
  audit.append({ kind: 'session-start', sessionId, workspace: cwd, pinnedWorkspace, review: !!opts.review, pid: process.pid });
  sessionSearch.recordSessionStart({ sessionId, workspace: cwd, pid: process.pid });

  // Incremental audit-log index catch-up — runs once at session start, async,
  // never blocks the user. Pulls in any sessions/turns persisted by other
  // shmakk instances since this DB was last opened.
  setImmediate(() => {
    try { sessionSearch.indexAuditLog(); } catch {}
  });

  // ── Global Ctrl+C handler (persistent bottom-of-stack) ──
  // Ctrl+C = shut up. Kills TTS, recorder, and voice loop immediately.
  // Ctrl+D exits the shell as normal (we never intercept it).
  session.captureStdin((data) => {
    if (opts.tts || opts.stt || opts.sts) {
      const cut = findCtrlC(data);
      if (cut !== -1) {
        try { fullVoiceTeardown(); } catch {}
        if (cut > 0) session.childWrite(data.slice(0, cut));
        session.childWrite('\r');
        return;
      }
    }
    session.childWrite(data);
  });

  // Conversation history — persists across agent invocations within one
  // session so follow-up questions like "now check the imports" make sense.
  let history = [];

  // command lifecycle state
  let lastCommand = null;
  let bufferMode = false;
  let pending = Buffer.alloc(0);
  let bufferStart = 0;
  let flushTimer = null;

  // When a correction is applied, store the original failed command so that
  // if the corrected command succeeds the agent still runs to handle the
  // user's broader intent rather than dropping back to the prompt.
  let correctionOrigin = null;

  function flushPending() {
    if (pending.length) { out(pending.toString('utf8')); pending = Buffer.alloc(0); }
    bufferMode = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }
  function discardPending() {
    pending = Buffer.alloc(0);
    bufferMode = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  // ── Ctrl-C-aware AI work wrapper ──
  // Single Ctrl+C: soft abort (paused) — allow graceful recovery
  // Double Ctrl+C within ~400ms: hard abort (stopped) — immediate exit
  // In STS mode, voice machinery is torn down on first Ctrl+C.
  const CTRL_C_DOUBLE_PRESS_MS = 400;

  async function withAI(fn) {
    const ctrl = new AbortController();
    setMaxListeners(0, ctrl.signal);
    let ctrlCCount = 0;
    let ctrlCTimer = null;

    const release = session.captureStdin((data) => {
      const cut = findCtrlC(data);
      if (cut === -1) {
        session.childWrite(data);
        return;
      }

      // Ctrl+C detected. Pass through any data before it.
      if (cut > 0) {
        session.childWrite(data.slice(0, cut));
      }

      ctrlCCount++;

      // Tear down voice on any Ctrl+C
      if (opts.sts || opts.tts || opts.stt) {
        try { fullVoiceTeardown(); } catch {}
      }

      if (ctrlCCount === 1) {
        // First Ctrl+C: soft abort with "paused" reason.
        // Wait 400ms to see if a second press comes.
        out('\r\n\x1b[33m[shmakk] paused — press Ctrl+C again to stop\x1b[0m\r\n');
        ctrl.abort(new Error('paused'));

        ctrlCTimer = setTimeout(() => {
          ctrlCTimer = null;
          // 400ms elapsed — no double press. Agent is already aborted,
          // but we don't show any resume message since the pause was already signaled.
        }, CTRL_C_DOUBLE_PRESS_MS);
      } else if (ctrlCCount === 2) {
        // Second Ctrl+C: hard abort with "stopped" reason.
        // Abort is already in effect, but update the error reason for clarity.
        if (ctrlCTimer) {
          clearTimeout(ctrlCTimer);
          ctrlCTimer = null;
        }
        out('\x1b[33m[shmakk] stopped\x1b[0m\r\n');
        // Controller already aborted, but call abort again to update error state
        try {
          ctrl.abort(new Error('stopped'));
        } catch {
          // ignore — already aborted
        }
      }
      // Subsequent Ctrl+C presses are ignored (controller already aborted)
    });

    try {
      return await fn(ctrl);
    } finally {
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      release();
    }
  }

  // Single-press emergency stop for all voice machinery. Called by both
  // the global Ctrl+C handler and the withAI handler so the user can
  // escape no matter which one is on top of the stdin stack.
  function fullVoiceTeardown() {
    try {
      if (opts.tts || opts.sts) {
        const tts = getTTSService();
        const vs = getVoiceService();
        vs._killTts();
        tts.stopSpeaking();
      }
      if (opts.stt || opts.sts) {
        getVoiceService()._killRecorder();
      }
      if (session._stsFlags) {
        session._stsFlags.setTtsSpeaking(false);
        if (session._stsFlags.stopLoop) session._stsFlags.stopLoop();
      }
    } catch {}
  }

  session.ev.on('cwd', (p) => { if (p) cwd = p; });
  function resetHistory() {
    history = [];
    try { clearTaskJournal(currentRoots()[0]); } catch {}
    try { clearIndex(currentRoots()[0]); } catch {}
    clearEdits();
    out('\r\n\x1b[33m[shmakk] conversation + task journal + workspace index cleared\x1b[0m\r\n');
  }
  registerSession(session, resetHistory);

  // ── Voice-as-agent-task helper ──
  // Routes transcribed speech straight to the LLM agent and (optionally)
  // speaks the response. Bypasses the shell entirely, so transcripts never
  // get executed as commands or run through the correction engine.
  let voiceTaskRunning = false;
  async function runVoiceAsTask(text) {
    if (!text || voiceTaskRunning) return;

    // Voice self-commands bypass the agent — say "list skills", "show rules",
    // "review edits", etc. and they execute locally just like typed input.
    const voiceSelfCmd = matchSelfCommand(text);
    if (voiceSelfCmd.matched) {
      audit.append({ kind: 'self-command', cmd: text, action: voiceSelfCmd.action, via: 'voice' });
      if (voiceSelfCmd.confirm) {
        const go = await ask(`Run ${voiceSelfCmd.action}?`, true, { onCancel: () => {} });
        if (!go) return;
      }
      executeSelfCommand(voiceSelfCmd, out, {
        opts,
        HELP,
        setColors: (v) => { colorsEnabled = v; },
      });
      return;
    }

    if (!isConfigured()) {
      out('\r\n\x1b[33m[shmakk] LLM not configured — voice input ignored\x1b[0m\r\n');
      return;
    }
    voiceTaskRunning = true;
    try {
      await withAI(async (ctrl) => {
        out('\x1b[36m[shmakk voice→task] (Ctrl-C to interrupt)\x1b[0m\r\n');
        try {
          const voiceRouting = routeToSpecialist(text, [...history, { role: 'user', content: text }]);
          const updated = await runAgent({
            input: text, roots: currentRoots(), glossary,
            confirmTool: makeToolConfirm(opts, ask, out, () => ctrl.abort()),
            write: out,
            signal: ctrl.signal,
            history,
            profile: opts.profile || voiceRouting.profile || 'balanced',
            colors: colorsEnabled,
            voiceMode: true,
            specialistHint: voiceRouting.specialistHint,
            mcpManager,
          });
          history = trimHistory(updated || history);
          if ((opts.tts || opts.sts) && updated && updated.length) {
            const lastAssistant = [...updated].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant?.content) {
              const reply = typeof lastAssistant.content === 'string'
                ? lastAssistant.content
                : lastAssistant.content.map((c) => c.text || '').join(' ');
              if (reply) {
                if (opts.sts || opts.stt) {
                  try { getVoiceService()._killRecorder(); } catch {}
                }
                if (session._stsFlags) session._stsFlags.setTtsSpeaking(true);
                session._ttsGen = (session._ttsGen || 0) + 1;
                const myGen = session._ttsGen;
                const ttsVoice = opts.ttsVoice || process.env.SHMAKK_TTS_VOICE || 'af_heart';
                const tts = getTTSService();
                const settle = (err) => {
                  if (session._ttsGen !== myGen) return;
                  if (session._stsFlags) session._stsFlags.setTtsSpeaking(false);
                  if (err && opts.debug) process.stderr.write(`[shmakk] tts: ${err.message}\n`);
                };
                // Parallel interrupt listener — lets user say "stop" to cut TTS.
                // suppressKillTts=true so recording alongside TTS doesn't immediately kill it.
                // Loop is gated on myGen so it stops the moment settle() fires.
                const STOP_WORDS = new Set(['stop', 'quiet', 'shut up', 'silence', 'enough', 'cancel']);
                let interruptListening = true;
                const listenForInterrupt = async () => {
                  const vs = getVoiceService();
                  while (interruptListening && session._ttsGen === myGen) {
                    try {
                      const heard = await vs.recordAndTranscribe({ maxDurationSec: 2, suppressKillTts: true });
                      if (!heard) continue;
                      if (STOP_WORDS.has(heard.toLowerCase().trim().replace(/[.!?]$/, ''))) {
                        try { fullVoiceTeardown(); } catch {}
                        break;
                      }
                    } catch { break; }
                  }
                };
                listenForInterrupt().catch(() => {});
                const settleAndStop = (err) => {
                  interruptListening = false; // stop interrupt loop before unpausing voice loop
                  settle(err);
                };
                tts.speak(reply, { voice: ttsVoice }).then(() => settleAndStop()).catch(settleAndStop);
              }
            }
          }
          session.childWrite('\r');
        } catch (e) {
          if (isAbortError(e)) {
            // Error message distinguishes between pause, stop, and other aborts
            if (e.message === 'paused' || e.message === 'stopped') {
              // Already showed message in Ctrl+C handler
            } else {
              out('\r\n\x1b[33m[shmakk] interrupted\x1b[0m\r\n');
            }
          } else {
            out(`\r\n[shmakk] task error: ${e.message}\r\n`);
          }
        }
      });
    } finally {
      voiceTaskRunning = false;
    }
  }

  // ── Continuous voice loop (--sts always-on) ──
  // When --sts is active, runs a background loop: listen → transcribe → inject.
  // No hotkey needed — just speak and pause.
  // Pauses while TTS is speaking to avoid feedback loop.
  if (opts.sts) {
    const vs = getVoiceService();
    if (!vs.isAvailable()) {
      out('\r\n\x1b[33m[shmakk] no audio recorder found. Install sox.\x1b[0m\r\n');
    } else {
      // Preload STT model in background so first transcription doesn't lag
      try { vs.preloadSTT(); } catch {}
      let voiceLoopActive = true;
      let voiceBusy = false;
      // Set when TTS starts, cleared when TTS finishes — voice loop pauses
      let ttsSpeaking = false;
      let ttsStoppedAt = 0;  // last time TTS finished (for cooldown)

      const voiceLoop = async () => {
        while (voiceLoopActive) {
          if (voiceBusy) { await new Promise(r => setTimeout(r, 100)); continue; }
          // Pause recording while TTS is playing to avoid feedback loop.
          // User can interrupt TTS by pressing Ctrl+C (handled globally).
          if (ttsSpeaking) { await new Promise(r => setTimeout(r, 200)); continue; }
          // Small cooldown after TTS stops — avoids picking up reverb
          if (Date.now() - ttsStoppedAt < 1200) { await new Promise(r => setTimeout(r, 100)); continue; }
          voiceBusy = true;
          try {
            const text = await vs.recordAndTranscribe({
              language: opts.voiceLanguage || process.env.SHMAKK_VOICE_LANGUAGE || 'english',
              maxDurationSec: parseInt(opts.voiceMaxDuration || process.env.SHMAKK_VOICE_MAX_SEC || '30', 10),
            });
            if (text && voiceLoopActive) {
              // Send straight to the LLM agent — do NOT inject into the
              // shell. Otherwise the correction engine will rewrite
              // mis-transcribed fragments into real commands.
              await runVoiceAsTask(text);
            }
          } catch (err) {
            if (opts.debug) process.stderr.write(`[shmakk voice] ${err.message}\n`);
            await new Promise(r => setTimeout(r, 1000));
          } finally {
            voiceBusy = false;
          }
        }
      };

      // Start the loop detached
      voiceLoop().catch(() => {});

      // Stop loop on session exit
      session.waitExit().then(() => { voiceLoopActive = false; });

      // Expose setter for TTS module to pause/resume voice loop
      // (used in the exit handler where TTS is launched)
      if (!session._stsFlags) session._stsFlags = {};
      session._stsFlags.setTtsSpeaking = (v) => { ttsSpeaking = v; if (!v) ttsStoppedAt = Date.now(); };
      // Let the global Ctrl+C handler stop the STS loop on double-press.
      session._stsFlags.stopLoop = () => { voiceLoopActive = false; };
    }
  }

  // ── Voice input handler (Ctrl+O hotkey) ──
  // Only active when --voice/--stt is passed without --sts.
  let voiceInProgress = false;
  if (opts.voice && !opts.sts) {
    const voiceWarned = { mic: false };
    session.ev.on('voice', async () => {
      if (voiceInProgress) return;
      voiceInProgress = true;
      try {
        const vs = getVoiceService();
        if (!voiceWarned.mic) {
          if (!vs.isAvailable()) {
            out('\r\n\x1b[33m[shmakk voice] no microphone found. Install sox/arecord.\x1b[0m\r\n');
            voiceInProgress = false;
            return;
          }
          voiceWarned.mic = true;
        }
        // Show recording indicator — stays visible until transcription starts
        out('\r\n\x1b[36m🎤 [shmakk] Listening... (speak now, stops on silence)\x1b[0m');
        // Use a handler on the stdin stack so Ctrl-C aborts recording
        let recordingDone = false;
        const release = session.captureStdin((data) => {
          for (let i = 0; i < data.length; i++) {
            if (data[i] === 0x03 || data[i] === 0x0f || findCtrlC(data) !== -1) {
              recordingDone = true;
              // Kill the recorder process immediately
              try { vs._killRecorder(); } catch {}
              release();
              return;
            }
          }
          session.childWrite(data);
        });
        const text = await vs.recordAndTranscribe({
          maxDurationSec: parseInt(opts.voiceMaxDuration || process.env.SHMAKK_VOICE_MAX_SEC || '10', 10),
          language: opts.voiceLanguage || process.env.SHMAKK_VOICE_LANGUAGE,
          onStart: () => {},
          onStop: () => {
            recordingDone = true;
            try { release(); } catch {}
          },
        });
        if (text) {
          // Route to the agent, not the shell, so the correction engine
          // doesn't try to turn transcripts into commands.
          await runVoiceAsTask(text);
        } else {
          out('\r\x1b[33m[shmakk] no speech detected\x1b[0m\r\n');
        }
      } catch (err) {
        out(`\r\x1b[31m[shmakk voice] ${err.message}\x1b[0m\r\n`);
        if (opts.debug) out(`\r\x1b[33m${err.stack}\x1b[0m\r\n`);
      } finally {
        voiceInProgress = false;
      }
    });
  }

  session.ev.on('command', (c) => {
    lastCommand = c;
    if (!isConfigured() || opts.noAi) return;
    bufferMode = true;
    pending = Buffer.alloc(0);
    bufferStart = Date.now();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { if (bufferMode) flushPending(); }, FLUSH_AFTER_MS);
  });

  session.ev.on('output', (buf) => {
    if (!bufferMode) { out(buf.toString('utf8')); return; }
    pending = Buffer.concat([pending, buf]);
    const s = pending.toString('utf8');
    if (ALT_SCREEN_RE.test(s) || pending.length > FLUSH_AFTER_BYTES || (Date.now() - bufferStart) > FLUSH_AFTER_MS) {
      flushPending();
    }
  });

  session.ev.on('exit', async (code) => {
    const lastCmd = lastCommand;
    const wasBuffered = bufferMode;
    lastCommand = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

    // ── Self-command detection (FIRST — before ANY other processing) ──
    // Self-commands are pure local execution. They MUST bypass:
    //   - the noAi early-return (they don't need an LLM)
    //   - the correction engine (no shell correction makes sense for them)
    //   - the agent pipeline (they have their own handlers)
    // Check is performed against lastCmd, which is the actual command the
    // shell tried to execute — including any correction that was applied.
    if (lastCmd && code !== 0) {
      const selfCmd = matchSelfCommand(lastCmd);
      if (selfCmd.matched) {
        discardPending();
        audit.append({ kind: 'self-command', cmd: lastCmd, action: selfCmd.action, cwd });
        // Clear any stale correction state so it doesn't leak into next command
        correctionOrigin = null;
        if (selfCmd.confirm) {
          const go = await ask(`Run ${selfCmd.action}?`, true, { onCancel: () => {} });
          if (!go) { session.childWrite('\r'); return; }
        }
        executeSelfCommand(selfCmd, out, {
          opts,
          HELP,
          setColors: (v) => { colorsEnabled = v; },
        });
        session.childWrite('\r');
        return;
      }
    }

    // Determine the command to feed forward.
    // - Succeeded (code 0): only continue if a correction was applied; give agent the original.
    // - Failed  (code != 0): give agent the original command the user typed, not any
    //   corrected variant — if a correction was applied but also failed, correctionOrigin
    //   still holds the user's original input and that's what the agent should reason about.
    let cmd = lastCmd;
    if (code === 0) {
      if (correctionOrigin && !opts.noAi) {
        cmd = correctionOrigin;
        correctionOrigin = null;
      } else {
        flushPending();
        return;
      }
    } else {
      if (opts.noAi) { flushPending(); return; }
      // If a correction was applied but the corrected command also failed,
      // restore the original so the agent sees what the user actually intended.
      if (correctionOrigin) {
        cmd = correctionOrigin;
        correctionOrigin = null;
      }
    }

    // No command was observed for this exit (e.g. a non-zero status from the
    // shell's own startup/PROMPT_COMMAND before the first preexec fired).
    if (!cmd) { flushPending(); return; }

    audit.append({ kind: 'failed-command', cmd, exit: code, cwd });

    // ── Correction runs standalone (no LLM needed) ──
    let decision;
    if (opts.noCorrection) {
      decision = { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'correction disabled' };
    } else {
      try {
        decision = await correct({ input: cmd, glossary });
      } catch (e) {
        if (opts.debug) out(`\r\n\x1b[33m[shmakk] correction error: ${e.message}\x1b[0m\r\n`);
        decision = { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: `correction failed: ${e.message}` };
      }
    }
    audit.append({ kind: 'correction-decision', cmd, decision });

    // ─── Command correction branch ───
    if (decision.category === 'command_correction' && decision.proposed) {
      const safe = decision.safety === 'safe';
      if (opts.review) {
        flushPending();
        out(decisionBanner({ input: cmd, decision, mode: 'review' }));
        const go = await ask('Run?', safe, {
          onCancel: () => {},
          onWhy: () => out([
            '',
            '\x1b[36mWhy this command correction?\x1b[0m',
            `- Original command failed: ${cmd}`,
            `- Proposed correction: ${decision.proposed}`,
            `- Safety classification: ${decision.safety}`,
            `- Reason: ${decision.reason || 'deterministic match'}`,
            '',
          ].join('\r\n')),
        });
        if (go) { correctionOrigin = cmd; audit.append({ kind: 'correction-run', proposed: decision.proposed }); session.childWrite(decision.proposed + '\r'); }
        return;
      }
      // auto mode: safe + was buffered → silent correction
      if (safe && wasBuffered) {
        discardPending();
        correctionOrigin = cmd;
        audit.append({ kind: 'correction-run', proposed: decision.proposed, silent: true });
        session.childWrite(decision.proposed + '\r');
        return;
      }
      flushPending();
      out(decisionBanner({ input: cmd, decision, mode: 'auto' }));
      const go = await ask('Run?', false, {
        onCancel: () => {},
        onWhy: () => out([
          '',
          '\x1b[36mWhy this command correction?\x1b[0m',
          `- Original command failed: ${cmd}`,
          `- Proposed correction: ${decision.proposed}`,
          `- Safety classification: ${decision.safety}`,
          `- Reason: ${decision.reason || 'deterministic match'}`,
          '',
        ].join('\r\n')),
      });
      if (go) { correctionOrigin = cmd; audit.append({ kind: 'correction-run', proposed: decision.proposed }); session.childWrite(decision.proposed + '\r'); }
      return;
    }

    // ─── Task branch (needs LLM) ───
    if (!isConfigured()) {
      flushPending();
      out('\r\n\x1b[33m[shmakk] LLM not configured — no AI task available\x1b[0m\r\n');
      return;
    }

    await withAI(async (ctrl) => {
      if (opts.review || !wasBuffered) {
        flushPending();
        out(decisionBanner({ input: cmd, decision, mode: opts.review ? 'review' : 'auto' }));
        if (opts.review) {
          const go = await ask('Treat as task?', true, {
            onCancel: () => ctrl.abort(),
            onWhy: () => out([
              '',
              '\x1b[36mWhy treat this as a task?\x1b[0m',
              `- Input did not resolve to a safe auto-correction path.`,
              `- Category: ${decision.category}`,
              `- Reason: ${decision.reason || 'No additional reason provided.'}`,
              '- Running as a task lets the agent inspect files/tools and produce a concrete fix.',
              '',
            ].join('\r\n')),
          });
          if (!go) return;
        }
      } else {
        discardPending();
      }
      const routing = routeToSpecialist(cmd, [...history, { role: 'user', content: cmd }]);
      const agentProfile = opts.profile || routing.profile || 'balanced';
      const agentOpts = {
        roots: currentRoots(), glossary,
        confirmTool: makeToolConfirm(opts, ask, out, () => ctrl.abort()),
        write: out,
        signal: ctrl.signal,
        profile: agentProfile,
        colors: colorsEnabled,
        specialistHint: routing.specialistHint,
        mcpManager,
      };

      // ── Team mode (multi-agent parallel execution) ──
      // When the task spans multiple domains, the PM agent assembles a specialist
      // team, runs them in parallel, and synthesizes results. Skips plan-first
      // and single-agent if team handles it. Not active in review mode.
      if (!opts.review && looksMultiDomain(cmd)) {
        let teamHandled = false;
        try {
          teamHandled = await runTeam({
            input: cmd,
            roots: currentRoots(),
            write: out,
            signal: ctrl.signal,
            mcpManager,
            taskProfile: routing.taskProfile,
            taskType: routing.taskType,
          });
        } catch (e) {
          if (isAbortError(e)) throw e;
          out(`\x1b[33m[shmakk · pm] team error: ${e.message} — falling back to single agent\x1b[0m\r\n`);
        }
        if (teamHandled) {
          session.childWrite('\r');
          return;
        }
      }

      // ── Plan-first execution ──
      // For complex multi-step requests, generate a plan and ask for approval
      // before running anything. Prefix input with '!' to bypass.
      let usedPlan = false;
      if (!opts.review && shouldPlan(cmd)) {
        out(dim('[shmakk] generating plan…', colorsEnabled) + '\r\n');
        let plan = null;
        try {
          plan = await generatePlan(cmd, { signal: ctrl.signal });
        } catch (e) {
          if (isAbortError(e)) throw e;
          out(dim('[shmakk] plan generation failed — running directly', colorsEnabled) + '\r\n');
        }

        if (plan) {
          out(formatPlan(plan));
          const approved = await ask('Approve plan?', true, {
            onCancel: () => ctrl.abort(),
          });

          if (!approved) {
            out('\x1b[33m[shmakk] plan rejected — rephrase your request or prefix with ! to run directly\x1b[0m\r\n');
            session.childWrite('\r');
            return;
          }

          // Execute each task in order
          plan.status = 'executing';
          savePlan(currentRoots()[0], plan);
          usedPlan = true;

          // Capture git SHA before any changes — used by post-plan code review
          const planBaseSha = captureGitSha(currentRoots()[0]);

          // Write the plan tasks to TASKS.md so they're visible in the project
          try {
            addPlanTasks(currentRoots()[0], plan);
            out(dim('[shmakk] tasks written to TASKS.md', colorsEnabled) + '\r\n');
          } catch {}

          let lastUpdated = null;
          for (let i = 0; i < plan.tasks.length; i++) {
            if (ctrl.signal.aborted) break;
            const task = plan.tasks[i];
            plan.currentTaskIndex = i;
            plan.tasks[i].status = 'in_progress';
            savePlan(currentRoots()[0], plan);

            out(`\x1b[36m[${i + 1}/${plan.tasks.length}] ${task.title}\x1b[0m\r\n`);
            if (task.description) {
              out(dim(`    ${task.description}`, colorsEnabled) + '\r\n');
            }

            const taskInput = `[Task ${i + 1} of ${plan.tasks.length}: ${task.title}]\n${task.description}\n\nOverall goal: ${plan.title}\n\nOriginal request: ${cmd}`;
            try {
              const updated = await runAgent({ ...agentOpts, input: taskInput, history });
              history = trimHistory(updated || history);
              lastUpdated = updated;
              plan.tasks[i].status = 'completed';
              plan.tasks[i].completedAt = new Date().toISOString();
              savePlan(currentRoots()[0], plan);
              try { markTaskComplete(currentRoots()[0], plan.tasks[i].title, plan.tasks[i].completedAt); } catch {}
            } catch (e) {
              if (isAbortError(e)) {
                plan.tasks[i].status = 'failed';
                savePlan(currentRoots()[0], plan);
                throw e;
              }
              plan.tasks[i].status = 'failed';
              savePlan(currentRoots()[0], plan);
              out(`\r\n\x1b[31m[shmakk] task ${i + 1} failed: ${e.message}\x1b[0m\r\n`);
              const skip = await ask(`Skip task ${i + 1} and continue?`, false, {
                onCancel: () => ctrl.abort(),
              });
              if (!skip) {
                plan.status = 'aborted';
                savePlan(currentRoots()[0], plan);
                out('\x1b[33m[shmakk] plan aborted\x1b[0m\r\n');
                session.childWrite('\r');
                return;
              }
              plan.tasks[i].status = 'skipped';
              savePlan(currentRoots()[0], plan);
              try { markTaskSkipped(currentRoots()[0], plan.tasks[i].title); } catch {}
            }
          }

          const completed = plan.tasks.filter((t) => t.status === 'completed').length;
          const skipped = plan.tasks.filter((t) => t.status === 'skipped').length;
          plan.status = 'completed';
          savePlan(currentRoots()[0], plan);
          out(`\x1b[32m[shmakk] plan done: ${completed}/${plan.tasks.length} tasks completed${skipped ? `, ${skipped} skipped` : ''}\x1b[0m\r\n`);

          // ── Post-plan code review ──
          // Runs automatically after a plan completes. Examines git diff for the
          // changes made by the plan and flags critical/important/minor issues.
          if (completed > 0 && !ctrl.signal.aborted) {
            try {
              await runPostPlanReview({ plan, baseSha: planBaseSha, agentOpts, write: out });
            } catch (e) {
              if (isAbortError(e)) throw e;
              out(`\x1b[33m[shmakk · review] error: ${e.message}\x1b[0m\r\n`);
            }
          }

          // TTS for the last task's response
          if (opts.tts && lastUpdated && lastUpdated.length) {
            const lastAssistant = [...lastUpdated].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant?.content) {
              const ttsText = typeof lastAssistant.content === 'string'
                ? lastAssistant.content
                : lastAssistant.content.map((c) => c.text || '').join(' ');
              if (ttsText) {
                if (opts.sts || opts.stt) { try { getVoiceService()._killRecorder(); } catch {} }
                if (session._stsFlags) session._stsFlags.setTtsSpeaking(true);
                session._ttsGen = (session._ttsGen || 0) + 1;
                const myGen = session._ttsGen;
                const ttsVoice = opts.ttsVoice || process.env.SHMAKK_TTS_VOICE || 'af_heart';
                const tts = getTTSService();
                const settle = (err) => {
                  if (session._ttsGen !== myGen) return;
                  if (session._stsFlags) session._stsFlags.setTtsSpeaking(false);
                  if (err && opts.debug) process.stderr.write(`[shmakk] tts: ${err.message}\n`);
                };
                tts.speak(ttsText, { voice: ttsVoice }).then(() => settle()).catch(settle);
              }
            }
          }
          session.childWrite('\r');
        }
      }

      // ── Standard single-shot execution ──
      if (!usedPlan && !ctrl.signal.aborted) {
        const taskIndicator = routing.indicator
          ? `\x1b[36m[shmakk task · ${routing.indicator}] (Ctrl-C to interrupt)\x1b[0m\r\n`
          : '\x1b[36m[shmakk task] (Ctrl-C to interrupt)\x1b[0m\r\n';
        out(taskIndicator);
        try {
          const updated = await runAgent({ ...agentOpts, input: cmd, history });
          history = trimHistory(updated || history);

          // TTS: speak the agent's response aloud if --tts is active
          if (opts.tts && updated && updated.length) {
            const lastAssistant = [...updated].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant?.content) {
              const ttsText = typeof lastAssistant.content === 'string'
                ? lastAssistant.content
                : lastAssistant.content.map((c) => c.text || '').join(' ');
              if (ttsText) {
                if (opts.sts || opts.stt) { try { getVoiceService()._killRecorder(); } catch {} }
                if (session._stsFlags) session._stsFlags.setTtsSpeaking(true);
                session._ttsGen = (session._ttsGen || 0) + 1;
                const myGen = session._ttsGen;
                const ttsVoice = opts.ttsVoice || process.env.SHMAKK_TTS_VOICE || 'af_heart';
                const tts = getTTSService();
                const settle = (err) => {
                  if (session._ttsGen !== myGen) return;
                  if (session._stsFlags) session._stsFlags.setTtsSpeaking(false);
                  if (err && opts.debug) process.stderr.write(`[shmakk] tts: ${err.message}\n`);
                };
                tts.speak(ttsText, { voice: ttsVoice }).then(() => settle()).catch(settle);
              }
            }
          }

          // Force the interactive shell to redraw its prompt so the user is
          // returned cleanly to the terminal without needing to press Enter.
          session.childWrite('\r');
        } catch (e) {
          if (isAbortError(e)) {
            if (e.message === 'paused' || e.message === 'stopped') {
              // Already showed message in Ctrl+C handler
            } else {
              out('\r\n\x1b[33m[shmakk] interrupted\x1b[0m\r\n');
            }
          } else {
            out(`\r\n[shmakk] task error: ${e.message}\r\n`);
          }
        }
      } else if (!usedPlan && ctrl.signal.aborted) {
        // aborted before reaching standard execution (e.g. during plan reject/abort)
        const reason = ctrl.signal.reason?.message;
        if (reason !== 'paused' && reason !== 'stopped') {
          out('\r\n\x1b[33m[shmakk] interrupted\x1b[0m\r\n');
        }
      }
    });
  });

  const { exitCode } = await session.waitExit();
  mcpManager.shutdown().catch(() => {});
  try { const { closeBrowser } = require('./browser'); closeBrowser().catch(() => {}); } catch {}
  audit.append({ kind: 'session-end', sessionId, exitCode });
  try { sessionSearch.recordSessionEnd({ sessionId }); sessionSearch.closeDB(); } catch {}
  return exitCode;
}

module.exports = { runOneSession };
