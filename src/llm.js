let OpenAI;
try { OpenAI = require('openai'); } catch { OpenAI = null; }

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

function envForProvider() {
  return {
    baseURL: process.env.SHMAKK_BASE_URL,
    apiKey: process.env.SHMAKK_API_KEY,
    headers: process.env.SHMAKK_HEADERS,
    model: process.env.SHMAKK_MODEL,
  };
}

function isConfigured() {
  const cfg = envForProvider();
  return !!cfg.baseURL && !!OpenAI;
}

function makeClient() {
  if (!OpenAI) throw new Error('openai sdk not installed');
  const cfg = envForProvider();
  return new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey || 'not-needed',
    defaultHeaders: parseHeaders(cfg.headers),
  });
}

function modelFor() {
  return process.env.SHMAKK_MODEL || 'gpt-4o-mini';
}

module.exports = { makeClient, modelFor, isConfigured };
