// Named endpoint presets with hotswap support.
// Loads ~/.config/shmakk/endpoints.js (or .json for backwards compat).
// Can switch endpoints mid-session without restarting.
//
// Format (~/.config/shmakk/endpoints.js):
// {
//   "makkorch": {
//     "base_url": "https://api.example.com/v1",
//     "api_key": "sk-...",
//     "model": "gpt-4o-mini",
//     "headers": "x-custom=value",
//     "registry": "claudeHaiku,claudeSonnet,ministral"
//   }
// }

const fs = require('fs');
const path = require('path');
const os = require('os');

let currentEndpointName = null;
let currentEndpointConfig = null;
let endpointsCwd = null;

function configPath(cwd) {
  const configDir = path.join(os.homedir(), '.config', 'shmakk');
  const jsPath = path.join(configDir, 'endpoints.js');
  const jsonPath = path.join(configDir, 'endpoints.json');

  // Try .js first, fall back to .json for backwards compatibility
  if (fs.existsSync(jsPath)) return jsPath;
  if (fs.existsSync(jsonPath)) return jsonPath;
  return jsPath; // Default to .js even if neither exists
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

function applyEndpoint(name, cwd) {
  const endpoints = loadEndpoints(cwd);
  if (!endpoints || !endpoints[name]) return false;

  const cfg = endpoints[name];
  currentEndpointName = name;

  // Normalize: accept both camelCase and snake_case
  const normalized = {
    base_url: cfg.base_url || cfg.baseUrl,
    api_key: cfg.api_key || cfg.apiKey,
    model: cfg.model,
    headers: cfg.headers,
    registry: cfg.registry,
  };

  currentEndpointConfig = normalized;
  endpointsCwd = cwd;

  // Also update env vars for backwards compatibility
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

function listEndpoints(cwd) {
  const endpoints = loadEndpoints(cwd);
  if (!endpoints) return [];
  return Object.keys(endpoints);
}

module.exports = {
  applyEndpoint,
  listEndpoints,
  getCurrentEndpoint,
  getCurrentEndpointName,
  clearEndpoint,
  loadEndpoints,
};
