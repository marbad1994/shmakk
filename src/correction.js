// Deterministic command correction with frequency-weighted distance matching.
// No LLM, no API calls, sub-millisecond.
//
// Only fires when a shell command exits with non-zero.
// First token matched against glossary commands; subsequent tokens matched
// against the corrected command's subcommands. Ties broken by usage frequency
// from the user's shell history.

const { loadFreqMap } = require('./history-parser');

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

// Natural-language pre-filter. If the input reads like a sentence or question,
// skip correction entirely and route to the task agent.
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

// Score candidates: lower distance = better, higher frequency = better.
// Returns the best match or null if none are close enough.
// Threshold scales with word length to avoid false positives on short tokens.
function bestMatch(word, candidates, freqMap) {
  if (!candidates || !candidates.length) return null;
  if (candidates.includes(word)) return word; // exact match

  const wlen = word.length;
  // Max distance scales with word length to catch transpositions on short
  // words (e.g. gti→git dist 2) while avoiding false matches on 1-char tokens.
  //   wlen=1 → maxDist=1, wlen=3 → maxDist=2, wlen=5+ → maxDist=3
  const maxDist = Math.max(1, Math.min(3, Math.floor(wlen / 2) + 1));

  const scored = candidates.map((c) => ({
    name: c,
    dist: levenshtein(word.toLowerCase(), c.toLowerCase()),
    freq: freqMap[c] || 0,
  }));

  // Filter: only keep within distance threshold
  const withinThreshold = scored.filter((s) => s.dist <= maxDist && s.dist > 0);
  if (!withinThreshold.length) return null;

  // Sort: distance ASC, then frequency DESC, then alphabetically for stability
  withinThreshold.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (b.freq !== a.freq) return b.freq - a.freq;
    return a.name.localeCompare(b.name);
  });

  return withinThreshold[0].name;
}

// Should a token be left as-is? (flags, paths, shell expansions, etc.)
function isStaticToken(tok) {
  return tok === '.'
    || tok === '..'
    || tok.startsWith('-')
    || tok.startsWith('$')
    || tok.startsWith('/')
    || tok.startsWith('~')
    || tok.startsWith('--');
}

async function correct({ input, glossary, signal: _unused }) {
  // Pre-filter natural language
  if (looksLikeNaturalLanguage(input)) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'looks like natural language' };
  }

  // No glossary? Can't correct anything.
  if (!glossary || !glossary.commands) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'no glossary available' };
  }

  const freqMap = loadFreqMap();
  const tokens = input.trim().split(/\s+/);
  if (!tokens.length) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'empty input' };
  }

  // ── Token 0: correct the command name ──
  const cmd = tokens[0];
  const allCommandNames = Object.keys(glossary.commands);
  const correctedCmd = bestMatch(cmd, allCommandNames, freqMap);

  // No close match for the command — pass through to task agent
  if (!correctedCmd) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'no close command match' };
  }

  const fixedTokens = [correctedCmd];
  const cmdEntry = glossary.commands[correctedCmd];
  const subcommands = cmdEntry?.subcommands || [];

  // ── Tokens 1+: correct subcommands and known arguments ──
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (isStaticToken(tok)) {
      fixedTokens.push(tok);
      continue;
    }
    // Already a known subcommand? Keep it.
    if (subcommands.includes(tok)) {
      fixedTokens.push(tok);
      continue;
    }
    // Try to match against subcommands
    const bestSub = bestMatch(tok, subcommands, freqMap);
    if (bestSub) {
      fixedTokens.push(bestSub);
    } else {
      fixedTokens.push(tok); // keep original
    }
  }

  const proposed = fixedTokens.join(' ');
  if (proposed === input.trim()) {
    return { category: 'not_a_correction', proposed: null, safety: 'uncertain', reason: 'no correction needed' };
  }

  return {
    category: 'command_correction',
    proposed,
    safety: 'safe',
    reason: '',
  };
}

module.exports = { correct, looksLikeNaturalLanguage };
