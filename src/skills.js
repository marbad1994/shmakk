const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SKILL_BYTES = 64 * 1024;
const DEFAULT_RENDER_BYTES = 12 * 1024;

function safeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function candidatePaths(name, cwd = process.cwd()) {
  const n = safeName(name);
  const home = os.homedir();
  return [
    path.join(cwd, '.claude', 'skills', `${n}.md`),
    path.join(cwd, '.claude', 'skills', n, 'SKILL.md'),
    path.join(cwd, '.codex', 'skills', `${n}.md`),
    path.join(cwd, '.codex', 'skills', n, 'SKILL.md'),
    path.join(home, '.claude', 'skills', `${n}.md`),
    path.join(home, '.claude', 'skills', n, 'SKILL.md'),
    path.join(home, '.codex', 'skills', `${n}.md`),
    path.join(home, '.codex', 'skills', n, 'SKILL.md'),
  ];
}

function stateDir(cwd = process.cwd()) {
  return path.join(cwd, '.aiterm', 'state');
}

function skillsDir(cwd = process.cwd()) {
  return path.join(cwd, '.aiterm', 'skills');
}

function registryPath(cwd = process.cwd()) {
  return path.join(stateDir(cwd), 'skills-registry.json');
}

function activeSkillPath(cwd = process.cwd()) {
  return path.join(stateDir(cwd), 'active-skill.json');
}

function ensureDirs(cwd = process.cwd()) {
  fs.mkdirSync(stateDir(cwd), { recursive: true });
  fs.mkdirSync(skillsDir(cwd), { recursive: true });
}

function sha256(s) {
  return require('crypto').createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/m.exec(String(raw || ''));
  if (!m) return { meta: {}, body: String(raw || '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (!mm) continue;
    meta[mm[1].toLowerCase()] = mm[2].trim();
  }
  return { meta, body: m[2] };
}

function validateSkill(raw, sourcePath = '') {
  const text = String(raw || '');
  const issues = [];
  if (!text.trim()) issues.push('empty skill content');
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) issues.push(`skill exceeds ${MAX_SKILL_BYTES} bytes`);
  if (!/^#\s+/m.test(text)) issues.push('missing markdown heading');
  if (!/(instruction|rule|guideline|workflow|steps?|when to use|pattern|quick start|core concepts?)/i.test(text)) {
    issues.push('no obvious instruction sections found');
  }
  if (/\b(ignore previous|bypass safety|exfiltrate|leak secret|disable security)\b/i.test(text)) {
    issues.push('contains potentially unsafe instruction phrases');
  }
  const fm = parseFrontmatter(text);
  const name = safeName(fm.meta.name || path.basename(sourcePath || '', path.extname(sourcePath || '')) || 'skill');
  const version = String(fm.meta.version || '1').trim();
  return {
    ok: issues.length === 0,
    issues,
    normalizedName: name,
    version,
    body: fm.body,
    raw: text,
  };
}

function loadRegistry(cwd = process.cwd()) {
  try {
    const p = registryPath(cwd);
    if (!fs.existsSync(p)) return { skills: {}, updatedAt: null };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { skills: j.skills || {}, updatedAt: j.updatedAt || null };
  } catch {
    return { skills: {}, updatedAt: null };
  }
}

function saveRegistry(cwd, registry) {
  ensureDirs(cwd);
  const p = registryPath(cwd);
  fs.writeFileSync(p, JSON.stringify({
    skills: registry.skills || {},
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function loadSkillToWorkspace(name, cwd = process.cwd()) {
  const n = safeName(name);
  if (!n) return { ok: false, error: 'missing skill name' };
  const found = candidatePaths(n, cwd).find((p) => fs.existsSync(p));
  if (!found) {
    return {
      ok: false,
      error: `skill not found: ${n}`,
      searched: candidatePaths(n, cwd),
    };
  }

  const raw = fs.readFileSync(found, 'utf8');
  const validation = validateSkill(raw, found);
  if (!validation.ok) {
    return { ok: false, error: `skill failed validation: ${validation.issues.join('; ')}` };
  }

  ensureDirs(cwd);
  const localSkillPath = path.join(skillsDir(cwd), `${validation.normalizedName}.md`);
  fs.writeFileSync(localSkillPath, validation.raw, 'utf8');

  const registry = loadRegistry(cwd);
  const checksum = sha256(validation.raw);
  registry.skills[validation.normalizedName] = {
    name: validation.normalizedName,
    version: validation.version,
    source: found,
    localPath: localSkillPath,
    checksum,
    bytes: Buffer.byteLength(validation.raw, 'utf8'),
    loadedAt: new Date().toISOString(),
    active: true,
  };

  for (const k of Object.keys(registry.skills)) {
    if (k !== validation.normalizedName) registry.skills[k].active = false;
  }

  saveRegistry(cwd, registry);
  fs.writeFileSync(activeSkillPath(cwd), JSON.stringify(registry.skills[validation.normalizedName], null, 2));

  return { ok: true, name: validation.normalizedName, source: found, localPath: localSkillPath, version: validation.version };
}

function importSkillContent(raw, sourceLabel, cwd = process.cwd(), fallbackName = 'downloaded-skill') {
  const validation = validateSkill(raw, sourceLabel);
  if (!validation.ok) {
    return { ok: false, error: `skill failed validation: ${validation.issues.join('; ')}` };
  }

  const name = validation.normalizedName || safeName(fallbackName) || 'downloaded-skill';
  ensureDirs(cwd);
  const localSkillPath = path.join(skillsDir(cwd), `${name}.md`);
  fs.writeFileSync(localSkillPath, validation.raw, 'utf8');

  const registry = loadRegistry(cwd);
  registry.skills[name] = {
    name,
    version: validation.version,
    source: sourceLabel,
    localPath: localSkillPath,
    checksum: sha256(validation.raw),
    bytes: Buffer.byteLength(validation.raw, 'utf8'),
    loadedAt: new Date().toISOString(),
    active: true,
  };
  for (const k of Object.keys(registry.skills)) {
    if (k !== name) registry.skills[k].active = false;
  }
  saveRegistry(cwd, registry);
  fs.writeFileSync(activeSkillPath(cwd), JSON.stringify(registry.skills[name], null, 2));
  return { ok: true, name, source: sourceLabel, localPath: localSkillPath, version: validation.version };
}

function readActiveSkill(cwd = process.cwd()) {
  try {
    const p = activeSkillPath(cwd);
    if (!fs.existsSync(p)) return null;
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!meta || !meta.localPath || !fs.existsSync(meta.localPath)) return null;
    const content = fs.readFileSync(meta.localPath, 'utf8');
    return { ...meta, content };
  } catch {
    return null;
  }
}

function renderActiveSkillForPrompt(cwd = process.cwd(), maxBytes = DEFAULT_RENDER_BYTES) {
  const skill = readActiveSkill(cwd);
  if (!skill || !skill.content) return '';
  const body = String(skill.content || '').slice(0, Math.max(1000, Number(maxBytes) || DEFAULT_RENDER_BYTES));
  return `Active loaded skill (${skill.name}${skill.version ? ` v${skill.version}` : ''}) instructions:\n${body}`;
}

function listSkills(cwd = process.cwd()) {
  const r = loadRegistry(cwd);
  return Object.values(r.skills || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function unloadSkill(name, cwd = process.cwd()) {
  const n = safeName(name);
  const registry = loadRegistry(cwd);
  const entry = registry.skills[n];
  if (!entry) return { ok: false, error: `skill not found in registry: ${n}` };
  delete registry.skills[n];
  if (entry.localPath) {
    try { fs.rmSync(entry.localPath, { force: true }); } catch {}
  }
  const active = readActiveSkill(cwd);
  if (active && safeName(active.name) === n) {
    try { fs.rmSync(activeSkillPath(cwd), { force: true }); } catch {}
  }
  saveRegistry(cwd, registry);
  return { ok: true, name: n };
}

function skillStatus(cwd = process.cwd()) {
  const active = readActiveSkill(cwd);
  const all = listSkills(cwd);
  return {
    active: active ? {
      name: active.name,
      version: active.version || '1',
      source: active.source,
      loadedAt: active.loadedAt,
      bytes: active.bytes || Buffer.byteLength(String(active.content || ''), 'utf8'),
    } : null,
    total: all.length,
  };
}

async function installSkillFromUrl(url, cwd = process.cwd()) {
  let u;
  try { u = new URL(String(url || '')); } catch { return { ok: false, error: 'invalid URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'only http(s) URLs are supported' };

  async function resolveGitHubUrl(inputUrl) {
    try {
      const gu = new URL(inputUrl);
      if (!/^(www\.)?github\.com$/i.test(gu.host)) return inputUrl;
      const parts = gu.pathname.split('/').filter(Boolean);
      // /owner/repo/tree/ref/path...
      if (parts.length >= 5 && (parts[2] === 'tree' || parts[2] === 'blob')) {
        const owner = parts[0];
        const repo = parts[1];
        const ref = parts[3];
        const relPath = parts.slice(4).join('/');
        if (parts[2] === 'blob') {
          return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${relPath}`;
        }
        // tree: if direct markdown path, convert to raw
        if (/\.(md|markdown)$/i.test(relPath)) {
          return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${relPath}`;
        }
        // tree directory: discover SKILL.md first, then first markdown fallback
        const api = `https://api.github.com/repos/${owner}/${repo}/contents/${relPath}?ref=${encodeURIComponent(ref)}`;
        const resp = await fetch(api, { headers: { 'user-agent': 'aiterm-skill-installer/1.0' } });
        if (!resp.ok) return inputUrl;
        const arr = await resp.json();
        if (!Array.isArray(arr)) return inputUrl;
        const skillFile = arr.find((x) => x && x.type === 'file' && /^SKILL\.md$/i.test(String(x.name || '')) && x.download_url)
          || arr.find((x) => x && x.type === 'file' && /\.(md|markdown)$/i.test(String(x.name || '')) && x.download_url);
        return skillFile?.download_url || inputUrl;
      }
      return inputUrl;
    } catch {
      return inputUrl;
    }
  }

  const resolvedUrl = await resolveGitHubUrl(u.href);
  let finalUrl;
  try { finalUrl = new URL(resolvedUrl); } catch { finalUrl = u; }

  let text = '';
  try {
    const resp = await fetch(finalUrl.href, {
      headers: { 'user-agent': 'aiterm-skill-installer/1.0' },
    });
    if (!resp.ok) return { ok: false, error: `download failed: HTTP ${resp.status}` };
    text = await resp.text();
  } catch (e) {
    return { ok: false, error: `download failed: ${e.message}` };
  }

  const derived = safeName(path.basename(finalUrl.pathname || '', path.extname(finalUrl.pathname || '')) || 'downloaded-skill');
  return importSkillContent(text, finalUrl.href, cwd, derived);
}

module.exports = {
  loadSkillToWorkspace,
  importSkillContent,
  readActiveSkill,
  renderActiveSkillForPrompt,
  listSkills,
  unloadSkill,
  skillStatus,
  installSkillFromUrl,
  safeName,
};
