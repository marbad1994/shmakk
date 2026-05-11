// Session state machine extracted from orchestrator.js.
// Manages one shmakk session: PTY lifecycle, workspace tracking, output
// buffering, command correction, and agent invocation.

const { startSession } = require('./pty');
const { correct } = require('./correction');
const { runAgent, clearTaskJournal } = require('./agent');
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
  async function withAI(fn) {
    const ctrl = new AbortController();
    // A single task can legitimately attach many short-lived abort listeners
    // across provider SDK calls and tool helpers.
    setMaxListeners(0, ctrl.signal);
    const release = session.captureStdin((data) => {
      let cut = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x03) { cut = i; break; }
      }
      if (cut === -1) {
        session.childWrite(data);
        return;
      }
      // pass any pre-^C bytes; abort; drop the rest
      if (cut > 0) session.childWrite(data.slice(0, cut));
      ctrl.abort(new Error('interrupted'));
    });
    try {
      return await fn(ctrl);
    } finally {
      release();
    }
  }

  session.ev.on('cwd', (p) => { if (p) cwd = p; });
  function resetHistory() {
    history = [];
    try { clearTaskJournal(currentRoots()[0]); } catch {}
    out('\r\n\x1b[33m[shmakk] conversation + task journal cleared\x1b[0m\r\n');
  }
  registerSession(session, resetHistory);

  // ── Continuous voice loop (--sts always-on) ──
  // When --sts is active, runs a background loop: listen → transcribe → inject.
  // No hotkey needed — just speak and pause.
  if (opts.sts) {
    const vs = getVoiceService();
    if (!vs.isAvailable()) {
      out('\r\n\x1b[33m[shmakk] no audio recorder found. Install sox.\x1b[0m\r\n');
    } else {
      let voiceLoopActive = true;
      let voiceBusy = false;

      const voiceLoop = async () => {
        while (voiceLoopActive) {
          if (voiceBusy) { await new Promise(r => setTimeout(r, 100)); continue; }
          voiceBusy = true;
          try {
            const text = await vs.recordAndTranscribe({
              language: opts.voiceLanguage || process.env.SHMAKK_VOICE_LANGUAGE || 'english',
              maxDurationSec: parseInt(opts.voiceMaxDuration || process.env.SHMAKK_VOICE_MAX_SEC || '30', 10),
            });
            if (text && voiceLoopActive) {
              session.childWrite(text + '\r');
            }
          } catch (err) {
            if (opts.debug) process.stderr.write(`[shmakk voice] ${err.message}\n`);
            // Brief pause on error before retrying
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
            if (data[i] === 0x03 || data[i] === 0x0f) { recordingDone = true; release(); return; }
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
          // transcript already echoed to stderr by voice service
          session.childWrite(text);
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
              const ttsVoice = opts.ttsVoice || process.env.SHMAKK_TTS_VOICE || 'af_heart';
              const tts = getTTSService();
              tts.speak(text, { voice: ttsVoice }).catch((err) => {
                // Fire-and-forget; ignore playback errors
                if (opts.debug) process.stderr.write(`[shmakk] tts: ${err.message}\n`);
              });
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
