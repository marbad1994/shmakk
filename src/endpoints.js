// Named model endpoints with hotswap support.
// Loads ~/.config/shmakk/endpoints.json (or .js for backwards compat).
// Can switch models mid-session without restarting.
//
// Preferred format (~/.config/shmakk/endpoints.json):
// {
//   "main": "gpt-5",
//   "fast": "gemini-flash",
//   "models": {
//     "gpt-5": {
//       "provider": "codex",
//       "model": "gpt-5-codex",
//       "api_key": "sk-..."
//     },
//     "kimi": {
//       "provider": "nvidia",
//       "model": "moonshotai/kimi-k2.6",
//       "api_key": "nvapi-..."
//     },
//     "claude": {
//       "provider": "anthropic",
//       "model": "claude-sonnet-4-5-20250929",
//       "api_key": "sk-ant-..."
//     },
//     "local": {
//       "provider": "openai-compatible",
//       "base_url": "http://127.0.0.1:1234/v1",
//       "model": "qwen/qwen3.5-9b"
//     }
//   }
// }

const fs = require('fs');
const path = require('path');
const os = require('os');

let currentEndpointName = null;
let currentEndpointConfig = null;
let endpointsCwd = null;

function configPath(cwd) {
  // Check project-local endpoints first (cwd/endpoints.json), then global
  const dir = cwd || process.cwd();
  const localJson = path.join(dir, 'endpoints.json');
  const localJs = path.join(dir, 'endpoints.js');
  if (fs.existsSync(localJson)) return localJson;
  if (fs.existsSync(localJs)) return localJs;

  const configDir = path.join(os.homedir(), '.config', 'shmakk');
  const jsonPath = path.join(configDir, 'endpoints.json');
  const jsPath = path.join(configDir, 'endpoints.js');

  // Prefer JSON for user-editable model registries; keep .js compatibility.
  if (fs.existsSync(jsonPath)) return jsonPath;
  if (fs.existsSync(jsPath)) return jsPath;
  return jsonPath;
}

function loadEndpoints(cwd) {
  const cfgPath = configPath(cwd || process.cwd());
  try {
    if (cfgPath.endsWith('.js')) {
      // Clear require cache to get fresh data on each load
      if (require.cache[cfgPath]) delete require.cache[cfgPath];
      return require(cfgPath);
    } else {
      // JSON format
      const raw = fs.readFileSync(cfgPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    return null;
  }
}

function normalizeModelConfig(name, cfg) {
  if (!cfg || typeof cfg !== 'object') return null;

  const provider = String(cfg.provider || cfg.type || 'openai-compatible').toLowerCase();
  return {
    name,
    provider,
    base_url: cfg.base_url || cfg.baseUrl || cfg.host || cfg.url || null,
    api_key: cfg.api_key || cfg.apiKey || cfg.key || null,
    model: cfg.model || name,
    headers: cfg.headers || cfg.headears || null,
    registry: cfg.registry || null,
    main: !!cfg.main,
    fast: !!cfg.fast,
    vision: _supportsVisionForConfig(cfg),
  };
}

function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object') {
    return { main: null, fast: null, models: {} };
  }

  const explicitModels = raw.models || raw.endpoints;
  const source = explicitModels && typeof explicitModels === 'object'
    ? explicitModels
    : Object.fromEntries(
      Object.entries(raw).filter(([key, value]) => {
        return key !== 'main' && value && typeof value === 'object' && !Array.isArray(value);
      }),
    );

  const models = {};
  for (const [name, cfg] of Object.entries(source)) {
    const normalized = normalizeModelConfig(name, cfg);
    if (normalized) models[name] = normalized;
  }

  let main = typeof raw.main === 'string' ? raw.main : null;
  let fast = typeof raw.fast === 'string' ? raw.fast : null;
  if (!main) {
    const marked = Object.values(models).find((cfg) => cfg.main);
    if (marked) main = marked.name;
  }
  if (!fast) {
    const marked = Object.values(models).find((cfg) => cfg.fast);
    if (marked) fast = marked.name;
  }
  if (!main && Object.keys(models).length === 1) {
    main = Object.keys(models)[0];
  }
  if (!fast && Object.keys(models).length === 1) {
    fast = Object.keys(models)[0];
  }

  return { main, fast, models };
}

function loadModelRegistry(cwd) {
  return normalizeRegistry(loadEndpoints(cwd));
}

function applyEndpoint(name, cwd) {
  const registry = loadModelRegistry(cwd);
  const selected = name === 'main' ? registry.main : name === 'fast' ? registry.fast : name;
  if (!selected || !registry.models[selected]) return false;

  const normalized = registry.models[selected];
  currentEndpointName = selected;

  currentEndpointConfig = normalized;
  endpointsCwd = cwd;

  // Also update env vars for backwards compatibility
  if (normalized.provider)  process.env.SHMAKK_PROVIDER  = normalized.provider;
  if (normalized.base_url)  process.env.SHMAKK_BASE_URL  = normalized.base_url;
  if (normalized.api_key)   process.env.SHMAKK_API_KEY   = normalized.api_key;
  if (normalized.model)     process.env.SHMAKK_MODEL     = normalized.model;
  if (normalized.headers)   process.env.SHMAKK_HEADERS   = normalized.headers;
  if (normalized.registry)  process.env.SHMAKK_REGISTRY  = normalized.registry;

  return true;
}

function getCurrentEndpoint() {
  // Returns current endpoint config if one is active
  return currentEndpointConfig ? { ...currentEndpointConfig } : null;
}

function getCurrentEndpointName() {
  return currentEndpointName;
}

// Drop the active preset so plain SHMAKK_* env vars take effect again.
function clearEndpoint() {
  currentEndpointName = null;
  currentEndpointConfig = null;
}

function _supportsVisionForConfig(cfg) {
  if (!cfg) return false;

  // Explicit config wins
  if ('vision' in cfg) return !!cfg.vision;

  // Auto-detect for known vision-capable providers
  const provider = (cfg.provider || '').toLowerCase();
  const model = (cfg.model || '').toLowerCase();

  // DeepSeek Flash reads images (api-docs.deepseek.com/guides/vision), with
  // the same image_url blocks as OpenAI. Covers deepseek-flash, versioned
  // names and the retired deepseek-v4-flash-vision-exp alias.
  if (/deepseek[\w.-]*flash/.test(model)) return true;

  // Providers whose APIs always support image_url content blocks
  const visionProviders = new Set([
    'anthropic',  // Claude 3+
    'google',     // Gemini
    'codex',      // Codex / OpenAI
    'openai',
    'nvidia',     // NIM
  ]);

  if (visionProviders.has(provider)) return true;

  // openai-compatible: check model name for vision hints
  if (provider === 'openai-compatible') {
    const visionPatterns = /vision|vl|multimodal|gpt-4o|gemini|claude|llava|minicpm|cogvlm|qwenvl|phi-3\.5-vision/i;
    return visionPatterns.test(model);
  }

  return false;
}

// SHMAKK_VISION (set from Settings → "This model can read images") says it
// for a provider configured by URL rather than in endpoints.json, where
// auto-detection by name cannot know newer models.
function supportsVision() {
  if (currentEndpointConfig) return _supportsVisionForConfig(currentEndpointConfig);
  const env = String(process.env.SHMAKK_VISION || '').trim();
  if (/^(1|true|yes|on)$/i.test(env)) return true;
  if (/^(0|false|no|off)$/i.test(env)) return false;
  return _supportsVisionForConfig({ provider: 'openai-compatible', model: process.env.SHMAKK_MODEL || '' });
}

function listEndpoints(cwd) {
  return Object.keys(loadModelRegistry(cwd).models);
}

function getModelRegistry(cwd) {
  const registry = loadModelRegistry(cwd || endpointsCwd || process.cwd());
  const models = Object.fromEntries(Object.entries(registry.models).map(([name, cfg]) => [name, { ...cfg }]));
  // Include top-level visionSupport in the models map so findVisionClient() picks it up
  const vs = getVisionSupport(cwd);
  if (vs) models.visionSupport = vs;
  return { main: registry.main, fast: registry.fast, models };
}

// Returns the visionSupport endpoint config if defined in endpoints.json.
// This is a dedicated endpoint used only for describing images when the
// active model doesn't support vision natively.
function getVisionSupport(cwd) {
  const raw = loadEndpoints(cwd || endpointsCwd || process.cwd());
  if (!raw || !raw.visionSupport || typeof raw.visionSupport !== 'object') return null;
  return normalizeModelConfig('visionSupport', raw.visionSupport);
}

// ── Registry editing (Settings → Model provider) ─────────────────────────────
// The registry file belongs to the user, so edits keep every key shmakk does
// not understand (visionSupport, per-model extras) and keep the stored API key
// when the form leaves the field blank.

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

function registryFilePath(cwd) {
  return configPath(cwd || process.cwd());
}

function editError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readEditableRegistry(cwd) {
  const file = registryFilePath(cwd);
  if (file.endsWith('.js')) {
    throw editError('This registry is endpoints.js — convert it to endpoints.json to edit it here');
  }
  let raw = {};
  if (fs.existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw editError(`Cannot edit ${file}: it is not valid JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw editError(`Cannot edit ${file}: expected a JSON object`);
    }
    raw = parsed;
  }
  if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
    const legacy = Object.keys(raw).filter((k) => k !== 'main' && k !== 'fast' && k !== 'visionSupport');
    if (legacy.length) {
      throw editError(`Cannot edit ${file}: entries must live inside a "models" object`);
    }
    raw.models = {};
  }
  return { file, raw };
}

function writeEditableRegistry(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function cleanModelName(name) {
  const value = String(name || '').trim();
  if (!MODEL_NAME_RE.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw editError('Name must be 1–64 characters: letters, digits, space, dot, dash or underscore');
  }
  return value;
}

function saveModel(cwd, name, cfg = {}) {
  const key = cleanModelName(name);
  const { file, raw } = readEditableRegistry(cwd);
  const prev = raw.models[key] && typeof raw.models[key] === 'object' ? raw.models[key] : {};
  const next = { ...prev };

  if (cfg.provider !== undefined) next.provider = String(cfg.provider || '').trim() || prev.provider || 'openai-compatible';
  if (cfg.model !== undefined) next.model = String(cfg.model || '').trim() || key;
  else if (!next.model) next.model = key;

  if (cfg.baseUrl !== undefined) {
    const value = String(cfg.baseUrl || '').trim();
    if (value) next.base_url = value;
    else delete next.base_url;
  }
  if (cfg.apiKey !== undefined) {
    const value = String(cfg.apiKey || '').trim();
    if (value) next.api_key = value;
    else delete next.api_key;
  }
  if (cfg.headers !== undefined) {
    const value = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : String(cfg.headers || '').trim();
    if (value && (typeof value === 'object' || value)) next.headers = value;
    else delete next.headers;
  }
  if (cfg.registry !== undefined) {
    const value = String(cfg.registry || '').trim();
    if (value) next.registry = value;
    else delete next.registry;
  }
  if (cfg.vision !== undefined) {
    if (cfg.vision === null) delete next.vision;
    else next.vision = !!cfg.vision;
  }
  raw.models[key] = next;

  if (cfg.main === true) raw.main = key;
  else if (cfg.main === false && raw.main === key) delete raw.main;

  if (cfg.fast === true) raw.fast = key;
  else if (cfg.fast === false && raw.fast === key) delete raw.fast;

  writeEditableRegistry(file, raw);
  return { name: key, config: next, path: file };
}

function deleteModel(cwd, name) {
  const key = cleanModelName(name);
  const { file, raw } = readEditableRegistry(cwd);
  if (!raw.models[key]) throw editError(`model "${key}" not found`, 404);
  delete raw.models[key];
  if (raw.main === key) delete raw.main;
  if (raw.fast === key) delete raw.fast;
  writeEditableRegistry(file, raw);
  if (currentEndpointName === key) clearEndpoint();
  return { name: key, path: file };
}

module.exports = {
  applyEndpoint,
  listEndpoints,
  getCurrentEndpoint,
  getCurrentEndpointName,
  clearEndpoint,
  loadEndpoints,
  supportsVision,
  getModelRegistry,
  getVisionSupport,
  registryFilePath,
  saveModel,
  deleteModel,
  _test: { normalizeRegistry, normalizeModelConfig },
  _supportsVisionForConfig,
};
