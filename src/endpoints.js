// Named endpoint presets. Loads .shmakk/endpoints.json from the workspace
// root (or the nearest ancestor) and applies the selected preset by setting
// process.env.SHMAKK_* variables before any other module reads them.
//
// Format (.shmakk/endpoints.json):
// {
//   "makkorch": {
//     "base_url": "https://api.example.com/v1",
//     "api_key": "sk-...",
//     "model": "gpt-4o-mini",
//     "headers": "x-custom=value"
//   }
// }

const fs = require('fs');
const path = require('path');

function configPath(cwd) {
  // Look in the workspace root (usually cwd). The endpoint config is
  // a user-local file and doesn't need ancestor traversal like state.
  return path.join(cwd, '.shmakk', 'endpoints.json');
}

function loadEndpoints(cwd) {
  try {
    const raw = fs.readFileSync(configPath(cwd || process.cwd()), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function applyEndpoint(name, cwd) {
  const endpoints = loadEndpoints(cwd);
  if (!endpoints || !endpoints[name]) return false;

  const cfg = endpoints[name];
  if (cfg.base_url)  process.env.SHMAKK_BASE_URL  = cfg.base_url;
  if (cfg.api_key)   process.env.SHMAKK_API_KEY   = cfg.api_key;
  if (cfg.model)     process.env.SHMAKK_MODEL     = cfg.model;
  if (cfg.headers)   process.env.SHMAKK_HEADERS   = cfg.headers;

  return true;
}

function listEndpoints(cwd) {
  const endpoints = loadEndpoints(cwd);
  if (!endpoints) return [];
  return Object.keys(endpoints);
}

module.exports = { applyEndpoint, listEndpoints };
