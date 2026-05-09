const fs = require('fs');
const os = require('os');
const path = require('path');

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
  const skillsDir = path.join(cwd, '.aiterm', 'skills');
  const stateDir = path.join(cwd, '.aiterm', 'state');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const localSkillPath = path.join(skillsDir, `${n}.md`);
  fs.writeFileSync(localSkillPath, raw, 'utf8');
  fs.writeFileSync(path.join(stateDir, 'active-skill.json'), JSON.stringify({
    name: n,
    source: found,
    localPath: localSkillPath,
    loadedAt: new Date().toISOString(),
  }, null, 2));

  return { ok: true, name: n, source: found, localPath: localSkillPath };
}

function readActiveSkill(cwd = process.cwd()) {
  try {
    const p = path.join(cwd, '.aiterm', 'state', 'active-skill.json');
    if (!fs.existsSync(p)) return null;
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!meta || !meta.localPath || !fs.existsSync(meta.localPath)) return null;
    const content = fs.readFileSync(meta.localPath, 'utf8');
    return { ...meta, content };
  } catch {
    return null;
  }
}

module.exports = { loadSkillToWorkspace, readActiveSkill, safeName };
