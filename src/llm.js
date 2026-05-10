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

function roleSuffix(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'agent') return 'AGENT';
  if (r === 'chat') return 'CHAT';
  return '';
}

function providerNameForRole(role) {
  const suf = roleSuffix(role);
  if (!suf) return 'primary';
  const lane = process.env[`SHMAKK_${suf}_PROVIDER`];
  if (!lane) return 'primary';
  return String(lane).toLowerCase() === 'secondary' ? 'secondary' : 'primary';
}

function envForProvider(provider) {
  const secondary = String(provider || '').toLowerCase() === 'secondary';
  return {
    baseURL: secondary ? process.env.SHMAKK_SECONDARY_BASE_URL : process.env.SHMAKK_BASE_URL,
    apiKey: secondary ? process.env.SHMAKK_SECONDARY_API_KEY : process.env.SHMAKK_API_KEY,
    headers: secondary ? process.env.SHMAKK_SECONDARY_HEADERS : process.env.SHMAKK_HEADERS,
    model: secondary ? process.env.SHMAKK_SECONDARY_MODEL : process.env.SHMAKK_MODEL,
  };
}

function isConfigured(role = 'agent') {
  const provider = providerNameForRole(role);
  const cfg = envForProvider(provider);
  return !!cfg.baseURL && !!OpenAI;
}

function makeClient(role = 'agent') {
  if (!OpenAI) throw new Error('openai sdk not installed');
  const provider = providerNameForRole(role);
  const cfg = envForProvider(provider);
  return new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey || 'not-needed',
    defaultHeaders: parseHeaders(cfg.headers),
  });
}

function modelFor(role) {
  const provider = providerNameForRole(role);
  const cfg = envForProvider(provider);
  const m = {
    agent: process.env.SHMAKK_AGENT_MODEL,
    chat: process.env.SHMAKK_CHAT_MODEL,
  }[role];
  return m || cfg.model || 'gpt-4o-mini';
}

module.exports = { makeClient, modelFor, isConfigured };
