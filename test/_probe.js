// scratch probe: does the web server actually hit the mock and send effort?
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const freePort = () => new Promise((res, rej) => {
  const s = require('net').createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => { try { fs.writeSync(2, `${m}\n`); } catch {} };

(async () => {
  const procs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shmakk-probe-'));
  const MOCK = await freePort();
  const PORT = await freePort();
  say(`mock=${MOCK} web=${PORT} tmp=${tmp}`);

  let mockLog = '';
  const mock = spawn('node', ['test/mock-llm.js', String(MOCK)], { stdio: ['ignore', 'pipe', 'pipe'] });
  mock.stdout.on('data', (c) => { mockLog += c; });
  mock.stderr.on('data', (c) => { mockLog += c; });
  procs.push(mock);
  await sleep(700);

  let webLog = '';
  const web = spawn('node', ['bin/shmakk.js', '--web', '--port', String(PORT), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SHMAKK_BASE_URL: `http://127.0.0.1:${MOCK}/v1`,
      SHMAKK_API_KEY: 'x',
      SHMAKK_MODEL: 'mock',
      SHMAKK_WEB_TOKEN: 'probe-token',
      XDG_STATE_HOME: path.join(tmp, 'state'),
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
    },
  });
  web.stdout.on('data', (c) => { webLog += c; });
  web.stderr.on('data', (c) => { webLog += c; });
  procs.push(web);

  const base = `http://127.0.0.1:${PORT}`;
  const call = async (p, opts = {}) => {
    const r = await fetch(base + p + (p.includes('?') ? '&' : '?') + `token=probe-token`, {
      ...opts,
      headers: { 'content-type': 'application/json', authorization: 'Bearer probe-token', ...(opts.headers || {}) },
    });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
  };

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/api/status?token=probe-token`); if (r.ok) break; } catch {}
    await sleep(250);
  }

  const settings = await call('/api/settings');
  say(`settings: ${JSON.stringify(settings.body).slice(0, 300)}`);

  for (const mode of ['code', 'chat']) {
    const conv = await call('/api/conversations', { method: 'POST', body: JSON.stringify({ mode }) });
    say(`conv(${mode}): status=${conv.status} body=${JSON.stringify(conv.body).slice(0, 400)}`);
    const id = conv.body && conv.body.id;
    const sent = await call(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: `probe ${mode}`, mode, effort: 'high' }) });
    say(`send(${mode}): ${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);
    await sleep(2500);
    const cap = await fetch(`http://127.0.0.1:${MOCK}/captured`).then((r) => r.json());
    say(`captured(${mode}): n=${cap.length} effort=${JSON.stringify(cap.map((p) => p.reasoning_effort))}`);
    say(`sys0(${mode}): ${JSON.stringify(String(((cap[0] || {}).messages || []).find((m) => m.role === 'system') || {}).slice(0, 200))}`);
  }

  const dup = fs.readdirSync(path.join(tmp, 'state', 'shmakk', 'web', 'conversations'), { withFileTypes: true }).length;
  say(`state convs in tmp: ${dup}`);
  say(`mock log: ${mockLog.replace(/\n/g, ' | ').slice(0, 400)}`);

  procs.forEach((p) => { try { p.kill(); } catch {} });
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})();
