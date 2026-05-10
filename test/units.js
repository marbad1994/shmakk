#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── markers ────────────────────────────────────────────────────────────────
{
  const { createMarkerStream } = require('../src/markers');

  test('markers: extracts B/C/D and strips them', () => {
    const ev = [];
    const feed = createMarkerStream((t, d) => ev.push([t, d]));
    const cmd = Buffer.from('npm install').toString('base64');
    const cwd = Buffer.from('/tmp').toString('base64');
    const s = `pre\x1b]6973;B;${cmd}\x07mid\x1b]6973;C;127\x07\x1b]6973;D;${cwd}\x07post`;
    assert.strictEqual(feed(Buffer.from(s)).toString('utf8'), 'premidpost');
    assert.deepStrictEqual(ev, [['command', 'npm install'], ['exit', 127], ['cwd', '/tmp']]);
  });

  test('markers: handles split chunks', () => {
    const ev = [];
    const feed = createMarkerStream((t, d) => ev.push([t, d]));
    const s = `x\x1b]6973;B;${Buffer.from('ls').toString('base64')}\x07y`;
    const a = feed(Buffer.from(s.slice(0, 8))).toString('utf8');
    const b = feed(Buffer.from(s.slice(8))).toString('utf8');
    assert.strictEqual(a + b, 'xy');
    assert.deepStrictEqual(ev, [['command', 'ls']]);
  });

  test('markers: passes through normal ANSI escapes', () => {
    const ev = [];
    const feed = createMarkerStream((t, d) => ev.push([t, d]));
    const s = '\x1b[1;31mred\x1b[0m';
    assert.strictEqual(feed(Buffer.from(s)).toString('utf8'), s);
    assert.deepStrictEqual(ev, []);
  });
}

// ── glossary (no-exec) ─────────────────────────────────────────────────────
{
  const { buildGlossary } = require('../src/glossary');

  test('glossary: builds with zero process spawns', async () => {
    const cp = require('child_process');
    const origSpawn = cp.spawn, origExec = cp.execFile, origExecSync = cp.execSync;
    let spawned = 0;
    cp.spawn = (...a) => { spawned++; return origSpawn.apply(cp, a); };
    cp.execFile = (...a) => { spawned++; return origExec.apply(cp, a); };
    cp.execSync = (...a) => { spawned++; return origExecSync.apply(cp, a); };
    try {
      const data = await buildGlossary();
      assert.ok(Object.keys(data.commands).length > 0);
      assert.strictEqual(spawned, 0, `expected 0 spawns, got ${spawned}`);
    } finally {
      cp.spawn = origSpawn; cp.execFile = origExec; cp.execSync = origExecSync;
    }
  });
}

// ── hook scripts ───────────────────────────────────────────────────────────
{
  const { configureForShell } = require('../src/hooks');

  test('hooks/fish: -C init defines preexec & postexec', () => {
    const c = configureForShell('fish');
    assert.ok(c.args.includes('-C'));
    const init = c.args[c.args.indexOf('-C') + 1];
    for (const re of [/fish_preexec/, /fish_postexec/, /6973;B/, /6973;C/, /6973;D/]) {
      assert.match(init, re);
    }
    c.cleanup();
  });

  test('hooks/bash: rcfile sources .bashrc and arms DEBUG trap', () => {
    const c = configureForShell('bash');
    const rc = c.args[c.args.indexOf('--rcfile') + 1];
    const txt = fs.readFileSync(rc, 'utf8');
    for (const re of [/\.bashrc/, /trap '__shmakk_preexec' DEBUG/, /PROMPT_COMMAND=/]) {
      assert.match(txt, re);
    }
    c.cleanup();
  });

  test('hooks/zsh: ZDOTDIR script preserves real config', () => {
    const c = configureForShell('zsh');
    const txt = fs.readFileSync(`${c.env.ZDOTDIR}/.zshrc`, 'utf8');
    for (const re of [/SHMAKK_REAL_ZDOTDIR/, /preexec_functions/, /precmd_functions/]) {
      assert.match(txt, re);
    }
    c.cleanup();
  });
}

// ── correction NL pre-filter ───────────────────────────────────────────────
{
  const { looksLikeNaturalLanguage } = require('../src/correction');

  test('NL pre-filter: catches questions and sentences', () => {
    for (const s of [
      'can you look through these files and tell me what to do',
      'why does my flutter app not run on linux',
      'fix the import error in lib/main.dart',
      'how do I install fish?',
      'tell me what is wrong here',
      'I need help with this',
      'what does this code do',
    ]) assert.strictEqual(looksLikeNaturalLanguage(s), true, `expected NL: ${s}`);
  });

  test('NL pre-filter: leaves real shell commands alone', () => {
    for (const s of [
      'nom itnsall', 'gti statsu', 'pyhton -m vnev .venv',
      'docker ps --formt json', 'ls -la', 'rm -rf node_modules',
      'cat', 'grep -r foo', 'npm install',
    ]) assert.strictEqual(looksLikeNaturalLanguage(s), false, `unexpected NL: ${s}`);
  });
}

// ── stdin filter ───────────────────────────────────────────────────────────
{
  const { createStdinFilter } = require('../src/markers');

  test('stdin filter: strips DA/DSR/OSC color responses', () => {
    const f = createStdinFilter();
    const input = Buffer.from('hi\x1b]11;rgb:2323/2626/2727\x1b\\\x1b[61;1R\x1b[?62;1;4cthere');
    assert.strictEqual(f(input).toString('binary'), 'hithere');
  });

  test('stdin filter: preserves user-typed bare ESC', () => {
    const f = createStdinFilter();
    // bare ESC followed by a normal char (e.g. user pressed Esc then j)
    const input = Buffer.from('\x1bj');
    assert.strictEqual(f(input).toString('binary'), '\x1bj');
  });

  test('stdin filter: handles split sequences across chunks', () => {
    const f = createStdinFilter();
    const a = f(Buffer.from('a\x1b]11;rgb:1234'));
    const b = f(Buffer.from('/5678/9abc\x07b'));
    assert.strictEqual(a.toString('binary') + b.toString('binary'), 'ab');
  });
}

// ── safety classification ──────────────────────────────────────────────────
{
  const { classifyRunCommand, isSecretPath } = require('../src/safety');

  test('safety: flags dangerous run commands', () => {
    for (const c of [
      'sudo apt update', 'rm -rf node_modules', 'rm -rf /', 'chmod -R 777 .',
      'mkfs.ext4 /dev/sda1', 'curl url | sh', 'npm i -g pkg', 'pip install foo',
      'cargo install bar', 'setxkbmap us', 'gsettings set org.x.y z',
    ]) assert.strictEqual(classifyRunCommand(c), 'unsafe', `expected unsafe: ${c}`);
  });

  test('safety: allows benign run commands', () => {
    for (const c of ['ls', 'npm test', 'git status', 'cat README.md', 'cargo build']) {
      assert.strictEqual(classifyRunCommand(c), 'safe', `expected safe: ${c}`);
    }
  });

  test('safety: flags secret paths', () => {
    for (const p of ['.env', '.env.local', '.ssh/id_rsa', '.aws/credentials', 'foo/.npmrc', 'key.pem']) {
      assert.strictEqual(isSecretPath(p), true, `expected secret: ${p}`);
    }
    for (const p of ['.gitignore', '.editorconfig', 'README.md', 'src/index.js']) {
      assert.strictEqual(isSecretPath(p), false, `expected non-secret: ${p}`);
    }
  });
}

// ── agent fallback tools ───────────────────────────────────────────────────
{
  const { classifyTool } = require('../src/tools');
  const { parseFallbackActions, parseDdgLite } = require('../src/web');

  test('agent: parses JSON fallback actions', () => {
    const actions = parseFallbackActions('```json\n{"shmakk_actions":[{"tool":"make_dir","args":{"path":"notes"}},{"tool":"run","args":{"cmd":"ls"}}]}\n```');
    assert.deepStrictEqual(actions, [
      { name: 'make_dir', args: { path: 'notes' } },
      { name: 'run', args: { cmd: 'ls' } },
    ]);
  });

  test('agent: ignores invalid fallback actions', () => {
    const actions = parseFallbackActions('{"shmakk_actions":[{"tool":"unknown","args":{}},{"tool":"write_file","args":{"path":"a.txt","content":"x"}}]}');
    assert.deepStrictEqual(actions, [
      { name: 'write_file', args: { path: 'a.txt', content: 'x' } },
    ]);
  });

  test('agent: classifies make_dir as safe except secret paths', () => {
    assert.strictEqual(classifyTool('make_dir', { path: 'tmp/new-dir' }), 'safe');
    assert.strictEqual(classifyTool('make_dir', { path: '.ssh/new-dir' }), 'unsafe');
  });

  test('agent: classifies web tools as safe', () => {
    assert.strictEqual(classifyTool('web_search', { query: 'OpenAI latest news' }), 'safe');
    assert.strictEqual(classifyTool('fetch_url', { url: 'https://example.com' }), 'safe');
  });

  test('agent: parses DuckDuckGo Lite results', () => {
    const html = `
      <tr>
        <td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews&amp;rut=x">Example &amp; News</a></td>
        <td class="result-snippet">A short &lt;b&gt;snippet&lt;/b&gt; here.</td>
      </tr>`;
    assert.deepStrictEqual(parseDdgLite(html, 5), [{
      title: 'Example & News',
      url: 'https://example.com/news',
      snippet: 'A short snippet here.',
    }]);
  });
}

// ── auto-subagent gating ────────────────────────────────────────────────────
{
  const { shouldUseAutoSubagents } = require('../src/subagent');

  test('auto-subagent gate: broad long input triggers by default', () => {
    const prev = process.env.SHMAKK_AUTO_SUBAGENTS;
    delete process.env.SHMAKK_AUTO_SUBAGENTS;
    const input = 'Please analyze this large project-wide architecture refactor across multiple modules and compare risks, implementation strategy, rollout plan, verification matrix, and dependency impact before any edits.';
    assert.strictEqual(shouldUseAutoSubagents(input, ['/repo']), true);
    if (prev === undefined) delete process.env.SHMAKK_AUTO_SUBAGENTS;
    else process.env.SHMAKK_AUTO_SUBAGENTS = prev;
  });

  test('auto-subagent gate: env disable forces false', () => {
    const prev = process.env.SHMAKK_AUTO_SUBAGENTS;
    process.env.SHMAKK_AUTO_SUBAGENTS = '0';
    const input = 'Please analyze this large project-wide architecture refactor across multiple modules and compare risks and implementation strategy.';
    assert.strictEqual(shouldUseAutoSubagents(input, ['/repo']), false);
    if (prev === undefined) delete process.env.SHMAKK_AUTO_SUBAGENTS;
    else process.env.SHMAKK_AUTO_SUBAGENTS = prev;
  });
}

// ── CLI args ───────────────────────────────────────────────────────────────
{
  const { parseArgs, HELP } = require('../src/cli');

  test('cli: parses yes-files flag', () => {
    const opts = parseArgs(['--yes-files']);
    assert.strictEqual(opts.yesFiles, true);
    assert.deepStrictEqual(opts.unknown, []);
  });

  test('cli: documents yes-files flag', () => {
    assert.match(HELP, /--yes-files/);
  });
}

// ── module load smoke ──────────────────────────────────────────────────────
test('modules: all entry modules load', () => {
  require('../src/cli');
  require('../src/shell');
  require('../src/pty');
  require('../src/llm');
  require('../src/correction');
  require('../src/agent');
  require('../src/review');
  require('../src/orchestrator');
});

// ── runner ─────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;

const c = {
  reset:   isTTY ? '\x1b[0m'    : '',
  green:   isTTY ? '\x1b[32m'   : '',
  red:     isTTY ? '\x1b[31m'   : '',
  bold:    isTTY ? '\x1b[1m'    : '',
  dim:     isTTY ? '\x1b[2m'    : '',
  cyan:    isTTY ? '\x1b[36m'   : '',
  yellow:  isTTY ? '\x1b[33m'   : '',
};

function status(symbol, style, label) {
  return `${style}${symbol}${c.reset} ${c.bold}${label}${c.reset}`;
}

function highlightDiffLines(text) {
  return text.split('\n').map(line => {
    if (/^\+/.test(line)) return `${c.green}${line}${c.reset}`;
    if (/^-/.test(line))  return `${c.red}${line}${c.reset}`;
    if (/\b(true|false|null|undefined|[0-9]+)\b/i.test(line)) {
      return line.replace(/\b(true|false|null|undefined|[0-9]+)\b/gi, `${c.bold}${c.cyan}$1${c.reset}`);
    }
    return line;
  }).join('\n');
}

(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ${status('✓', c.green, name)}`);
      pass++;
    } catch (e) {
      const msg = String(e.message).trimEnd();
      console.log(`  ${status('✗', c.red, name)}`);
      const highlighted = highlightDiffLines(msg);
      const indented = highlighted.replace(/\n/g, `\n${c.dim}      ${c.reset}`);
      console.log(`${c.dim}      ${indented}${c.reset}`);
      fail++;
    }
  }
  const totalColor = fail ? c.red : c.green;
  console.log(`\n  ${totalColor}${pass} passed${c.reset}, ${c.yellow}${fail} failed${c.reset}`);
  process.exit(fail ? 1 : 0);
})();
