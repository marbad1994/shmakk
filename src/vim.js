const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function binPath() {
  return path.resolve(__dirname, '..', 'bin', 'shmakk.js');
}

function splitPath(value) {
  return String(value || '').split(path.delimiter).filter(Boolean);
}

function withoutDir(pathValue, dir) {
  const resolved = path.resolve(dir);
  return splitPath(pathValue).filter((p) => {
    try { return path.resolve(p) !== resolved; } catch { return true; }
  }).join(path.delimiter);
}

function findExecutable(name, pathValue = process.env.PATH) {
  for (const dir of splitPath(pathValue)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function prepareVimEnvironment(mode = 'vim') {
  if (mode === 'disable') return { env: {}, cleanup: () => {} };
  const command = mode === 'vi' ? 'vi' : 'vim';
  const currentPath = process.env.PATH || '';
  const real = findExecutable(command, currentPath);
  if (!real) {
    process.stderr.write(`[shmakk] warning: --vim ${command} requested, but ${command} was not found in PATH\n`);
    return { env: {}, cleanup: () => {} };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shmakk-vim-'));
  const wrapper = path.join(dir, command);
  const script = [
    '#!/usr/bin/env sh',
    `exec "${process.execPath}" "${binPath()}" --vim-editor "${command}" --vim-real "${real}" -- "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(wrapper, script, { mode: 0o755 });

  return {
    env: {
      SHMAKK_REAL_PATH: currentPath,
      SHMAKK_VIM_SHIM_DIR: dir,
      PATH: `${dir}${path.delimiter}${currentPath}`,
    },
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

function writePlugin() {
  const p = path.join(os.tmpdir(), `shmakk-vim-plugin-${process.pid}-${Date.now()}.vim`);
  const node = process.execPath;
  const shmakk = binPath();
  const lines = [];
  lines.push('if exists("g:loaded_shmakk_vim") | finish | endif');
  lines.push('let g:loaded_shmakk_vim = 1');
  lines.push(`let s:shmakk_node = ${JSON.stringify(node)}`);
  lines.push(`let s:shmakk_bin = ${JSON.stringify(shmakk)}`);
  lines.push('');
  lines.push('function! s:Run(mode, payload) abort');
  lines.push('  let out = system([s:shmakk_node, s:shmakk_bin, "--vim-ai", a:mode], json_encode(a:payload))');
  lines.push('  if v:shell_error != 0');
  lines.push('    echohl ErrorMsg | echom "[shmakk] " . out | echohl None');
  lines.push('    return {"ok": v:false, "error": out}');
  lines.push('  endif');
  lines.push('  let decoded = json_decode(out)');
  lines.push('  if type(decoded) != v:t_dict');
  lines.push('    return {"ok": v:false, "error": "invalid shmakk response"}');
  lines.push('  endif');
  lines.push('  return decoded');
  lines.push('endfunction');
  lines.push('');
  lines.push('let s:auto_jobs = {}');
  lines.push('');
  lines.push('function! s:StartAsyncSuggest(payload) abort');
  lines.push('  if !exists("*job_start") | return 0 | endif');
  lines.push('  let in_file = tempname()');
  lines.push('  let out_file = tempname()');
  lines.push('  let err_file = tempname()');
  lines.push('  call writefile([json_encode(a:payload)], in_file)');
  lines.push('  let job = job_start([s:shmakk_node, s:shmakk_bin, "--vim-ai", "suggest"], {"in_io": "file", "in_name": in_file, "out_io": "file", "out_name": out_file, "err_io": "file", "err_name": err_file})');
  lines.push('  if job <= 0');
  lines.push('    call delete(in_file) | call delete(out_file) | call delete(err_file)');
  lines.push('    return 0');
  lines.push('  endif');
  lines.push('  let s:auto_jobs[job] = {"out": out_file, "err": err_file, "in": in_file, "buf": bufnr("%"), "line": line("."), "col": col(".") }');
  lines.push('  call timer_start(500, function("s:PollAsyncSuggest", [job]))');
  lines.push('  return 1');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! s:PollAsyncSuggest(job, timer) abort');
  lines.push('  if !has_key(s:auto_jobs, a:job) | return | endif');
  lines.push('  if job_status(a:job) ==# "run"');
  lines.push('    call timer_start(500, function("s:PollAsyncSuggest", [a:job]))');
  lines.push('    return');
  lines.push('  endif');
  lines.push('  let meta = remove(s:auto_jobs, a:job)');
  lines.push('  let raw = join(readfile(meta.out), "\\n")');
  lines.push('  let err = join(readfile(meta.err), "\\n")');
  lines.push('  call delete(meta.in) | call delete(meta.out) | call delete(meta.err)');
  lines.push('  if bufnr("%") != meta.buf | return | endif');
  lines.push('  let decoded = json_decode(raw)');
  lines.push('  if type(decoded) != v:t_dict || !get(decoded, "ok", v:false)');
  lines.push('    if err !=# "" | echom "[shmakk] auto-suggest failed: " . err | endif');
  lines.push('    return');
  lines.push('  endif');
  lines.push('  let text = get(decoded, "text", "")');
  lines.push('  if text ==# "" | return | endif');
  lines.push('  let b:shmakk_pending_suggestion = {"text": text, "line": meta.line, "col": meta.col}');
  lines.push('  echo "[shmakk] suggestion ready: :ShmakkAccept, :ShmakkPreview, or :ShmakkDeny"');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! s:Context(prompt) abort');
  lines.push('  return {"file": expand("%:p"), "line": line("."), "col": col("."), "prompt": a:prompt, "buffer": join(getline(1, "$"), "\\n")}');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! s:InsertAtCursor(text) abort');
  lines.push('  let parts = split(a:text, "\\n", v:true)');
  lines.push('  if empty(parts) | return | endif');
  lines.push('  let lnum = line(".")');
  lines.push('  let c = col(".")');
  lines.push('  let cur = getline(lnum)');
  lines.push('  let before = strpart(cur, 0, c - 1)');
  lines.push('  let after = strpart(cur, c - 1)');
  lines.push('  if len(parts) == 1');
  lines.push('    call setline(lnum, before . parts[0] . after)');
  lines.push('  else');
  lines.push('    call setline(lnum, before . parts[0])');
  lines.push('    call append(lnum, parts[1:-2] + [parts[-1] . after])');
  lines.push('  endif');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkGenerate(prompt) abort');
  lines.push('  let prompt = a:prompt');
  lines.push('  echo "[shmakk] generating..." | redraw');
  lines.push('  let r = s:Run("generate", s:Context(prompt))');
  lines.push('  if get(r, "ok", v:false)');
  lines.push('    call s:InsertAtCursor(get(r, "text", ""))');
  lines.push('  else');
  lines.push('    echohl ErrorMsg | echom "[shmakk] " . get(r, "error", "generation failed") | echohl None');
  lines.push('  endif');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkTypeWriter(prompt) abort');
  lines.push('  let prompt = a:prompt');
  lines.push('  echo "[shmakk] writing..." | redraw');
  lines.push('  let r = s:Run("typewriter", s:Context(prompt))');
  lines.push('  if get(r, "ok", v:false)');
  lines.push('    call s:InsertAtCursor(get(r, "text", ""))');
  lines.push('  else');
  lines.push('    echohl ErrorMsg | echom "[shmakk] " . get(r, "error", "typewriter failed") | echohl None');
  lines.push('  endif');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkSuggest() abort');
  lines.push('  echo "[shmakk] suggesting..." | redraw');
  lines.push('  let r = s:Run("suggest", s:Context(""))');
  lines.push('  if !get(r, "ok", v:false)');
  lines.push('    echohl ErrorMsg | echom "[shmakk] " . get(r, "error", "suggestion failed") | echohl None');
  lines.push('    return');
  lines.push('  endif');
  lines.push('  let text = get(r, "text", "")');
  lines.push('  if text ==# "" | return | endif');
  lines.push('  botright new');
  lines.push('  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted readonly');
  lines.push('  file [shmakk-suggestion]');
  lines.push('  call setline(1, split(text, "\\n", v:true))');
  lines.push('  normal! gg');
  lines.push('  let choice = confirm("Accept shmakk suggestion?", "&Accept\\n&Deny", 2)');
  lines.push('  bdelete!');
  lines.push('  if choice == 1');
  lines.push('    call s:InsertAtCursor(text)');
  lines.push('  endif');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkAccept() abort');
  lines.push('  if !exists("b:shmakk_pending_suggestion")');
  lines.push('    echo "[shmakk] no pending suggestion"');
  lines.push('    return');
  lines.push('  endif');
  lines.push('  let text = b:shmakk_pending_suggestion.text');
  lines.push('  let source_buf = bufnr("%")');
  lines.push('  botright new');
  lines.push('  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted readonly');
  lines.push('  file [shmakk-suggestion]');
  lines.push('  call setline(1, split(text, "\\n", v:true))');
  lines.push('  normal! gg');
  lines.push('  let choice = confirm("Accept shmakk suggestion?", "&Accept\\n&Deny", 2)');
  lines.push('  bdelete!');
  lines.push('  if choice == 1');
  lines.push('    if bufnr("%") != source_buf | execute "buffer " . source_buf | endif');
  lines.push('    unlet b:shmakk_pending_suggestion');
  lines.push('    call s:InsertAtCursor(text)');
  lines.push('  endif');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkDeny() abort');
  lines.push('  if exists("b:shmakk_pending_suggestion") | unlet b:shmakk_pending_suggestion | endif');
  lines.push('  echo "[shmakk] suggestion cleared"');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkPreview() abort');
  lines.push('  if !exists("b:shmakk_pending_suggestion")');
  lines.push('    echo "[shmakk] no pending suggestion"');
  lines.push('    return');
  lines.push('  endif');
  lines.push('  let text = b:shmakk_pending_suggestion.text');
  lines.push('  botright new');
  lines.push('  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted readonly');
  lines.push('  file [shmakk-suggestion]');
  lines.push('  call setline(1, split(text, "\\n", v:true))');
  lines.push('  normal! gg');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! s:MaybeAutoSuggest(timer) abort');
  lines.push('  if !get(g:, "shmakk_auto_suggest", 0) | return | endif');
  lines.push('  if mode() !=# "i" || exists("b:shmakk_pending_suggestion") | return | endif');
  lines.push('  let min_chars = get(g:, "shmakk_auto_suggest_min_chars", 20)');
  lines.push('  let before = strpart(getline("."), 0, col(".") - 1)');
  lines.push('  if strlen(before) < min_chars | return | endif');
  lines.push('  echo "[shmakk] auto-suggesting..."');
  lines.push('  call s:StartAsyncSuggest(s:Context(""))');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! s:ScheduleAutoSuggest() abort');
  lines.push('  if !get(g:, "shmakk_auto_suggest", 0) | return | endif');
  lines.push('  if exists("b:shmakk_auto_timer") | call timer_stop(b:shmakk_auto_timer) | endif');
  lines.push('  let b:shmakk_auto_timer = timer_start(get(g:, "shmakk_auto_suggest_delay_ms", 2000), function("s:MaybeAutoSuggest"))');
  lines.push('endfunction');
  lines.push('');
  lines.push('function! ShmakkCommand(cmd) abort');
  lines.push('  let r = s:Run("cmd", {"cmd": a:cmd, "cwd": getcwd()})');
  lines.push('  botright new');
  lines.push('  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted');
  lines.push('  file [shmakk-cmd]');
  lines.push('  let lines = ["$ " . a:cmd, "exit " . string(get(r, "code", 1)), ""]');
  lines.push('  if get(r, "stdout", "") != "" | call extend(lines, split(r.stdout, "\\n", v:true)) | endif');
  lines.push('  if get(r, "stderr", "") != "" | call extend(lines, ["", "stderr:"]) | call extend(lines, split(r.stderr, "\\n", v:true)) | endif');
  lines.push('  call setline(1, lines)');
  lines.push('  normal! gg');
  lines.push('endfunction');
  lines.push('');
  lines.push('nnoremap <silent> <C-Space> :call ShmakkSuggest()<CR>');
  lines.push('inoremap <silent> <C-Space> <Esc>:call ShmakkSuggest()<CR>a');
  lines.push('nnoremap <silent> <leader>sa :call ShmakkAccept()<CR>');
  lines.push('nnoremap <silent> <leader>sd :call ShmakkDeny()<CR>');
  lines.push('nnoremap <silent> <leader>sp :call ShmakkPreview()<CR>');
  lines.push('augroup ShmakkVimAI');
  lines.push('  autocmd! * <buffer>');
  lines.push('  autocmd TextChangedI <buffer> call s:ScheduleAutoSuggest()');
  lines.push('augroup END');
  lines.push('command! -nargs=* ShmakkGenerate call ShmakkGenerate(<q-args>)');
  lines.push('command! -nargs=* G call ShmakkGenerate(<q-args>)');
  lines.push('command! -nargs=* ShmakkTypeWriter call ShmakkTypeWriter(<q-args>)');
  lines.push('command! -nargs=* Tw call ShmakkTypeWriter(<q-args>)');
  lines.push('command! -nargs=* ShmakkCommand call ShmakkCommand(<q-args>)');
  lines.push('command! -nargs=* Cmd call ShmakkCommand(<q-args>)');
  lines.push('command! -nargs=0 ShmakkSuggest call ShmakkSuggest()');
  lines.push('command! -nargs=0 ShmakkAccept call ShmakkAccept()');
  lines.push('command! -nargs=0 ShmakkDeny call ShmakkDeny()');
  lines.push('command! -nargs=0 ShmakkPreview call ShmakkPreview()');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

function runEditor(realEditor, args = []) {
  const script = writePlugin();
  const cleanPath = process.env.SHMAKK_REAL_PATH || withoutDir(process.env.PATH || '', process.env.SHMAKK_VIM_SHIM_DIR || '');
  const env = { ...process.env, PATH: cleanPath };
  const childArgs = [...args, '-S', script];
  const res = spawnSync(realEditor, childArgs, { stdio: 'inherit', env });
  try { fs.rmSync(script, { force: true }); } catch {}
  return res.status ?? (res.signal ? 1 : 0);
}

function stripFence(text) {
  const s = String(text || '').trim();
  const m = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

function contextWindow(payload, mode) {
  const buffer = String(payload.buffer || '');
  if (mode !== 'suggest') return buffer.slice(0, 30000);

  const lines = buffer.split('\n');
  const cursorLine = Math.max(1, Number(payload.line) || 1);
  const beforeLines = Math.max(10, Number(process.env.SHMAKK_VIM_SUGGEST_BEFORE_LINES) || 80);
  const afterLines = Math.max(5, Number(process.env.SHMAKK_VIM_SUGGEST_AFTER_LINES) || 40);
  const start = Math.max(0, cursorLine - beforeLines - 1);
  const end = Math.min(lines.length, cursorLine + afterLines);
  let windowText = lines.slice(start, end).join('\n');
  const maxChars = Math.max(2000, Number(process.env.SHMAKK_VIM_SUGGEST_MAX_CHARS) || 12000);
  if (windowText.length > maxChars) {
    windowText = windowText.slice(Math.max(0, windowText.length - maxChars));
  }
  const prefix = start > 0 ? `[Earlier lines omitted: 1-${start}]\n` : '';
  const suffix = end < lines.length ? `\n[Later lines omitted: ${end + 1}-${lines.length}]` : '';
  return prefix + windowText + suffix;
}

function suggestEndpointName() {
  return process.env.SHMAKK_VIM_SUGGEST_ENDPOINT || process.env.SHMAKK_FAST_ENDPOINT || 'fast';
}

async function callModel(mode, payload) {
  const { isConfigured, makeClient, makeClientForEndpoint, modelFor } = require('./llm');
  if (!isConfigured()) {
    return { ok: false, error: 'LLM is not configured. Set SHMAKK_BASE_URL or an endpoint first.' };
  }
  let client = makeClient('vim');
  let model = modelFor('vim');
  if (mode === 'suggest') {
    const fast = makeClientForEndpoint(suggestEndpointName());
    if (fast) {
      client = fast.client;
      model = fast.model;
    }
  }
  const intent = mode === 'typewriter'
    ? 'Write prose or documentation at the cursor.'
    : mode === 'suggest'
      ? 'Predict the best next code block at the cursor. Prefer complete functions, methods, classes, or cohesive multi-line edits when appropriate.'
      : 'Generate or edit code at the cursor.';
  const messages = [
    { role: 'system', content: 'You are shmakk inside Vim. Return only the requested text. Do not wrap code in markdown fences unless the user explicitly asks for markdown.' },
    { role: 'user', content: `${intent}\nFile: ${payload.file || '(unnamed)'}\nCursor: ${payload.line || 1}:${payload.col || 1}\nPrompt/base: ${payload.prompt || ''}\n\nBuffer/context:\n${contextWindow(payload, mode)}` },
  ];
  const resp = await client.chat.completions.create({
    model,
    temperature: mode === 'suggest' ? 0.1 : 0.2,
    max_tokens: mode === 'suggest' ? 1800 : 2400,
    messages,
  });
  const text = resp.choices?.[0]?.message?.content || '';
  return { ok: true, text: stripFence(text) };
}

function readsStdin() {
  return fs.readFileSync(0, 'utf8');
}

function commandUsesShmakk(cmd) {
  return /(^|[;&|()]\s*)shmakk(\s|$)/.test(String(cmd || ''));
}

function runShellCommand(cmd, cwd) {
  if (commandUsesShmakk(cmd)) {
    return { ok: false, code: 127, stdout: '', stderr: 'shmakk is not available inside :cmd\n' };
  }
  const shell = process.env.SHELL || '/bin/sh';
  const env = { ...process.env };
  delete env.SHMAKK;
  delete env.SHMAKK_PID;
  delete env.SHMAKK_SESSION_ID;
  env.PATH = env.SHMAKK_REAL_PATH || withoutDir(env.PATH || '', env.SHMAKK_VIM_SHIM_DIR || '');
  const spawnOpts = {
    cwd: cwd || process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  };
  let res = spawnSync(shell, ['-lc', String(cmd || '')], spawnOpts);
  let fallbackNote = '';
  if (res.error && shell !== '/bin/sh') {
    fallbackNote = `${res.error.message}; retried with /bin/sh\n`;
    res = spawnSync('/bin/sh', ['-lc', String(cmd || '')], spawnOpts);
  }
  const code = res.error ? 1 : (res.status ?? (res.signal ? 1 : 0));
  return {
    ok: !res.error && code === 0,
    code,
    stdout: res.stdout || '',
    stderr: fallbackNote + (res.stderr || (res.error ? `${res.error.message}\n` : '')),
  };
}

async function runAi(mode) {
  let payload = {};
  try { payload = JSON.parse(readsStdin() || '{}'); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `invalid JSON: ${e.message}` }) + '\n');
    return 1;
  }
  const result = mode === 'cmd'
    ? runShellCommand(payload.cmd, payload.cwd)
    : await callModel(mode, payload);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.ok === false ? 1 : 0;
}

module.exports = {
  prepareVimEnvironment,
  runEditor,
  runAi,
  commandUsesShmakk,
  _test: { findExecutable, withoutDir, commandUsesShmakk, stripFence, writePlugin, contextWindow, suggestEndpointName },
};
