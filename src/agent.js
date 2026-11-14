// Minimal task/chat handler. Streams chat replies; for tasks, runs a small
// tool-call loop with read_file / write_file / list_dir / run constrained to
// the workspace root.
//
// Tool definitions, dispatch, web, subagents, and the system prompt are now
// in separate files: ./tools.js, ./web.js, ./subagent.js, ./system-prompt.js

const fs = require('fs');
const path = require('path');
const { makeClient, modelFor, isConfigured } = require('./llm');
const { buildOrRefreshIndex, relevantSubgraph } = require('./workspace-index');
const { renderActiveSkillForPrompt } = require('./skills');
const { renderRulesForPrompt } = require('./rules');
const { renderMemoryForPrompt } = require('./memory');
const sessionSearch = require('./session-search');
const promptCache = require('./prompt-cache');
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

// Tiny spinner so the user sees "the agent is thinking" while we wait on
// the model. Erased when stop() is called.
function startSpinner(write, label = 'thinking') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0; let line = '';
  const draw = () => {
    line = `\x1b[2m${frames[i % frames.length]} ${label}…\x1b[0m`;
    write('\r' + line);
    i++;
  };
  draw();
  const tm = setInterval(draw, 100);
  return () => {
    clearInterval(tm);
    write('\r' + ' '.repeat(line.replace(/\x1b\[[0-9;]*m/g, '').length + 2) + '\r\r');
  };
}

function dim(s, enabled = true) { return enabled ? `\x1b[2m${s}\x1b[0m` : s; }

function highlightCodeBlocks(text, enabled = true) {
  const src = String(text || '');
  if (!enabled) return src;
  return src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const head = `\x1b[36m\x1b[1m${lang || 'code'}\x1b[0m`;
    const body = `\x1b[90m${code.replace(/\n$/, '')}\x1b[0m`;
    return `${head}\n${body}`;
  }).replace(/\u0000\u0000\u0000/g, '```');
}

// ── Main agent entry point ──────────────────────────────────────────────────

async function runAgent({ input, roots, glossary, confirmTool, write, signal, history = [], profile = 'balanced', colors = true, voiceMode = false, specialistHint = null, mcpManager = null, requireToolUse = false, onEvent = null }) {
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
  const client = makeClient('agent');
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
    }
  } catch {}

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
  });

  const boundedHistory = trimForContext(history, runtimeProfile.historyEntries);
  const resumeContext = priorJournal && priorJournal.status === 'running'
    ? `\n\nResume context from previous interrupted run:\n- previous_input: ${String(priorJournal.input || '').slice(0, 300)}\n- touched_files: ${(priorJournal.touchedFiles || []).slice(-20).join(', ') || '(none)'}\n- note: continue from latest completed work, avoid redoing already-touched steps unless necessary.`
    : '';

  const messages = [
    { role: 'system', content: sys },
    ...boundedHistory,
    { role: 'user', content: input + resumeContext },
  ];

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
  for (let i = 0; i < dynamicToolBudget; i++) {
    if (signal && signal.aborted) return messages.slice(1);

    // Stream the response so the user sees text as it generates.
    const cacheKey = promptCacheEnabled ? promptCache.makeKey({ model: modelFor('agent'), messages, toolChoice: 'auto' }) : null;
    if (promptCacheEnabled && cacheKey) {
      const hit = promptCache.get(roots[0], cacheKey);
      if (hit && hit.content) {
        if (emit) {
          emit({ type: 'message', content: hit.content, cached: true });
        } else {
          write(dim('[shmakk] prompt cache hit', colors) + '\n');
          write(highlightCodeBlocks(hit.content, colors));
          if (!hit.content.endsWith('\n')) write('\n');
        }
        messages.push({ role: 'assistant', content: hit.content });
        clearTaskJournal(roots[0]);
        return messages.slice(1);
      }
    }

    const spinnerLabel = i === 0 ? 'thinking' : 'continuing';
    if (emit) emit({ type: 'status', label: spinnerLabel });
    const stop = emit ? () => {} : startSpinner(write, spinnerLabel);
    const allTools = mcpManager ? [...TOOLS, ...mcpManager.getToolDefinitions()] : TOOLS;
    let stream;
    try {
      // First iteration only: optionally force a tool call so the model can't
      // silently respond with text. After the first round any further calls
      // can be either tool or text.
      const toolChoiceForThisIter = (requireToolUse && i === 0) ? 'required' : 'auto';
      stream = await client.chat.completions.create({
        model: modelFor('agent'),
        messages, tools: allTools, tool_choice: toolChoiceForThisIter,
        temperature: 0, stream: true,
      }, { signal });
    } catch (e) {
      stop();
      throw e;
    }

    let content = '';
    let reasoningContent = '';
    const toolCalls = []; // [{id, type:'function', function:{name, arguments}}]
    let spinnerStopped = false;
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          if (emit) emit({ type: 'delta', text: delta.content });
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
          reasoningContent += delta.reasoning_content;
          if (emit) emit({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.tool_calls) {
          if (!spinnerStopped) { stop(); spinnerStopped = true; }
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
      if (!spinnerStopped) stop();
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
      if (content) {
        if (emit) {
          emit({ type: 'message', content });
        } else {
          write(highlightCodeBlocks(content, colors));
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
      return messages.slice(1);
    }

    // Dispatch tool calls.
    // Reads/lists are noisy — collect them silently and show a single dim summary.
    // Writes, edits, runs, and errors always print clearly.
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
        result = await dispatchTool(c.function.name, args, roots, confirmTool, signal, mcpManager);
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

      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 8000) });
      producedAnything = true;
      persistJournal('running');
      if (signal && signal.aborted) return messages.slice(1);
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
      break;
    }
  }

  // Finalization pass: force a no-tools answer before giving up.
  try {
    const final = await client.chat.completions.create({
      model: modelFor('agent'),
      messages: [
        ...messages,
        { role: 'user', content: 'Finalize now without using any tools. Summarize completed work and exact next actionable step if blocked.' },
      ],
      temperature: 0,
      tool_choice: 'none',
      stream: false,
    }, { signal });
    const finalText = final.choices?.[0]?.message?.content || '';
    if (finalText) {
      if (emit) {
        emit({ type: 'message', content: finalText });
      } else {
        write(finalText);
        if (!finalText.endsWith('\n')) write('\n');
      }
      clearTaskJournal(roots[0]);
      return messages.slice(1);
    }
  } catch {}

  write(dim('[shmakk] paused after several tool rounds. Resume later continues from task journal; try `shmakk --reset` to clear.', colors) + '\n');
  persistJournal('paused');
  return messages.slice(1);
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
