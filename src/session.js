// Session state machine extracted from orchestrator.js.
// Manages one shmakk session: PTY lifecycle, workspace tracking, output
// buffering, command correction, and agent invocation.

const { startSession } = require('./pty');
const { correct } = require('./correction');
const { runAgent, clearTaskJournal } = require('./agent');
const { clearIndex } = require('./workspace-index');
const { loadGlossary } = require('./glossary');
const { isConfigured } = require('./llm');
const { makePrompter, decisionBanner } = require('./review');
const { workspaceWarning } = require('./safety');
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
    out([
      '\x1b[36m── shmakk tool ──\x1b[0m',
      `  action:    ${description}`,
      `  safety:    ${safety}`,
      `  auto-mode: ${wouldAuto ? 'would auto-run' : 'would ask confirmation'}`,
      '',
    ].join('\r\n'));
    const whyText = [
      '',
      '\x1b[36mWhy this tool?\x1b[0m',
      `- The agent needs to: ${description}`,
      `- Safety classification: ${safety}`,
      `- Auto-mode policy: ${wouldAuto ? 'would auto-run in this mode' : 'requires confirmation in this mode'}`,
      '- This action is required to continue the current task.',
      '',
    ].join('\r\n');
    const ok = await ask('Run?', wouldAuto, {
      onCancel: getAbort,
      onWhy: () => out(whyText),
    });
    audit.append({ kind: ok ? 'tool-allowed' : 'tool-declined', name, args });
    return ok;
  };
}

async function runOneSession(opts, registerSession) {
  const session = startSession({ debug: opts.debug, voiceEnabled: !!opts.voice });
  const colorsEnabled = opts.colors !== false;
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

  const wsWarn = workspaceWarning(cwd);
  if (wsWarn) out(`\x1b[33m[shmakk] ${wsWarn}\x1b[0m\r\n`);
  if (!isConfigured()) {
    out('\x1b[33m[shmakk] note: SHMAKK_BASE_URL not set — running as plain PTY (no AI).\x1b[0m\r\n');
  } else if (!glossary) {
    out('\x1b[33m[shmakk] tip: run `shmakk --update-command-glossary` for better corrections.\x1b[0m\r\n');
  }
  audit.append({ kind: 'session-start', workspace: cwd, pinnedWorkspace, review: !!opts.review, pid: process.pid });

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
  // Installs a stdin tap that watches for 0x03 → aborts the controller.
  // Other bytes pass through to the shell so the user can keep typing.
  // In STS mode, Ctrl+C also tears down TTS, recording, and the voice
  // loop — otherwise the user is trapped because this handler sits on
  // top of the global one and would normally eat the keypress.
  async function withAI(fn) {
    const ctrl = new AbortController();
    setMaxListeners(0, ctrl.signal);
    const release = session.captureStdin((data) => {
      const cut = findCtrlC(data);
      if (cut === -1) {
        session.childWrite(data);
        return;
      }
      if (cut > 0) session.childWrite(data.slice(0, cut));
      if (opts.sts || opts.tts || opts.stt) {
        try { fullVoiceTeardown(); } catch {}
      }
      ctrl.abort(new Error('interrupted'));
    });
    try {
      return await fn(ctrl);
    } finally {
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
    if (!isConfigured()) {
      out('\r\n\x1b[33m[shmakk] LLM not configured — voice input ignored\x1b[0m\r\n');
      return;
    }
    voiceTaskRunning = true;
    try {
      await withAI(async (ctrl) => {
        out('\x1b[36m[shmakk voice→task] (Ctrl-C to interrupt)\x1b[0m\r\n');
        try {
          const updated = await runAgent({
            input: text, roots: currentRoots(), glossary,
            confirmTool: makeToolConfirm(opts, ask, out, () => ctrl.abort()),
            write: out,
            signal: ctrl.signal,
            history,
            profile: opts.profile,
            colors: colorsEnabled,
            voiceMode: true,
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
          if (isAbortError(e)) out('\r\n\x1b[33m[shmakk] interrupted\x1b[0m\r\n');
          else out(`\r\n[shmakk] task error: ${e.message}\r\n`);
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

    // Determine the command to feed forward. Normally this is the failed
    // command, but when a correction was applied and succeeded we use the
    // user's original input so the agent handles their broader intent.
    let cmd = lastCmd;
    if (code === 0) {
      if (correctionOrigin && !opts.noAi) {
        cmd = correctionOrigin;
        correctionOrigin = null;
      } else {
        flushPending();
        return;
      }
    } else if (opts.noAi) {
      flushPending();
      return;
    }

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
      out('\x1b[36m[shmakk task] (Ctrl-C to interrupt)\x1b[0m\r\n');
      try {
        const updated = await runAgent({
          input: cmd, roots: currentRoots(), glossary,
          confirmTool: makeToolConfirm(opts, ask, out, () => ctrl.abort()),
          write: out,
          signal: ctrl.signal,
          history,
          profile: opts.profile,
          colors: colorsEnabled,
        });
        history = trimHistory(updated || history);

        // TTS: speak the agent's response aloud if --tts is active
        if (opts.tts && updated && updated.length) {
          const lastAssistant = [...updated].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant?.content) {
            const text = typeof lastAssistant.content === 'string'
              ? lastAssistant.content
              : lastAssistant.content.map((c) => c.text || '').join(' ');
            if (text) {
              // Interrupt any active voice recording so the mic doesn't
              // pick up TTS audio as the next voice command.
              if (opts.sts || opts.stt) {
                try { getVoiceService()._killRecorder(); } catch {}
              }
              // Pause STS voice loop while TTS is speaking.
              // Use a generation counter so only the latest speak's settle
              // flips ttsSpeaking back to false — prevents an earlier,
              // already-cancelled speak from unpausing the mic mid-sentence.
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
              tts.speak(text, { voice: ttsVoice }).then(() => settle()).catch(settle);
            }
          }
        }

        // Force the interactive shell to redraw its prompt so the user is
        // returned cleanly to the terminal without needing to press Enter.
        session.childWrite('\r');
      } catch (e) {
        if (isAbortError(e)) out('\r\n\x1b[33m[shmakk] interrupted\x1b[0m\r\n');
        else out(`\r\n[shmakk] task error: ${e.message}\r\n`);
      }
    });
  });

  const { exitCode } = await session.waitExit();
  audit.append({ kind: 'session-end', exitCode });
  return exitCode;
}

module.exports = { runOneSession };
