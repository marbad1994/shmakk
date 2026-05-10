// Web search and URL fetch helpers extracted from agent.js.
// Uses DuckDuckGo Lite (no API key required) and plain http(s) fetch.

const MAX_FETCH_BYTES = 128 * 1024;

function decodeDdgUrl(url) {
  try {
    let raw = String(url || '');
    // Handle protocol-relative URLs (//duckduckgo.com/...)
    if (raw.startsWith('//')) raw = 'https:' + raw;
    // Decode HTML entities that appear in href attribute values
    raw = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const u = new URL(raw);
    const p = u.searchParams;
    if ((u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com')) && p.has('uddg')) {
      const raw = p.get('uddg');
      if (raw) {
        const decoded = decodeURIComponent(raw);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    return url;
  } catch { return url; }
}

function stripTags(html) {
  return String(html || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDdgLite(html, maxResults = 5) {
  const results = [];
  const seen = new Set();

  // Primary: old/current lite table result rows
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) && results.length < maxResults) {
    const block = row[1];
    const link = /<a[^>]+(?:class="result-link"|rel="nofollow")[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = decodeDdgUrl(link[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const snippetMatch = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(block);
    const title = stripTags(link[2]);
    if (!title) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : '',
    });
  }

  // Fallback: generic anchor extraction for changed DDG markup
  if (results.length < maxResults) {
    const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = anchorRe.exec(html)) && results.length < maxResults) {
      const url = decodeDdgUrl(a[1]);
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      if (/duckduckgo\.com\/(?:lite|html|\?|$)/i.test(url)) continue;
      const title = stripTags(a[2]);
      if (!title || title.length < 3) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
    }
  }

  return results;
}

function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  let removeUpstreamAbortListener = null;
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else {
      const onAbort = () => ctrl.abort(opts.signal.reason);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      removeUpstreamAbortListener = () => opts.signal.removeEventListener('abort', onAbort);
    }
  }
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
    if (removeUpstreamAbortListener) removeUpstreamAbortListener();
  });
}

async function webSearch(query, maxResults, signal) {
  const q = String(query || '').trim();
  if (!q) return { error: 'query required' };
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 5));
  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; aiterm/0.1; +https://duckduckgo.com)' };

  async function searchOne(url) {
    const resp = await fetchWithTimeout(url, { signal, headers });
    const html = await resp.text();
    if (!resp.ok) return { error: `search failed: HTTP ${resp.status}`, results: [] };
    return { results: parseDdgLite(html, limit) };
  }

  try {
    const lite = await searchOne(liteUrl);
    if (lite.results.length) return { query: q, results: lite.results, source: 'ddg-lite' };

    const html = await searchOne(htmlUrl);
    if (html.results.length) return { query: q, results: html.results, source: 'ddg-html-fallback' };

    return { query: q, results: [], source: 'ddg-lite+html', note: lite.error || html.error || 'no results parsed' };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function fetchUrl(url, signal) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return { error: 'invalid URL' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { error: 'only http(s) URLs are supported' };
  try {
    const resp = await fetchWithTimeout(parsed.href, {
      signal,
      headers: { 'user-agent': 'aiterm/0.1' },
    });
    const text = await resp.text();
    return {
      url: parsed.href,
      status: resp.status,
      contentType: resp.headers.get('content-type') || '',
      text: stripTags(text).slice(0, MAX_FETCH_BYTES),
      truncated: text.length > MAX_FETCH_BYTES,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ── JSON fallback action extraction ─────────────────────────────────────────

function stripJsonFence(s) {
  const t = String(s || '').trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1].trim() : t;
}

function parseFallbackActions(content) {
  const text = stripJsonFence(content);
  if (!text) return [];

  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return [];
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  }

  const rawActions = Array.isArray(obj?.aiterm_actions) ? obj.aiterm_actions : [];
  const allowed = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url',
    'write_file', 'edit_file', 'make_dir', 'delete_file', 'run']);
  const actions = [];
  for (const a of rawActions) {
    const name = a?.tool || a?.name;
    const args = a?.args && typeof a.args === 'object' ? a.args : {};
    if (allowed.has(name)) actions.push({ name, args });
  }
  return actions;
}

// ── XML fallback action extraction ──────────────────────────────────────────

function parseXmlFallbackActions(content) {
  const text = String(content || '');
  if (!text) return [];
  const allowed = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url',
    'write_file', 'edit_file', 'make_dir', 'delete_file', 'run']);
  const actions = [];

  const tcRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let m;
  while ((m = tcRe.exec(text))) {
    const block = m[1];
    const fnMatch = /<function\s*=\s*([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/function>/i.exec(block);
    if (!fnMatch) continue;
    const name = fnMatch[1];
    if (!allowed.has(name)) continue;
    const body = fnMatch[2] || '';
    const args = {};
    const pRe = /<parameter\s*=\s*([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let p;
    while ((p = pRe.exec(body))) {
      const k = p[1];
      const raw = (p[2] || '').trim();
      if (/^(true|false)$/i.test(raw)) args[k] = /^true$/i.test(raw);
      else if (/^-?\d+(?:\.\d+)?$/.test(raw)) args[k] = Number(raw);
      else args[k] = raw;
    }
    actions.push({ name, args });
  }

  return actions;
}

module.exports = {
  webSearch,
  fetchUrl,
  parseDdgLite,
  stripTags,
  decodeDdgUrl,
  fetchWithTimeout,
  stripJsonFence,
  parseFallbackActions,
  parseXmlFallbackActions,
};
