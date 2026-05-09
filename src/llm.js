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

function isConfigured() {
  return !!process.env.AITERM_BASE_URL && !!OpenAI;
}

function makeClient() {
  if (!OpenAI) throw new Error('openai sdk not installed');
  return new OpenAI({
    baseURL: process.env.AITERM_BASE_URL,
    apiKey: process.env.AITERM_API_KEY || 'not-needed',
    defaultHeaders: parseHeaders(process.env.AITERM_HEADERS),
  });
}

function modelFor(role) {
  const m = {
    correction: process.env.AITERM_CORRECTION_MODEL,
    agent: process.env.AITERM_AGENT_MODEL,
    chat: process.env.AITERM_CHAT_MODEL,
  }[role];
  return m || process.env.AITERM_MODEL || 'gpt-4o-mini';
}

module.exports = { makeClient, modelFor, isConfigured };
