let OpenAI;
try { OpenAI = require('openai'); } catch { OpenAI = null; }

const path = require('path');
const os = require('os');
const fs = require('fs');
const { getCurrentEndpoint, getCurrentEndpointName, getModelRegistry, supportsVision, getVisionSupport } = require('./endpoints');
const { normalizeImages, skippedNote } = require('./images');

function parseHeaders(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function buildHeaders(customHeaders) {
  return parseHeaders(customHeaders);
}

// ── Retry helper ───────────────────────────────────────────────────────────
// Shared retry with exponential backoff + jitter for 429 / 503 / 502.
// Also enforces a minimum gap between requests within this process so that
// rapid tool-call loops don't pile onto the rate limit immediately.

const RETRYABLE = new Set([429, 503, 502, 504]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const MIN_GAP_MS = 600; // floor between subsequent fetches in this process

let _lastReq = 0;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const parsed = Number(retryAfterHeader);
    if (!Number.isNaN(parsed) && parsed > 0) return Math.min(parsed * 1000, MAX_DELAY_MS);
  }
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = exp * (0.5 + Math.random() * 0.5); // 50%–100% of exponential
  return Math.round(jitter);
}

async function fetchWithBackoff(url, init, providerLabel) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Abort signal check first
    if (init.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Enforce minimum request gap
    const now = Date.now();
    const wait = MIN_GAP_MS - (now - _lastReq);
    if (wait > 0) await sleepMs(wait);

    let res;
    try {
      _lastReq = Date.now();
      res = await fetch(url, init);
    } catch (e) {
      if (attempt < MAX_RETRIES && (e.name === 'TypeError' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT')) {
        await sleepMs(retryDelay(attempt, null));
        continue;
      }
      throw e;
    }

    if (res.ok) return res;

    const status = res.status;
    const retryAfter = res.headers.get('retry-after');
    const isRetryable = RETRYABLE.has(status);

    if (isRetryable && attempt < MAX_RETRIES) {
      const errText = await res.text().catch(() => '');
      const delay = retryDelay(attempt, retryAfter);
      process.stderr.write(`[shmakk] ${providerLabel} ${status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${(delay / 1000).toFixed(1)}s…\n`);
      await sleepMs(delay);
      continue;
    }

    const errText = await res.text().catch(() => '');
    throw new Error(`${providerLabel} API ${status}: ${errText.slice(0, 500)}`);
  }
}

function envForProvider() {
  // Check active endpoint first (allows hotswap)
  const activeEndpoint = getCurrentEndpoint();
  if (activeEndpoint) {
    return {
      name: getCurrentEndpointName() || activeEndpoint.name || null,
      provider: activeEndpoint.provider || 'openai-compatible',
      baseURL: activeEndpoint.base_url,
      apiKey: activeEndpoint.api_key,
      headers: activeEndpoint.headers,
      model: activeEndpoint.model,
    };
  }
  // Fall back to env vars for backwards compatibility
  return {
    name: null,
    provider: process.env.SHMAKK_PROVIDER || 'openai-compatible',
    baseURL: process.env.SHMAKK_BASE_URL,
    apiKey: process.env.SHMAKK_API_KEY,
    headers: process.env.SHMAKK_HEADERS,
    model: process.env.SHMAKK_MODEL,
  };
}

function isConfigured() {
  const cfg = envForProvider();
  if (recommendationMode()) return Object.keys(getModelRegistry().models).length > 0;
  if (cfg.provider === 'anthropic') return true;  // claude-proxy handles auth via OAuth
  if (cfg.provider === 'codex') return true;  // codex-proxy handles auth via OAuth
  if (cfg.provider === 'nvidia') return !!cfg.apiKey && !!OpenAI;
  if (cfg.provider === 'xai' || cfg.provider === 'grok') return !!cfg.apiKey && !!OpenAI;
  return (!!cfg.baseURL || cfg.provider === 'openai') && !!OpenAI;
}

function getDefaultBaseURL(provider) {
  if (provider === 'openai') return 'https://local:8095/v1';
  if (provider === 'nvidia') return 'https://integrate.api.nvidia.com/v1';
  if (provider === 'xai' || provider === 'grok') return 'https://api.x.ai/v1';
  return undefined;
}

function makeOpenAIClient(cfg) {
  if (!OpenAI) throw new Error('openai sdk not installed');
  const baseURL = cfg.baseURL || getDefaultBaseURL(cfg.provider);
  if (!baseURL) throw new Error('SHMAKK_BASE_URL is required for OpenAI-compatible providers');
  const client = new OpenAI({
    baseURL,
    apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || 'not-needed',
    defaultHeaders: buildHeaders(cfg.headers, cfg.registry),
  });
  const rawCreate = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = async (params, options = {}) => {
    try {
      return await rawCreate(params, options);
    } catch (e) {
      if (!hasVisionContent(params?.messages) || !isImageUrlSchemaError(e)) throw e;
      process.stderr.write('[shmakk] endpoint rejected image_url blocks; retrying with image metadata as text\n');
      return rawCreate({ ...params, messages: downgradeVisionMessages(params.messages) }, options);
    }
  };
  return client;
}

function hasVisionContent(messages) {
  return (messages || []).some((message) => {
    return Array.isArray(message?.content) && message.content.some((part) => {
      return part && typeof part === 'object' && (part.type === 'image_url' || part.image_url);
    });
  });
}

function imageUrlSummary(part) {
  const url = String(part?.image_url?.url || part?.url || '');
  const mime = url.match(/^data:([^;]+);base64,/)?.[1] || 'image';
  const b64 = url.match(/^data:[^;]+;base64,(.*)$/)?.[1] || '';
  const size = b64 ? `, base64=${b64.length} chars` : '';
  const detail = part?.image_url?.detail || part?.detail;
  return `[Image omitted: ${mime}${size}${detail ? `, detail=${detail}` : ''}]`;
}

function contentArrayToText(content) {
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') return String(part.text || '');
    if (part.type === 'image_url' || part.image_url) return imageUrlSummary(part);
    return JSON.stringify(part);
  }).filter(Boolean).join('\n');
}

function downgradeVisionMessages(messages) {
  return (messages || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    return {
      ...message,
      content: contentArrayToText(message.content),
    };
  });
}

function isImageUrlSchemaError(err) {
  const status = err?.status || err?.response?.status || 0;
  const message = String(err?.message || err?.error?.message || err?.response?.data || '');
  return status >= 400 && status < 500 && /\bimage_url\b/i.test(message) && /(unknown variant|expected|deserialize|invalid)/i.test(message);
}

function makeProviderClient(cfg) {
  if (cfg.provider === 'anthropic') return makeAnthropicCompatClient(cfg);
  if (cfg.provider === 'codex') return makeCodexCompatClient(cfg);
  if (cfg.provider === 'nvidia') return makeOpenAIClient(cfg);
  return makeOpenAIClient(cfg);
}

function makeClient() {
  const cfg = envForProvider();
  if (recommendationMode()) return makeRoutingClient(cfg);
  return makeProviderClient(cfg);
}

function makeClientForEndpoint(name) {
  const registry = getModelRegistry();
  const selected = name === 'main' ? registry.main : name === 'fast' ? registry.fast : name;
  if (!selected || !registry.models[selected]) return null;
  const cfg = configFromModelEntry(selected, registry.models[selected]);
  return {
    name: selected,
    model: cfg.model || selected,
    client: makeProviderClient(cfg),
  };
}

// Resolve the client for a requested model id. When the id (or a registry
// entry name) matches an entry in endpoints.json, that entry's base URL, key,
// headers and provider are used, so picking a model from the registry also
// switches provider instead of sending a foreign model name to the active one.
function makeClientForModel(modelId) {
  const requested = String(modelId || '').trim();
  const registry = getModelRegistry();
  if (requested) {
    for (const [name, cfg] of Object.entries(registry.models || {})) {
      if (name === requested || (cfg.model || name) === requested) {
        const config = configFromModelEntry(name, cfg);
        return { model: config.model, client: makeProviderClient(config) };
      }
    }
  }
  return { model: requested || modelFor(), client: makeClient() };
}

function modelFor() {
  if (recommendationMode()) return process.env._SHMAKK_LAST_MODEL || 'model-recommendation';
  const activeEndpoint = getCurrentEndpoint();
  return activeEndpoint?.model || process.env.SHMAKK_MODEL || 'gpt-4o-mini';
}

function recommendationMode() {
  return process.env.SHMAKK_MODEL_RECOMMENDATION === '1';
}

function configFromModelEntry(name, cfg) {
  return {
    name,
    provider: cfg.provider || 'openai-compatible',
    baseURL: cfg.base_url,
    apiKey: cfg.api_key,
    headers: cfg.headers,
    registry: cfg.registry,
    model: cfg.model || name,
  };
}

function skillPathCandidates() {
  const root = path.join(os.homedir(), '.config', 'shmakk', 'skills');
  return [
    path.join(root, 'model-recommendation.md'),
    path.join(root, 'model-recommendation', 'SKILL.md'),
    path.join(root, 'general-model-recommendation.md'),
  ];
}

function loadRecommendationSkill() {
  for (const p of skillPathCandidates()) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').slice(0, 12000);
    } catch {}
  }
  return 'Choose the least expensive model that can reliably complete the task. Prefer strongest models for architecture, debugging, security, tool-heavy edits, and multi-agent planning. Prefer faster models for simple read-only, summarization, or mechanical edits.';
}

function summarizeCall(params) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const text = messages.slice(-6).map((m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return `${m.role}: ${content.slice(0, 1200)}`;
  }).join('\n\n');
  const tools = Array.isArray(params.tools) ? params.tools.map((t) => t.function?.name || t.name).filter(Boolean) : [];
  return { text, tools, stream: !!params.stream, toolChoice: params.tool_choice || null };
}

function fallbackRecommendation(registry, params) {
  const entries = Object.entries(registry.models);
  if (!entries.length) return null;
  const summary = summarizeCall(params);
  const s = `${summary.text}\n${summary.tools.join(' ')}`.toLowerCase();
  const needsStrong = /architecture|security|debug|refactor|multi.?agent|team|design|review|risk|tool|edit|write|implement/.test(s);
  const anthropic = entries.find(([, cfg]) => cfg.provider === 'anthropic');
  const codex = entries.find(([, cfg]) => cfg.provider === 'codex' || /codex|gpt-5/i.test(cfg.model || ''));
  if (needsStrong && codex) return codex[0];
  if (needsStrong && anthropic) return anthropic[0];
  return registry.main || entries[0][0];
}

async function recommendModel(registry, params, signal) {
  const available = Object.fromEntries(Object.entries(registry.models).map(([name, cfg]) => [name, {
    provider: cfg.provider,
    model: cfg.model,
    main: name === registry.main || cfg.main,
  }]));

  const mainName = registry.main || Object.keys(registry.models)[0];
  const main = mainName ? registry.models[mainName] : null;
  if (!main) return fallbackRecommendation(registry, params);

  try {
    const client = makeProviderClient(configFromModelEntry(mainName, main));
    const resp = await client.chat.completions.create({
      model: main.model,
      temperature: 0,
      stream: false,
      tool_choice: 'none',
      messages: [
        {
          role: 'system',
          content: `${loadRecommendationSkill()}\n\nReturn only JSON: {"model":"<one available key>","reason":"<short reason>"}.`,
        },
        {
          role: 'user',
          content: `Available models:\n${JSON.stringify(available, null, 2)}\n\nCall summary:\n${JSON.stringify(summarizeCall(params), null, 2)}`,
        },
      ],
    }, { signal });
    const raw = String(resp.choices?.[0]?.message?.content || '');
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    if (parsed && registry.models[parsed.model]) return parsed.model;
  } catch {}

  return fallbackRecommendation(registry, params);
}

function makeRoutingClient() {
  return {
    chat: {
      completions: {
        create: async (params, options = {}) => {
          const registry = getModelRegistry();
          const selected = await recommendModel(registry, params, options.signal);
          const cfg = selected && registry.models[selected]
            ? configFromModelEntry(selected, registry.models[selected])
            : envForProvider();
          process.env._SHMAKK_LAST_MODEL = `${selected || cfg.name || cfg.provider}:${cfg.model || params.model}`;
          const client = makeProviderClient(cfg);
          return client.chat.completions.create({ ...params, model: cfg.model || params.model }, options);
        },
      },
    },
  };
}

async function ensureModelRuntime() {}

// ── Codex (Responses API) compat client ────────────────────────────────────
// Translates OpenAI chat.completions format to/from the Codex Responses API
// via the anthprox FastAPI (:8256) -> mitmdump (:8095) -> chatgpt.com.

function splitCodexSystem(messages) {
  let instructions = '';
  const input = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      instructions += (instructions ? '\n\n' : '') +
        (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      });
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (m.content) {
        input.push({ role: 'assistant', content: String(m.content) });
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || '{}',
        });
      }
    } else {
      input.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      });
    }
  }
  return { instructions: instructions || 'Be helpful.', input };
}

function codexTools(tools) {
  return (tools || []).map((tool) => {
    const fn = tool.function || tool;
    return {
      type: 'function',
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    };
  }).filter((t) => t.name);
}

function codexToolChoice(choice) {
  if (!choice || choice === 'auto') return 'auto';
  if (choice === 'required') return 'required';
  if (choice === 'none') return 'none';
  if (choice.function?.name) return choice.function.name;
  return 'auto';
}


// ── SSE parsing helpers (shared by streaming + buffered paths) ──────────

function codexSSEParseState() {
  return {
    content: '',
    callMap: new Map(),  // item_id -> { call_id, name, arguments }
  };
}

function codexSSEFeed(state, line) {
  // Processes one SSE data line (without the 'data: ' prefix).
  // Returns a content delta string if text was produced, else null.
  if (!line) return null;
  let evt;
  try { evt = JSON.parse(line); } catch { return null; }

  if (evt.type === 'response.output_text.delta') {
    state.content += evt.delta || '';
    return evt.delta || '';
  }
  if (evt.type === 'response.output_item.added' && evt.item?.type === 'function_call') {
    state.callMap.set(evt.item.id, {
      call_id: evt.item.call_id,
      name: evt.item.name,
      arguments: evt.item.arguments || '',
    });
  } else if (evt.type === 'response.function_call_arguments.delta' && evt.item_id) {
    const entry = state.callMap.get(evt.item_id);
    if (entry) entry.arguments += evt.delta || '';
  } else if (evt.type === 'response.function_call_arguments.done' && evt.item_id) {
    const entry = state.callMap.get(evt.item_id);
    if (entry) entry.arguments = evt.arguments || entry.arguments;
  }
  return null;
}

function codexSSEBuildCompletion(model, state) {
  const calls = [...state.callMap.values()].map((c) => ({
    id: c.call_id,
    type: 'function',
    function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) },
  }));
  const message = { role: 'assistant', content: state.content, tool_calls: undefined };
  if (calls.length) message.tool_calls = calls;
  return {
    id: 'codex-' + Date.now(),
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  };
}

function codexSSEBuildToolCallChunks(state) {
  // Build OpenAI-format tool_call delta chunks for streaming consumers.
  const calls = [...state.callMap.values()];
  if (!calls.length) return [];
  return calls.map((c, i) => ({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: i,
          id: c.call_id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }],
      },
      finish_reason: null,
    }],
  }));
}

// ── Streaming SSE iterator ─────────────────────────────────────────────

async function* codexStreamIterator(body, model, signal) {
  const state = codexSSEParseState();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';  // keep incomplete final line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const delta = codexSSEFeed(state, line.slice(6).replace(/\r$/, ''));
        if (delta) {
          yield { choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] };
        }
      }
    }

    // Flush remaining buffer
    if (buffer.startsWith('data: ')) {
      codexSSEFeed(state, buffer.slice(6));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Yield tool calls then stop
  const toolChunks = codexSSEBuildToolCallChunks(state);
  for (const chunk of toolChunks) yield chunk;
  yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
}

// ── Codex compat client ─────────────────────────────────────────────────

function makeCodexCompatClient(cfg) {
  return {
    chat: {
      completions: {
        create: async (params, options = {}) => {
          const { instructions, input } = splitCodexSystem(params.messages || []);
          const tools = params.tool_choice === 'none' ? [] : codexTools(params.tools);
          const body = {
            model: params.model || cfg.model,
            instructions,
            input,
            store: false,
            stream: true,   // Codex API requires stream: true
          };
          if (tools.length) {
            body.tools = tools;
            const tc = codexToolChoice(params.tool_choice);
            if (tc) body.tool_choice = tc;
          }

          // Default to the anthprox codex-api FastAPI, not the raw mitmdump.
          const base = (cfg.baseURL || 'http://localhost:8256').replace(/\/+$/, '');
          const res = await fetchWithBackoff(`${base}/responses`, {
            method: 'POST',
            signal: options.signal,
            headers: {
              'content-type': 'application/json',
              ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
              ...buildHeaders(cfg.headers, cfg.registry),
            },
            body: JSON.stringify(body),
          }, 'Codex');

          // Streaming: return an async iterable that yields OpenAI-format chunks
          // as SSE events arrive from the codex-api.
          if (params.stream) {
            return codexStreamIterator(res.body, body.model, options.signal);
          }

          // Non-streaming: buffer and parse the SSE response into a completion.
          const raw = await res.text();
          const state = codexSSEParseState();
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) codexSSEFeed(state, line.slice(6).replace(/\r$/, ''));
          }
          if (!state.content && !state.callMap.size) throw new Error('Codex API: no response data');
          return codexSSEBuildCompletion(body.model, state);
        },
      },
    },
  };
}

function splitAnthropicSystem(messages) {
  const system = [];
  const converted = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      system.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    } else if (m.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
        }],
      });
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name,
          input: safeJson(tc.function?.arguments || '{}'),
        });
      }
      converted.push({ role: 'assistant', content });
    } else {
      converted.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      });
    }
  }
  return { system: system.join('\n\n'), messages: converted };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function anthropicTools(tools) {
  return (tools || []).map((tool) => {
    const fn = tool.function || tool;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  }).filter((t) => t.name);
}

function anthropicToolChoice(choice) {
  if (!choice || choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return undefined;
  if (choice.function?.name) return { type: 'tool', name: choice.function.name };
  return { type: 'auto' };
}

function toOpenAICompletion(model, data) {
  const message = { role: 'assistant', content: '', tool_calls: undefined };
  const calls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') message.content += block.text || '';
    if (block.type === 'tool_use') {
      calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  if (calls.length) message.tool_calls = calls;
  return { id: data.id, object: 'chat.completion', model, choices: [{ index: 0, message, finish_reason: data.stop_reason || 'stop' }] };
}

// ── Anthropic SSE helpers ──────────────────────────────────────────────────
// Anthropic streaming SSE format (via anthprox proxy):
//   event: content_block_start  /  content_block_delta  /  content_block_stop
//   event: message_start  /  message_delta  /  message_stop
//   event: ping

function anthropicSSEParseState() {
  return {
    content: '',
    blocks: new Map(),     // index -> { type, id?, name?, text, input_json }
    blockOrder: [],
    stopReason: null,
    model: null,
  };
}

function anthropicSSEFeed(state, eventName, data) {
  let evt;
  try { evt = JSON.parse(data); } catch { return null; }
  const type = evt.type;
  if (type === 'message_start') {
    state.model = evt.message?.model;
  } else if (type === 'content_block_start') {
    const idx = evt.index;
    const block = evt.content_block || {};
    state.blocks.set(idx, { type: block.type, id: block.id, name: block.name, text: '', input_json: '' });
    state.blockOrder.push(idx);
  } else if (type === 'content_block_delta') {
    const block = state.blocks.get(evt.index);
    if (!block) return null;
    const delta = evt.delta || {};
    if (delta.type === 'text_delta') {
      block.text += delta.text || '';
      return delta.text || '';
    } else if (delta.type === 'input_json_delta') {
      block.input_json += delta.partial_json || '';
    }
  } else if (type === 'content_block_stop') {
    // no-op
  } else if (type === 'message_delta') {
    state.stopReason = evt.delta?.stop_reason || null;
  }
  return null;
}

function anthropicSSEBuildCompletion(state) {
  const message = { role: 'assistant', content: '', tool_calls: undefined };
  const calls = [];
  for (const idx of state.blockOrder) {
    const block = state.blocks.get(idx);
    if (!block) continue;
    if (block.type === 'text' || !block.type) {
      message.content += block.text;
    } else if (block.type === 'tool_use') {
      calls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.input_json || '{}' },
      });
    }
  }
  if (calls.length) message.tool_calls = calls;
  return {
    id: 'ant-' + Date.now(),
    object: 'chat.completion',
    model: state.model || 'claude',
    choices: [{ index: 0, message, finish_reason: state.stopReason || 'stop' }],
  };
}

function anthropicSSEBuildToolCallChunks(state) {
  const chunks = [];
  for (const idx of state.blockOrder) {
    const block = state.blocks.get(idx);
    if (!block || block.type !== 'tool_use') continue;
    chunks.push({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.input_json || '{}' },
          }],
        },
        finish_reason: null,
      }],
    });
  }
  return chunks;
}

async function* anthropicStreamIterator(body, model, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = anthropicSSEParseState();
  let buffer = '';
  let eventName = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE — Anthropic uses "event:" + "data:" lines, \r\n endings
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('event: ')) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          // Trim trailing \r that comes from \r\n line endings
          const payload = line.slice(6).replace(/\r$/, '');
          const text = anthropicSSEFeed(state, eventName, payload);
          if (text) {
            yield { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
          }
        }
      }
    }
    // Flush remaining buffer
    const flushPayload = buffer.startsWith('data: ') ? buffer.slice(6).replace(/\r$/, '') : '';
    if (flushPayload) {
      anthropicSSEFeed(state, '', flushPayload);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Yield tool calls then stop
  const toolChunks = anthropicSSEBuildToolCallChunks(state);
  for (const chunk of toolChunks) yield chunk;
  yield { choices: [{ index: 0, delta: {}, finish_reason: state.stopReason || 'stop' }] };
}

function makeAnthropicCompatClient(cfg) {
  return {
    chat: {
      completions: {
        create: async (params, options = {}) => {
          const { system, messages } = splitAnthropicSystem(params.messages || []);
          const tools = params.tool_choice === 'none' ? [] : anthropicTools(params.tools);
          const body = {
            model: params.model || cfg.model,
            max_tokens: params.max_tokens || 4096,
            temperature: params.temperature ?? 0,
            stream: !!params.stream,
            messages,
          };
          if (system) body.system = system;
          if (tools.length) {
            body.tools = tools;
            const toolChoice = anthropicToolChoice(params.tool_choice);
            if (toolChoice) body.tool_choice = toolChoice;
          }

          // Default to the anthprox claude-api FastAPI, not the raw mitmdump.
          const base = (cfg.baseURL || 'http://localhost:8083').replace(/\/+$/, '');
          const res = await fetchWithBackoff(`${base}/v1/messages`, {
            method: 'POST',
            signal: options.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': cfg.apiKey || '',
              'anthropic-version': '2023-06-01',
              ...buildHeaders(cfg.headers, cfg.registry),
            },
            body: JSON.stringify(body),
          }, 'Anthropic');

          // Streaming: read SSE in real-time via Anthropic SSE parser
          if (params.stream) {
            return anthropicStreamIterator(res.body, body.model, options.signal);
          }

          // Non-streaming: buffer and convert
          const data = await res.json();
          return toOpenAICompletion(body.model, data);
        },
      },
    },
  };
}

// ── DeepSeek settings ──────────────────────────────────────────────────────
// DeepSeek thinking / reasoning_effort increases protocol complexity because
// the runtime must distinguish visible content, internal reasoning_content,
// and structured tool_calls.  That makes rare DSML leaks more likely in
// streaming/tool-heavy flows.  Disable thinking for mutation/tool-loop turns.

function isDeepSeekProvider() {
  const cfg = envForProvider();
  const base = (cfg.baseURL || process.env.SHMAKK_BASE_URL || '').toLowerCase();
  return base.includes('deepseek');
}

// `max` is DeepSeek's top thinking effort. It is not on the OpenAI ladder
// (ALL_EFFORT_LEVELS), but it is a real level the composer can store.
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ALL_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const KNOWN_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEEPSEEK_EFFORT_LEVELS = ['low', 'high', 'max'];

function normalizeEffort(effort) {
  const v = String(effort || '').trim().toLowerCase();
  return REASONING_EFFORTS.has(v) ? v : null;
}

// Live catalog of reasoning_effort levels discovered from provider /models
// responses (xAI exposes capabilities.reasoning_effort). Keyed by model id
// and alias. Cleared when the base URL changes.
const effortCatalog = new Map(); // modelId -> EffortLevel[]
let effortCatalogBase = null;

function clearEffortCatalog() {
  effortCatalog.clear();
  effortCatalogBase = null;
}

/** Normalize an endpoints.json `effort` override into a level list, or null when unset. */
function parseEffortOverride(raw) {
  if (raw === undefined) return null;
  if (raw === false || raw === null) return [];
  if (raw === true) return ALL_EFFORT_LEVELS.slice();
  const list = Array.isArray(raw)
    ? raw
    : String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  // Keep only levels shmakk knows; drop provider-only tokens like "none".
  return list.map((s) => String(s).trim().toLowerCase()).filter((v) => REASONING_EFFORTS.has(v));
}

function filterEffortLevels(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const v = String(raw || '').trim().toLowerCase();
    if (REASONING_EFFORTS.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Name/provider heuristics used when the live /models catalog has nothing for
 * this id. Returns [] when the model is known not to take reasoning_effort
 * (dropdown should hide). Unknown models also return [] so we never send a
 * parameter the provider will reject.
 */
function heuristicEffortLevels(model, { baseUrl = '', provider = '' } = {}) {
  const m = String(model || '').toLowerCase();
  const base = String(baseUrl || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  if (!m && !base && !p) return [];

  // DeepSeek thinking effort is low/high/max (api-docs thinking mode). Legacy
  // aliases such as deepseek-v4-flash are not always listed by /models, so the
  // name or host is enough to show the control.
  if (base.includes('deepseek') || p.includes('deepseek') || m.includes('deepseek')) {
    return DEEPSEEK_EFFORT_LEVELS.slice();
  }

  // Anthropic extended thinking uses budget tokens, not reasoning_effort.
  if (p === 'anthropic' || /(^|\/)claude/.test(m)) return [];

  // OpenAI o-series (o1, o3, o4-mini, ...).
  if (/(^|\/)o[1-9]([.-]|$)/.test(m) || /(^|[^a-z])o[1-9](-mini|-pro)?\b/.test(m)) {
    return ['low', 'medium', 'high'];
  }

  // GPT-5 family. Pro/codex variants accept xhigh; the rest stop at high.
  if (/gpt-5/.test(m)) {
    if (/pro|codex/.test(m)) return ['minimal', 'low', 'medium', 'high', 'xhigh'];
    return ['minimal', 'low', 'medium', 'high'];
  }

  // xAI / Grok — mirror the public model catalog when live fetch is unavailable.
  const xai = base.includes('x.ai') || p === 'xai' || p === 'grok' || m.startsWith('grok');
  if (xai) {
    if (/non-reasoning|imagine/.test(m)) return [];
    // grok-4.3 ships "none" as the off switch; our UI uses auto for that.
    if (/grok-4\.3\b/.test(m)) return ['low', 'medium', 'high', 'xhigh'];
    if (/grok-4\.[5-9]\b|grok-4\.[1-9]\d/.test(m)) return ['low', 'medium', 'high', 'xhigh'];
    if (/grok-3/.test(m)) return ['low', 'high'];
    // grok-build / code-fast and several 4.20 variants reason but expose no effort knob.
    return [];
  }

  return [];
}

function lookupEffortCatalog(model) {
  const id = String(model || '').trim();
  if (!id) return null;
  if (effortCatalog.has(id)) return effortCatalog.get(id);
  const lower = id.toLowerCase();
  for (const [key, levels] of effortCatalog.entries()) {
    if (key.toLowerCase() === lower) return levels;
  }
  return null;
}

/**
 * Levels the UI may offer for a model. Order of precedence:
 *   1. endpoints.json `effort` override on the entry
 *   2. live /models catalog (when the provider advertises capabilities)
 *   3. name/provider heuristics
 * Empty array => model does not take reasoning_effort; hide the control.
 */
function effortLevelsForModel(model, opts = {}) {
  const override = parseEffortOverride(opts.effort);
  if (override) return override;

  const live = lookupEffortCatalog(model);
  // null = catalog has no entry (fall through); [] = provider said no effort.
  if (live !== null) return live.slice();

  return heuristicEffortLevels(model, opts);
}

/** Ingest a /models page (OpenAI-shaped) into the live effort catalog. */
function ingestEffortCatalog(models, baseUrl = null) {
  const base = baseUrl == null ? effortCatalogBase : String(baseUrl || '');
  if (effortCatalogBase !== base) {
    effortCatalog.clear();
    effortCatalogBase = base;
  }
  const list = Array.isArray(models) ? models : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || entry.name || '').trim();
    if (!id) continue;
    const raw = advertisedEffortLevels(entry);
    // Only write an entry when the provider spoke about effort. Models with no
    // capabilities block stay absent so heuristics can still apply.
    if (raw == null) continue;
    const levels = filterEffortLevels(raw);
    effortCatalog.set(id, levels);
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const alias of aliases) {
      const a = String(alias || '').trim();
      if (a) effortCatalog.set(a, levels);
    }
  }
  return effortCatalog.size;
}

/**
 * Pull /models from the active client and refresh the effort catalog.
 * Failures are silent — heuristics remain the fallback.
 */
async function refreshEffortCatalog(client, baseUrl = null) {
  if (!client || !client.models || typeof client.models.list !== 'function') return 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let page;
    try {
      page = await client.models.list({ signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const models = (page && page.data) || (Array.isArray(page) ? page : []);
    return ingestEffortCatalog(models, baseUrl);
  } catch {
    return 0;
  }
}

/** Levels a /models entry advertises, or null when it said nothing about effort. */
function advertisedEffortLevels(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const caps = entry.capabilities || entry.features || {};
  const effortObj = [entry.effort, caps.effort].find((v) => v && typeof v === 'object' && !Array.isArray(v));
  return (
    caps.reasoning_effort ||
    caps.reasoningEffort ||
    (caps.reasoningEffortOptions && caps.reasoningEffortOptions.supportedEfforts) ||
    entry.reasoning_effort ||
    (effortObj && (effortObj.supported_levels || effortObj.supportedLevels || effortObj.levels)) ||
    (Array.isArray(entry.effort) ? entry.effort : null) ||
    null
  );
}

function providerBaseUrl() {
  const cfg = envForProvider();
  return cfg.baseURL || process.env.SHMAKK_BASE_URL || '';
}

/** Base URL of the registry entry that would actually serve this model id. */
function baseUrlForModel(model) {
  const id = String(model || '').trim();
  if (id) {
    try {
      const registry = getModelRegistry();
      for (const [name, cfg] of Object.entries((registry && registry.models) || {})) {
        if (name === id || String(cfg.model || name) === id) return cfg.base_url || '';
      }
    } catch { /* registry missing: fall through to the active endpoint */ }
  }
  return providerBaseUrl();
}

function isDeepSeekTarget(model, baseUrl) {
  const m = String(model || '').toLowerCase();
  const base = String(baseUrl || '').toLowerCase();
  if (m.includes('deepseek') || base.includes('deepseek')) return true;
  // No model id: the active endpoint decides (CLI and the default chat model).
  if (!model) return isDeepSeekProvider();
  return false;
}

// `thinking` is a DeepSeek-native field, not part of the OpenAI schema. Hosts
// that merely serve DeepSeek model ids (Venice, OpenRouter, local vLLM) reject
// unknown body fields — Venice answers 400 because its request schema is
// sealed (additionalProperties: false) — so only DeepSeek's own API gets it.
function isNativeDeepSeekHost(baseUrl) {
  const base = String(baseUrl || '').toLowerCase();
  if (!base) return isDeepSeekProvider();
  return base.includes('deepseek');
}

// DeepSeek maps the OpenAI ladder onto low/high, and only `max` stays max.
function mapDeepSeekEffort(effort) {
  const level = normalizeEffort(effort);
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'max') return 'max';
  return 'high';
}

// Reasoning / thinking options for a request.
//
// DeepSeek takes `reasoning_effort` (low/high/max) plus its own `thinking`
// flag. Tool and mutation turns still disable thinking and omit effort: high
// or max thinking makes DSML leaks more likely in streaming tool loops.
// Other OpenAI-compatible providers take `reasoning_effort` only when the
// caller asked for a level the model accepts.
//
// DeepSeek model ids also appear on third-party hosts (Venice serves
// deepseek-v4-1-flash-*). Those hosts speak plain OpenAI, so they get
// `reasoning_effort` only and never the `thinking` extra_body.
function getReasoningOptions(taskType, effort = null, model = null) {
  const resolvedModel = model || modelFor();
  const baseUrl = baseUrlForModel(resolvedModel);
  if (isDeepSeekTarget(resolvedModel, baseUrl)) {
    if (!isNativeDeepSeekHost(baseUrl)) {
      // Standard OpenAI surface: honor an explicit composer choice and
      // otherwise leave the provider default alone.
      const picked = normalizeEffort(effort);
      if (!picked) return {};
      return { reasoning_effort: mapDeepSeekEffort(picked) };
    }

    // Respect runtime override (set after a DSML leak).
    const forceNoThinking = process.env._SHMAKK_FORCE_NO_THINKING === '1';

    const toolOrMutationTurn =
      taskType === 'edit_file' ||
      taskType === 'run_command' ||
      taskType === 'apply_patch' ||
      taskType === 'tool_loop';

    if (forceNoThinking || toolOrMutationTurn) {
      return {
        extra_body: {
          thinking: { type: 'disabled' },
        },
        // Do NOT send reasoning_effort here.
      };
    }

    // Chat / planning turns: honor the composer selection. Unset stays at
    // the provider default, which is high.
    return {
      reasoning_effort: mapDeepSeekEffort(effort),
      extra_body: {
        thinking: { type: 'enabled' },
      },
    };
  }

  const level = normalizeEffort(effort);
  if (!level) return {};

  // Drop levels the model actually being called cannot take.
  const supported = effortLevelsForModel(resolvedModel, {
    baseUrl: baseUrl || providerBaseUrl(),
    provider: '',
  });
  if (!supported.includes(level)) return {};
  return { reasoning_effort: level };
}

// ── Vision fallback: describe images via a vision-capable endpoint ────────
// When the current endpoint doesn't support vision but a tool returned images,
// we call the dedicated visionSupport endpoint (from endpoints.json) to
// describe them as text for the non-vision model.

async function describeImages(images, signal) {
  // Only images with base64 data, and only formats a vision model will accept
  // (bmp/tiff/ico/avif/heic/svg get converted to png first, or dropped).
  const { images: valid } = await normalizeImages(images);
  if (!valid.length) return null;

  let visionCfg = getVisionSupport();

  // No explicit visionSupport config: try to find a vision-capable endpoint
  // from the model registry automatically.
  if (!visionCfg) {
    const registry = getModelRegistry();
    if (registry && registry.models) {
      for (const [name, entry] of Object.entries(registry.models)) {
        if (entry.vision) {
          visionCfg = { name, ...entry, vision: true };
          break;
        }
      }
    }
  }

  if (!visionCfg) return null;

  const cfg = configFromModelEntry('visionSupport', visionCfg);
  let client;
  try {
    client = makeProviderClient(cfg);
  } catch {
    return null;
  }
  if (!client) return null;

  const desc = valid.map((img, i) =>
    `[Image #${i + 1}: ${img.mimeType}, ${(img.dataLength * 0.75) | 0} decoded bytes${img.truncated ? ', truncated' : ''}]`
  ).join(', ');

  try {
    const resp = await client.chat.completions.create({
      model: cfg.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe these images concisely. Focus on what is visible: UI elements, text, layout, key content. If there are multiple images, describe each one labeled by number. Keep it under 500 words.' },
          ...valid.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'auto' },
          })),
        ],
      }],
      max_tokens: 600,
    }, { signal });

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (text) {
      process.stderr.write(`[shmakk] vision fallback described ${valid.length} image(s): ${desc}\n`);
      return `[Vision description via ${cfg.model || 'visionSupport'}]:\n${text}`;
    }
    return null;
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    process.stderr.write(`[shmakk] vision fallback (${cfg.model || 'visionSupport'}) failed: ${e.message}\n`);
    return null;
  }
}

// ── Outgoing user turns that carry images ────────────────────────────────
// Shared by the agent (composer + design images) and Chat mode so both paths
// produce identical message shapes.

function imageBlocks(text, images) {
  return [
    { type: 'text', text: text || '[image attached]' },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.data}`, detail: 'auto' },
    })),
  ];
}

// Returns a string when the active endpoint cannot see images (text note or a
// description from the visionSupport endpoint), otherwise multimodal blocks.
async function userContentWithImages(text, images, signal) {
  const { images: valid, skipped } = await normalizeImages(images);
  const note = skippedNote(skipped);
  if (!valid.length) return note ? `${text}\n\n${note}`.trim() : text;

  if (supportsVision()) return imageBlocks(note ? `${text}\n\n${note}` : text, valid);

  const desc = await describeImages(valid, signal);
  if (desc) return [text, desc, note].filter(Boolean).join('\n\n').trim();

  const meta = valid
    .map((img, i) => `[Image #${i + 1}: ${img.name || 'image'}, ${img.mimeType || 'image/png'}]`)
    .join(', ');
  const tail = `${meta} (the active model cannot view images and no vision endpoint is configured)`;
  return [text, tail, note].filter(Boolean).join('\n\n').trim();
}

// History must stay text-only: base64 blocks are large and would be resent on
// every later turn (and persisted into the conversation file).
function stripImageBlocks(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const text = m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim();
    return { ...m, content: text || '[image attachment]' };
  });
}

module.exports = {
  makeClient,
  makeClientForEndpoint,
  makeClientForModel,
  modelFor,
  isConfigured,
  ensureModelRuntime,
  getReasoningOptions,
  normalizeEffort,
  isDeepSeekProvider,
  effortLevelsForModel,
  heuristicEffortLevels,
  ingestEffortCatalog,
  refreshEffortCatalog,
  clearEffortCatalog,
  parseEffortOverride,
  ALL_EFFORT_LEVELS,
  KNOWN_EFFORT_LEVELS,
  supportsVision,
  describeImages,
  userContentWithImages,
  stripImageBlocks,
  imageBlocks,
  normalizeImages,
  skippedNote,
  _test: { downgradeVisionMessages, hasVisionContent, isImageUrlSchemaError },
};
