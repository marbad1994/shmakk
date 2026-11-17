// Preview proxy for the built-in browser pane.
//
// The app frames whatever dev server the workspace runs. That cannot be done by
// pointing an <iframe> at http://localhost:5173 directly:
//   • the app's CSP only allows same-origin frames and fetches;
//   • when shmakk runs on a server (Docker, --host), "localhost" in the user's
//     browser is their own machine, not the one the dev server runs on;
//   • many servers send X-Frame-Options / frame-ancestors and refuse framing.
//
// So the pane loads the page through this proxy instead. It listens on its own
// port: the previewed app then has a real origin of its own, root-relative
// assets ("/src/main.tsx", "/@vite/client") resolve against it unchanged, and
// HMR websockets are piped through as-is. Being a different origin from the
// app also means the previewed page cannot read the app's DOM or storage.
//
// Access: the app hands the browser a signed, short-lived /__shmakk/go link.
// It sets a per-target cookie on the preview origin; every proxied request must
// carry it. The shmakk token cookie (cookies ignore ports, so it arrives here
// too) is stripped before anything is forwarded to the previewed app.
//
// HTML responses get one <script> injected: the code inspector used by
// "Edit in browser" (see preview-inspector.js). It is inert until the pane
// switches edit mode on.

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { INSPECTOR_SOURCE } = require('./preview-inspector');

const COOKIE = 'shmakk_pv';
const PREFIX = '/__shmakk/';
const LINK_TTL_MS = 10 * 60e3;
const MAX_HTML = 12 * 1024 * 1024;

// Hop-by-hop headers never travel through a proxy.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function b64u(s) { return Buffer.from(String(s), 'utf8').toString('base64url'); }
function unb64u(s) { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return ''; } }

function sign(secret, data) { return crypto.createHmac('sha256', String(secret)).update(String(data)).digest('base64url'); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Only plain http(s) URLs with a host can be previewed. Returns a URL or null. */
function parseTarget(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  u.hash = '';
  return u;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Cookie header for the upstream app: everything except shmakk's own cookies. */
function upstreamCookies(header) {
  return String(header || '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^shmakk_/i.test(p))
    .join('; ');
}

/**
 * Drop framing restrictions from a CSP while keeping the rest of the policy:
 * the page's own script/style rules still apply.
 */
function stripFrameAncestors(csp) {
  return String(csp || '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors\b/i.test(d))
    .join('; ');
}

/**
 * Rewrite a Set-Cookie from the upstream app so the browser stores it for the
 * preview origin: no Domain (it would name the upstream host), no Secure over
 * plain http, and never anything named like shmakk's own cookies.
 */
function rewriteSetCookie(value, { secure }) {
  const parts = String(value || '').split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const name = parts[0].split('=')[0].trim();
  if (/^shmakk_/i.test(name)) return null;
  const kept = parts.filter((p, i) => i === 0 || (!/^domain=/i.test(p) && (secure || !/^secure$/i.test(p))));
  if (!secure) {
    // SameSite=None requires Secure; without TLS fall back to Lax.
    for (let i = 1; i < kept.length; i++) if (/^samesite=none$/i.test(kept[i])) kept[i] = 'SameSite=Lax';
  }
  return kept.join('; ');
}

/** Inject the inspector loader as early as possible in an HTML document. */
function injectLoader(html) {
  const tag = `<script src="${PREFIX}inspector.js" data-shmakk-preview></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + html;
}

/** Turn an absolute redirect to the upstream origin into a preview-relative one. */
function rewriteLocation(loc, target) {
  if (!loc) return loc;
  try {
    const u = new URL(loc, target.origin);
    if (u.origin === target.origin) return u.pathname + u.search + u.hash;
  } catch {}
  return loc;
}

function createPreviewServer({ secret, host = '127.0.0.1', port = 0, tls = null, log = () => {} } = {}) {
  let server = null;
  let boundPort = null;

  const cookieValue = (target) => `${b64u(target.origin)}.${sign(secret, `pv:${target.origin}`)}`;
  const targetFromCookie = (req) => {
    const v = parseCookies(req.headers.cookie)[COOKIE];
    if (!v) return null;
    const [enc, sig] = String(v).split('.');
    const origin = unb64u(enc);
    if (!origin || !safeEqual(sig, sign(secret, `pv:${origin}`))) return null;
    return parseTarget(origin);
  };

  /** Signed hand-off path for a target URL, valid for LINK_TTL_MS. */
  function link(rawUrl) {
    const target = parseTarget(rawUrl);
    if (!target) return null;
    const exp = Date.now() + LINK_TTL_MS;
    const payload = `${target.href}|${exp}`;
    return `${PREFIX}go?to=${b64u(target.href)}&exp=${exp}&sig=${sign(secret, `go:${payload}`)}`;
  }

  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    const buf = Buffer.from(String(body));
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(buf);
  };

  const notReachable = (res, target, err) => send(res, 502, `<!doctype html><meta charset="utf-8"><title>Not reachable</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#222">
<div style="max-width:440px;padding:24px"><h1 style="font-size:17px;margin:0 0 6px">Nothing answered at ${escapeHtml(target.origin)}</h1>
<p style="margin:0;color:#555">The preview is fetched by the shmakk server, so the address must be reachable from the machine shmakk runs on. Start the dev server there, then reload.</p>
<p style="margin:10px 0 0;color:#888;font-size:12px">${escapeHtml(String((err && err.code) || (err && err.message) || ''))}</p></div></body>`, 'text/html; charset=utf-8');

  function upstreamHeaders(req, target) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k) || k === 'host' || k === 'cookie' || k === 'accept-encoding') continue;
      headers[k] = v;
    }
    headers.host = target.host;
    // Ask for plain bodies: HTML needs rewriting and dev servers are local.
    headers['accept-encoding'] = 'identity';
    const cookie = upstreamCookies(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    // The page believes it lives on the upstream origin; keep its CORS / host
    // checks (Vite's allowedHosts, Next's origin check) happy.
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) {
      try { const r = new URL(headers.referer); headers.referer = target.origin + r.pathname + r.search; } catch { delete headers.referer; }
    }
    return headers;
  }

  function proxy(req, res, target) {
    const mod = target.protocol === 'https:' ? https : http;
    const secure = !!tls || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
    const upstream = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, target),
      // Self-signed dev certificates are the norm for local https servers.
      rejectUnauthorized: false,
      timeout: 30000,
    }, (up) => {
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (HOP.has(k) || k === 'x-frame-options' || k === 'content-length' || k === 'set-cookie') continue;
        headers[k] = v;
      }
      if (up.headers['content-security-policy']) {
        const csp = stripFrameAncestors(up.headers['content-security-policy']);
        if (csp) headers['content-security-policy'] = csp; else delete headers['content-security-policy'];
      }
      if (up.headers.location) headers.location = rewriteLocation(up.headers.location, target);
      const cookies = [].concat(up.headers['set-cookie'] || []).map((c) => rewriteSetCookie(c, { secure })).filter(Boolean);
      if (cookies.length) headers['set-cookie'] = cookies;

      const type = String(up.headers['content-type'] || '');
      const encoded = up.headers['content-encoding'] && up.headers['content-encoding'] !== 'identity';
      if (/text\/html/i.test(type) && !encoded && req.method !== 'HEAD') {
        const chunks = [];
        let size = 0;
        up.on('data', (c) => { size += c.length; if (size <= MAX_HTML) chunks.push(c); });
        up.on('end', () => {
          const body = size > MAX_HTML ? Buffer.concat(chunks) : Buffer.from(injectLoader(Buffer.concat(chunks).toString('utf8')), 'utf8');
          headers['content-length'] = body.length;
          headers['cache-control'] = 'no-store';
          res.writeHead(up.statusCode || 200, headers);
          res.end(body);
        });
        up.on('error', () => { try { res.destroy(); } catch {} });
        return;
      }
      if (up.headers['content-length']) headers['content-length'] = up.headers['content-length'];
      res.writeHead(up.statusCode || 200, headers);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })));
    upstream.on('error', (e) => { if (!res.headersSent) notReachable(res, target, e); else try { res.destroy(); } catch {} });
    req.pipe(upstream);
  }

  async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://preview'); } catch { return send(res, 400, 'bad request'); }

    if (url.pathname === `${PREFIX}go`) {
      const href = unb64u(url.searchParams.get('to'));
      const exp = Number(url.searchParams.get('exp'));
      const sig = url.searchParams.get('sig');
      const target = parseTarget(href);
      if (!target || !Number.isFinite(exp) || exp < Date.now() || !safeEqual(sig, sign(secret, `go:${target.href}|${exp}`))) {
        return send(res, 403, 'This preview link has expired. Reload the browser pane.');
      }
      const secure = !!tls || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
      res.writeHead(302, {
        'set-cookie': `${COOKIE}=${cookieValue(target)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
        location: target.pathname + target.search,
        'cache-control': 'no-store',
      });
      return res.end();
    }

    if (url.pathname === `${PREFIX}inspector.js`) {
      const buf = Buffer.from(INSPECTOR_SOURCE, 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-cache' });
      return res.end(buf);
    }

    if (url.pathname === '/__shmakk/healthz') return send(res, 200, 'ok');

    const target = targetFromCookie(req);
    if (!target) return send(res, 401, 'Open this page from the shmakk browser pane.');
    return proxy(req, res, target);
  }

  function onUpgrade(req, socket, head) {
    const target = targetFromCookie(req);
    if (!target) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    const mod = target.protocol === 'https:' ? https : http;
    const headers = upstreamHeaders(req, target);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    delete headers['accept-encoding'];
    const up = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
      rejectUnauthorized: false,
    });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const end = () => { try { socket.destroy(); } catch {} try { upSocket.destroy(); } catch {} };
      upSocket.on('error', end);
      socket.on('error', end);
      upSocket.on('close', end);
      socket.on('close', end);
    });
    up.on('response', (r) => { socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nConnection: close\r\n\r\n`); socket.destroy(); });
    up.on('error', () => { try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); socket.destroy(); } catch {} });
    up.end();
  }

  async function start() {
    server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    server.on('upgrade', onUpgrade);
    server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
    const listen = (p) => new Promise((resolve, reject) => {
      const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
      const onOk = () => { server.removeListener('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, host);
    });
    try { await listen(port); } catch (e) {
      if (e.code !== 'EADDRINUSE' || port === 0) throw e;
      log(`[shmakk web] preview port ${port} busy, using a random one`);
      await listen(0);
    }
    boundPort = server.address().port;
    return boundPort;
  }

  async function close() {
    if (!server) return;
    await new Promise((r) => { server.close(() => r()); setTimeout(r, 500).unref(); });
  }

  return { start, close, link, get port() { return boundPort; } };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── discovery + probing (used by the API so the pane can offer real servers) ──

/**
 * Listening TCP ports on loopback / all interfaces, from /proc/net/tcp{,6}.
 * Linux only; returns [] elsewhere (callers fall back to probing known ports).
 */
function listeningPorts(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const ports = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = readFile(file); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = LISTEN
      const [addr, portHex] = String(cols[1]).split(':');
      const p = parseInt(portHex, 16);
      if (!Number.isFinite(p)) continue;
      // Loopback or any-address listeners are reachable at localhost.
      const any = /^0+$/.test(addr);
      const loop4 = addr === '0100007F';
      const loop6 = addr === '00000000000000000000000001000000';
      const mapped = /^0000000000000000FFFF00000100007F$/i.test(addr);
      if (any || loop4 || loop6 || mapped) ports.add(p);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** One quick request from the server's side. Resolves { ok, status, title, error }. */
function probe(rawUrl, timeoutMs = 2500) {
  const target = parseTarget(rawUrl);
  if (!target) return Promise.resolve({ ok: false, error: 'not an http(s) address' });
  const mod = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(target, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false, headers: { accept: 'text/html,*/*', 'accept-encoding': 'identity' } }, (res) => {
      const type = String(res.headers['content-type'] || '');
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 32768) body += c; else res.destroy(); });
      const done = () => {
        const m = /<title[^>]*>([^<]{0,160})<\/title>/i.exec(body);
        resolve({ ok: true, status: res.statusCode, html: /text\/html/i.test(type), title: m ? m[1].trim() : null });
      };
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

const COMMON_PORTS = [5173, 3000, 8080, 4200, 8000, 5000, 4321, 8888, 3001, 5174, 4173, 9000, 1234, 8081];

/**
 * Dev servers reachable from this machine: every loopback listener that
 * answers HTTP, minus shmakk's own ports. Falls back to well-known ports.
 */
async function discoverServers({ exclude = [] } = {}) {
  let ports = listeningPorts();
  if (!ports.length) ports = COMMON_PORTS;
  ports = ports.filter((p) => !exclude.includes(p) && p > 1023).slice(0, 40);
  const results = await Promise.all(ports.map(async (p) => {
    const url = `http://localhost:${p}/`;
    const r = await probe(url, 1200);
    return r.ok && r.html ? { port: p, url: `http://localhost:${p}`, title: r.title, status: r.status } : null;
  }));
  return results.filter(Boolean);
}

module.exports = {
  createPreviewServer,
  parseTarget,
  upstreamCookies,
  stripFrameAncestors,
  rewriteSetCookie,
  rewriteLocation,
  injectLoader,
  listeningPorts,
  probe,
  discoverServers,
};
