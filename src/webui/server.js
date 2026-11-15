// shmakk web UI server.
//
//   shmakk --web                    → http://127.0.0.1:4317 (opens the browser)
//   shmakk --web --port 0           → random free port
//   shmakk --desktop                → same server inside the Electron shell
//
// The server can read files and run commands, so it is locked down:
//   • binds to loopback unless --host says otherwise
//   • every request needs the per-launch token (cookie or Bearer)
//   • cross-origin requests and WebSocket upgrades are rejected

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const store = require('./store');
const { ChatManager } = require('./chat');
const { TerminalHub } = require('./terminal');
const { createApi, HttpError, publicSettings } = require('./api');
const { createMCPManager } = require('../mcp-client');
const { createProjects } = require('./projects');
const { createAutomations } = require('./automations');
const design = require('./design');
const endpoints = require('../endpoints');
const sessionSearch = require('../session-search');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'shmakk_token';
const DEFAULT_PORT = 4317;

const PUBLIC_FILES = new Set(['/favicon.svg', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);

const MIME = {
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>shmakk — sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f0e;color:#e7ebe8;font:15px/1.5 system-ui,sans-serif}
form{width:min(380px,calc(100vw - 48px));display:grid;gap:14px}h1{font-size:20px;margin:0;font-weight:600}p{margin:0;color:#9aa39d}
input{font:14px ui-monospace,monospace;padding:11px 12px;border-radius:10px;border:1px solid #2b312d;background:#151917;color:inherit;outline:none}
input:focus{border-color:#4af073}button{font:inherit;font-weight:600;padding:10px;border:0;border-radius:10px;background:#4af073;color:#06210f;cursor:pointer}
</style></head><body><form method="get" action="/"><h1>shmakk</h1><p>This session is protected. Paste the access token printed in the terminal where you ran <code>shmakk --web</code>.</p>
<input name="token" placeholder="access token" autofocus autocomplete="off"><button>Open shmakk</button></form></body></html>`;

const NOT_BUILT_PAGE = `<!doctype html><meta charset="utf-8"><title>shmakk</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f0e;color:#e7ebe8;font:15px/1.6 system-ui,sans-serif">
<div style="max-width:520px;padding:24px"><h1 style="font-size:20px">The web interface hasn't been built yet</h1>
<p style="color:#9aa39d">You're running shmakk from a source checkout. Build the front-end once, then reload:</p>
<pre style="background:#151917;border:1px solid #2b312d;border-radius:10px;padding:12px 14px">npm run build:web</pre></div></body>`;

// opts: { port, host, workspace, open, token, quiet, review, yesFiles,
//         noCorrection, noAi, debug, profile }
async function startWebServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  // SHMAKK_WEB_TOKEN pins the token (handy for the Vite dev proxy); otherwise
  // a fresh one is minted for every launch.
  // The token is minted once and kept (owner-only file), so a phone that has
  // signed in — or added shmakk to its home screen — stays signed in across
  // restarts. `--new-token` rotates it.
  const saved = store.loadSettings();
  let token = opts.token || process.env.SHMAKK_WEB_TOKEN || (!opts.newToken && saved.token) || crypto.randomBytes(24).toString('base64url');
  if (!opts.token && !process.env.SHMAKK_WEB_TOKEN && saved.token !== token) store.saveSettings({ ...saved, token });
  const version = require('../../package.json').version;
  const built = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  const log = opts.quiet ? () => {} : (s) => process.stderr.write(`${s}\n`);

  // ── state ──
  const settings = store.loadSettings();
  settings.token = token;
  // CLI flags given at launch win over what the UI saved last time.
  for (const k of ['review', 'yesFiles', 'noCorrection', 'noAi', 'debug']) if (opts[k]) settings[k] = true;
  if (opts.profile) settings.profile = opts.profile;

  let workspace = path.resolve(opts.workspace || process.cwd());
  try { fs.mkdirSync(workspace, { recursive: true }); } catch {}
  const homeWorkspace = workspace;
  try { process.chdir(workspace); } catch {}

  const clients = new Set();
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) { try { ws.send(data); } catch {} }
  };

  const app = {
    version,
    settings,
    saveSettings: () => { store.saveSettings(settings); broadcast({ t: 'settings', settings: publicSettings(settings) }); },
    getWorkspace: () => workspace,
    homeWorkspace,
    // "hosted" = reachable beyond this machine (Docker / --host): the UI
    // then offers sign-out and hides things that only make sense locally.
    hosted: host !== '127.0.0.1' && host !== 'localhost' && host !== '::1',
    broadcast,
    mcp: createMCPManager(),
    getMcp: () => app.mcp,
  };

  // Provider: env wins; otherwise fall back to what was saved from the UI.
  app.applyProvider = (p, { persist = false } = {}) => {
    const set = (envKey, v) => {
      if (v === undefined) return;
      if (v === null || v === '') delete process.env[envKey];
      else process.env[envKey] = String(v);
    };
    if (p.baseUrl !== undefined || p.apiKey !== undefined) endpoints.clearEndpoint();
    set('SHMAKK_BASE_URL', p.baseUrl);
    set('SHMAKK_MODEL', p.model);
    set('SHMAKK_HEADERS', p.headers);
    set('SHMAKK_MODELS', p.modelList !== undefined ? p.modelList : p.registry);
    if (p.apiKey !== undefined) set('SHMAKK_API_KEY', p.apiKey);
    if (persist) {
      settings.provider = {
        baseUrl: process.env.SHMAKK_BASE_URL || '',
        model: process.env.SHMAKK_MODEL || '',
        headers: process.env.SHMAKK_HEADERS || '',
        modelList: process.env.SHMAKK_MODELS || '',
        apiKey: process.env.SHMAKK_API_KEY || '',
      };
      store.saveSettings(settings);
    }
    app.broadcastProvider();
  };
  app.broadcastProvider = () => { if (app.providerInfo) broadcast({ t: 'provider', provider: app.providerInfo() }); };

  if (settings.provider && !process.env.SHMAKK_BASE_URL && !endpoints.getCurrentEndpointName()) {
    const p = settings.provider;
    if (p.baseUrl) process.env.SHMAKK_BASE_URL = p.baseUrl;
    if (p.apiKey && !process.env.SHMAKK_API_KEY) process.env.SHMAKK_API_KEY = p.apiKey;
    if (p.model && !process.env.SHMAKK_MODEL) process.env.SHMAKK_MODEL = p.model;
    if (p.headers && !process.env.SHMAKK_HEADERS) process.env.SHMAKK_HEADERS = p.headers;
    const savedModels = p.modelList ?? p.registry;
    if (savedModels && !process.env.SHMAKK_MODELS) process.env.SHMAKK_MODELS = savedModels;
  }

  app.projects = createProjects();
  app.artifactSecret = token;
  app.chat = new ChatManager({
    projects: app.projects,
    get automations() { return app.automations; },
    settings,
    saveSettings: app.saveSettings,
    broadcast,
    get mcpManager() { return app.mcp; },
    getWorkspace: () => workspace,
    onProviderChanged: () => app.broadcastProvider(),
  });

  app.automations = createAutomations({ chat: app.chat, projects: app.projects, broadcast, getWorkspace: () => workspace });

  app.restartMcp = async () => {
    try { await app.mcp.shutdown(); } catch {}
    app.mcp = createMCPManager();
    const n = app.mcp.loadConfig(workspace);
    const results = n > 0 ? await app.mcp.startAll(() => {}).catch(() => []) : [];
    broadcast({ t: 'status.changed' });
    return results;
  };

  app.setWorkspace = (dir) => {
    workspace = path.resolve(dir);
    try { process.chdir(workspace); } catch {}
    settings.recentWorkspaces = [workspace, ...(settings.recentWorkspaces || []).filter((w) => w !== workspace)].slice(0, 8);
    store.saveSettings(settings);
    broadcast({ t: 'workspace', workspace });
    app.restartMcp().catch(() => {});
  };
  settings.recentWorkspaces = [workspace, ...(settings.recentWorkspaces || []).filter((w) => w !== workspace)].slice(0, 8);

  const terminals = new TerminalHub();
  const api = createApi(app);

  // ── auth helpers ──
  const isAuthed = (req) => {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return true;
    return safeEqual(parseCookies(req.headers.cookie)[COOKIE], token);
  };
  // Same-origin check: browsers always send Origin on WebSocket upgrades and
  // on cross-origin / non-GET requests.
  // SHMAKK_PUBLIC_URL lists the address(es) the app is served from when it
  // sits behind a reverse proxy that rewrites Host.
  const publicHosts = new Set(String(process.env.SHMAKK_PUBLIC_URL || '').split(',').map((u) => { try { return new URL(u.trim()).host; } catch { return ''; } }).filter(Boolean));
  const trustProxy = /^(1|true|yes)$/i.test(process.env.SHMAKK_TRUST_PROXY || '');
  const originOk = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const h = new URL(origin).host;
      return h === req.headers.host || publicHosts.has(h) || (trustProxy && h === req.headers['x-forwarded-host']);
    } catch { return false; }
  };
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const isHttps = (req) => !!req.socket.encrypted || (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

  // Brute-force guard for the token: 8 wrong guesses per address per 10 minutes.
  const failures = new Map(); // ip → { n, resetAt }
  const blocked = (ip) => { const f = failures.get(ip); return !!f && f.resetAt > Date.now() && f.n >= 8; };
  const noteFailure = (ip) => {
    const now = Date.now();
    const f = failures.get(ip);
    if (!f || f.resetAt <= now) failures.set(ip, { n: 1, resetAt: now + 10 * 60e3 });
    else f.n += 1;
    if (failures.size > 5000) for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  };

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end(buf);
  };

  const serveFile = (res, file) => {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': data.length,
        // Vite fingerprints everything under /assets, so it can be cached hard.
        'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
      });
      res.end(data);
    });
  };

  // Optional built-in TLS (otherwise terminate TLS at your reverse proxy).
  const tls = process.env.SHMAKK_TLS_CERT && process.env.SHMAKK_TLS_KEY
    ? { cert: fs.readFileSync(process.env.SHMAKK_TLS_CERT), key: fs.readFileSync(process.env.SHMAKK_TLS_KEY) }
    : null;
  const handler = async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'bad request'); }
    const pathname = decodeURIComponent(url.pathname);

    // Liveness probe for Docker / load balancers — reveals nothing.
    if (pathname === '/healthz') return send(res, 200, { ok: true });

    const ip = clientIp(req);

    // Design previews: signed URL instead of the cookie, served into a sandboxed
    // (opaque-origin) frame so generated pages can't reach the app.
    if (pathname.startsWith('/artifact/')) {
      const [, , convId, sig, ...rest] = pathname.split('/');
      const hit = design.resolveArtifact(app.artifactSecret, convId, sig, rest.join('/'));
      if (!hit || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, 'not found');
      return fs.readFile(hit.file, (err, data) => {
        if (err) return send(res, 404, 'not found');
        res.writeHead(200, { 'content-type': hit.type, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': design.ARTIFACT_CSP, 'referrer-policy': 'no-referrer' });
        res.end(data);
      });
    }

    // Automation webhooks: POST /hooks/<id>/<secret> — the secret is the credential.
    if (pathname.startsWith('/hooks/')) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      if (blocked(ip)) return send(res, 429, { error: 'too many attempts' });
      const [, , id, secret] = pathname.split('/');
      let payload = '';
      try { payload = (await readBody(req, 256 * 1024)).toString('utf8'); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
      const r = await app.automations.trigger(id, secret, payload).catch((e) => ({ status: 500, error: e.message }));
      if (r.status === 404) noteFailure(ip);
      return send(res, r.status, r.status === 202 ? { ok: true, runId: r.runId } : { error: r.error || 'not found' });
    }
    // Token hand-off: /?token=… → cookie → clean URL.
    if (url.searchParams.has('token')) {
      if (blocked(ip)) return send(res, 429, 'Too many attempts. Try again in a few minutes.', { 'retry-after': '600' });
      if (!safeEqual(url.searchParams.get('token'), token)) {
        noteFailure(ip);
        return send(res, 401, LOGIN_PAGE, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
      }
      res.writeHead(302, {
        'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 90}${isHttps(req) ? '; Secure' : ''}`,
        location: pathname || '/',
        'cache-control': 'no-store',
      });
      return res.end();
    }

    // Icons and the app manifest are fetched without credentials by browsers.
    if (pathname === '/favicon.ico') return serveFile(res, path.join(PUBLIC_DIR, 'favicon.svg'));
    if (PUBLIC_FILES.has(pathname)) return serveFile(res, path.join(PUBLIC_DIR, pathname));

    if (pathname === '/logout') {
      res.writeHead(302, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, location: '/', 'cache-control': 'no-store' });
      return res.end();
    }

    if (!isAuthed(req)) {
      if (req.headers.authorization) { if (blocked(ip)) return send(res, 429, { error: 'too many attempts' }); noteFailure(ip); }
      if (pathname.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
      return send(res, 401, LOGIN_PAGE, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    }

    // ── API ──
    if (pathname.startsWith('/api/')) {
      if (!originOk(req)) return send(res, 403, { error: 'cross-origin request refused' });
      try {
        let body = {};
        let raw = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const isJson = String(req.headers['content-type'] || '').includes('application/json');
          raw = await readBody(req, isJson ? 8 * 1024 * 1024 : 40 * 1024 * 1024);
          if (isJson && raw.length) {
            try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON body'); }
          }
        }
        const query = Object.fromEntries(url.searchParams.entries());
        const out = await api.handle(req.method, pathname, { body: body || {}, raw, query });
        if (!out.found) return send(res, 404, { error: 'not found' });
        if (out.result && out.result.__binary) return send(res, 200, out.result.__binary, { 'content-type': out.result.contentType });
        return send(res, 200, out.result ?? { ok: true });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500 && settings.debug) log(`[shmakk web] ${e.stack || e}`);
        return send(res, status, { error: String(e.message || e) });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

    // ── static ──
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
    // SPA fallback for extension-less paths
    if (!path.extname(rel)) {
      if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
        return send(res, 503, NOT_BUILT_PAGE, { 'content-type': 'text/html; charset=utf-8' });
      }
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    return send(res, 404, 'not found');
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

  // ── WebSocket: live transcript updates + terminals ──
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
    if (pathname !== '/ws' || !isAuthed(req) || !originOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const reply = (msg) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch {} } };
    reply({ t: 'hello', version, workspace });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      try {
        switch (msg.t) {
          case 'chat.send': {
            const r = await app.chat.send(msg.convId, msg.text, { mode: msg.mode, attachments: msg.attachments });
            if (!r.ok) reply({ t: 'toast', level: 'error', text: r.error });
            break;
          }
          case 'chat.stop': app.chat.stop(msg.convId); break;
          case 'chat.answer': app.chat.answer(msg.convId, msg.askId, msg.value); break;
          case 'term.open':
            terminals.open({
              id: String(msg.id), kind: msg.kind === 'shell' ? 'shell' : 'shmakk',
              cols: msg.cols, rows: msg.rows, cwd: workspace, settings, owner: ws,
              onData: (d) => reply({ t: 'term.data', id: msg.id, data: d }),
              onExit: (code) => reply({ t: 'term.exit', id: msg.id, code }),
            });
            break;
          case 'term.input': terminals.input(String(msg.id), String(msg.data || '')); break;
          case 'term.resize': terminals.resize(String(msg.id), msg.cols, msg.rows); break;
          case 'term.close': terminals.close(String(msg.id)); break;
          case 'ping': reply({ t: 'pong' }); break;
          default:
        }
      } catch (e) {
        reply({ t: 'toast', level: 'error', text: String(e.message || e) });
        if (msg && msg.t === 'term.open') reply({ t: 'term.exit', id: msg.id, code: -1, error: String(e.message || e) });
      }
    });
    ws.on('close', () => { clients.delete(ws); terminals.closeOwnedBy(ws); });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);
  heartbeat.unref();

  // ── listen ──
  const wantPort = opts.port === 0 || opts.port ? Number(opts.port) : DEFAULT_PORT;
  const listen = (port) => new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, host);
  });
  try {
    await listen(wantPort);
  } catch (e) {
    // Default port busy → pick any free one. An explicit --port fails loudly.
    if (e.code === 'EADDRINUSE' && (opts.port === undefined || opts.port === null)) await listen(0);
    else throw e;
  }
  const port = server.address().port;
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : (host.includes(':') ? `[${host}]` : host);
  const baseUrl = `${tls ? 'https' : 'http'}://${shownHost}:${port}`;
  const url = `${baseUrl}/?token=${token}`;

  // MCP servers + search index warm up in the background.
  const mcpCount = app.mcp.loadConfig(workspace);
  if (mcpCount > 0) app.mcp.startAll(() => {}).then(() => broadcast({ t: 'status.changed' })).catch(() => {});
  setImmediate(() => { try { sessionSearch.indexAuditLog(); } catch {} });
  app.automations.start();

  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((r) => { resolveClosed = r; });
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    app.automations.stop();
    try { app.chat.shutdown(); } catch {}
    terminals.closeAll();
    for (const ws of clients) { try { ws.close(1001); } catch {} }
    try { await app.mcp.shutdown(); } catch {}
    try { const { closeBrowser } = require('../browser'); await closeBrowser().catch(() => {}); } catch {}
    try { sessionSearch.closeDB(); } catch {}
    await new Promise((r) => { server.close(() => r()); setTimeout(r, 1000).unref(); });
    resolveClosed();
  }
  app.shutdown = () => { if (typeof opts.onShutdown === 'function') opts.onShutdown(); else close(); };

  if (!opts.quiet) {
    log('');
    log(`  \x1b[1m\x1b[32mshmakk web\x1b[0m  v${version}`);
    log(`  \x1b[2mworkspace\x1b[0m  ${workspace}`);
    log(`  \x1b[2mopen\x1b[0m       \x1b[36m${url}\x1b[0m`);
    for (const u of String(process.env.SHMAKK_PUBLIC_URL || '').split(',').map((x) => x.trim()).filter(Boolean)) log(`  \x1b[2mpublic\x1b[0m     \x1b[36m${u.replace(/\/$/, '')}/?token=${token}\x1b[0m`);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      // Addresses a phone on the same network can open.
      for (const addrs of Object.values(require('os').networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal && (host === '0.0.0.0' || host === a.address)) log(`  \x1b[2mphone\x1b[0m      \x1b[36mhttp://${a.address}:${port}/?token=${token}\x1b[0m`);
        }
      }
      log(`  \x1b[33mwarning\x1b[0m    listening on ${host} — anyone who can reach this port and has the token can run commands here.`);
    }
    if (!built) log('  \x1b[33mnote\x1b[0m       front-end not built — run `npm run build:web` first');
    log('  \x1b[2mCtrl+C to stop\x1b[0m');
    log('');
  }
  if (opts.open) openInBrowser(url);

  return { url, baseUrl, port, host, token, close, closed: closedPromise, app };
}

// CLI entry: run until Ctrl+C / SIGTERM / “Quit” from the UI.
async function runWebCli(opts) {
  let handle;
  try {
    handle = await startWebServer(opts);
  } catch (e) {
    process.stderr.write(`[shmakk] could not start web UI: ${e.message}\n`);
    return 1;
  }
  const stop = () => { handle.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await handle.closed;
  return 0;
}

module.exports = { startWebServer, runWebCli, DEFAULT_PORT };
