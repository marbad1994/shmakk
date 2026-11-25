// GitHub integration for the web UI: connect an account, browse repositories,
// and start "cloud sessions" — a conversation whose workspace is a fresh
// clone of a repository on this server.
//
// Auth is either a personal access token pasted into Settings, the
// SHMAKK_GITHUB_TOKEN / GITHUB_TOKEN environment variable, or GitHub's device
// flow when an OAuth app client id is configured (SHMAKK_GITHUB_CLIENT_ID).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Overridable for GitHub Enterprise Server (API is https://HOST/api/v3).
const API = (process.env.SHMAKK_GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const WEB = (process.env.SHMAKK_GITHUB_URL || 'https://github.com').replace(/\/$/, '');
const UA = 'shmakk-web';
const HELPER = path.join(__dirname, 'git-credential.js');

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function workspacesDir() {
  if (process.env.SHMAKK_WORKSPACES_DIR) return path.resolve(process.env.SHMAKK_WORKSPACES_DIR);
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'shmakk', 'workspaces');
}

// "owner/repo", "https://github.com/owner/repo(.git)", "git@github.com:owner/repo.git"
function parseRepo(input) {
  const s = String(input || '').trim();
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(s);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2], fullName: `${m[1]}/${m[2]}` };
}

// Git ref names are restrictive; keep to a safe, predictable subset.
function validBranch(name) {
  const s = String(name || '');
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//');
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

function git(cwd, args, { timeout = 120000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', LC_ALL: 'C', ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-3).join(' · ');
        return reject(new GitHubError(400, msg || 'git failed'));
      }
      resolve(String(stdout));
    });
  });
}

// ctx: { settings, saveSettings }
function createGitHub(ctx) {
  let userCache = null;      // { at, token, user }
  let repoCache = null;      // { at, token, repos }
  const devices = new Map(); // device_code → { interval, expiresAt }

  const token = () => process.env.SHMAKK_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ctx.settings.github?.token || '';
  const tokenSource = () => (process.env.SHMAKK_GITHUB_TOKEN || process.env.GITHUB_TOKEN ? 'env' : ctx.settings.github?.token ? 'saved' : null);
  const clientId = () => process.env.SHMAKK_GITHUB_CLIENT_ID || '';

  async function gh(method, url, body, tok = token()) {
    if (!tok) throw new GitHubError(401, 'GitHub is not connected');
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${tok}`,
        'user-agent': UA,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const detail = json?.errors?.[0]?.message ? ` — ${json.errors[0].message}` : '';
      throw new GitHubError(res.status === 401 ? 401 : res.status === 404 ? 404 : 400, `GitHub: ${json?.message || res.statusText}${detail}`);
    }
    return { json, headers: res.headers };
  }

  async function currentUser(tok = token()) {
    if (!tok) return null;
    if (userCache && userCache.token === tok && Date.now() - userCache.at < 5 * 60e3) return userCache.user;
    const { json, headers } = await gh('GET', '/user', null, tok);
    const user = {
      login: json.login, name: json.name || json.login, id: json.id, avatar: json.avatar_url, url: json.html_url,
      scopes: (headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
    userCache = { at: Date.now(), token: tok, user };
    return user;
  }

  async function status() {
    const base = { connected: false, source: tokenSource(), deviceFlow: !!clientId(), workspacesDir: workspacesDir(), user: null, error: null };
    if (!token()) return base;
    try { return { ...base, connected: true, user: await currentUser() }; }
    catch (e) { return { ...base, error: e.message }; }
  }

  async function connect(newToken) {
    const tok = String(newToken || '').trim();
    if (!tok) throw new GitHubError(400, 'token required');
    const user = await currentUser(tok); // validates before saving
    ctx.settings.github = { token: tok, login: user.login };
    ctx.saveSettings();
    repoCache = null;
    return status();
  }

  function disconnect() {
    delete ctx.settings.github;
    ctx.saveSettings();
    userCache = null;
    repoCache = null;
    return status();
  }

  // ── device flow (optional) ──
  async function deviceStart() {
    if (!clientId()) throw new GitHubError(400, 'device sign-in needs SHMAKK_GITHUB_CLIENT_ID (a GitHub OAuth app with device flow enabled)');
    const res = await fetch(`${WEB}/login/device/code`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ client_id: clientId(), scope: 'repo read:org' }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    if (!res.ok || !j.device_code) throw new GitHubError(400, j.error_description || 'could not start device sign-in');
    devices.set(j.device_code, { expiresAt: Date.now() + (j.expires_in || 900) * 1000 });
    return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval || 5, expiresIn: j.expires_in || 900 };
  }

  async function devicePoll(deviceCode) {
    const d = devices.get(deviceCode);
    if (!d) throw new GitHubError(400, 'unknown or expired sign-in');
    if (Date.now() > d.expiresAt) { devices.delete(deviceCode); return { state: 'expired' }; }
    const res = await fetch(`${WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ client_id: clientId(), device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    if (j.access_token) { devices.delete(deviceCode); await connect(j.access_token); return { state: 'connected' }; }
    if (j.error === 'authorization_pending' || j.error === 'slow_down') return { state: 'pending', slowDown: j.error === 'slow_down' };
    devices.delete(deviceCode);
    return { state: j.error === 'expired_token' ? 'expired' : 'denied', error: j.error_description || j.error };
  }

  // ── repositories ──
  const repoView = (r) => ({
    fullName: r.full_name, owner: r.owner.login, name: r.name, private: r.private, fork: r.fork, archived: r.archived,
    description: r.description || '', defaultBranch: r.default_branch, pushedAt: r.pushed_at, language: r.language || null,
    url: r.html_url, canPush: !!r.permissions?.push,
  });

  async function listRepos({ q = '', refresh = false } = {}) {
    const tok = token();
    if (!repoCache || repoCache.token !== tok || refresh || Date.now() - repoCache.at > 60e3) {
      const repos = [];
      for (let page = 1; page <= 4; page++) {
        const { json } = await gh('GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
        repos.push(...json.map(repoView));
        if (json.length < 100) break;
      }
      repoCache = { at: Date.now(), token: tok, repos };
    }
    const needle = String(q).trim().toLowerCase();
    let repos = needle ? repoCache.repos.filter((r) => r.fullName.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle)) : repoCache.repos;
    // A full "owner/repo" that isn't in the list (e.g. a public repo you don't own) can still be opened.
    const direct = parseRepo(q);
    if (direct && !repos.some((r) => r.fullName.toLowerCase() === direct.fullName.toLowerCase())) {
      try { repos = [repoView((await gh('GET', `/repos/${direct.owner}/${direct.repo}`)).json), ...repos]; } catch { /* not accessible */ }
    }
    return { total: repoCache.repos.length, repos: repos.slice(0, 100) };
  }

  async function listBranches(fullName) {
    const r = parseRepo(fullName);
    if (!r) throw new GitHubError(400, 'invalid repository');
    const [{ json: repo }, { json: branches }] = await Promise.all([
      gh('GET', `/repos/${r.owner}/${r.repo}`),
      gh('GET', `/repos/${r.owner}/${r.repo}/branches?per_page=100`),
    ]);
    return { defaultBranch: repo.default_branch, canPush: !!repo.permissions?.push, branches: branches.map((b) => b.name) };
  }

  // ── cloud sessions ──
  // Each session gets its own clone, so parallel sessions on one repository
  // never trample each other's working tree.
  async function prepareWorkspace({ repo, branch, newBranch, label }) {
    const r = parseRepo(repo);
    if (!r) throw new GitHubError(400, 'invalid repository — use owner/name');
    if (branch && !validBranch(branch)) throw new GitHubError(400, 'invalid branch name');
    if (newBranch && !validBranch(newBranch)) throw new GitHubError(400, 'invalid new branch name');
    const user = await currentUser();
    const { json: info } = await gh('GET', `/repos/${r.owner}/${r.repo}`);
    const base = branch || info.default_branch;

    const root = workspacesDir();
    const parent = path.join(root, info.owner.login);
    fs.mkdirSync(parent, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
    let dir = path.join(parent, `${info.name}--${slug(label || newBranch || base)}-${stamp}`);
    for (let n = 2; fs.existsSync(dir); n++) dir = `${dir.replace(/~\d+$/, '')}~${n}`;
    if (!dir.startsWith(root + path.sep)) throw new GitHubError(400, 'invalid workspace path');

    const url = `${WEB}/${info.full_name}.git`;
    const helper = `!node "${HELPER}"`;
    try {
      // Blobless clone: full history for git log/blame, file contents fetched on demand.
      await git(parent, ['-c', `credential.helper=${helper}`, 'clone', '--filter=blob:none', '--branch', base, '--', url, dir], { timeout: 10 * 60e3 });
      await git(dir, ['config', 'credential.helper', helper]);
      await git(dir, ['config', 'user.name', user.name || user.login]);
      await git(dir, ['config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`]);
      // shmakk keeps per-workspace state in .shmakk/ — never let it reach a commit.
      // (.git/info/exclude is clone-local, so the repository itself is untouched.)
      fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n# shmakk session state\n.shmakk/\n');
      if (newBranch) await git(dir, ['checkout', '-b', newBranch]);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return {
      dir,
      repo: { fullName: info.full_name, url: info.html_url, private: info.private, baseBranch: base, branch: newBranch || base, defaultBranch: info.default_branch, canPush: !!info.permissions?.push },
    };
  }

  async function gitStatus(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) throw new GitHubError(404, 'workspace is gone');
    const out = await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], { timeout: 20000 });
    const st = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) st.branch = line.slice(14);
      else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
      else if (line.startsWith('1 ') || line.startsWith('2 ')) { const p = line.split(' '); st.files.push({ status: p[1].replace(/\./g, ''), path: line.split('\t')[0].split(' ').slice(8).join(' ') }); }
      else if (line.startsWith('? ')) st.files.push({ status: '?', path: line.slice(2) });
      else if (line.startsWith('u ')) st.files.push({ status: 'U', path: line.split(' ').slice(10).join(' ') });
    }
    // Commits not yet on the remote at all (covers branches with no upstream).
    try { st.unpushed = Number((await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], { timeout: 20000 })).trim()) || 0; } catch { st.unpushed = st.ahead; }
    return st;
  }

  async function commitAndPush(dir, { message }) {
    const st = await gitStatus(dir);
    if (!st.branch || st.branch === '(detached)') throw new GitHubError(400, 'not on a branch');
    let committed = false;
    if (st.files.length) {
      const msg = String(message || '').trim();
      if (!msg) throw new GitHubError(400, 'commit message required');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', msg]);
      committed = true;
    } else if (!st.unpushed) {
      throw new GitHubError(400, 'nothing to commit or push');
    }
    await git(dir, ['push', '--set-upstream', 'origin', st.branch], { timeout: 5 * 60e3 });
    return { committed, branch: st.branch, status: await gitStatus(dir) };
  }

  async function findPullRequest(fullName, branch) {
    const r = parseRepo(fullName);
    if (!r || !branch) return null;
    try {
      const { json } = await gh('GET', `/repos/${r.owner}/${r.repo}/pulls?state=all&head=${encodeURIComponent(`${r.owner}:${branch}`)}&per_page=1`);
      const pr = json[0];
      return pr ? { number: pr.number, url: pr.html_url, state: pr.merged_at ? 'merged' : pr.state, title: pr.title, draft: !!pr.draft } : null;
    } catch { return null; }
  }

  async function createPullRequest(fullName, { head, base, title, body, draft }) {
    const r = parseRepo(fullName);
    if (!r) throw new GitHubError(400, 'invalid repository');
    if (!String(title || '').trim()) throw new GitHubError(400, 'title required');
    const { json: pr } = await gh('POST', `/repos/${r.owner}/${r.repo}/pulls`, { head, base, title: String(title).trim(), body: String(body || ''), draft: !!draft });
    return { number: pr.number, url: pr.html_url, state: pr.state, title: pr.title, draft: !!pr.draft };
  }

  function removeWorkspace(dir) {
    const root = workspacesDir();
    const abs = path.resolve(dir);
    if (!abs.startsWith(root + path.sep)) throw new GitHubError(400, 'not a session workspace');
    fs.rmSync(abs, { recursive: true, force: true });
    return true;
  }

  return {
    token, status, connect, disconnect, deviceStart, devicePoll, listRepos, listBranches,
    prepareWorkspace, gitStatus, commitAndPush, findPullRequest, createPullRequest, removeWorkspace, workspacesDir,
  };
}

module.exports = { createGitHub, GitHubError, parseRepo, validBranch, workspacesDir, slug };
