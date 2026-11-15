const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const llm = require('./llm');
const { getModelRegistry, getVisionSupport } = require('./endpoints');
const { automationSystem, automationUser } = require('./vibedit/prompts');

const DEFAULT_PORT = 3947;
const STATE_PATH = path.join(os.homedir(), '.config', 'shmakk', 'browser-daemon.json');

function stripFences(s) {
  const match = String(s || '').match(/\{[\s\S]*\}/);
  if (match) return match[0].trim();
  return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2));
  } catch {}
}

function findVisionClient() {
  const registry = getModelRegistry();
  for (const [name, cfg] of Object.entries(registry.models)) {
    if (cfg.vision) return llm.makeClientForEndpoint(name);
  }
  // Fall back to top-level visionSupport key
  const vs = getVisionSupport();
  if (vs) return llm.makeClientForEndpoint('visionSupport');
  return null;
}

async function getClient(visionClient) {
  if (visionClient) return visionClient.client;
  const fast = llm.makeClientForEndpoint('fast');
  if (fast) return fast.client;
  if (!llm.isConfigured()) return null;
  return llm.makeClient();
}

async function chatCompletion(client, messages, model, opts = {}) {
  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens || 2048,
  });
  return ((response?.choices?.[0]?.message?.content) || '').trim();
}

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function daemonAutomationSystem() {
  return automationSystem() + `

Additional browser-extension actions are allowed:
- "newTab": { "action": "newTab", "url": "https://...", "active": true, "description": "..." }
- "reload": { "action": "reload", "description": "..." }
- "closeTab": { "action": "closeTab", "description": "..." }
- "switchTab": { "action": "switchTab", "tabId": 123, "description": "..." }
- "createGroup": { "action": "createGroup", "title": "Group name", "color": "blue", "description": "..." }
- "moveToGroup": { "action": "moveToGroup", "groupId": 123, "description": "..." }
- "ungroup": { "action": "ungroup", "description": "..." }
Use these only when the user asks for tab or tab-group management.`;
}

async function handleAutomation(ws, msg, runtime) {
  const directActions = Array.isArray(msg.directActions) ? msg.directActions : [];
  if (directActions.length) {
    send(ws, {
      type: 'executeActions',
      actions: directActions,
      summary: `Replaying ${directActions.length} recorded action${directActions.length === 1 ? '' : 's'}`,
      notes: '',
    });
    return;
  }

  const client = await getClient(runtime.visionClient);
  if (!client) {
    send(ws, { type: 'error', text: 'LLM not configured' });
    return;
  }

  const fast = llm.makeClientForEndpoint('fast');
  const model = runtime.visionModel || (fast ? fast.model : null) || llm.modelFor();
  send(ws, { type: 'status', text: `Building browser automation with ${model}...` });

  const shots = msg.screenshots && msg.screenshots.length ? msg.screenshots : [];
  const userContent = automationUser(msg);
  const vision = runtime.visionEnabled && shots.length;
  let raw;

  if (vision) {
    const imageParts = shots.map((s) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${s}`, detail: 'high' } }));
    try {
      raw = await chatCompletion(client, [
        { role: 'system', content: daemonAutomationSystem() },
        { role: 'user', content: [{ type: 'text', text: userContent }, ...imageParts] },
      ], model);
    } catch {
      raw = await chatCompletion(client, [
        { role: 'system', content: daemonAutomationSystem() },
        { role: 'user', content: userContent },
      ], model);
    }
  } else {
    raw = await chatCompletion(client, [
      { role: 'system', content: daemonAutomationSystem() },
      { role: 'user', content: userContent },
    ], model);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    send(ws, {
      type: 'automationResult',
      ok: false,
      summary: 'Failed to parse automation response.',
      modelOutput: raw.slice(0, 1500),
    });
    return;
  }

  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (actions.length) {
    send(ws, {
      type: 'executeActions',
      actions,
      summary: parsed.summary || '',
      notes: parsed.notes || '',
    });
    return;
  }

  send(ws, {
    type: 'automationResult',
    ok: true,
    summary: parsed.summary || 'No executable actions were produced.',
    notes: parsed.notes || '',
    hasActions: false,
  });
}

async function startBrowserDaemon(opts = {}) {
  const port = Number(opts.port) || DEFAULT_PORT;
  const visionClient = findVisionClient();
  const fast = llm.makeClientForEndpoint('fast');
  const runtime = {
    visionClient,
    visionModel: visionClient ? visionClient.model : null,
    visionEnabled: !!visionClient,
  };
  const model = runtime.visionModel || (fast ? fast.model : null) || (llm.modelFor?.() || 'unknown');

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port, model, vision: runtime.visionEnabled }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    saveState({ running: true, port, model, vision: runtime.visionEnabled, connectedAt: Date.now() });
    send(ws, { type: 'hello', model, vision: runtime.visionEnabled, daemon: true });
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try {
        if (msg.type === 'automation') await handleAutomation(ws, msg, runtime);
        else if (msg.type === 'status') send(ws, { type: 'status', text: 'Browser daemon connected.' });
        else if (msg.type === 'tabStatus') saveState({ running: true, port, model, vision: runtime.visionEnabled, activeTab: msg.tab || null });
      } catch (err) {
        send(ws, { type: 'error', text: err.message });
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  saveState({ running: true, port, model, vision: runtime.visionEnabled, pid: process.pid, startedAt: Date.now() });
  return {
    port,
    statePath: STATE_PATH,
    close: () => {
      saveState({ running: false, port, stoppedAt: Date.now() });
      wss.close();
      httpServer.close();
    },
  };
}

module.exports = {
  DEFAULT_PORT,
  STATE_PATH,
  startBrowserDaemon,
};
