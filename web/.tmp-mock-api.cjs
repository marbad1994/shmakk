// Mock API for a one-off UI check of the per-session inspector.
const http = require('http');

const conv = (id, title) => ({ id, title, mode: 'code', updatedAt: 1750000000000, createdAt: 1740000000000, running: false, pinned: false, projectId: null, automationId: null });
const snapshot = (id) => ({ ...conv(id), items: [], workspace: '/tmp/ws', cwd: '/tmp/ws', running: false });

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  let body = {};
  if (p === '/api/bootstrap') {
    body = {
      version: '0.0.0-test', home: '/tmp', platform: 'linux', hosted: false, workspace: '/tmp/ws',
      settings: {}, provider: { name: 'test', models: ['test-model'], model: 'test-model' }, features: {}, profiles: [], status: { workspace: '/tmp/ws' },
      conversations: [conv('a1', 'Alpha'), conv('b1', 'Beta')], projects: [],
    };
  } else if (/^\/api\/conversations\/[^/]+$/.test(p)) body = snapshot(p.split('/').pop());
  else if (p === '/api/edits') body = { edits: [] };
  else if (p === '/api/status') body = { workspace: '/tmp/ws' };
  else if (p === '/api/projects') body = { projects: [] };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(5200, '127.0.0.1', () => console.log('mock api on 5200'));
