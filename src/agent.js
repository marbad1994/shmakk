// Minimal task/chat handler. Streams chat replies; for tasks, runs a small
// tool-call loop with read_file / write_file / list_dir / run constrained to
// the workspace root.
//
// Tool definitions, dispatch, web, subagents, and the system prompt are now
// in separate files: ./tools.js, ./web.js, ./subagent.js, ./system-prompt.js

const fs = require('fs');
const path = require('path');
const { makeClientForModel, modelFor, isConfigured, getReasoningOptions, supportsVision, describeImages, userContentWithImages, stripImageBlocks, imageBlocks, normalizeImages, skippedNote } = require('./llm');
const {
  sanitizeAssistantContent,
  isLeakedToolMarkup,
  mightBecomeInternalMarkup,
  MUTATION_TOOLS,
  isMutationTool,
  hashArgs,
  DSML_RETRY_USER_MESSAGE,
} = require('./guard');
const { buildOrRefreshIndex, relevantSubgraph } = require('./workspace-index');
const { renderActiveSkillForPrompt } = require('./skills');
const { renderRulesForPrompt } = require('./rules');
const { renderMemoryForPrompt } = require('./memory');
const sessionSearch = require('./session-search');
const promptCache = require('./prompt-cache');
const audit = require('./audit');
const { buildSystemPrompt } = require('./system-prompt');
const {
  TOOLS,
  classifyTool,
  describeTool,
  dispatchTool,
  normalizeToolCalls,
  applyRoundToolBudget,
  parseFallbackActions,
  parseXmlFallbackActions,
} = require('./tools');
const { shouldUseAutoSubagents, runAutoSubagents } = require('./subagent');

const MAX_TOOL_ITERS = Math.max(1, Number(process.env.SHMAKK_MAX_TOOL_ITERS) || 16);
const CONTEXT_PROFILES = {
  tiny: { historyEntries: 10, maxToolIters: Math.min(MAX_TOOL_ITERS, 10), stallRepeat: 2, maxDiscoveryCallsPerRound: 1 },
  balanced: { historyEntries: 20, maxToolIters: MAX_TOOL_ITERS, stallRepeat: 3, maxDiscoveryCallsPerRound: 2 },
  deep: { historyEntries: 40, maxToolIters: Math.max(MAX_TOOL_ITERS, 24), stallRepeat: 4, maxDiscoveryCallsPerRound: 3 },
  builder: { historyEntries: 50, maxToolIters: Math.max(MAX_TOOL_ITERS, 32), stallRepeat: 5, maxDiscoveryCallsPerRound: 4 },
  'large-app': { historyEntries: 50, maxToolIters: Math.max(MAX_TOOL_ITERS, 32), stallRepeat: 5, maxDiscoveryCallsPerRound: 4 },
};

function contextProfile(mode) {
  const key = String(mode || 'balanced').toLowerCase();
  return CONTEXT_PROFILES[key] || CONTEXT_PROFILES.balanced;
}

function trimForContext(history, maxEntries) {
  if (!Array.isArray(history) || history.length <= maxEntries) return history || [];
  let cut = history.length - maxEntries;
  while (cut > 0 && history[cut] && history[cut].role === 'tool') cut--;
  return history.slice(cut);
}

function journalPath(root) {
  return path.join(root, '.shmakk', 'state', 'task-journal.json');
}

function loadTaskJournal(root) {
  try {
    const p = journalPath(root);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveTaskJournal(root, journal) {
  try {
    const p = journalPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(journal, null, 2));
  } catch {}
}

function clearTaskJournal(root) {
  try { fs.rmSync(journalPath(root), { force: true }); } catch {}
}

const { renderBlock } = require('./markdown');

// Tiny spinner so the user sees "the agent is thinking" while we wait on
// the model. Erased when stop() is called. Also updates the terminal tab
// title so you can see agent activity even when looking at another tab.
function startSpinner(write, label = 'thinking') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0; let line = '';
  const draw = () => {
    line = `\x1b[2m${frames[i % frames.length]} ${label}…\x1b[0m`;
    write('\r' + line);
    // Update terminal tab/window title so activity is visible from other tabs
    write(`\x1b]0;${frames[i % frames.length]} ${label} — shmakk\x07`);
    i++;
  };
  draw();
  const tm = setInterval(draw, 100);
  return () => {
    clearInterval(tm);
    write('\r' + ' '.repeat(line.replace(/\x1b\[[0-9;]*m/g, '').length + 2) + '\r\r');
    // Clear the terminal title — shell will restore normal title on next prompt
    write('\x1b]0;\x07');
  };
}

function dim(s, enabled = true) { return enabled ? `\x1b[2m${s}\x1b[0m` : s; }

// ── Main agent entry point ──────────────────────────────────────────────────

async function runAgent({ input, roots, glossary, confirmTool, write, signal, history = [], profile = 'balanced', colors = true, markdown = true, voiceMode = false, specialistHint = null, mcpManager = null, requireToolUse = false, onEvent = null, model = null, images = null, effort = null }) {
  // Reasoning effort for reasoning-capable OpenAI-compatible endpoints.
  // Per-request value wins; otherwise fall back to SHMAKK_EFFORT from the CLI.
  const effortLevel = effort || process.env.SHMAKK_EFFORT || null;
  // onEvent: optional structured-event sink used by GUI front-ends (web UI).
  // When present, streaming text, tool calls and results are reported as
  // objects instead of being rendered to `write` as terminal text.
  const emit = typeof onEvent === 'function' ? (ev) => { try { onEvent(ev); } catch {} } : null;
  // roots: array of allowed workspace roots (first is the primary cwd).
  // history: prior conversation turns (assistant/user/tool). System prompt
  // is rebuilt fresh each call so the current cwd is always accurate.
  if (!isConfigured('agent')) {
    write(`[shmakk] AI not configured (set SHMAKK_BASE_URL).\n`);
    return history;
  }
  const resolved = makeClientForModel(model);
  const client = resolved.client;
  const modelName = resolved.model;
  const rootList = roots.length === 1 ? roots[0] : roots.join(', ');
  const priorJournal = loadTaskJournal(roots[0]);
  const activeSkillText = renderActiveSkillForPrompt(roots[0], Number(process.env.SHMAKK_SKILL_PROMPT_MAX_BYTES) || 12000);
  const touchedFiles = new Set(Array.isArray(priorJournal?.touchedFiles) ? priorJournal.touchedFiles : []);
  const startedAt = Date.now();
  const runtimeProfile = contextProfile(profile);
  const baseToolBudget = runtimeSafeNumber(runtimeProfile.maxToolIters, 16);
  let dynamicToolBudget = baseToolBudget;
  let noProgressRepeats = 0;

  function persistJournal(state) {
    saveTaskJournal(roots[0], {
      status: state,
      input,
      updatedAt: new Date().toISOString(),
      startedAt: priorJournal?.startedAt || new Date(startedAt).toISOString(),
      profile,
      touchedFiles: Array.from(touchedFiles).slice(-200),
      roundsBudget: dynamicToolBudget,
      roots,
    });
  }

  persistJournal('running');
  const promptCacheEnabled = String(process.env.SHMAKK_PROMPT_CACHE || '1') !== '0';

  // ── Per-turn mutation-approval state ───────────────────────────────────
  // Every mutation tool call must be individually approved.  If the user
  // denies ANY mutation in a turn, ALL pending mutations from that turn are
  // invalidated.  This prevents the agent from executing an edit after the
  // user said no.
  const turnApprovals = new Map();   // toolCallId → { approved, argsHash, expiresAt }
  let turnDenied = false;

  function clearTurnApprovals() {
    turnApprovals.clear();
    turnDenied = false;
  }

  function wrapConfirmTool(baseConfirm) {
    if (!baseConfirm) return null;
    return async ({ name, args, safety, description }) => {
      // If this turn has already been denied, reject all mutation tools.
      if (turnDenied && isMutationTool(name)) {
        return false;
      }
      const ok = await baseConfirm({ name, args, safety, description });
      if (!ok && isMutationTool(name)) {
        turnDenied = true;
        // Invalidate any pre-approved mutation calls from this turn.
        for (const [id, a] of turnApprovals) {
          if (isMutationTool(a.toolName)) a.approved = false;
        }
      }
      return ok;
    };
  }

  const guardedConfirm = wrapConfirmTool(confirmTool);
  const maxDiscoveryCallsPerRound = Math.max(
    1,
    Number(process.env.SHMAKK_MAX_DISCOVERY_CALLS_PER_ROUND)
      || runtimeProfile.maxDiscoveryCallsPerRound
      || 2,
  );
  let indexHint = '';
  try {
    const idx = await buildOrRefreshIndex(roots[0]);
    const graph = relevantSubgraph(idx, input, 12, 1);
    if (graph.length) {
      indexHint = `\n\nCompact relevant subgraph for this task:\n${graph.map((n) => `- ${n.path} [role=${n.role}] symbols=${n.symbols.slice(0, 4).join(', ') || '-'} edges=${n.edges.slice(0, 4).join(', ') || '-'} snippet=${(n.snippet || []).slice(0, 3).join(' | ') || '-'}`).join('\n')}\nStart with these files and their immediate dependencies before broad exploration. Prefer these snippet cues before reading full files.`;
    } else {
      // Fallback: no query hits — give the agent a top-level map so it can
      // start exploring without waiting for the user to say "read the dir".
      const files = idx.files || {};
      const configHints = [];
      const topDirs = new Set();
      const topFiles = new Set();
      const allKeys = Object.keys(files);
      // Determine which top-level names are directories vs files by checking
      // whether they appear as a prefix for deeper entries.
      const hasSlash = new Map(); // topName -> true if dir, false if top-level file
      for (const rel of allKeys) {
        const top = rel.split('/')[0];
        if (!top || top.startsWith('.') || top === 'node_modules') continue;
        if (rel === top) {
          // A top-level file (no / in path) — only mark if not already known as dir
          if (!hasSlash.has(top)) hasSlash.set(top, false);
        } else {
          // e.g. "src/agent.js" — top="src", this is a directory
          hasSlash.set(top, true);
        }
        const base = rel.split('/').pop();
        if (base === 'package.json' || base === 'README.md' || base === 'tsconfig.json') {
          const f = files[rel];
          configHints.push(`- ${rel} [role=${f.role}] snippet=${(f.snippet || []).slice(0, 1).join(' | ') || '-'}`);
        }
      }
      for (const [name, isDir] of hasSlash) {
        if (isDir) topDirs.add(name); else topFiles.add(name);
      }
      const topLines = [];
      if (topDirs.size) topLines.push(`Top-level dirs: ${[...topDirs].sort().join(', ')}`);
      if (topFiles.size) topLines.push(`Top-level files: ${[...topFiles].sort().join(', ')}`);
      indexHint = `\n\nWorkspace structure (no query hits — start by exploring relevant directories):\n${topLines.join('\n')}${configHints.length ? '\n' + configHints.join('\n') : ''}\nUse list_dir to explore further.`;
    }
  } catch (e) {
    indexHint = `\n\nWorkspace index unavailable (${e.message || 'unknown error'}). Start with list_dir of the root directory to discover the project structure.`;
  }

  // Build MCP tool hint for system prompt if MCP tools are available
  let mcpToolHint = null;
  if (mcpManager) {
    const mcpDefs = mcpManager.getToolDefinitions();
    if (mcpDefs.length) {
      const toolList = mcpDefs.map((d) => `- ${d.function.name}: ${d.function.description}`).join('\n');
      mcpToolHint = `MCP Tools Available (external tool servers):\n${toolList}\nUse these tools by calling them directly. They behave like regular tools.`;
    }
  }

  const userRulesText = renderRulesForPrompt(roots[0]);
  const userMemoryText = renderMemoryForPrompt(roots[0]);

  const sys = buildSystemPrompt({
    roots,
    rootList,
    indexHint,
    activeSkillText,
    maxDiscoveryCallsPerRound,
    voiceMode,
    specialistHint,
    mcpToolHint,
    userRulesText,
    userMemoryText,
    supportsVision: supportsVision(),
  });

  const boundedHistory = trimForContext(history, runtimeProfile.historyEntries);
  const resumeContext = priorJournal && priorJournal.status === 'running'
    ? `\n\nResume context from previous interrupted run:\n- previous_input: ${String(priorJournal.input || '').slice(0, 300)}\n- touched_files: ${(priorJournal.touchedFiles || []).slice(-20).join(', ') || '(none)'}\n- note: continue from latest completed work, avoid redoing already-touched steps unless necessary.`
    : '';

  // Attached images (from the composer) are shown to this turn only. Vision
  // endpoints get real image blocks; otherwise a vision endpoint describes them.
  const userContent = await userContentWithImages(input + resumeContext, images, signal);

  const messages = [
    { role: 'system', content: sys },
    ...boundedHistory,
    { role: 'user', content: userContent },
  ];

  // Handed-back history stays text-only so base64 never gets persisted into a
  // conversation file or resent on later turns.
  const historyOut = () => stripImageBlocks(messages.slice(1));

  // Record user input as a turn for cross-session search
  const searchSessionId = process.env.SHMAKK_SESSION_ID || null;
  if (searchSessionId) {
    try { sessionSearch.recordTurn({ sessionId: searchSessionId, role: 'user', content: input }); } catch {}
  }

  if (shouldUseAutoSubagents(input, roots)) {
    try {
      write(dim('[shmakk] auto-subagents: planning pass', colors) + '\n');
      const subFindings = await runAutoSubagents({ client, input, roots, signal });
      if (subFindings) {
        messages.splice(1, 0, {
          role: 'system',
          content: `Auto-subagent findings (read-only planning):\n${subFindings}\nUse these findings as hints only; still verify via tools before edits.`,
        });
      }
    } catch {}
  }

  // Prevent repeated expensive reads/searches within a single task run.
  const toolResultCache = new Map();
  const cacheableTools = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url']);
  let lastSignature = '';
  let repeatedSignatureCount = 0;

  // Tool loop. Streams content as it arrives; prints each tool call.
  let producedAnything = false;
  const runState = { _dsmlLeakRetries: 0 };
  let taskSpinnerStop = null;
  const ensureSpinner = () => {
    if (!taskSpinnerStop) taskSpinnerStop = startSpinner(write, 'thinking');
  };
  const stopTaskSpinner = () => {
    if (taskSpinnerStop) { taskSpinnerStop(); taskSpinnerStop = null; }
  };
  for (let i = 0; i < dynamicToolBudget; i++) {
    if (signal && signal.aborted) { stopTaskSpinner(); return historyOut(); }

    // Stream the response so the user sees text as it generates.
    const cacheKey = promptCacheEnabled ? promptCache.makeKey({ model: modelName, messages, toolChoice: 'auto' }) : null;
    if (promptCacheEnabled && cacheKey) {
      const hit = promptCache.get(roots[0], cacheKey);
      if (hit && hit.content) {
        stopTaskSpinner();
        if (emit) {
          emit({ type: 'message', content: hit.content, cached: true });
        } else {
          write(dim('[shmakk] prompt cache hit', colors) + '\n');
          write(renderBlock(hit.content, { enabled: markdown, colors }));
          if (!hit.content.endsWith('\n')) write('\n');
        }
        messages.push({ role: 'assistant', content: hit.content });
        clearTaskJournal(roots[0]);
        return historyOut();
      }
    }

    if (emit) emit({ type: 'status', label: i === 0 ? 'thinking' : 'continuing' });
    else ensureSpinner();
    const allTools = mcpManager ? [...TOOLS, ...mcpManager.getToolDefinitions()] : TOOLS;
    let stream;
    try {
      // First iteration only: optionally force a tool call so the model can't
      // silently respond with text. After the first round any further calls
      // can be either tool or text.
      const toolChoiceForThisIter = (requireToolUse && i === 0) ? 'required' : 'auto';
      stream = await client.chat.completions.create({
        model: modelName,
        messages, tools: allTools, tool_choice: toolChoiceForThisIter,
        temperature: 0, stream: true,
        ...getReasoningOptions('tool_loop', effortLevel),
      }, { signal });
    } catch (e) {
      stopTaskSpinner();
      throw e;
    }

    let content = '';
    let reasoningContent = '';
    const toolCalls = []; // [{id, type:'function', function:{name, arguments}}]
    let streamingContentOk = true;  // flipped to false on leak
    try {
      for await (const chunk of stream) {
        // Check for abort between chunks.
        if (signal && signal.aborted) {
          streamingContentOk = false;
          break;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          // ── Streaming guard: buffer tokens before flushing ──────────
          // We never append tokens directly to visible chat state.
          // Small lookbehind buffer so partial strings like "<｜｜DSML"
          // are not flushed before we can detect them.
          const token = delta.content;
          content += token;
          if (emit) emit({ type: 'delta', text: token });

          // Check the trailing portion for partial DSML prefixes.
          // Only check the last ~80 chars — enough to catch any prefix.
          const tail = content.slice(-80);
          if (mightBecomeInternalMarkup(tail)) {
            // Hold back — don't flush yet, the next token may complete
            // a benign string or reveal leaked markup.
            continue;
          }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
          reasoningContent += delta.reasoning_content;
          if (emit) emit({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            const slot = toolCalls[idx];
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.function.name = tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      }
    } finally {
      // Spinner runs continuously from loop start — stopped below when
      // we're about to show output or dispatch tools that may need input.
    }

    // ── DSML leak detection (after stream completes) ────────────────────
    if (content && isLeakedToolMarkup(content)) {
      const sanitized = sanitizeAssistantContent(content);
      // Log the leak but do NOT persist raw content.
      audit.append({
        kind: 'dsml-leak',
        model: modelFor('agent'),
        leakedMarkupDetected: true,
        retried: false,
      });

      // If this is the first leak in this turn, retry once with safer settings.
      // We inject a user message telling the model not to emit DSML and re-run
      // the current iteration.
      const RETRY_MAX = 1;
      if (!runState._dsmlLeakRetries) runState._dsmlLeakRetries = 0;

      if (runState._dsmlLeakRetries < RETRY_MAX) {
        runState._dsmlLeakRetries += 1;

        // Remove the last user message (the one that triggered this turn)
        // and replace it with the retry instruction so we don't grow history.
        // Find the last user message index.
        let lastUserIdx = -1;
        for (let mi = messages.length - 1; mi >= 0; mi--) {
          if (messages[mi].role === 'user') { lastUserIdx = mi; break; }
        }
        if (lastUserIdx >= 0) {
          messages.splice(lastUserIdx, 1);
        }
        messages.push(DSML_RETRY_USER_MESSAGE);

        // Disable thinking for this retry.
        process.env._SHMAKK_FORCE_NO_THINKING = '1';
        i--; // re-spend this iteration
        audit.append({ kind: 'dsml-leak-retry', model: modelFor('agent') });
        continue; // re-enter the tool loop
      }

      // Max retries exceeded — strip and show what we can.
      content = sanitized.visibleText;
      if (!content) {
        stopTaskSpinner();
        write(dim('[shmakk] response contained only leaked tool markup — blocked.', colors) + '\n');
        clearTaskJournal(roots[0]);
        return historyOut();
      }
    }

    const fallbackActions = toolCalls.length ? [] : [
      ...parseFallbackActions(content),
      ...parseXmlFallbackActions(content),
    ];
    if (fallbackActions.length) {
      for (const action of fallbackActions) {
        toolCalls.push({
          id: `fallback_${i}_${toolCalls.length}`,
          type: 'function',
          function: { name: action.name, arguments: JSON.stringify(action.args) },
        });
      }
      content = '';
      // The streamed text was really a tool call in disguise — take it back.
      if (emit) emit({ type: 'retract' });
    }

    const normalizedToolCalls = applyRoundToolBudget(normalizeToolCalls(toolCalls, i), maxDiscoveryCallsPerRound);

    const signature = normalizedToolCalls
      .map((c) => `${c.function.name}:${c.function.arguments || '{}'}`)
      .join('|');
    const signatureRepeated = !!signature && signature === lastSignature;
    if (signatureRepeated) repeatedSignatureCount += 1;
    else repeatedSignatureCount = 0;
    lastSignature = signature;

    // Persist this turn for history.
    const hasToolCalls = normalizedToolCalls.length > 0;
    const hasContent = !!content;
    const msg = {
      role: 'assistant',
      ...(hasContent ? { content } : (hasToolCalls ? { content: null } : { content: '' })),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(hasToolCalls ? { tool_calls: normalizedToolCalls } : {}),
    };
    if (hasContent || hasToolCalls || reasoningContent) messages.push(msg);

    // Record assistant text turn for cross-session search (skip tool-only turns
    // which have no human-readable content worth indexing).
    if (hasContent && searchSessionId) {
      try { sessionSearch.recordTurn({ sessionId: searchSessionId, role: 'assistant', content }); } catch {}
    }

    // No tools → done.
    if (!normalizedToolCalls.length) {
      stopTaskSpinner();
      if (content) {
        if (emit) {
          emit({ type: 'message', content });
        } else {
          write(renderBlock(content, { enabled: markdown, colors }));
          if (!content.endsWith('\n')) write('\n');
        }
        producedAnything = true;
        if (promptCacheEnabled && cacheKey) {
          promptCache.put(roots[0], cacheKey, { content });
        }
      }
      // Only show "no response" message if we didn't abort and got no content.
      // If signal is aborted (user interrupt), suppress the message.
      if (!producedAnything && !(signal && signal.aborted)) {
        write(dim('[shmakk] model returned no response — try `shmakk --reset` or rephrase.', colors) + '\n');
      }
      clearTaskJournal(roots[0]);
      return historyOut();
    }

    // Dispatch tool calls.
    // Reads/lists are noisy — collect them silently and show a single dim summary.
    // Writes, edits, runs, and errors always print clearly.
    stopTaskSpinner();
    const SILENT_TOOLS = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url']);
    let iterProgress = false;
    let silentReads = [];
    // Text that accompanied tool calls ("I'll read the config first…") is
    // only surfaced to structured front-ends; the terminal stays quiet.
    if (emit && content) emit({ type: 'message', content, interim: true });
    for (const c of normalizedToolCalls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      if (typeof args.path === 'string' && args.path) {
        touchedFiles.add(args.path);
        if (searchSessionId) {
          try { sessionSearch.recordFileTouched({ sessionId: searchSessionId, tool: c.function.name, filePath: args.path }); } catch {}
        }
      }

      const isSilent = SILENT_TOOLS.has(c.function.name);
      const cacheKey = `${c.function.name}:${JSON.stringify(args || {})}`;
      const canUseCache = cacheableTools.has(c.function.name);
      let result;
      if (emit) emit({ type: 'tool_start', id: c.id, name: c.function.name, args });
      if (canUseCache && toolResultCache.has(cacheKey)) {
        result = toolResultCache.get(cacheKey);
      } else {
        result = await dispatchTool(c.function.name, args, roots, guardedConfirm, signal, mcpManager);
        if (canUseCache && !result?.error) toolResultCache.set(cacheKey, result);
        iterProgress = true;
      }

      if (emit) {
        emit({
          type: 'tool_end', id: c.id, name: c.function.name, args, result,
          summary: summarizeToolResult(c.function.name, result),
          error: result?.error || null,
        });
      } else if (result?.error) {
        // Always show errors regardless of tool type
        write(dim(`→ ${c.function.name}(${shortArgs(args)}) — error: ${result.error}`, colors) + '\n');
      } else if (isSilent) {
        // Collect for batched summary
        silentReads.push(shortArgs(args) || c.function.name);
      } else {
        // Action tools: write, edit, run, make_dir, delete — show clearly
        const summary = summarizeToolResult(c.function.name, result);
        write(dim(`→ ${c.function.name}(${shortArgs(args)})${summary ? ' — ' + summary : ''}`, colors) + '\n');
      }

      // Build tool result message. If the result includes images with real
      // base64 data AND the current endpoint has `vision: true`, send them as
      // vision content blocks in a follow-up user message. Otherwise just
      // include image metadata in the text. Keep the tool message text-only.
      // Only formats the provider accepts survive normalisation; anything else
      // is converted to png up front or reported as text instead of sent.
      const rawToolImages = Array.isArray(result.images) ? result.images.filter((img) => img.data) : [];
      const prepared = rawToolImages.length ? await normalizeImages(rawToolImages) : { images: [], skipped: [] };
      const toolImages = prepared.images;
      const skippedNoteText = skippedNote(prepared.skipped);
      const toolText = result.content || '';
      const toolMeta = Object.fromEntries(
        Object.entries(result || {}).filter(([k]) => !['content', 'images', 'error', 'isRetryable'].includes(k)),
      );
      let toolContent = (toolText + (Object.keys(toolMeta).length ? ' ' + JSON.stringify(toolMeta) : '')).trim();
      if (skippedNoteText) toolContent = toolContent ? `${toolContent} ${skippedNoteText}` : skippedNoteText;
      if (toolImages.length > 0 && !supportsVision()) {
        // Endpoint doesn't support vision — call a vision-capable endpoint
        // to describe the images as text for the non-vision model.
        const visionDesc = await describeImages(toolImages, signal);
        if (visionDesc) {
          toolContent = toolContent ? `${toolContent}\n${visionDesc}` : visionDesc;
        } else {
          // Fallback: include image metadata as text
          const imgDesc = toolImages.map((img, i) => `[Image #${i + 1}: ${img.mimeType}, base64=${img.dataLength} chars${img.truncated ? ', truncated' : ''}]`).join(', ');
          toolContent = toolContent ? `${toolContent} ${imgDesc}` : imgDesc;
        }
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: toolContent.slice(0, 8000) });
      if (toolImages.length > 0 && supportsVision()) {
        messages.push({
          role: 'user',
          content: imageBlocks(
            `[Images returned by ${c.function.name}${toolImages.some((img) => img.truncated) ? ' (some truncated to ~2MB base64)' : ''}]`,
            toolImages,
          ),
        });
      }
      producedAnything = true;
      persistJournal('running');
      if (signal && signal.aborted) return historyOut();
    }

    // Print batched read summary if any
    if (silentReads.length && !emit) {
      write(dim(`· read ${silentReads.length === 1 ? silentReads[0] : silentReads.length + ' files'}`, colors) + '\n');
    }

    if (signatureRepeated && !iterProgress) noProgressRepeats += 1;
    else noProgressRepeats = 0;

    if (iterProgress && dynamicToolBudget < runtimeProfile.maxToolIters + 12) {
      dynamicToolBudget += 1;
    }

    if (repeatedSignatureCount >= runtimeProfile.stallRepeat && noProgressRepeats >= 2) {
      stopTaskSpinner();
      break;
    }
  }

  // Finalization pass: force a no-tools answer before giving up.
  try {
    const final = await client.chat.completions.create({
      model: modelName,
      messages: [
        ...messages,
        { role: 'user', content: 'Finalize now without using any tools. Summarize completed work and exact next actionable step if blocked.' },
      ],
      temperature: 0,
      tool_choice: 'none',
      stream: false,
      ...getReasoningOptions('tool_loop', effortLevel),
    }, { signal });
    const finalText = final.choices?.[0]?.message?.content || '';
    if (finalText) {
      // ── DSML leak guard (same as the main loop) ──────────────────────
      const finalSanitized = sanitizeAssistantContent(finalText);
      const displayText = finalSanitized.hadInternalLeak
        ? finalSanitized.visibleText
        : finalText;
      if (finalSanitized.hadInternalLeak) {
        audit.append({ kind: 'dsml-leak-finalize', model: modelFor('agent'), leakedMarkupDetected: true });
      }
      if (emit) {
        emit({ type: 'message', content: displayText });
      } else if (displayText) {
        write(renderBlock(displayText, { enabled: markdown, colors }));
        if (!displayText.endsWith('\n')) write('\n');
      }
      clearTaskJournal(roots[0]);
      return historyOut();
    }
  } catch {}

  stopTaskSpinner();
  write(dim('[shmakk] paused after several tool rounds. Resume later continues from task journal; try `shmakk --reset` to clear.', colors) + '\n');
  persistJournal('paused');
  return historyOut();
}

function runtimeSafeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function shortArgs(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.path === 'string') return args.path;
  if (typeof args.cmd === 'string') return args.cmd.slice(0, 80);
  return JSON.stringify(args).slice(0, 80);
}

function summarizeToolResult(name, r) {
  if (!r || typeof r !== 'object') return '';
  if (r.error) return `error: ${r.error}`;
  if (name === 'read_file' && typeof r.content === 'string') {
    return `read ${r.content.length} bytes${r.truncated ? ' (truncated)' : ''}`;
  }
  if (name === 'list_dir' && Array.isArray(r.entries)) {
    return `${r.entries.length} entries`;
  }
  if (name === 'run' && typeof r.exitCode !== 'undefined') {
    return `exit ${r.exitCode}`;
  }
  if (name === 'web_search' && Array.isArray(r.results)) return `${r.results.length} results`;
  if (name === 'fetch_url' && typeof r.status !== 'undefined') return `HTTP ${r.status}`;
  if (name === 'write_file' && r.ok) return 'written';
  if (name === 'edit_file' && r.ok) return 'edited';
  if (name === 'make_dir' && r.ok) return 'created';
  if (name === 'delete_file' && r.ok) return 'deleted';
  if (name === 'browser') {
    if (r.error) return `error: ${r.error}`;
    if (r.title) return `${r.url || ''} — ${r.title}`;
    if (r.ok) return r.message || 'done';
    return '';
  }
  return '';
}

module.exports = {
  runAgent,
  classifyTool,
  describeTool,
  parseFallbackActions,
  parseDdgLite: require('./web').parseDdgLite,
  loadTaskJournal,
  clearTaskJournal,
  shouldUseAutoSubagents,
  summarizeToolResult,
};
