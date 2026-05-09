#!/usr/bin/env node
// Minimal OpenAI-compatible /v1/chat/completions server for end-to-end testing
// of aiterm without spending tokens. Pattern-matches a few canned cases from
// the spec (§16 acceptance tests) and returns appropriate JSON for the
// correction model, plain text for chat, and tool-free replies for tasks.
//
// Run:  node test/mock-llm.js [port]
//       (default port 8787)
//
// Then in another shell:
//   set -x AITERM_BASE_URL "http://127.0.0.1:8787/v1"
//   set -x AITERM_API_KEY "x"
//   set -x AITERM_MODEL "mock"
//   aiterm --review

const http = require('http');

const port = parseInt(process.argv[2] || '8787', 10);

// Canned correction outcomes. The real correction model receives a JSON
// object whose `input` field is the user's failed command. We match on that.
const CORRECTIONS = [
  { match: /^nom\s+itnsall\s*$/, out: { category: 'command_correction', proposed: 'npm install', confidence: 0.97, safety: 'safe', reason: 'command and subcommand misspelled' } },
  { match: /^gti\s+statsu\s*$/, out: { category: 'command_correction', proposed: 'git status', confidence: 0.97, safety: 'safe', reason: 'transposed letters' } },
  { match: /^pyhton\s+-m\s+vnev\s+\.venv\s*$/, out: { category: 'command_correction', proposed: 'python -m venv .venv', confidence: 0.95, safety: 'safe', reason: 'transposed letters in command and module' } },
  { match: /^docker\s+ps\s+--formt\s+json\s*$/, out: { category: 'command_correction', proposed: 'docker ps --format json', confidence: 0.96, safety: 'safe', reason: 'flag misspelled' } },
  { match: /^rm\s+rf\s+/, out: { category: 'command_correction', proposed: (cmd) => `rm -rf ${cmd.split(/\s+/).slice(2).join(' ')}`, confidence: 0.9, safety: 'unsafe', reason: 'destructive recursive removal' } },
  { match: /^curl\s+example\s+com\s+sh\s*$/, out: { category: 'command_correction', proposed: 'curl example.com | sh', confidence: 0.4, safety: 'uncertain', reason: 'pipe-to-shell from network is risky' } },
  { match: /\?$|^why\b|^what\b|^how\b|^can you\b/i, out: { category: 'not_a_correction', proposed: null, confidence: 0.9, safety: 'uncertain', reason: 'looks like a natural-language question' } },
];

function decideCorrection(input) {
  for (const c of CORRECTIONS) {
    if (c.match.test(input)) {
      const out = { ...c.out };
      if (typeof out.proposed === 'function') out.proposed = out.proposed(input);
      return out;
    }
  }
  return { category: 'not_a_correction', proposed: null, confidence: 0.2, safety: 'uncertain', reason: 'no match' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function classify(messages) {
  const sys = (messages.find((m) => m.role === 'system') || {}).content || '';
  if (/correct mistyped shell commands/i.test(sys)) return 'correction';
  if (/inside aiterm working in/i.test(sys)) return 'task';
  return 'chat';
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
  const messages = payload.messages || [];
  const role = classify(messages);

  if (role === 'correction') {
    let userInput = '';
    try {
      const userMsg = messages.find((m) => m.role === 'user');
      const parsed = JSON.parse(userMsg.content);
      userInput = (parsed.input || '').trim();
    } catch {}
    const decision = decideCorrection(userInput);
    process.stderr.write(`[mock] correction("${userInput}") → ${JSON.stringify(decision)}\n`);
    const reply = {
      id: 'mock-1', object: 'chat.completion', created: Date.now() / 1000 | 0,
      model: payload.model, choices: [{
        index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(decision) },
      }],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
    return;
  }

  if (role === 'chat') {
    const text = `[mock chat] I would answer your question here. Streaming line 1.\nLine 2.\nLine 3.`;
    process.stderr.write('[mock] chat reply\n');
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const chunk of text.split(/(\s+)/)) {
        const evt = { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunk } }] };
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', model: payload.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      }));
    }
    return;
  }

  // task
  process.stderr.write('[mock] task reply (no tool calls)\n');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock', object: 'chat.completion', model: payload.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '[mock task] no real tool calls in mock; would have edited files here.' } }],
  }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock LLM listening on http://127.0.0.1:${port}/v1`);
  console.log(`AITERM_BASE_URL=http://127.0.0.1:${port}/v1 AITERM_API_KEY=x AITERM_MODEL=mock aiterm --review`);
});
