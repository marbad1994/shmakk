const { makeClient, modelFor, isConfigured } = require('./llm');

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function pickCandidates(input, glossary, k = 8) {
  if (!glossary) return [];
  const head = (input.trim().split(/\s+/)[0] || '').toLowerCase();
  if (!head) return [];
  const names = Object.keys(glossary.commands);
  const scored = names.map((n) => [n, levenshtein(head, n.toLowerCase())]);
  scored.sort((a, b) => a[1] - b[1]);
  return scored.slice(0, k).map(([n]) => n);
}

// Decide between "typo of a shell command" and "natural language".
// Read the WHOLE input, not just the first word. Default to null when
// uncertain — the user prefers being routed to the task agent over a
// wrong "correction" of an English sentence.
const SYSTEM = `Classify a failed shell input. Reply with ONE JSON object, nothing else.
Schema: {"fix": "<corrected command>" or null, "safe": true|false}

Return null when ANY of these are true:
- the input has more than 5 whitespace-separated tokens
- the input contains "?", or pronouns/articles ("I", "you", "me", "my", "the", "this", "that", "these", "those")
- the input reads like a question, request, or sentence ("can you...", "why does...", "fix the...", "look at...")
- you are not highly confident a small edit yields a real shell command

Return a fix only when the input is a short shell command with a clear typo
(misspelled executable, subcommand, flag, or argument).

safe=false for: sudo/su/doas, rm -r/-f, chmod -R, chown -R, mkfs, dd, |sh, |bash,
global package install (-g/--global, pip install, cargo install, brew install,
apt install, pacman -S), setxkbmap, gsettings set, xrandr, chsh.
otherwise safe=true.`;

const FEW_SHOT = [
  { role: 'user', content: 'input: nom itnsall\ncandidates: npm, nvim, node' },
  { role: 'assistant', content: '{"fix":"npm install","safe":true}' },
  { role: 'user', content: 'input: gti statsu\ncandidates: git, gtk, ghci' },
  { role: 'assistant', content: '{"fix":"git status","safe":true}' },
  { role: 'user', content: 'input: docker ps --formt json\ncandidates: docker' },
  { role: 'assistant', content: '{"fix":"docker ps --format json","safe":true}' },
  { role: 'user', content: 'input: rm rf node_modules\ncandidates: rm, rmdir' },
  { role: 'assistant', content: '{"fix":"rm -rf node_modules","safe":false}' },
  // Natural-language cases — must return null:
  { role: 'user', content: 'input: can you look through these files and tell me what to do\ncandidates: cat, can, case' },
  { role: 'assistant', content: '{"fix":null}' },
  { role: 'user', content: 'input: why does my app not run on linux\ncandidates: who, while, which' },
  { role: 'assistant', content: '{"fix":null}' },
  { role: 'user', content: 'input: fix the import error in main.dart\ncandidates: file, find, fc' },
  { role: 'assistant', content: '{"fix":null}' },
  { role: 'user', content: 'input: how do I install fish\ncandidates: how, host, hexdump' },
  { role: 'assistant', content: '{"fix":null}' },
];

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Local pre-filter: catch obvious natural language before paying for an LLM
// call. If this returns true, we bypass the correction model entirely and
// route to the task agent.
const NL_WORDS = new RegExp(
  '\\b(' +
  'I|me|my|you|your|the|this|that|these|those|a|an|is|are|was|were|do|does|did|' +
  'can|could|would|should|please|why|what|how|where|when|who|which|' +
  'fix|tell|show|explain|help|find|look|check|run|make|build|install|create|update|' +
  'add|remove|delete|change|setup|set\\s+up|debug' +
  ')\\b',
  'i'
);

function looksLikeNaturalLanguage(input) {
  if (!input) return false;
  const trimmed = input.trim();
  if (trimmed.includes('?')) return true;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 5) return true;
  if (tokens.length > 2 && NL_WORDS.test(trimmed)) return true;
  return false;
}

async function correct({ input, glossary, signal }) {
  if (!isConfigured('correction')) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'LLM not configured' };
  }
  // Free, local, instant: skip correction for clearly-natural-language input.
  if (looksLikeNaturalLanguage(input)) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'looks like natural language' };
  }
  const candidates = pickCandidates(input, glossary).slice(0, 6);
  // Compact payload — no stderr, no cwd, no snippets. The candidates plus
  // the few-shot are enough for typo fixing.
  const userMsg = `input: ${input}\ncandidates: ${candidates.join(', ') || '(none)'}`;

  const client = makeClient('correction');
  const resp = await client.chat.completions.create({
    model: modelFor('correction'),
    temperature: 0,
    max_tokens: 60,
    messages: [
      { role: 'system', content: SYSTEM },
      ...FEW_SHOT,
      { role: 'user', content: userMsg },
    ],
  }, { signal });
  const txt = resp.choices?.[0]?.message?.content || '';
  const parsed = extractJson(txt) || {};

  if (parsed.fix == null) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: '' };
  }
  return {
    category: 'command_correction',
    proposed: String(parsed.fix),
    safety: parsed.safe === false ? 'unsafe' : 'safe',
    reason: '',
  };
}

module.exports = { correct, looksLikeNaturalLanguage };
