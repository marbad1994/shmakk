// Node federation for the web UI.
//
// Two roles, one class:
//   * client: the desktop node reaches the cloud (REST proxy + WebSocket relay)
//     and can expose its own sessions with an SSH reverse tunnel.
//   * host:   the cloud node keeps a registry of "remote" sessions and proxies
//     them to the tunnel endpoints the desktop opened.
//
// Every node-to-node hop is authenticated with the target node's access token.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const WebSocket = require('ws');
const { loadHostConfig, resolveHost } = require('../ssh');
const store = require('./store');

const MAX_PROXY_BYTES = 64 * 1024 * 1024;

function ensureNodeId(settings) {
  if (settings.nodeId && /^n_[a-z0-9]{8,40}$/i.test(settings.nodeId)) return settings.nodeId;
  settings.nodeId = `n_${crypto.randomBytes(8).toString('hex')}`;
  return settings.nodeId;
}

function registryPath() { return path.join(store.stateDir(), 'remote.json'); }

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return new Map(Object.entries(raw.sessions || {}));
  } catch {
    return new Map();
  }
}

function saveRegistry(map) {
  try {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify({ sessions: Object.fromEntries(map) }, null, 2));
  } catch {}
}

class NodeHub {
  // ctx: { settings, saveSettings, log, getToken, getPort, broadcast }
  constructor(ctx) {
    this.ctx = ctx;
    this.registry = loadRegistry();
    this.cloudWs = null;        // client WebSocket to the cloud node
    this.cloudRetry = 0;
    this.remoteClients = new Map(); // endpoint → { ws, token, retry, pending }
    this.tunnelProc = null;
    this.tunnelExposed = new Set();
    this.exposedIds = new Set();    // session ids this node has exposed (echo filter)
  }

  nodeId() { return ensureNodeId(this.ctx.settings); }

  // ── configuration ────────────────────────────────────────────────────────

  cloudConfig() {
    const c = this.ctx.settings.cloud;
    if (!c || !c.enabled || !c.url || !c.token) return null;
    return { url: c.url.replace(/\/+$/, ''), token: c.token, label: c.label || new URL(c.url).host, sshHost: c.sshHost || null, remotePort: c.remotePort || null, remoteBind: c.remoteBind || '0.0.0.0' };
  }

  remoteGateway() {
    return String(process.env.SHMAKK_REMOTE_GATEWAY || this.ctx.settings.remoteGateway || 'http://172.17.0.1').replace(/\/+$/, '');
  }

  nodes() {
    const local = { id: 'local', label: 'This computer', kind: 'local', url: '', online: true };
    const c = this.cloudConfig();
    const list = [local];
    if (c) list.push({ id: 'cloud', label: c.label, kind: 'cloud', url: c.url, online: !!this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN });
    return list;
  }

  // Resolve a proxy target for a node name: "cloud" is the configured cloud
  // node, anything else is a remote-session id in the registry.
  proxyTarget(node) {
    if (node === 'cloud') return this.cloudConfig();
    const entry = this.registry.get(node);
    if (entry) return { url: entry.endpoint, token: entry.token };
    return null;
  }

  // ── generic HTTP proxy (JSON-sized responses) ────────────────────────────

  async proxy(target, method, pathname, { body, raw, query = {} } = {}) {
    const url = new URL(pathname, `${target.url}/`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${target.token}` };
    const res = await fetch(url, {
      method,
      headers: raw ? headers : { ...headers, 'content-type': 'application/json' },
      body: raw ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PROXY_BYTES) throw new Error('proxy response too large');
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: buf,
    };
  }

  // Stream a request body to a remote node and return the raw response stream.
  postStream(target, pathname, bodyStream) {
    const url = new URL(pathname, `${target.url}/`);
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/x-shmakk-bundle' },
      body: Readable.toWeb(bodyStream),
      // @ts-ignore — required by undici for streamed request bodies
      duplex: 'half',
    });
  }

  getStream(target, pathname) {
    const url = new URL(pathname, `${target.url}/`);
    return fetch(url, { method: 'GET', headers: { authorization: `Bearer ${target.token}` } });
  }

  // ── cloud WebSocket relay (client side) ──────────────────────────────────

  startCloudRelay() {
    const cfg = this.cloudConfig();
    if (!cfg || this.cloudWs) return;
    this._connectCloud(cfg);
  }

  // Re-connect after the cloud configuration changed (saved/disabled/changed).
  reconnectCloud() {
    const old = this.cloudWs;
    this.cloudWs = null; // detach first so the old socket's close handler bails
    if (old) { try { old.close(); } catch {} }
    this.cloudRetry = 0;
    const cfg = this.cloudConfig();
    if (cfg) this._connectCloud(cfg);
  }

  _connectCloud(cfg) {
    const proto = new URL(cfg.url).protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${new URL(cfg.url).host}/ws`;
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${cfg.token}` } });
    this.cloudWs = ws;

    ws.on('open', () => {
      this.cloudRetry = 0;
      this.ctx.broadcast({ t: 'nodes.changed' });
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || !msg.t || msg.t === 'hello') return;
      // The cloud also broadcasts this desktop's own remote sessions (a `conv`
      // with remote:true, and `conv.deleted` when they are unregistered). Those
      // already live locally, so don't echo them back as if they were cloud
      // sessions; doing so would mislabel them in the sidebar.
      if (msg.t === 'conv' && msg.conv && msg.conv.remote) return;
      if (msg.t === 'conv.deleted' && this.exposedIds.has(msg.id)) return;
      this.ctx.broadcast({ ...msg, node: 'cloud' });
    });
    ws.on('close', () => {
      if (this.cloudWs !== ws) return;
      this.cloudWs = null;
      this.ctx.broadcast({ t: 'nodes.changed' });
      const delay = Math.min(15000, 1000 * 2 ** this.cloudRetry++);
      setTimeout(() => { if (this.cloudConfig()) this._connectCloud(this.cloudConfig()); }, delay);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  sendCloud(msg) {
    if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
      try {
        // Strip the node routing tag before forwarding so the cloud runs the
        // message locally instead of re-forwarding it to another node.
        const { node: _node, ...rest } = msg;
        this.cloudWs.send(JSON.stringify(rest));
        return true;
      } catch { return false; }
    }
    return false;
  }

  // Route an outgoing client WS message. Returns true when handled by a remote
  // node (cloud or a remote session); false means it is a local conversation.
  routeMsg(msg) {
    if (msg.node === 'cloud' && (msg.t === 'chat.send' || msg.t === 'chat.stop' || msg.t === 'chat.answer')) {
      return this.sendCloud(msg);
    }
    if ((msg.t === 'chat.send' || msg.t === 'chat.stop' || msg.t === 'chat.answer') && this.registry.has(msg.convId)) {
      return this._sendToRemote(msg);
    }
    return false;
  }

  // ── remote session registry (host side) ──────────────────────────────────

  registerRemote(sessionId, entry) {
    const rec = { ...entry, registeredAt: Date.now() };
    this.registry.set(sessionId, rec);
    saveRegistry(this.registry);
    // `remote: true` must win over the meta's own `remote: false`, otherwise
    // the client treats this as a plain local conversation and 404s on open.
    this.ctx.broadcast({ t: 'conv', conv: { ...(entry.meta || {}), id: sessionId, remote: true } });
    // Connect to the desktop's WebSocket now so live transcript updates flow
    // as soon as the session is exposed, not only after this node sends a
    // message (the client is otherwise created lazily in _sendToRemote).
    this._ensureRemoteClient(rec);
  }

  unregisterRemote(sessionId) {
    this.registry.delete(sessionId);
    saveRegistry(this.registry);
    this.ctx.broadcast({ t: 'conv.deleted', id: sessionId });
  }

  remoteFor(sessionId) { return this.registry.get(sessionId) || null; }

  remoteMetaList() {
    return Array.from(this.registry.entries()).map(([id, e]) => ({ ...(e.meta || {}), id, remote: true }));
  }

  _sendToRemote(msg) {
    const entry = this.registry.get(msg.convId);
    if (!entry) return false;
    const client = this._ensureRemoteClient(entry);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
    }
    return false;
  }

  _ensureRemoteClient(entry) {
    const key = entry.endpoint;
    let client = this.remoteClients.get(key);
    if (client && client.ws.readyState === WebSocket.OPEN) return client;
    if (client) return client;
    client = { ws: null, token: entry.token, retry: 0 };
    this.remoteClients.set(key, client);
    this._connectRemote(key, entry.token, client);
    return client;
  }

  _connectRemote(endpoint, token, client) {
    const proto = endpoint.startsWith('https') ? 'wss' : 'ws';
    const host = endpoint.replace(/^https?:\/\//, '');
    const ws = new WebSocket(`${proto}://${host}/ws`, { headers: { authorization: `Bearer ${token}` } });
    client.ws = ws;
    ws.on('open', () => { client.retry = 0; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || !msg.t || msg.t === 'hello') return;
      // Messages tagged `node: 'cloud'` are this node's own broadcasts echoed
      // back through the desktop's cloud relay; re-broadcasting them would
      // loop forever between the two relays.
      if (msg.node === 'cloud') return;
      // The desktop's /ws broadcasts every local conversation, not just the
      // ones exposed here. Relay only conversation messages for registered
      // remote sessions, and re-tag their meta as remote (the desktop reports
      // remote:false because the session runs locally there; if it leaked
      // through as-is the client would route it to the local store and 404).
      const id = (msg.conv && msg.conv.id) || msg.convId || msg.id;
      if (!id || !this.registry.has(id)) return;
      if (msg.t === 'conv' && msg.conv) msg = { ...msg, conv: { ...msg.conv, remote: true } };
      if (msg.t === 'conv.deleted') { this.registry.delete(id); saveRegistry(this.registry); }
      this.ctx.broadcast(msg);
    });
    ws.on('close', () => {
      if (this.remoteClients.get(endpoint) !== client) return;
      const delay = Math.min(15000, 1000 * 2 ** client.retry++);
      setTimeout(() => { if (this.remoteClients.get(endpoint) === client) this._connectRemote(endpoint, token, client); }, delay);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  // ── SSH reverse tunnel (client side: expose local sessions) ───────────────

  _tunnelTarget() {
    const cfg = this.cloudConfig();
    if (!cfg || !cfg.sshHost) return null;
    const hostCfg = loadHostConfig(null);
    const entry = resolveHost(hostCfg, cfg.sshHost) || (cfg.sshHost.includes('@') ? { host: cfg.sshHost, port: 22 } : null);
    return entry;
  }

  tunnelStatus() {
    return { up: !!this.tunnelProc, exposed: Array.from(this.tunnelExposed) };
  }

  async expose(sessionId, meta) {
    this.tunnelExposed.add(sessionId);
    this.exposedIds.add(sessionId);
    await this._ensureTunnel();
    if (!this.tunnelProc) {
      this.tunnelExposed.delete(sessionId);
      return { ok: false, error: 'reverse tunnel not configured (set SSH host and remote port in Cloud settings)' };
    }
    const cfg = this.cloudConfig();
    if (!cfg) {
      this.tunnelExposed.delete(sessionId);
      return { ok: false, error: 'cloud not configured' };
    }
    // Register with the cloud node over HTTPS.
    const res = await this.proxy({ url: cfg.url, token: cfg.token }, 'POST', '/api/remote/register', {
      body: { sessionId, nodeId: this.nodeId(), token: this.ctx.getToken(), remotePort: cfg.remotePort, meta },
    });
    const parsed = res.status < 300 ? JSON.parse(res.body.toString('utf8')) : null;
    return parsed || { ok: false, error: `register failed (${res.status})` };
  }

  async unexpose(sessionId) {
    this.tunnelExposed.delete(sessionId);
    const cfg = this.cloudConfig();
    if (cfg) {
      await this.proxy({ url: cfg.url, token: cfg.token }, 'POST', '/api/remote/unregister', { body: { sessionId } }).catch(() => {});
    }
    if (this.tunnelExposed.size === 0) this._stopTunnel();
  }

  async _ensureTunnel() {
    if (this.tunnelProc) return;
    const entry = this._tunnelTarget();
    const cfg = this.cloudConfig();
    if (!entry || !cfg || !cfg.remotePort) return;
    const bind = cfg.remoteBind || '0.0.0.0';
    const args = [
      ...(entry.port && entry.port !== 22 ? ['-p', String(entry.port)] : []),
      '-N', '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `${bind}:${cfg.remotePort}:127.0.0.1:${this.ctx.getPort()}`,
      entry.host,
    ];
    const proc = spawn('ssh', args, { stdio: 'ignore' });
    this.tunnelProc = proc;
    this.ctx.log(`reverse tunnel up: ${entry.host}:${cfg.remotePort} → 127.0.0.1:${this.ctx.getPort()}`);
    this.ctx.broadcast({ t: 'nodes.changed' });
    proc.on('exit', () => {
      if (this.tunnelProc !== proc) return;
      this.tunnelProc = null;
      this.ctx.log('reverse tunnel down');
      this.ctx.broadcast({ t: 'nodes.changed' });
      if (this.tunnelExposed.size) setTimeout(() => this._ensureTunnel().catch(() => {}), 3000);
    });
    proc.on('error', () => { this.tunnelProc = null; this.ctx.broadcast({ t: 'nodes.changed' }); });
  }

  _stopTunnel() {
    if (this.tunnelProc) { try { this.tunnelProc.kill(); } catch {} this.tunnelProc = null; }
  }

  shutdown() {
    this._stopTunnel();
    if (this.cloudWs) { try { this.cloudWs.close(); } catch {} this.cloudWs = null; }
    for (const c of this.remoteClients.values()) { try { c.ws && c.ws.close(); } catch {} }
  }
}

module.exports = { NodeHub, ensureNodeId };
