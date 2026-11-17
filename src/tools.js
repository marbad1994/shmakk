// Tool definitions, classification, dispatch, and fallback parsing.
// Extracted from agent.js. Depends on ./safety and ./web for run/search/fetch.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { classifyRunCommand, isSecretPath } = require('./safety');
const { webSearch, fetchUrl } = require('./web');
const { dispatchBrowser, classifyBrowserCommand } = require('./browser');
const { dispatchMobile, classifyMobileCommand } = require('./mobile');
const { dispatchElectron, classifyElectronCommand } = require('./electron');
const { recordEdit } = require('./edit-tracker');
const { isImagePath, mimeForFile, normalizeImage } = require('./images');
const { appendMemory } = require('./memory');
const { isMutationTool, hashArgs } = require('./guard');
const https = require('https');
const http = require('http');
const os = require('os');

// Lazy-load the deliver module (writes to the web UI state dir). Only needed
// when deliver_file is called; CLI sessions still get a working file + URL.
let _deliver = null;
function _getDeliver() {
  if (_deliver) return _deliver;
  _deliver = require('./webui/deliver');
  return _deliver;
}

// Lazy-load SSH (optional — only required when ssh_* tools are called).
let _ssh = null;
function _getSSH(roots) {
  if (_ssh) return _ssh;
  try { _ssh = require('./ssh'); } catch (e) { return null; }
  return _ssh;
}

// Lazy-load TTS (kokoro-js is an optional dep; only required when
// tts_generate is actually called).
let _ttsGenerate = null;
function _getTtsGenerate() {
  if (_ttsGenerate) return _ttsGenerate;
  try {
    ({ generate: _ttsGenerate } = require('./services/tts'));
  } catch (e) {
    throw new Error(
      'TTS dependencies not installed. Run: npm run setup:voice\n' +
      'Or: npm install --include=optional\n' +
      `Details: ${e.message}`,
    );
  }
  return _ttsGenerate;
}

const MAX_FILE_BYTES = 64 * 1024;

// Resolve a path against a list of allowed roots. Returns the absolute
// path if it lies inside any root, or null otherwise. The first root in
// the list is used as the base for relative resolution.
//
// Uses realpath to defeat symlink traversal: a path that appears to be
// inside a root via lexical resolution but points outside via a symlink
// chain will be rejected.
function within(roots, p) {
  if (!roots || !roots.length) return null;
  if (typeof p !== 'string' || !p.trim()) return null;
  const base = path.resolve(roots[0]);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);

  // Resolve to real path to defeat symlink escapes.
  let realAbs;
  try {
    realAbs = fs.realpathSync(abs);
  } catch {
    // Path doesn't exist yet (e.g. write_file target).
    // Resolve the deepest existing ancestor to guard against symlinks
    // in parent directories.
    let d = path.dirname(abs);
    while (d && d !== path.dirname(d)) {
      try { realAbs = path.join(fs.realpathSync(d), path.relative(d, abs)); break; }
      catch { d = path.dirname(d); }
    }
    if (!realAbs) return null;
  }

  for (const r of roots) {
    let rr;
    try { rr = fs.realpathSync(r); } catch { rr = path.resolve(r); }
    if (realAbs === rr || realAbs.startsWith(rr + path.sep)) return abs;
  }
  return null;
}

const TOOLS = [
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a file inside the workspace. Text files support partial reads (head, tail, grep, imports, exports, symbol). Image files (.png/.jpg/.gif/.webp/.bmp/.svg) are returned as base64 for vision analysis.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mode: { type: 'string', enum: ['full', 'head', 'tail', 'grep', 'imports', 'exports', 'symbol'] },
        max_lines: { type: 'number', minimum: 1, maximum: 400 },
        query: { type: 'string' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'write_file',
    description: 'Write or overwrite a UTF-8 file inside the workspace.',
    parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Edit an existing UTF-8 file inside the workspace by replacing a specific string with a new string.',
    parameters: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'make_dir',
    description: 'Create a directory inside the workspace, including parents.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'list_dir',
    description: 'List entries in a directory inside the workspace.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'run',
    description: 'Run a non-interactive shell command inside the workspace. Output is captured.',
    parameters: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'web_search',
    description: 'Search the web for current information. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number', minimum: 1, maximum: 10 },
      },
    },
  }},
  { type: 'function', function: {
    name: 'fetch_url',
    description: 'Fetch text from an http(s) URL for source checking. Output is size-limited.',
    parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'delete_file',
    description: 'Delete a file inside the workspace. Always requires user confirmation.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }},
  { type: 'function', function: {
    name: 'remember',
    description: 'Save a durable fact to agent memory so it survives across sessions. Use for codebase quirks, API gotchas, user preferences, or anything you wouldn\'t want to re-discover next session. Keep facts short and specific.',
    parameters: {
      type: 'object',
      required: ['fact'],
      properties: {
        fact: { type: 'string', description: 'Short single-line fact, e.g. "Auth uses HS256 JWTs, secret in $JWT_SECRET"' },
        category: { type: 'string', description: 'Section to file the fact under. Examples: Codebase, Preferences, Gotchas, API quirks. Default: Notes.' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: 'global = applies to all workspaces; workspace = only this project. Default: workspace (project-specific facts are usually safer to scope).' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'browser',
    description: 'Control a headless browser. Commands: navigate (go to URL), click (CSS selector), type (fill input), read_page (extract page content, links, forms), screenshot (save PNG), evaluate (run JS), select (dropdown), wait (for selector or seconds), scroll (up/down), close.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', enum: ['navigate', 'click', 'type', 'read_page', 'screenshot', 'evaluate', 'select', 'wait', 'scroll', 'close'] },
        url: { type: 'string', description: 'URL for navigate' },
        selector: { type: 'string', description: 'CSS selector for click/type/select/wait' },
        text: { type: 'string', description: 'Text to type or option to select' },
        code: { type: 'string', description: 'JavaScript for evaluate' },
        seconds: { type: 'number', description: 'Seconds to wait' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'deliver_file',
    description: 'Give the user a file as a download in chat. Provide either `content` (text) or `data` (base64, for images/binary). Returns `url`, `viewUrl`, and a ready-to-paste `markdown` link; put that markdown link in your reply and the web UI renders it as a download button (images render inline via viewUrl).',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'File name, e.g. report.md or chart.png' },
        content: { type: 'string', description: 'Text content of the file (for text files)' },
        data: { type: 'string', description: 'Base64-encoded bytes (for images and binary files)' },
        mimeType: { type: 'string', description: 'MIME type; inferred from the name when omitted' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'mobile',
    description: 'Control an Android device/emulator via ADB. Commands: screenshot (capture screen as PNG), click (tap at x,y coordinates), type (input text), swipe (drag from x1,y1 to x2,y2), key (press BACK/HOME/etc), read_page (parse UI hierarchy via uiautomator), list_apps (list installed packages), launch (start app by package name), close (force-stop app), wait (pause in ms). Requires adb on PATH and a connected device.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', enum: ['screenshot', 'click', 'type', 'swipe', 'key', 'read_page', 'list_apps', 'launch', 'close', 'wait'] },
        x: { type: 'number', description: 'X coordinate for click' },
        y: { type: 'number', description: 'Y coordinate for click' },
        x1: { type: 'number', description: 'Start X for swipe' },
        y1: { type: 'number', description: 'Start Y for swipe' },
        x2: { type: 'number', description: 'End X for swipe' },
        y2: { type: 'number', description: 'End Y for swipe' },
        duration: { type: 'number', description: 'Swipe duration in ms' },
        text: { type: 'string', description: 'Text to type' },
        code: { type: 'string', description: 'Key code: BACK, HOME, ENTER, DELETE, MENU, APP_SWITCH, VOLUME_UP, VOLUME_DOWN' },
        package: { type: 'string', description: 'Android package name (e.g. com.example.app)' },
        filter: { type: 'string', description: 'Package name filter for list_apps' },
        ms: { type: 'number', description: 'Milliseconds to wait' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'electron',
    description: 'Control an Electron desktop app via Chrome DevTools Protocol (CDP). Commands: screenshot (capture window as PNG), navigate (go to URL), click (CSS selector), type (fill input), read_page (extract page content, links, forms), evaluate (run JS), select (dropdown), wait (for selector or seconds), scroll (up/down), close (disconnect), connect (attach to a debug port). The Electron app must be running with --remote-debugging-port (default 9222). Requires playwright installed.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', enum: ['screenshot', 'navigate', 'click', 'type', 'read_page', 'evaluate', 'select', 'wait', 'scroll', 'close', 'connect'] },
        url: { type: 'string', description: 'URL for navigate' },
        selector: { type: 'string', description: 'CSS selector for click/type/select/wait' },
        text: { type: 'string', description: 'Text to type or option to select' },
        code: { type: 'string', description: 'JavaScript for evaluate' },
        seconds: { type: 'number', description: 'Seconds to wait' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Scroll amount in pixels' },
        debugPort: { type: 'number', description: 'CDP debug port. Default 9222.' },
        value: { type: 'string', description: 'Option value for select' },
        fullPage: { type: 'boolean', description: 'Screenshot full page. Default true.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'image_gen',
    description: 'Generate an image from a text prompt using OpenAI DALL-E. The image is saved to disk and the file path is returned. Requires SHMAKK_OPENAI_API_KEY env var.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        outputPath: { type: 'string', description: 'Optional output path. Defaults to a temp file.' },
        size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], description: 'Image size. Defaults to 1024x1024.' },
        quality: { type: 'string', enum: ['standard', 'hd'], description: 'Quality level. Defaults to standard.' },
        style: { type: 'string', enum: ['vivid', 'natural'], description: 'Style. Defaults to vivid.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'tts_generate',
    description: 'Generate speech audio from text using Kokoro TTS (local, no API key needed). Returns the audio file path and voice used.',
    parameters: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text to convert to speech' },
        outputPath: { type: 'string', description: 'Optional WAV output path. Defaults to a temp file.' },
        voice: { type: 'string', description: 'Voice name. Defaults to af_heart. Use list_voices tool to discover available voices.' },
        speed: { type: 'number', description: 'Speech speed. Defaults to 1.5.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'video_probe',
    description: 'Get media file metadata using ffprobe: duration, codec, resolution, frame rate, etc.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to the media file to probe' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'video_compose',
    description: 'Compose images, audio tracks, and transitions into a video using ffmpeg. Takes a structured timeline of segments and assembles them into a single MP4 file.',
    parameters: {
      type: 'object',
      required: ['segments', 'outputPath'],
      properties: {
        segments: {
          type: 'array',
          description: 'Array of segment objects. Each segment: { imagePath: string (required), audioPath: string (required), startSec: number, durationSec: number, transition: string|null (fade/crossfade/dissolve/slide_left/slide_right/zoompan) }',
        },
        outputPath: { type: 'string', description: 'Output MP4 file path' },
        width: { type: 'number', description: 'Output video width. Defaults to 1920.' },
        height: { type: 'number', description: 'Output video height. Defaults to 1080.' },
        fps: { type: 'number', description: 'Output frame rate. Defaults to 24.' },
        backgroundColor: { type: 'string', description: 'Background color as hex. Defaults to #000000.' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'ssh_run',
    description: 'Run a shell command on a pre-configured remote host via SSH. Hosts are defined in .shmakk/hosts.json or ~/.config/shmakk/hosts.json. Output is captured.',
    parameters: {
      type: 'object',
      required: ['host', 'cmd'],
      properties: {
        host: { type: 'string', description: 'Host alias as defined in hosts.json (e.g. "devbox")' },
        cmd: { type: 'string', description: 'Shell command to run on the remote host' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'ssh_push',
    description: 'Copy a file from the local workspace to a remote host via SCP. Hosts are defined in .shmakk/hosts.json.',
    parameters: {
      type: 'object',
      required: ['host', 'src', 'dest'],
      properties: {
        host: { type: 'string', description: 'Host alias as defined in hosts.json' },
        src: { type: 'string', description: 'Local file path (relative to workspace or absolute)' },
        dest: { type: 'string', description: 'Remote destination path (absolute on remote host)' },
      },
    },
  }},
  { type: 'function', function: {
    name: 'ssh_pull',
    description: 'Copy a file from a remote host to the local workspace via SCP. Hosts are defined in .shmakk/hosts.json.',
    parameters: {
      type: 'object',
      required: ['host', 'src', 'dest'],
      properties: {
        host: { type: 'string', description: 'Host alias as defined in hosts.json' },
        src: { type: 'string', description: 'Remote source path (absolute on remote host)' },
        dest: { type: 'string', description: 'Local destination path (relative to workspace or absolute)' },
      },
    },
  }},
];

// Tool safety classification.
// 'safe'      → auto mode runs it without asking; review mode asks with [Y/n]
// 'unsafe'    → both modes ask, defaulting to No  ([y/N])
// 'uncertain' → both modes ask, defaulting to No  ([y/N])
function classifyTool(name, args, mcpManager) {
  if (name.startsWith('mcp__') && mcpManager) return mcpManager.classifyTool(name);
  if (name === 'read_file' || name === 'list_dir') {
    if (args.path && isSecretPath(args.path)) return 'unsafe';
    return 'safe';
  }
  if (name === 'write_file') {
    if (args.path && isSecretPath(args.path)) return 'unsafe';
    return 'uncertain';
  }
  if (name === 'make_dir') {
    if (args.path && isSecretPath(args.path)) return 'unsafe';
    return 'safe';
  }
  if (name === 'delete_file') return 'unsafe'; // user wants delete to always prompt
  if (name === 'run') return classifyRunCommand(args.cmd || '');
  if (name === 'web_search' || name === 'fetch_url') return 'safe';
  if (name === 'browser') return classifyBrowserCommand(args);
  if (name === 'mobile') return classifyMobileCommand(args);
  if (name === 'electron') return classifyElectronCommand(args);
  if (name === 'remember') return 'safe';
  if (name === 'image_gen') return 'unsafe';       // external API call, costs money
  if (name === 'tts_generate') return 'safe';       // local-only, no network
  if (name === 'video_probe') return 'safe';        // read-only local metadata
  if (name === 'deliver_file') return 'safe';       // writes only into the user's own state dir
  if (name === 'video_compose') return 'safe';      // local ffmpeg, reads only workspace files
  if (name === 'ssh_run' || name === 'ssh_push' || name === 'ssh_pull') return 'unsafe';
  return 'uncertain';
}

function describeTool(name, args, mcpManager) {
  if (name.startsWith('mcp__') && mcpManager) return mcpManager.describeTool(name, args);
  if (name === 'read_file') return `read ${args.path}${args.mode ? ` (${args.mode})` : ''}`;
  if (name === 'list_dir') return `list ${args.path || '.'}`;
  if (name === 'write_file') return `write ${args.path} (${(args.content || '').length} bytes)`;
  if (name === 'edit_file') return `edit ${args.path}`;
  if (name === 'make_dir') return `mkdir ${args.path}`;
  if (name === 'delete_file') return `delete ${args.path}`;
  if (name === 'run') return `run command (see below)`;
  if (name === 'web_search') return `web search: "${(args.query || '').slice(0, 100)}"`;
  if (name === 'fetch_url') return `fetch ${args.url}`;
  if (name === 'remember') return `remember [${args.scope || 'workspace'}/${args.category || 'Notes'}]: ${(args.fact || '').slice(0, 100)}`;
  if (name === 'deliver_file') return `deliver ${args.name || 'file'}`;
  if (name === 'browser') {
    const cmd = args.command || '';
    if (cmd === 'navigate') return `browser navigate ${args.url || ''}`;
    if (cmd === 'click') return `browser click ${args.selector || ''}`;
    if (cmd === 'type') return `browser type into ${args.selector || ''}`;
    if (cmd === 'read_page') return 'browser read page content';
    if (cmd === 'screenshot') return 'browser screenshot';
    if (cmd === 'evaluate') return `browser eval JS`;
    return `browser ${cmd}`;
  }
  if (name === 'mobile') {
    const cmd = args.command || '';
    if (cmd === 'screenshot') return 'mobile screenshot';
    if (cmd === 'click') return `mobile click (${args.x}, ${args.y})`;
    if (cmd === 'type') return `mobile type "${(args.text || '').slice(0, 40)}"`;
    if (cmd === 'swipe') return `mobile swipe (${args.x1},${args.y1}) to (${args.x2},${args.y2})`;
    if (cmd === 'read_page') return 'mobile read page';
    if (cmd === 'launch') return `mobile launch ${args.package || ''}`;
    if (cmd === 'close') return `mobile close ${args.package || ''}`;
    return `mobile ${cmd}`;
  }
  if (name === 'electron') {
    const cmd = args.command || '';
    if (cmd === 'screenshot') return 'electron screenshot';
    if (cmd === 'navigate') return `electron navigate ${args.url || ''}`;
    if (cmd === 'click') return `electron click ${args.selector || ''}`;
    if (cmd === 'type') return `electron type into ${args.selector || ''}`;
    if (cmd === 'read_page') return 'electron read page content';
    if (cmd === 'connect') return `electron connect port ${args.debugPort || 9222}`;
    return `electron ${cmd}`;
  }
  if (name === 'image_gen') return `image_gen: "${(args.prompt || '').slice(0, 80)}" (${args.size || '1024x1024'})`;
  if (name === 'tts_generate') return `tts_generate: "${(args.text || '').slice(0, 80)}" (voice: ${args.voice || 'af_heart'})`;
  if (name === 'video_probe') return `video_probe ${args.path || ''}`;
  if (name === 'video_compose') return `video_compose ${(args.segments || []).length} segments → ${args.outputPath || ''}`;
  if (name === 'ssh_run') return `ssh_run ${args.host || ''}: ${(args.cmd || '').slice(0, 100)}`;
  if (name === 'ssh_push') return `ssh_push ${args.src || ''} → ${args.host || ''}:${args.dest || ''}`;
  if (name === 'ssh_pull') return `ssh_pull ${args.host || ''}:${args.src || ''} → ${args.dest || ''}`;
  return `${name} ${JSON.stringify(args).slice(0, 80)}`;
}

function runCmd(cwd, cmd, signal) {
  return new Promise((resolve) => {
    let removeAbortListener = null;
    const child = execFile('/bin/sh', ['-c', cmd], { cwd, timeout: 15000, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (removeAbortListener) removeAbortListener();
        resolve({
          exitCode: err ? (err.code || 1) : 0,
          stdout: (stdout || '').toString().slice(-32000),
          stderr: (stderr || '').toString().slice(-32000),
          aborted: signal && signal.aborted ? true : undefined,
        });
      });
    if (signal) {
      const onAbort = () => { try { child.kill('SIGINT'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 500); };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
    }
  });
}

async function dispatchTool(name, args, roots, confirmTool, signal, mcpManager) {
  if (signal && signal.aborted) return { error: 'aborted' };
  const safety = classifyTool(name, args, mcpManager);

  // ── Mutation-tool approval ────────────────────────────────────────────
  // Every mutation tool MUST have explicit, fresh user approval before
  // execution.  This check is the runtime enforcement — even if the agent
  // loop has a bug, the tool refuses to run without valid approval.
  if (isMutationTool(name)) {
    if (!confirmTool) return { error: 'mutation tool requires explicit user approval (no confirmTool available)' };
    const ok = await confirmTool({ name, args, safety, description: describeTool(name, args, mcpManager) });
    if (!ok) {
      try {
        const audit = require('./audit');
        audit.append({ kind: 'tool-denied', name, argsHash: hashArgs(args) });
      } catch {}
      return { error: 'user declined' };
    }
  } else if (confirmTool) {
    // Non-mutation tools: still confirm, but don't enforce the same strictness.
    const ok = await confirmTool({ name, args, safety, description: describeTool(name, args, mcpManager) });
    if (!ok) return { error: 'user declined' };
  }
  if (signal && signal.aborted) return { error: 'aborted' };
  // MCP tools: route to MCP manager
  if (name.startsWith('mcp__') && mcpManager) {
    return mcpManager.dispatchTool(name, args, signal);
  }
  if (name === 'read_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    try {
      const buf = fs.readFileSync(p);

      // Image files: return as base64 for vision-capable providers. Formats the
      // provider cannot read (bmp, tiff, ico, avif, heic, svg) are converted to
      // png first; if that is impossible the image is described in words only.
      // Mode-specific sub-reads don't apply to images — always return full.
      if (isImagePath(p)) {
        const maxImageBytes = 2 * 1024 * 1024; // 2 MB binary (~2.7 MB base64)
        const slice = buf.length > maxImageBytes ? buf.subarray(0, maxImageBytes) : buf;
        const b64 = slice.toString('base64');
        const normalized = await normalizeImage({
          name: path.basename(p),
          mimeType: mimeForFile(p, slice),
          data: b64,
          dataLength: b64.length,
          truncated: buf.length > maxImageBytes,
        });
        const notes = [];
        if (normalized.convertedFrom) notes.push(`converted from ${normalized.convertedFrom}`);
        if (normalized.unsupported) notes.push(`${normalized.mimeType || 'unknown format'} cannot be shown to the model${normalized.reason ? ` (${normalized.reason})` : ''}`);
        return {
          content: `[Image: ${path.basename(p)} — ${buf.length} bytes${buf.length > maxImageBytes ? ' (truncated to 2MB for display)' : ''}${notes.length ? ` — ${notes.join('; ')}` : ''}]`,
          images: normalized.unsupported ? [] : [normalized],
        };
      }

      const text = buf.slice(0, MAX_FILE_BYTES).toString('utf8');
      const lines = text.split(/\r?\n/);
      const mode = args.mode || 'full';
      const maxLines = Math.max(1, Math.min(400, Number(args.max_lines) || 80));
      if (mode === 'head') {
        return { content: lines.slice(0, maxLines).join('\n'), mode, truncated: lines.length > maxLines };
      }
      if (mode === 'tail') {
        return { content: lines.slice(-maxLines).join('\n'), mode, truncated: lines.length > maxLines };
      }
      if (mode === 'grep') {
        const q = String(args.query || '').toLowerCase();
        if (!q) return { error: 'query required for grep mode' };
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue;
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          hits.push(lines.slice(start, end).join('\n'));
          if (hits.length >= 5) break;
        }
        return { content: hits.join('\n---\n'), mode, truncated: hits.length >= 5 };
      }
      if (mode === 'imports') {
        const out = lines.filter((line) => /\bimport\b|require\(/.test(line)).slice(0, maxLines).join('\n');
        return { content: out, mode, truncated: out.split(/\r?\n/).length >= maxLines };
      }
      if (mode === 'exports') {
        const out = lines.filter((line) => /\bexport\b|module\.exports/.test(line)).slice(0, maxLines).join('\n');
        return { content: out, mode, truncated: out.split(/\r?\n/).length >= maxLines };
      }
      if (mode === 'symbol') {
        const q = String(args.query || '').toLowerCase();
        if (!q) return { error: 'query required for symbol mode' };
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue;
          const start = Math.max(0, i - 8);
          const end = Math.min(lines.length, i + Math.max(12, maxLines));
          return { content: lines.slice(start, end).join('\n'), mode, truncated: end < lines.length };
        }
        return { error: `symbol/query not found: ${args.query}` };
      }
      return { content: text, mode: 'full', truncated: buf.length > MAX_FILE_BYTES };
    } catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'list_dir') {
    const p = within(roots, args.path || '.');
    if (!p) return { error: 'path outside workspace' };
    try {
      const ents = fs.readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { entries: ents };
    } catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'write_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    const oldContent = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, args.content ?? '');
    recordEdit({ filePath: p, oldContent, newContent: args.content ?? '', tool: 'write_file' });
    return { ok: true };
  }
  if (name === 'edit_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    try {
      const content = fs.readFileSync(p, 'utf8');
      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');
      if (!oldString) return { error: 'old_string is required' };
      const first = content.indexOf(oldString);
      if (first === -1) return { error: 'old_string not found' };
      const second = content.indexOf(oldString, first + oldString.length);
      if (second !== -1) return { error: 'old_string is ambiguous; appears multiple times' };
      const updated = content.slice(0, first) + newString + content.slice(first + oldString.length);
      fs.writeFileSync(p, updated);
      recordEdit({ filePath: p, oldContent: content, newContent: updated, tool: 'edit_file' });
      return { ok: true, replaced: 1 };
    } catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'make_dir') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    fs.mkdirSync(p, { recursive: true });
    return { ok: true };
  }
  if (name === 'delete_file') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    try { fs.rmSync(p, { force: true }); return { ok: true }; }
    catch (e) { return { error: String(e.message) }; }
  }
  if (name === 'run') {
    // run from the first root as cwd
    return await runCmd(roots[0], args.cmd, signal);
  }
  if (name === 'web_search') {
    return await webSearch(args.query, args.max_results, signal);
  }
  if (name === 'fetch_url') {
    return await fetchUrl(args.url, signal);
  }
  if (name === 'browser') {
    return await dispatchBrowser(args);
  }
  if (name === 'mobile') {
    return await dispatchMobile(args);
  }
  if (name === 'electron') {
    return await dispatchElectron(args);
  }
  if (name === 'remember') {
    const r = appendMemory({
      category: args.category,
      fact: args.fact,
      scope: args.scope === 'global' ? 'global' : 'workspace',
      cwd: roots[0],
    });
    return r.ok
      ? { ok: true, saved_to: r.path, line: r.line }
      : { error: r.error };
  }
  if (name === 'deliver_file') {
    try {
      const d = _getDeliver().create({
        name: args.name,
        content: args.content,
        data: args.data,
        mimeType: args.mimeType,
      });
      return {
        ok: true,
        url: d.url,
        viewUrl: d.viewUrl,
        filename: d.name,
        mimeType: d.mimeType,
        size: d.size,
        markdown: d.markdown,
        hint: 'Paste the `markdown` link into your reply so the user gets a download button.',
      };
    } catch (e) {
      return { error: `deliver_file failed: ${e.message}` };
    }
  }
  if (name === 'image_gen') {
    const apiKey = process.env.SHMAKK_OPENAI_API_KEY;
    if (!apiKey) return { error: 'SHMAKK_OPENAI_API_KEY env var is not set' };
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return { error: 'prompt is required' };
    const size = args.size || '1024x1024';
    const quality = args.quality || 'standard';
    const style = args.style || 'vivid';
    const outputPath = args.outputPath || path.join(os.tmpdir(), `shmakk-img-${Date.now()}.png`);

    const body = JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality,
      style,
      response_format: 'b64_json',
    });

    const postData = await new Promise((resolve, reject) => {
      const url = new URL('https://api.openai.com/v1/images/generations');
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`OpenAI API error ${res.statusCode}: ${(json.error && json.error.message) || data.slice(0, 200)}`));
              return;
            }
            resolve(json);
          } catch (e) {
            reject(new Error(`Failed to parse OpenAI response: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI API request timed out after 120s')); });
      req.write(body);
      req.end();
    });

    const b64 = postData.data && postData.data[0] && postData.data[0].b64_json;
    if (!b64) return { error: 'No image data in OpenAI response' };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
    recordEdit({ filePath: outputPath, oldContent: null, newContent: `[binary image ${(b64.length * 0.75) | 0} bytes]`, tool: 'image_gen' });
    return {
      ok: true,
      imagePath: outputPath,
      prompt,
      size,
      revised_prompt: postData.data[0].revised_prompt || prompt,
      images: [{
        mimeType: 'image/png',
        data: b64,
        dataLength: b64.length,
        truncated: false,
      }],
    };
  }
  if (name === 'tts_generate') {
    const text = String(args.text || '').trim();
    if (!text) return { error: 'text is required' };
    const outputPath = args.outputPath || path.join(os.tmpdir(), `shmakk-tts-${Date.now()}.wav`);
    const opts = {};
    if (args.voice) opts.voice = args.voice;
    if (args.speed !== undefined) opts.speed = Number(args.speed);
    opts.outputPath = outputPath;

    try {
      const ttsFn = _getTtsGenerate();
      const result = await ttsFn(text, opts);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      return {
        ok: true,
        audioPath: result.audioPath,
        voice: result.voice,
        textLength: text.length,
      };
    } catch (e) {
      return { error: `TTS generation failed: ${e.message}` };
    }
  }
  if (name === 'video_probe') {
    const p = within(roots, args.path);
    if (!p) return { error: 'path outside workspace' };
    if (!fs.existsSync(p)) return { error: `file not found: ${p}` };

    const result = await new Promise((resolve) => {
      const child = execFile('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        p,
      ], { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').toString().trim() || err.message;
          resolve({ error: `ffprobe failed: ${msg}` });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          // Extract a clean summary
          const summary = { path: p };
          if (data.format) {
            summary.format = data.format.format_name;
            summary.durationSec = parseFloat(data.format.duration) || null;
            summary.sizeBytes = parseInt(data.format.size, 10) || null;
            summary.bitRate = parseInt(data.format.bit_rate, 10) || null;
          }
          if (data.streams) {
            summary.streams = data.streams.map((s) => ({
              index: s.index,
              codec_type: s.codec_type,
              codec_name: s.codec_name,
              width: s.width || null,
              height: s.height || null,
              r_frame_rate: s.r_frame_rate || null,
              sample_rate: s.sample_rate || null,
              channels: s.channels || null,
              duration_ts: s.duration_ts || null,
            }));
          }
          resolve({ ok: true, ...summary, raw: data });
        } catch (e) {
          resolve({ error: `Failed to parse ffprobe output: ${e.message}` });
        }
      });
      if (signal) {
        const onAbort = () => { try { child.kill('SIGINT'); } catch {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return result;
  }
  if (name === 'video_compose') {
    const segments = args.segments || [];
    if (!Array.isArray(segments) || segments.length === 0) {
      return { error: 'segments must be a non-empty array' };
    }
    const outputPath = args.outputPath;
    if (!outputPath) return { error: 'outputPath is required' };

    // Validate all input files exist
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.imagePath) return { error: `segment[${i}]: imagePath is required` };
      if (!seg.audioPath) return { error: `segment[${i}]: audioPath is required` };
      const imgPath = within(roots, seg.imagePath);
      const audPath = within(roots, seg.audioPath);
      if (!imgPath) return { error: `segment[${i}]: imagePath outside workspace` };
      if (!audPath) return { error: `segment[${i}]: audioPath outside workspace` };
      if (!fs.existsSync(imgPath)) return { error: `segment[${i}]: imagePath not found: ${seg.imagePath}` };
      if (!fs.existsSync(audPath)) return { error: `segment[${i}]: audioPath not found: ${seg.audioPath}` };
    }

    const width = args.width || 1920;
    const height = args.height || 1080;
    const fps = args.fps || 24;
    const bgColor = args.backgroundColor || '#000000';

    // First pass: probe each audio segment for its actual duration.
    // Fall back to segment.durationSec if ffprobe is unavailable.
    let segmentDurations = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const audPath = within(roots, seg.audioPath);
      if (seg.durationSec && seg.durationSec > 0) {
        segmentDurations.push({ ...seg, resolvedSec: seg.durationSec, audPath });
        continue;
      }
      try {
        const probeOut = await new Promise((resolve) => {
          execFile('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            audPath,
          ], { timeout: 10000, maxBuffer: 256 * 1024 }, (err, stdout) => {
            if (err) { resolve(null); return; }
            try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
          });
        });
        const dur = probeOut && probeOut.format && probeOut.format.duration
          ? parseFloat(probeOut.format.duration) : 3;
        segmentDurations.push({ ...seg, resolvedSec: dur, audPath });
      } catch {
        segmentDurations.push({ ...seg, resolvedSec: seg.durationSec || 3, audPath });
      }
    }

    // Build filter_complex: for each segment, scale/zoom the image to fill,
    // concatenate with transitions.
    const filterParts = [];
    let totalDuration = 0;
    const trimPairs = [];

    // Build per-segment video inputs
    for (let i = 0; i < segmentDurations.length; i++) {
      const seg = segmentDurations[i];
      const dur = seg.resolvedSec;
      const imgPath = within(roots, seg.imagePath);
      const trans = seg.transition || null;

      // Each image looped for its duration, scaled to fill.
      filterParts.push(`[${i}:v]loop=loop=-1:size=${Math.ceil(dur * fps)},trim=duration=${dur},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=crop,crop=${width}:${height},setsar=1[v${i}]`);

      if (trans === 'fade' || trans === 'crossfade' || trans === 'dissolve') {
        // Fade in at start, except first segment
        if (i === 0) {
          filterParts.push(`[v${i}]fade=t=in:st=0:d=0.5,fade=t=out:st=${dur - 0.5}:d=0.5[fv${i}]`);
        } else {
          filterParts.push(`[v${i}]fade=t=in:st=0:d=0.5,fade=t=out:st=${dur - 0.5}:d=0.5[fv${i}]`);
        }
        trimPairs.push(`[fv${i}]`);
      } else if (trans === 'zoompan') {
        filterParts.push(`[v${i}]zoompan=z='min(zoom+0.0015,1.5)':d=${Math.ceil(dur * fps)}:s=${width}x${height}[fv${i}]`);
        trimPairs.push(`[fv${i}]`);
      } else if (trans === 'slide_left') {
        // Slide in from right
        const steps = Math.ceil(dur * fps);
        filterParts.push(`[v${i}]trim=duration=${dur},setpts=PTS-STARTPTS,format=rgba,fade=t=in:st=0:d=0.3:alpha=1,overlay=x='min(W-(W/2)*(t/${dur}),W)':y=0:format=auto,setsar=1,trim=duration=${dur}[fv${i}]`);
        trimPairs.push(`[fv${i}]`);
      } else if (trans === 'slide_right') {
        filterParts.push(`[v${i}]trim=duration=${dur},setpts=PTS-STARTPTS,format=rgba,fade=t=in:st=0:d=0.3:alpha=1,setsar=1,trim=duration=${dur}[fv${i}]`);
        trimPairs.push(`[fv${i}]`);
      } else {
        // No transition
        trimPairs.push(`[v${i}]`);
      }
      totalDuration += dur;
    }

    // Concatenate all video segments
    const concatInputs = trimPairs.join('');
    filterParts.push(`${concatInputs}concat=n=${segmentDurations.length}:v=1:a=0[outv]`);

    // Build audio inputs: concat all audio files
    const audioInputs = [];
    for (let i = 0; i < segmentDurations.length; i++) {
      const seg = segmentDurations[i];
      // Input index for the audio: total image inputs + i
      const audioIdx = segments.length + i;
      audioInputs.push(`[${audioIdx}:a]`);
    }
    filterParts.push(`${audioInputs.join('')}concat=n=${segmentDurations.length}:v=0:a=1[outa]`);

    const filterComplex = filterParts.join(';');

    // Build ffmpeg args
    const ffmpegArgs = ['-y'];
    // Image inputs
    for (const seg of segmentDurations) {
      ffmpegArgs.push('-loop', '1', '-i', within(roots, seg.imagePath));
    }
    // Audio inputs
    for (const seg of segmentDurations) {
      ffmpegArgs.push('-i', seg.audPath);
    }
    ffmpegArgs.push(
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-t', String(totalDuration),
      outputPath,
    );

    fs.mkdirSync(path.dirname(path.resolve(roots[0], outputPath)), { recursive: true });

    const composeResult = await new Promise((resolve) => {
      const child = execFile('ffmpeg', ffmpegArgs, {
        cwd: roots[0],
        timeout: 300000,   // 5 min timeout for video encoding
        maxBuffer: 512 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').toString().split('\n').slice(-5).join('\n') || err.message;
          resolve({ error: `ffmpeg compose failed: ${msg}` });
          return;
        }
        resolve({ ok: true, outputPath, durationSec: totalDuration, segmentCount: segments.length });
      });
      if (signal) {
        const onAbort = () => { try { child.kill('SIGINT'); } catch {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return composeResult;
  }
  if (name === 'ssh_run') {
    const ssh = _getSSH(roots);
    if (!ssh) return { error: 'SSH module not available' };
    const cfg = ssh.loadHostConfig(roots[0]);
    const entry = ssh.resolveHost(cfg, args.host);
    if (!entry) return { error: 'host not configured: ' + args.host + '. Define it in .shmakk/hosts.json or ~/.config/shmakk/hosts.json' };
    return await ssh.sshRun(entry, args.cmd, signal);
  }
  if (name === 'ssh_push') {
    const ssh = _getSSH(roots);
    if (!ssh) return { error: 'SSH module not available' };
    const cfg = ssh.loadHostConfig(roots[0]);
    const entry = ssh.resolveHost(cfg, args.host);
    if (!entry) return { error: 'host not configured: ' + args.host };
    const p = within(roots, args.src);
    if (!p) return { error: 'src path outside workspace' };
    if (!fs.existsSync(p)) return { error: 'src not found: ' + args.src };
    return await ssh.sshTransfer(entry, p, args.dest, 'push', signal);
  }
  if (name === 'ssh_pull') {
    const ssh = _getSSH(roots);
    if (!ssh) return { error: 'SSH module not available' };
    const cfg = ssh.loadHostConfig(roots[0]);
    const entry = ssh.resolveHost(cfg, args.host);
    if (!entry) return { error: 'host not configured: ' + args.host };
    const p = within(roots, args.dest);
    if (!p) return { error: 'dest path outside workspace' };
    return await ssh.sshTransfer(entry, args.src, p, 'pull', signal);
  }
  return { error: `unknown tool: ${name}` };
}

// ── Tool call normalization & budgeting ────────────────────────────────────

function normalizeToolCalls(rawToolCalls, iter) {
  const calls = [];
  let seq = 0;
  for (const tc of rawToolCalls || []) {
    if (!tc || tc.type !== 'function') continue;
    const name = String(tc.function?.name || '').trim();
    if (!name) continue;
    const id = String(tc.id || '').trim() || `tc_${iter}_${seq++}`;
    const argsRaw = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
    calls.push({
      id,
      type: 'function',
      function: {
        name,
        arguments: argsRaw || '{}',
      },
    });
  }
  return calls;
}

function applyRoundToolBudget(toolCalls, maxDiscoveryCalls) {
  const discovery = new Set(['read_file', 'list_dir', 'web_search', 'fetch_url']);
  const actionCalls = [];
  const discoveryCalls = [];
  for (const c of toolCalls) {
    if (discovery.has(c.function?.name)) discoveryCalls.push(c);
    else actionCalls.push(c);
  }
  // Progress-first bias: execute action calls first, then only a small discovery budget.
  return [...actionCalls, ...discoveryCalls.slice(0, maxDiscoveryCalls)];
}

// ── Fallback action parsing (text-based tool calls) ─────────────────────────

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

  const rawActions = Array.isArray(obj?.shmakk_actions) ? obj.shmakk_actions : [];
  const allowed = new Set(TOOLS.map((t) => t.function.name));
  const actions = [];
  for (const a of rawActions) {
    const name = a?.tool || a?.name;
    const args = a?.args && typeof a.args === 'object' ? a.args : {};
    if (allowed.has(name)) actions.push({ name, args });
  }
  return actions;
}

function parseXmlFallbackActions(content) {
  // Normalize DeepSeek DSML format: <｜｜DSML｜｜tool_calls> → <tool_calls>
  // DSML uses fullwidth vertical bars (U+FF5C) around tag names.
  const text = String(content || '').replace(/<(\/?)(?:｜+DSML)?｜+/g, '<$1').replace(/｜+>/g, '>');
  if (!text) return [];
  const allowed = new Set(TOOLS.map((t) => t.function.name));
  const actions = [];

  // Old Anthropic format:
  //   <tool_call><function=tool_name><parameter=key>val</parameter></function></tool_call>
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
      args[k] = parseXmlParamValue(p[2]);
    }
    actions.push({ name, args });
  }

  // New Anthropic format:
  //   <tool_calls><invoke name="tool_name"><parameter name="key" string="true">val</parameter></invoke></tool_calls>
  const tcsRe = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;
  while ((m = tcsRe.exec(text))) {
    const block = m[1];
    const invRe = /<invoke\s+name\s*=\s*"([a-zA-Z0-9_]+)"\s*>([\s\S]*?)<\/invoke>/gi;
    let inv;
    while ((inv = invRe.exec(block))) {
      const name = inv[1];
      if (!allowed.has(name)) continue;
      const body = inv[2] || '';
      const args = {};
      const pRe = /<parameter\s+name\s*=\s*"([a-zA-Z0-9_]+)"([^>]*?)>([\s\S]*?)<\/parameter>/gi;
      let p;
      while ((p = pRe.exec(body))) {
        const k = p[1];
        args[k] = parseXmlParamValue(p[3]);
      }
      actions.push({ name, args });
    }
  }

  return actions;
}

function parseXmlParamValue(raw) {
  const v = (raw || '').trim();
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  return v;
}

module.exports = {
  TOOLS,
  classifyTool,
  describeTool,
  dispatchTool,
  runCmd,
  normalizeToolCalls,
  applyRoundToolBudget,
  within,
  parseFallbackActions,
  parseXmlFallbackActions,
  stripJsonFence,
};
