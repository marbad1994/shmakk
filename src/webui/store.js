// Persistence for the web UI: conversations (transcript + LLM history) and
// UI-level settings. Everything lives under the user's own state/config
// directories — nothing is written into the workspace.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'shmakk', 'web');
}

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'shmakk');
}

function conversationsDir() { return path.join(stateDir(), 'conversations'); }
function settingsPath() { return path.join(configDir(), 'web.json'); }

function newId(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function safeId(id) {
  return /^[a-z]_[a-z0-9]{6,40}$/i.test(String(id || '')) ? String(id) : null;
}

function writeFileAtomic(p, data, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, p);
}

// ── Settings ────────────────────────────────────────────────────────────────
// The first block mirrors the CLI's session opts (same key names, so
// self-commands like "review on" can mutate this object directly).

const DEFAULT_SETTINGS = {
  review: false,
  yesFiles: false,
  noCorrection: false,
  noAi: false,
  debug: false,
  colors: true,
  profile: null, // null = let the coordinator pick per task
  modelByMode: { chat: null, code: null, design: null, cowork: null }, // per-space model override (null = default)
  reasoningEffort: null, // null = provider default; else minimal|low|medium|high|xhigh|max
  systemPrompt: '', // global instruction prepended to every conversation, in every mode
  // voice
  ttsAuto: false,
  ttsVoice: null,
  voiceLanguage: null,
  voiceHandsFree: false,
  // provider overrides saved from the UI (applied only when env is unset)
  provider: null,
  recentWorkspaces: [],
  // Directory new workspaces are created under. Workspaces live directly in
  // this folder (one level), never in nested sub-folders of it.
  workspacesRoot: null,
  github: null, // { token, login } when connected from the UI
  token: null, // access token, kept so signed-in devices survive restarts
  // node federation
  nodeId: null, // stable identity of this shmakk instance
  cloud: null, // { enabled, url, token, label, sshHost, remotePort, remoteBind }
  transfer: 'copy', // 'copy' (default) or 'move'
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    // 0600: the file may hold an API key the user typed into the UI.
    writeFileAtomic(settingsPath(), JSON.stringify(settings, null, 2), 0o600);
    try { fs.chmodSync(settingsPath(), 0o600); } catch {}
  } catch {}
}

// ── Conversations ───────────────────────────────────────────────────────────

// chat = plain conversation · code = agent in a workspace · design = live
// HTML artifacts · cowork = automations and scheduled work
const MODES = ['chat', 'code', 'design', 'cowork'];

function metaOf(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    pinned: !!conv.pinned,
    workspace: conv.workspace || null,
    preview: conv.preview || '',
    repo: conv.repo || null, // set for GitHub cloud sessions
    mode: MODES.includes(conv.mode) ? conv.mode : 'code',
    projectId: conv.projectId || null,
    automationId: conv.automationId || null,
    node: conv.node || 'local',
    remote: !!conv.remote,
    paused: !!conv.paused,
    sessionId: conv.sessionId || null,
    origin: conv.origin || null, // 'cli' = mirrored from a session started outside the app
  };
}

// States that only make sense while a run is live get normalised when a
// transcript is loaded from disk (e.g. after the server was restarted).
function settleItems(items) {
  for (const it of items) {
    if (it.streaming) it.streaming = false;
    if (it.type === 'ask' && it.status === 'pending') it.status = 'expired';
    if (it.type === 'tool' && it.status === 'running') it.status = 'interrupted';
    if (it.type === 'shell' && it.running) { it.running = false; it.exitCode = it.exitCode ?? null; it.interrupted = true; }
    if (it.type === 'team' && Array.isArray(it.agents)) {
      for (const a of it.agents) if (a.status === 'running') a.status = 'interrupted';
    }
  }
  return items;
}

function loadConversation(id) {
  const sid = safeId(id);
  if (!sid) return null;
  try {
    const conv = JSON.parse(fs.readFileSync(path.join(conversationsDir(), `${sid}.json`), 'utf8'));
    conv.items = settleItems(Array.isArray(conv.items) ? conv.items : []);
    conv.history = Array.isArray(conv.history) ? conv.history : [];
    return conv;
  } catch {
    return null;
  }
}

function saveConversation(conv) {
  try {
    const { id, title, createdAt, updatedAt, pinned, workspace, cwd, preview, sessionId, repo, mode, projectId, automationId, items, history, node, remote, paused, resumePrompt, origin } = conv;
    writeFileAtomic(
      path.join(conversationsDir(), `${id}.json`),
      JSON.stringify({ id, title, createdAt, updatedAt, pinned, workspace, cwd, preview, sessionId, repo, mode, projectId, automationId, items, history, node, remote, paused, resumePrompt, origin }),
    );
  } catch {}
}

function deleteConversation(id) {
  const sid = safeId(id);
  if (!sid) return false;
  try { fs.rmSync(path.join(conversationsDir(), `${sid}.json`), { force: true }); return true; } catch { return false; }
}

function listConversations() {
  let files = [];
  try { files = fs.readdirSync(conversationsDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(conversationsDir(), f), 'utf8'));
      if (conv && conv.id) out.push(metaOf(conv));
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

module.exports = {
  stateDir,
  MODES,
  configDir,
  settingsPath,
  newId,
  safeId,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  metaOf,
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
};
