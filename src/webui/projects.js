// Projects group conversations from any mode (chat, code, design, cowork).
// A project carries its own instructions and one switch — `shareContext` —
// that decides whether its conversations can see each other's work.

const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_CONTEXT_CHARS = 7000;
const MAX_SIBLINGS = 8;

function filePath() { return path.join(store.stateDir(), 'projects.json'); }

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function save(list) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const tmp = `${filePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, filePath());
  } catch {}
}

const COLORS = ['green', 'blue', 'violet', 'amber', 'rose'];

function clean(patch, base = {}) {
  const out = { ...base };
  if (typeof patch.name === 'string' && patch.name.trim()) out.name = patch.name.trim().slice(0, 80);
  if (typeof patch.description === 'string') out.description = patch.description.trim().slice(0, 400);
  if (typeof patch.instructions === 'string') out.instructions = patch.instructions.slice(0, 8000);
  if (typeof patch.shareContext === 'boolean') out.shareContext = patch.shareContext;
  if (typeof patch.color === 'string' && COLORS.includes(patch.color)) out.color = patch.color;
  if (typeof patch.workspace === 'string') out.workspace = patch.workspace.trim() || null;
  return out;
}

function createProjects() {
  let list = load();
  return {
    list: () => list.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    get: (id) => list.find((p) => p.id === id) || null,
    create(patch) {
      const now = Date.now();
      const p = clean(patch, {
        id: store.newId('p'), name: 'Untitled project', description: '', instructions: '', shareContext: true,
        color: COLORS[list.length % COLORS.length], workspace: null, createdAt: now, updatedAt: now,
      });
      list.push(p);
      save(list);
      return p;
    },
    update(id, patch) {
      const i = list.findIndex((p) => p.id === id);
      if (i === -1) return null;
      list[i] = { ...clean(patch, list[i]), updatedAt: Date.now() };
      save(list);
      return list[i];
    },
    remove(id) {
      const before = list.length;
      list = list.filter((p) => p.id !== id);
      save(list);
      return list.length !== before;
    },
  };
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Text injected into a conversation's system prompt.
//   • Project instructions always apply.
//   • With shareContext on, a digest of the project's other conversations is
//     added, so e.g. a code chat knows what the design chat decided.
// siblings: [{ id, title, mode, updatedAt, items, designDir, designFiles, workspace }]
function buildContext(project, conv, siblings) {
  if (!project) return '';
  const out = [`## Project: ${project.name}`];
  if (project.description) out.push(project.description);
  if (project.instructions && project.instructions.trim()) out.push(`### Project instructions (always follow)\n${project.instructions.trim()}`);

  if (project.shareContext) {
    const others = siblings.filter((s) => s.id !== conv.id).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SIBLINGS);
    if (others.length) {
      const lines = ['### Shared context — other conversations in this project', 'Treat these as background from your teammates. Build on them; do not redo their work.'];
      const budget = Math.floor((MAX_CONTEXT_CHARS - 600) / others.length);
      for (const s of others) {
        const items = s.items || [];
        const lastUser = [...items].reverse().find((i) => i.type === 'user');
        const lastReply = [...items].reverse().find((i) => i.type === 'assistant' && !i.interim && i.text);
        const part = [`- [${s.mode}] “${clip(s.title, 80)}”`];
        if (s.mode === 'design' && s.designDir) part.push(`  design files (readable): ${s.designDir}${s.designFiles && s.designFiles.length ? ` → ${s.designFiles.slice(0, 8).join(', ')}` : ''}`);
        if (s.mode !== 'design' && s.mode !== 'chat' && s.workspace) part.push(`  workspace: ${s.workspace}`);
        if (lastUser) part.push(`  last request: ${clip(lastUser.text, Math.min(300, budget / 3))}`);
        if (lastReply) part.push(`  latest reply: ${clip(lastReply.text, Math.max(200, budget - 420))}`);
        lines.push(part.join('\n'));
      }
      out.push(lines.join('\n'));
    }
  }
  return out.join('\n\n').slice(0, MAX_CONTEXT_CHARS);
}

module.exports = { createProjects, buildContext, COLORS };
