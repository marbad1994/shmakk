let OpenAI;
try { OpenAI = require('openai'); } catch { OpenAI = null; }

const path = require('path');
const os = require('os');
const { getCurrentEndpoint } = require('./endpoints');

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

function envForProvider() {
  // Check active endpoint first (allows hotswap)
  const activeEndpoint = getCurrentEndpoint();
  if (activeEndpoint) {
    return {
      baseURL: activeEndpoint.base_url,
      apiKey: activeEndpoint.api_key,
      headers: activeEndpoint.headers,
      model: activeEndpoint.model,
    };
  }
  // Fall back to env vars for backwards compatibility
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
    defaultHeaders: buildHeaders(cfg.headers),
  });
}

function modelFor() {
  return process.env.SHMAKK_MODEL || 'gpt-4o-mini';
}

module.exports = { makeClient, modelFor, isConfigured };
