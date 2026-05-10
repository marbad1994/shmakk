const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = Math.max(60_000, Number(process.env.SHMAKK_PROMPT_CACHE_TTL_MS) || 6 * 60 * 60 * 1000);
const DEFAULT_MAX_ENTRIES = Math.max(20, Number(process.env.SHMAKK_PROMPT_CACHE_MAX_ENTRIES) || 200);

function cachePath(root) {
  return path.join(root, '.shmakk', 'state', 'prompt-cache.json');
}

function hashObj(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

function normalizeMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role,
    content: m.content,
    tool_calls: m.tool_calls || undefined,
    tool_call_id: m.tool_call_id || undefined,
  }));
}

function makeKey({ model, messages, toolChoice = 'auto' }) {
  return hashObj({ model, toolChoice, messages: normalizeMessages(messages) });
}

function load(root) {
  try {
    const p = cachePath(root);
    if (!fs.existsSync(p)) return { entries: {} };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { entries: j.entries || {} };
  } catch {
    return { entries: {} };
  }
}

function save(root, cache) {
  try {
    const p = cachePath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ entries: cache.entries || {} }, null, 2));
  } catch {}
}

function get(root, key, ttlMs = DEFAULT_TTL_MS) {
  const c = load(root);
  const e = c.entries[key];
  if (!e) return null;
  const age = Date.now() - Number(e.createdAt || 0);
  if (!Number.isFinite(age) || age > ttlMs) {
    delete c.entries[key];
    save(root, c);
    return null;
  }
  e.lastHitAt = Date.now();
  e.hits = Number(e.hits || 0) + 1;
  c.entries[key] = e;
  save(root, c);
  return e;
}

function put(root, key, value, maxEntries = DEFAULT_MAX_ENTRIES) {
  const c = load(root);
  c.entries[key] = {
    content: String(value.content || ''),
    createdAt: Date.now(),
    lastHitAt: Date.now(),
    hits: 0,
  };

  const keys = Object.keys(c.entries);
  if (keys.length > maxEntries) {
    keys.sort((a, b) => Number(c.entries[a].lastHitAt || 0) - Number(c.entries[b].lastHitAt || 0));
    const removeN = keys.length - maxEntries;
    for (let i = 0; i < removeN; i++) delete c.entries[keys[i]];
  }
  save(root, c);
}

module.exports = { makeKey, get, put };
