// vibedit control server — WebSocket + HTTP for the in-browser overlay.
// Uses shmakk's LLM client for chat/save/flow operations.
//
// Chat: LLM returns DOM ops applied instantly in the browser.
// Save: LLM produces a structured functionality spec → handed to shmakk PM.
// Flow: LLM produces a spec from recorded interaction flows.

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { shortlistFiles } = require('./files');
const { chatSystem, chatUser, saveSystem, saveUser, flowUser, automationSystem, automationUser } = require('./prompts');
const llm = require('../llm');
const { getModelRegistry, getVisionSupport } = require('../endpoints');

function stripFences(s) {
  // Try to extract JSON from anywhere in the text
  const match = s.match(/\{[\s\S]*\}/);
  if (match) return match[0].trim();
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// Write a spec and return its path. Also appends to a queue file so the
// shmakk session can pick it up on the next agent invocation.
function saveSpec(ctx, spec, pageUrl) {
  const specDir = ctx.specsDir || path.join(ctx.stateDir, 'vibedit-specs');
  fs.mkdirSync(specDir, { recursive: true });

  const ts = Date.now();
  const specFile = path.join(specDir, `spec-${ts}.json`);
  const fullSpec = {
    timestamp: new Date(ts).toISOString(),
    pageUrl,
    projectDir: ctx.projectDir,
    ...spec,
  };
  fs.writeFileSync(specFile, JSON.stringify(fullSpec, null, 2));

  // Write a signal file that session.js checks before each agent run
  const signalFile = ctx.pendingSpecFile || path.join(specDir, 'pending');
  fs.writeFileSync(signalFile, specFile);

  return specFile;
}

// Pick the first endpoint with vision: true for vibedit (screenshots need vision).
// Falls back to null if none exists — then the normal shmakk model is used.
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

async function startControlServer(ctx) {
  const { stateDir, page, projectDir } = ctx;
  const requestedPort = Number.isInteger(Number(ctx.port)) ? Number(ctx.port) : 0;
  let port = requestedPort;
  const sessionsDir = ctx.sessionsDir || path.join(stateDir, 'vibedit-sessions');
  const pageStateFile = ctx.pageStateFile || path.join(stateDir, 'vibedit-page-state.json');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(pageStateFile), { recursive: true });

  // Resolve a vision-capable model for vibedit. Shmakk keeps its own model selection.
  const visionClient = findVisionClient();
  const visionModel = visionClient ? visionClient.model : null;
  const visionEnabled = visionClient != null;

  async function getClient() {
    if (visionClient) return visionClient.client;
    const fast = llm.makeClientForEndpoint('fast');
    if (fast) return fast.client;
    if (!llm.isConfigured()) return null;
    return llm.makeClient();
  }

  async function chatCompletion(client, messages, opts = {}) {
    const fast = llm.makeClientForEndpoint('fast');
    const model = visionModel || (fast ? fast.model : null) || llm.modelFor();
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens || 2048,
    });
    return ((response?.choices[0]?.message?.content) || '').trim();
  }

  // Plain HTTP for serving session screenshots to the overlay playback view
  const httpServer = http.createServer((req, res) => {
    const m = req.url.match(/^\/sessions\/([\w-]+)\/(shot-\d+\.jpg)$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    const file = path.join(sessionsDir, m[1], m[2]);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server: httpServer });

  let recording = null; // { id, dir, events, timer, shots }
  let lastContext = null; // { selected, selector } from edit mode selection
  let pageState = readPageState();

  function readPageState() {
    try {
      if (!fs.existsSync(pageStateFile)) return {};
      const parsed = JSON.parse(fs.readFileSync(pageStateFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writePageState(patch = {}) {
    pageState = {
      ...pageState,
      ...patch,
      updatedAt: new Date().toISOString(),
      pageUrl: page.url(),
    };
    try {
      fs.writeFileSync(pageStateFile, JSON.stringify(pageState, null, 2));
    } catch {}
    return pageState;
  }

  async function screenshotB64() {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      return Buffer.from(buf).toString('base64');
    } catch { return null; }
  }

  function send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  async function handleChat(ws, msg) {
    if (!msg.selected && lastContext) msg.selected = lastContext.selected;
    send(ws, { type: 'status', text: 'Thinking...' });
    const client = await getClient();
    if (!client) { send(ws, { type: 'error', text: 'LLM not configured' }); return; }
    const shots = msg.screenshots && msg.screenshots.length ? msg.screenshots : (msg.screenshot ? [msg.screenshot] : []);
    if (!shots.length) {
      const fallback = await screenshotB64();
      if (fallback) shots.push(fallback);
    }
    const flowCtx = msg.flowEvents ? flowContext(msg.flowEvents) : '';
    const userContent = chatUser(msg) + flowCtx;
    const vision = visionEnabled;
    let raw;
    if (vision && shots.length) {
      const imageParts = shots.map((s) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${s}`, detail: 'high' } }));
      try {
        raw = await chatCompletion(client, [
          { role: 'system', content: chatSystem() },
          { role: 'user', content: [{ type: 'text', text: userContent }, ...imageParts] },
        ]);
      } catch {
        raw = await chatCompletion(client, [
          { role: 'system', content: chatSystem() },
          { role: 'user', content: userContent },
        ]);
      }
    } else {
      raw = await chatCompletion(client, [
        { role: 'system', content: chatSystem() },
        { role: 'user', content: userContent },
      ]);
    }

    let parsed;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      parsed = { reply: raw, ops: [] };
    }
    console.log('[vibedit] chat raw length:', raw.length, ' ops count:', (parsed.ops || []).length);
    if ((parsed.ops || []).length === 0) console.log('[vibedit] raw preview:', raw.slice(0, 300));
    send(ws, { type: 'chatResult', reply: parsed.reply || '', ops: Array.isArray(parsed.ops) ? parsed.ops : [] });
  }

  async function handleScreenshot(ws, msg) {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70, clip: { x: msg.x, y: msg.y, width: msg.width, height: msg.height } });
      const data = Buffer.from(buf).toString('base64');
      send(ws, { type: 'screenshotResult', data });
    } catch (err) {
      send(ws, { type: 'error', text: 'Screenshot failed: ' + err.message });
    }
  }

  // ── Save: produce structured functionality spec for shmakk PM ──────
  async function handleSave(ws, msg) {
    if (!msg.changes || msg.changes.length === 0) {
      send(ws, { type: 'saveResult', ok: false, summary: 'No tracked changes to save.' });
      return;
    }
    const client = await getClient();
    if (!client) { send(ws, { type: 'error', text: 'LLM not configured' }); return; }

    send(ws, { type: 'status', text: 'Locating source files...' });
    const shortlist = shortlistFiles(projectDir, msg.changes);

    const fast = llm.makeClientForEndpoint('fast');
    const model = visionModel || (fast ? fast.model : null) || llm.modelFor();
    send(ws, { type: 'status', text: `Asking ${model} for a structured specification...` });

    const raw = await chatCompletion(client, [
      { role: 'system', content: saveSystem() },
      { role: 'user', content: saveUser(msg, shortlist) },
    ], { maxTokens: 4096 });

    let spec;
    try {
      spec = JSON.parse(stripFences(raw));
    } catch {
      send(ws, {
        type: 'saveResult',
        ok: false,
        summary: 'LLM did not produce a valid spec. Try again.',
        modelOutput: raw.slice(0, 1500),
      });
      return;
    }

    // Save the spec and signal the session
    const specPath = saveSpec(ctx, spec, msg.url);

    // Call onSpec callback if registered (session.js uses this to inject into agent)
    if (ctx.onSpec) {
      try { ctx.onSpec(spec, specPath); } catch {}
    }

    const comps = (spec.files || []).map((f) => f.path).join(', ');
    send(ws, {
      type: 'saveResult',
      ok: true,
      summary: `Spec saved. ${spec.files ? spec.files.length : 0} file(s) affected: ${comps || '(none listed)'}. Handed to shmakk PM.`,
      spec,
      specPath,
    });
  }

  function startFlow(ws) {
    if (recording) return;
    const id = `flow-${Date.now()}`;
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    recording = { id, dir, events: [], shots: 0, t0: Date.now(), timer: null };
    const snap = async () => {
      if (!recording) return;
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
        const n = recording.shots++;
        fs.writeFileSync(path.join(dir, `shot-${n}.jpg`), buf);
        recording.events.push({ t: Date.now() - recording.t0, kind: 'shot', n });
      } catch {}
    };
    snap();
    recording.timer = setInterval(snap, 1500);
    send(ws, { type: 'flowStarted', id });
  }

  function stopFlow(ws) {
    if (!recording) return;
    clearInterval(recording.timer);
    const { id, dir, events, shots } = recording;
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(events, null, 2));
    writePageState({
      currentFlowSession: {
        id,
        shots,
        events,
        base: `http://127.0.0.1:${port}/sessions/${id}/`,
      },
    });
    recording = null;
    send(ws, { type: 'flowStopped', id, shots, events, base: `http://127.0.0.1:${port}/sessions/${id}/` });
  }

  async function handleFlowApply(ws, msg) {
    const client = await getClient();
    if (!client) { send(ws, { type: 'error', text: 'LLM not configured' }); return; }

    const dir = path.join(sessionsDir, msg.id);
    if (!fs.existsSync(path.join(dir, 'events.json'))) {
      send(ws, { type: 'error', text: 'Session not found.' });
      return;
    }
    const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
    send(ws, { type: 'status', text: 'Locating source files for the recorded flow...' });
    const needles = events.filter((e) => e.kind === 'click').map((e) => ({ before: e.text || '', selector: e.selector || '' }));
    const shortlist = shortlistFiles(projectDir, needles.length ? needles : [{ before: (msg.dom || '').slice(0, 400) }]);

    const fast = llm.makeClientForEndpoint('fast');
    const model = visionModel || (fast ? fast.model : null) || llm.modelFor();
    send(ws, { type: 'status', text: `Asking ${model} for a structured specification...` });
    const raw = await chatCompletion(client, [
      { role: 'system', content: saveSystem() },
      { role: 'user', content: flowUser(msg, events, shortlist) },
    ], { maxTokens: 4096 });

    let spec;
    try {
      spec = JSON.parse(stripFences(raw));
    } catch {
      send(ws, {
        type: 'saveResult',
        ok: false,
        summary: 'LLM did not produce a valid spec. Try again.',
        modelOutput: raw.slice(0, 1500),
      });
      return;
    }

    const specPath = saveSpec(ctx, spec, msg.url);

    if (ctx.onSpec) {
      try { ctx.onSpec(spec, specPath); } catch {}
    }

    send(ws, {
      type: 'saveResult',
      ok: true,
      summary: `Flow spec saved. Handed to shmakk PM.`,
      spec,
      specPath,
    });
  }

  // ── Automation: produce Playwright script + in-page actions ──────
  async function handleAutomation(ws, msg) {
    const client = await getClient();
    if (!client) { send(ws, { type: 'error', text: 'LLM not configured' }); return; }

    const fast = llm.makeClientForEndpoint('fast');
    const model = visionModel || (fast ? fast.model : null) || llm.modelFor();
    send(ws, { type: 'status', text: `Building automation with ${model}...` });

    const shots = msg.screenshots && msg.screenshots.length ? msg.screenshots : [];
    if (!shots.length) {
      const fallback = await screenshotB64();
      if (fallback) shots.push(fallback);
    }

    let raw;
    const userContent = automationUser(msg);
    const vision = visionEnabled;
    if (vision && shots.length) {
      const imageParts = shots.map((s) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${s}`, detail: 'high' } }));
      try {
        raw = await chatCompletion(client, [
          { role: 'system', content: automationSystem() },
          { role: 'user', content: [{ type: 'text', text: userContent }, ...imageParts] },
        ]);
      } catch {
        raw = await chatCompletion(client, [
          { role: 'system', content: automationSystem() },
          { role: 'user', content: userContent },
        ]);
      }
    } else {
      raw = await chatCompletion(client, [
        { role: 'system', content: automationSystem() },
        { role: 'user', content: userContent },
      ]);
    }

    let parsed;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      send(ws, {
        type: 'automationResult',
        ok: false,
        summary: 'Failed to parse automation script.',
        modelOutput: raw.slice(0, 1500),
      });
      return;
    }

    // Save the automation response alongside flow sessions
    const autoDir = ctx.automationsDir || path.join(stateDir, 'browser-automations');
    fs.mkdirSync(autoDir, { recursive: true });
    const ts = Date.now();
    const autoJsonFile = path.join(autoDir, `automation-${ts}.json`);
    fs.writeFileSync(autoJsonFile, JSON.stringify(parsed, null, 2));

    let scriptFile = null;
    if (parsed.script && typeof parsed.script === 'string' && parsed.script.trim().length > 0) {
      scriptFile = path.join(autoDir, `automation-${ts}.js`);
      fs.writeFileSync(scriptFile, parsed.script);
    }

    // Send actions for in-page execution first (if any)
    const actions = parsed.actions;
    if (actions && Array.isArray(actions) && actions.length > 0) {
      send(ws, {
        type: 'executeActions',
        actions,
        summary: parsed.summary || '',
        notes: parsed.notes || '',
        scriptFile: scriptFile,
      });
      return;
    }

    // No in-page actions; send standard result
    send(ws, {
      type: 'automationResult',
      ok: true,
      summary: parsed.summary || '',
      script: parsed.script || '',
      notes: parsed.notes || '',
      file: scriptFile || autoJsonFile,
      hasActions: false,
    });
  }

  // ── Execute a saved Playwright script ──────
  async function handleExecuteScript(ws, msg) {
    const file = msg.file;
    if (!file || !fs.existsSync(file)) {
      send(ws, { type: 'scriptResult', ok: false, summary: `Script not found: ${file}` });
      return;
    }

    send(ws, { type: 'status', text: `Running ${path.basename(file)}...` });

    try {
      const { execSync } = require('child_process');
      const cwd = path.dirname(file);
      const output = execSync(`node ${path.basename(file)}`, {
        cwd,
        timeout: 120000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      send(ws, {
        type: 'scriptResult',
        ok: true,
        summary: `Script completed:\n${output.slice(-500)}`,
        file,
      });
    } catch (e) {
      send(ws, {
        type: 'scriptResult',
        ok: false,
        summary: `Script failed: ${e.stderr || e.message}`.slice(0, 1000),
        file,
      });
    }
  }

  wss.on('connection', (ws) => {
    var _a, _b;
    const fast = llm.makeClientForEndpoint('fast');
    const model = visionModel || (fast ? fast.model : null) || ((_a = llm.modelFor) === null || _a === void 0 ? void 0 : _a.call(llm)) || 'qwen/qwen3.5-9b';
    const vision = visionEnabled || ((_b = llm.supportsVision) === null || _b === void 0 ? void 0 : _b.call(llm)) || false;
    send(ws, { type: 'hello', model, vision });
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try {
        if (msg.type === 'chat') await handleChat(ws, msg);
        else if (msg.type === 'context') { lastContext = { selected: msg.selected, selector: msg.selector }; }
        else if (msg.type === 'screenshot') await handleScreenshot(ws, msg);
        else if (msg.type === 'save') await handleSave(ws, msg);
        else if (msg.type === 'flowStart') startFlow(ws);
        else if (msg.type === 'flowStop') stopFlow(ws);
        else if (msg.type === 'flowEvent' && recording) recording.events.push({ ...msg.ev, t: Date.now() - recording.t0 });
        else if (msg.type === 'flowDiscard' && /^flow-\d+$/.test(msg.id || '')) {
          fs.rmSync(path.join(sessionsDir, msg.id), { recursive: true, force: true });
          if (pageState.currentFlowSession && pageState.currentFlowSession.id === msg.id) {
            writePageState({ currentFlowSession: null });
          }
        }
        else if (msg.type === 'flowApply') await handleFlowApply(ws, msg);
        else if (msg.type === 'automation') await handleAutomation(ws, msg);
        else if (msg.type === 'executeScript') await handleExecuteScript(ws, msg);
        else if (msg.type === 'pageStateGet') send(ws, { type: 'pageState', state: readPageState() });
        else if (msg.type === 'pageStateSet') writePageState(msg.state || {});
      } catch (err) {
        send(ws, { type: 'error', text: err.message });
      }
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, '127.0.0.1', () => {
      const addr = httpServer.address();
      port = addr && typeof addr === 'object' ? addr.port : requestedPort;
      resolve();
    });
  });

  let closed = false;
  return {
    port,
    close: () => {
      if (closed) return;
      closed = true;
      if (recording && recording.timer) {
        try { clearInterval(recording.timer); } catch {}
        recording = null;
      }
      try { wss.close(); } catch {}
      try { httpServer.close(); } catch {}
    },
  };
}

function flowContext(events) {
  const relevant = events.filter((e) => e.kind !== 'shot').slice(0, 80);
  if (!relevant.length) return '';
  const evLines = relevant.map((e) => {
    if (e.kind === 'click') return `[${(e.t/1000).toFixed(1)}s] click ${e.selector} "${(e.text || '').slice(0, 60)}"`;
    if (e.kind === 'scroll') return `[${(e.t/1000).toFixed(1)}s] scroll to y=${e.y}`;
    if (e.kind === 'input') return `[${(e.t/1000).toFixed(1)}s] typed in ${e.selector}`;
    if (e.kind === 'nav') return `[${(e.t/1000).toFixed(1)}s] navigated to ${e.url}`;
    return `[${(e.t/1000).toFixed(1)}s] ${e.kind}`;
  }).join('\n');
  return `\n\nThe user recorded this interaction flow on the page. Use the recorded selectors to understand what elements they interacted with. Prefer selectors from the flow events:\n${evLines}`;
}

module.exports = { startControlServer };
