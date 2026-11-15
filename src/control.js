// Control commands run from *inside* an shmakk session (the orchestrator
// puts its own PID in SHMAKK_PID for the child shell's environment).

function getParentPid() {
  const pid = parseInt(process.env.SHMAKK_PID || '0', 10);
  return pid > 0 ? pid : 0;
}

function profileSignalPath(pid) {
  return `/tmp/shmakk-profile-${pid}.txt`;
}

function taskJournalPath(cwd = process.cwd()) {
  return require('path').join(cwd, '.shmakk', 'state', 'task-journal.json');
}

function activeSkillMetaPath(cwd = process.cwd()) {
  return require('path').join(cwd, '.shmakk', 'state', 'active-skill.json');
}

function activePlanPath(cwd = process.cwd()) {
  return require('path').join(cwd, '.shmakk', 'state', 'active-plan.json');
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function status() {
  const pid = getParentPid();
  if (!pid) {
    process.stdout.write('shmakk: not running (this terminal is not inside shmakk)\n');
    return 1;
  }
  if (!isAlive(pid)) {
    process.stdout.write(`shmakk: stale SHMAKK_PID=${pid} (parent not alive)\n`);
    return 2;
  }
  process.stdout.write(`shmakk: running, parent pid ${pid}\n`);
  return 0;
}

function exitParent() {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('shmakk --exit: not inside an shmakk session\n');
    return 1;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) {
    process.stderr.write(`shmakk --exit: ${e.message}\n`); return 1;
  }
  return 0;
}

function restartParent() {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('shmakk --restart: not inside an shmakk session\n');
    return 1;
  }
  try { process.kill(pid, 'SIGUSR1'); } catch (e) {
    process.stderr.write(`shmakk --restart: ${e.message}\n`); return 1;
  }
  return 0;
}

function resetConversation() {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('shmakk --reset: not inside an shmakk session\n');
    return 1;
  }
  try { process.kill(pid, 'SIGUSR2'); } catch (e) {
    process.stderr.write(`shmakk --reset: ${e.message}\n`); return 1;
  }
  return 0;
}

function setProfileAndRestart(profileName) {
  const pid = getParentPid();
  if (!pid || !isAlive(pid)) {
    process.stderr.write('shmakk --profile-set: not inside an shmakk session\n');
    return 1;
  }
  const name = String(profileName || '').trim().toLowerCase();
  if (!name) {
    process.stderr.write('shmakk --profile-set: missing profile name\n');
    return 1;
  }
  try {
    require('fs').writeFileSync(profileSignalPath(pid), name + '\n', 'utf8');
    process.kill(pid, 'SIGUSR1');
  } catch (e) {
    process.stderr.write(`shmakk --profile-set: ${e.message}\n`);
    return 1;
  }
  return 0;
}

function resumeStatus() {
  const p = taskJournalPath();
  try {
    const fs = require('fs');
    if (!fs.existsSync(p)) {
      process.stdout.write('shmakk: no resume journal found\n');
      return 0;
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    process.stdout.write('shmakk resume status\n');
    process.stdout.write('--------------------\n');
    process.stdout.write(`status: ${j.status || 'unknown'}\n`);
    process.stdout.write(`profile: ${j.profile || 'unknown'}\n`);
    process.stdout.write(`updated: ${j.updatedAt || 'unknown'}\n`);
    process.stdout.write(`input: ${String(j.input || '').slice(0, 120)}\n`);
    process.stdout.write(`touched_files: ${Array.isArray(j.touchedFiles) ? j.touchedFiles.length : 0}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`shmakk --resume-status: ${e.message}\n`);
    return 1;
  }
}

function compactContext() {
  const pid = getParentPid();
  if (pid && isAlive(pid)) {
    try { process.kill(pid, 'SIGUSR2'); } catch (e) {
      process.stderr.write(`shmakk --compact: ${e.message}\n`);
      return 1;
    }
    process.stdout.write('shmakk: compact requested (conversation + task journal cleared)\n');
    return 0;
  }

  try {
    const fs = require('fs');
    fs.rmSync(taskJournalPath(), { force: true });
    process.stdout.write('shmakk: compacted local task journal (no active session)\n');
    return 0;
  } catch (e) {
    process.stderr.write(`shmakk --compact: ${e.message}\n`);
    return 1;
  }
}

function stats() {
  const fs = require('fs');
  const audit = require('./audit');
  const pid = getParentPid();
  const running = !!(pid && isAlive(pid));
  let journal = null;
  let activeSkill = null;
  let auditLines = 0;

  try {
    const p = taskJournalPath();
    if (fs.existsSync(p)) journal = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  try {
    const p = activeSkillMetaPath();
    if (fs.existsSync(p)) activeSkill = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  try {
    const p = audit.logPath();
    if (fs.existsSync(p)) auditLines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch {}

  process.stdout.write('shmakk stats\n');
  process.stdout.write('-----------\n');
  process.stdout.write(`session_running: ${running ? 'yes' : 'no'}\n`);
  process.stdout.write(`session_pid: ${running ? pid : 'n/a'}\n`);
  process.stdout.write(`resume_status: ${journal?.status || 'none'}\n`);
  process.stdout.write(`resume_updated: ${journal?.updatedAt || 'n/a'}\n`);
  process.stdout.write(`resume_touched_files: ${Array.isArray(journal?.touchedFiles) ? journal.touchedFiles.length : 0}\n`);
  process.stdout.write(`profile: ${journal?.profile || 'n/a'}\n`);
  process.stdout.write(`active_skill: ${activeSkill?.name || 'none'}\n`);
  process.stdout.write(`active_skill_loaded_at: ${activeSkill?.loadedAt || 'n/a'}\n`);
  process.stdout.write(`audit_events_total: ${auditLines}\n`);
  process.stdout.write('token_stats: unavailable (provider usage streaming not persisted yet)\n');
  return 0;
}

function loadSkill(name, global = false) {
  const skills = require('./skills');
  const fn = global ? skills.loadSkillGlobally : skills.loadSkillToWorkspace;
  const res = global ? fn(name) : fn(name, process.cwd());
  if (!res.ok) {
    process.stderr.write(`shmakk --load-skill: ${res.error}\n`);
    if (res.searched) process.stderr.write(`searched:\n- ${res.searched.join('\n- ')}\n`);
    return 1;
  }
  process.stdout.write(`shmakk: loaded skill '${res.name}' (${global ? 'global' : 'workspace'})\n`);
  process.stdout.write(`source: ${res.source}\n`);
  process.stdout.write(`local: ${res.localPath}\n`);
  return 0;
}

// listSkills(filter):
//   filter undefined → grouped summary by category (one line per category)
//   filter = '*'      → flat list of all skills with category tag
//   filter = '<cat>'  → only skills in the given category
function listSkills(filter) {
  const skills = require('./skills');
  const all = skills.listAllSkills(process.cwd());

  if (!all.length) {
    process.stdout.write('shmakk: no skills loaded\n');
    return 0;
  }

  const grouped = skills.groupByCategory(all);

  // Default: show category summary so the list isn't 80 lines.
  if (!filter) {
    process.stdout.write('shmakk skill categories\n');
    process.stdout.write('───────────────────────\n');
    for (const [cat, list] of grouped) {
      const info = skills.categoryInfo(cat);
      const label = info ? info.label : cat;
      const blurb = info ? info.blurb : '';
      process.stdout.write(`  ${cat.padEnd(13)} ${String(list.length).padStart(3)} skills   ${blurb}\n`);
    }
    process.stdout.write(`\nTotal: ${all.length} skills across ${grouped.size} categories.\n`);
    process.stdout.write('Use "list skills <category>" to expand, or "find skill <query>" to search.\n');
    return 0;
  }

  // Show a single category
  const wanted = String(filter).toLowerCase().trim();
  if (wanted === '*' || wanted === 'all') {
    process.stdout.write(`shmakk: all ${all.length} skills\n`);
    process.stdout.write('─────────────────\n');
    for (const [cat, list] of grouped) {
      const info = skills.categoryInfo(cat);
      const label = info ? info.label : cat;
      process.stdout.write(`\n[${label}]\n`);
      for (const s of list) {
        const tag = s.active ? ' [active]' : '';
        process.stdout.write(`  ${s.name.padEnd(22)} ${s.scope === 'workspace' ? '(ws)' : '    '}${tag}\n`);
      }
    }
    return 0;
  }

  const list = grouped.get(wanted);
  if (!list || !list.length) {
    process.stdout.write(`shmakk: no skills in category "${wanted}"\n`);
    process.stdout.write('\nAvailable categories:\n');
    for (const [cat, l] of grouped) {
      process.stdout.write(`  ${cat.padEnd(13)} ${l.length} skills\n`);
    }
    return 1;
  }

  const info = skills.categoryInfo(wanted);
  const label = info ? info.label : wanted;
  process.stdout.write(`shmakk skills · ${label} (${list.length})\n`);
  if (info && info.blurb) process.stdout.write(`${info.blurb}\n`);
  process.stdout.write('─────────────────────\n');
  for (const s of list) {
    const tag = s.active ? ' [active]' : '';
    const scope = s.scope === 'workspace' ? ' (workspace)' : '';
    process.stdout.write(`  ${s.name.padEnd(22)} v${s.version || '1'}${scope}${tag}\n`);
    if (s.description) {
      const desc = s.description.length > 100 ? s.description.slice(0, 100) + '…' : s.description;
      process.stdout.write(`    ${desc}\n`);
    }
  }
  return 0;
}

function listSkillCategories() {
  const skills = require('./skills');
  const all = skills.listAllSkills(process.cwd());
  const grouped = skills.groupByCategory(all);
  process.stdout.write('shmakk skill categories\n');
  process.stdout.write('───────────────────────\n');
  for (const [cat, list] of grouped) {
    const info = skills.categoryInfo(cat);
    const label = info ? info.label : cat;
    const blurb = info ? info.blurb : '';
    process.stdout.write(`  ${cat.padEnd(13)} ${String(list.length).padStart(3)} skills   ${blurb}\n`);
  }
  process.stdout.write(`\nTotal: ${all.length} skills across ${grouped.size} categories.\n`);
  return 0;
}

function findSkills(query) {
  const skills = require('./skills');
  const all = skills.listAllSkills(process.cwd());
  const hits = skills.searchSkills(query, all);
  if (!hits.length) {
    process.stdout.write(`shmakk: no skills match "${query}"\n`);
    return 1;
  }
  process.stdout.write(`shmakk: ${hits.length} skill${hits.length === 1 ? '' : 's'} matching "${query}"\n`);
  process.stdout.write('─────────────────────────\n');
  for (const s of hits) {
    process.stdout.write(`  ${s.name.padEnd(22)} [${s.category || 'general'}] v${s.version || '1'}\n`);
    if (s.description) {
      const desc = s.description.length > 120 ? s.description.slice(0, 120) + '…' : s.description;
      process.stdout.write(`    ${desc}\n`);
    }
  }
  return 0;
}

function skillStatus() {
  const skills = require('./skills');
  const wst = skills.skillStatus(process.cwd());
  const gst = skills.skillStatusGlobally();
  const total = wst.total + gst.total;
  const active = wst.active || gst.active;

  process.stdout.write('shmakk skill status\n');
  process.stdout.write('-------------------\n');
  process.stdout.write(`total: ${total}\n`);
  if (!active) {
    process.stdout.write('active: none\n');
    return 0;
  }
  process.stdout.write(`active: ${active.name}\n`);
  process.stdout.write(`version: ${active.version}\n`);
  process.stdout.write(`loaded_at: ${active.loadedAt || 'n/a'}\n`);
  process.stdout.write(`bytes: ${active.bytes || 0}\n`);
  process.stdout.write(`source: ${active.source || 'n/a'}\n`);
  return 0;
}

function unloadSkill(name) {
  const skills = require('./skills');
  // Try workspace first
  let res = skills.unloadSkill(name, process.cwd());
  let location = 'workspace';
  // If not in workspace, try global
  if (!res.ok) {
    res = skills.unloadSkillGlobally(name);
    location = 'global';
  }
  if (!res.ok) {
    process.stderr.write(`shmakk --unload-skill: ${res.error}\n`);
    return 1;
  }
  process.stdout.write(`shmakk: unloaded skill '${res.name}' from ${location}\n`);
  return 0;
}

async function installSkill(url, global = false) {
  const skills = require('./skills');
  const fn = global ? skills.installSkillFromUrlGlobally : skills.installSkillFromUrl;
  const res = global ? await fn(url) : await fn(url, process.cwd());
  if (!res.ok) {
    process.stderr.write(`shmakk --install-skill: ${res.error}\n`);
    return 1;
  }
  process.stdout.write(`shmakk: installed + loaded skill '${res.name}' (${global ? 'global' : 'workspace'})\n`);
  process.stdout.write(`source: ${res.source}\n`);
  process.stdout.write(`local: ${res.localPath}\n`);
  return 0;
}

function showPlan() {
  const fs = require('fs');
  const p = activePlanPath();
  try {
    if (!fs.existsSync(p)) {
      process.stdout.write('shmakk: no active plan\n');
      return 0;
    }
    const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
    const STATUS_CHAR = { completed: '✓', failed: '✗', skipped: '–', in_progress: '▸', pending: ' ' };
    process.stdout.write(`shmakk plan: ${plan.title}\n`);
    process.stdout.write(`status: ${plan.status || 'unknown'} · updated: ${(plan.updatedAt || '').slice(0, 19)}\n`);
    process.stdout.write('─'.repeat(44) + '\n');
    for (const t of plan.tasks || []) {
      const icon = STATUS_CHAR[t.status] || ' ';
      process.stdout.write(`  ${icon} ${t.id}. ${t.title}\n`);
    }
    const done = (plan.tasks || []).filter((t) => t.status === 'completed').length;
    const total = (plan.tasks || []).length;
    process.stdout.write(`\n${done}/${total} tasks completed\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`shmakk --show-plan: ${e.message}\n`);
    return 1;
  }
}

function mcpStatus() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const globalPath = path.join(os.homedir(), '.config', 'shmakk', 'mcp.json');
  const workspacePath = path.join(process.cwd(), '.shmakk', 'mcp.json');
  let globalConfig = null;
  let workspaceConfig = null;

  try {
    if (fs.existsSync(globalPath)) globalConfig = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  } catch {}
  try {
    if (fs.existsSync(workspacePath)) workspaceConfig = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
  } catch {}

  const globalServers = globalConfig?.mcpServers || {};
  const workspaceServers = workspaceConfig?.mcpServers || {};
  const merged = { ...globalServers, ...workspaceServers };
  const names = Object.keys(merged);

  process.stdout.write('shmakk MCP status\n');
  process.stdout.write('─────────────────\n');
  process.stdout.write(`config (global):    ${fs.existsSync(globalPath) ? globalPath : 'not found'}\n`);
  process.stdout.write(`config (workspace): ${fs.existsSync(workspacePath) ? workspacePath : 'not found'}\n`);
  process.stdout.write(`servers configured: ${names.length}\n`);

  if (!names.length) {
    process.stdout.write('\nNo MCP servers configured.\n');
    process.stdout.write(`Create ${globalPath} with:\n`);
    process.stdout.write('  { "mcpServers": { "name": { "command": "...", "args": [...] } } }\n');
    return 0;
  }

  process.stdout.write('\n');
  for (const name of names) {
    const cfg = merged[name];
    const disabled = cfg.disabled ? ' [disabled]' : '';
    const source = workspaceServers[name] ? 'workspace' : 'global';
    process.stdout.write(`  ${name}${disabled} (${source})\n`);
    process.stdout.write(`    command: ${cfg.command} ${(cfg.args || []).join(' ')}\n`);
    if (cfg.safety) process.stdout.write(`    safety:  ${cfg.safety}\n`);
    if (cfg.safeTools?.length) process.stdout.write(`    safe:    ${cfg.safeTools.join(', ')}\n`);
    if (cfg.env && Object.keys(cfg.env).length) {
      process.stdout.write(`    env:     ${Object.keys(cfg.env).join(', ')}\n`);
    }
  }

  process.stdout.write('\nNote: tool counts are only available during an active shmakk session.\n');
  return 0;
}

function consolidateWorkspace() {
  const fs = require('fs');
  const path = require('path');

  const cwd = process.cwd();
  const rootShmakk = path.join(cwd, '.shmakk');
  const rootSkills = path.join(rootShmakk, 'skills');
  const rootState = path.join(rootShmakk, 'state');

  // Ensure root .shmakk dirs exist
  fs.mkdirSync(rootShmakk, { recursive: true });
  fs.mkdirSync(rootSkills, { recursive: true });
  fs.mkdirSync(rootState, { recursive: true });

  // Find all nested .shmakk dirs (skip root itself, skip node_modules)
  const nested = [];
  function walk(dir, depth) {
    if (depth > 50) return; // safety limit
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === '.shmakk' && depth > 0) {
        nested.push(full);
      } else if (!e.name.startsWith('.')) {
        walk(full, depth + 1);
      }
    }
  }
  walk(cwd, 0);

  if (!nested.length) {
    process.stdout.write('shmakk: no nested .shmakk directories found to consolidate\n');
    return 1;
  }

  process.stdout.write(`shmakk: found ${nested.length} nested .shmakk director${nested.length > 1 ? 'ies' : 'y'}\n`);

  let mergedSkills = 0;
  let mergedMemory = 0;
  let mergedRules = 0;
  let mergedMcp = 0;
  let mergedHosts = 0;
  let mergedState = 0;

  // Helper: read file if exists
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  // Helper: read JSON if exists
  const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

  // Helper: write JSON
  const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

  // Helper: append line-deduplicated content (for memory.md, rules.md)
  function mergeLines(rootFile, nestedFile) {
    const rootContent = read(rootFile) || '';
    const rootLines = new Set(rootContent.split('\n').map(l => l.trim()).filter(Boolean));
    const nestedContent = read(nestedFile);
    if (!nestedContent) return 0;
    const newLines = nestedContent.split('\n')
      .map(l => l.trim())
      .filter(l => Boolean(l) && !rootLines.has(l));
    if (!newLines.length) return 0;
    const append = (rootContent.endsWith('\n') ? '' : '\n') + newLines.join('\n') + '\n';
    fs.appendFileSync(rootFile, append);
    return newLines.length;
  }

  // Helper: merge JSON objects shallowly (root wins)
  function mergeJSON(rootFile, nestedFile) {
    const root = readJSON(rootFile) || {};
    const nested = readJSON(nestedFile);
    if (!nested) return 0;
    let added = 0;
    for (const [k, v] of Object.entries(nested)) {
      if (!(k in root)) { root[k] = v; added++; }
    }
    if (added > 0) writeJSON(rootFile, root);
    return added;
  }

  for (const nsm of nested) {
    const rel = path.relative(cwd, path.dirname(nsm)) || '(root)';
    process.stdout.write(`  merging ${rel}/.shmakk/\n`);

    // memory.md
    const memRoot = path.join(rootShmakk, 'memory.md');
    const memNested = path.join(nsm, 'memory.md');
    const memAdded = mergeLines(memRoot, memNested);
    if (memAdded) process.stdout.write(`    memory.md: +${memAdded} line(s)\n`);
    mergedMemory += memAdded;

    // rules.md
    const rulesRoot = path.join(rootShmakk, 'rules.md');
    const rulesNested = path.join(nsm, 'rules.md');
    const rulesAdded = mergeLines(rulesRoot, rulesNested);
    if (rulesAdded) process.stdout.write(`    rules.md: +${rulesAdded} line(s)\n`);
    mergedRules += rulesAdded;

    // skills/*.md
    const skillsNested = path.join(nsm, 'skills');
    if (fs.existsSync(skillsNested)) {
      let entries;
      try { entries = fs.readdirSync(skillsNested, { withFileTypes: true }); } catch { entries = []; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md')) {
          const dst = path.join(rootSkills, e.name);
          if (!fs.existsSync(dst)) {
            fs.copyFileSync(path.join(skillsNested, e.name), dst);
            process.stdout.write(`    skills/${e.name}: copied\n`);
            mergedSkills++;
          }
        } else if (e.isDirectory()) {
          const skillFile = path.join(skillsNested, e.name, 'SKILL.md');
          const dstDir = path.join(rootSkills, e.name);
          const dstFile = path.join(dstDir, 'SKILL.md');
          if (fs.existsSync(skillFile) && !fs.existsSync(dstFile)) {
            fs.mkdirSync(dstDir, { recursive: true });
            fs.copyFileSync(skillFile, dstFile);
            // Also copy sibling files if any
            let subEntries;
            try { subEntries = fs.readdirSync(path.join(skillsNested, e.name)); } catch { subEntries = []; }
            for (const se of subEntries) {
              const srcSub = path.join(skillsNested, e.name, se);
              const dstSub = path.join(dstDir, se);
              if (se !== 'SKILL.md' && !fs.existsSync(dstSub)) {
                try { fs.copyFileSync(srcSub, dstSub); } catch {}
              }
            }
            process.stdout.write(`    skills/${e.name}/: copied\n`);
            mergedSkills++;
          }
        }
      }
    }

    // mcp.json
    const mcpRoot = path.join(rootShmakk, 'mcp.json');
    const mcpNested = path.join(nsm, 'mcp.json');
    const mcpRootObj = readJSON(mcpRoot) || {};
    const mcpNestedObj = readJSON(mcpNested);
    if (mcpNestedObj?.mcpServers) {
      if (!mcpRootObj.mcpServers) mcpRootObj.mcpServers = {};
      let added = 0;
      for (const [k, v] of Object.entries(mcpNestedObj.mcpServers)) {
        if (!(k in mcpRootObj.mcpServers)) {
          mcpRootObj.mcpServers[k] = v;
          added++;
        }
      }
      if (added) {
        writeJSON(mcpRoot, mcpRootObj);
        process.stdout.write(`    mcp.json: +${added} server(s)\n`);
        mergedMcp += added;
      }
    }

    // hosts.json
    const hostsRoot = path.join(rootShmakk, 'hosts.json');
    const hostsNested = path.join(nsm, 'hosts.json');
    const hAdded = mergeJSON(hostsRoot, hostsNested);
    if (hAdded) {
      process.stdout.write(`    hosts.json: +${hAdded} host(s)\n`);
      mergedHosts += hAdded;
    }

    // state/* — merge/copy all state files from nested into root
    const stateNested = path.join(nsm, 'state');
    if (fs.existsSync(stateNested)) {
      let stateEntries;
      try { stateEntries = fs.readdirSync(stateNested, { withFileTypes: true }); } catch { stateEntries = []; }
      for (const se of stateEntries) {
        if (!se.isFile()) continue;
        const src = path.join(stateNested, se.name);
        const dst = path.join(rootState, se.name);

        // command-freq.json: merge maps, root wins
        if (se.name === 'command-freq.json') {
          const rootObj = readJSON(dst) || {};
          const nestedObj = readJSON(src);
          if (nestedObj) {
            let added = 0;
            for (const [k, v] of Object.entries(nestedObj)) {
              if (!(k in rootObj)) { rootObj[k] = v; added++; }
            }
            if (added) {
              writeJSON(dst, rootObj);
              process.stdout.write(`    state/${se.name}: +${added} command(s)\n`);
              mergedState += added;
            }
          }
          continue;
        }

        // task-journal.json: merge arrays deduped by id
        if (se.name === 'task-journal.json') {
          const rootArr = readJSON(dst) || [];
          const nestedArr = readJSON(src);
          if (Array.isArray(nestedArr) && nestedArr.length) {
            const rootIds = new Set(rootArr.map(e => e.id || JSON.stringify(e)));
            const newEntries = nestedArr.filter(e => !rootIds.has(e.id || JSON.stringify(e)));
            if (newEntries.length) {
              rootArr.push(...newEntries);
              writeJSON(dst, rootArr);
              process.stdout.write(`    state/${se.name}: +${newEntries.length} task(s)\n`);
              mergedState += newEntries.length;
            }
          }
          continue;
        }

        // Any other JSON file: shallow merge, root wins
        if (se.name.endsWith('.json')) {
          const rootObj = readJSON(dst) || {};
          const nestedObj = readJSON(src);
          if (nestedObj && typeof nestedObj === 'object') {
            let added = 0;
            if (Array.isArray(nestedObj)) {
              const rootJson = JSON.stringify(rootObj);
              for (const item of nestedObj) {
                if (rootJson.indexOf(JSON.stringify(item)) === -1) {
                  rootObj.push(item);
                  added++;
                }
              }
            } else {
              for (const [k, v] of Object.entries(nestedObj)) {
                if (!(k in rootObj)) { rootObj[k] = v; added++; }
              }
            }
            if (added) {
              writeJSON(dst, rootObj);
              process.stdout.write(`    state/${se.name}: +${added} entry(ies)\n`);
              mergedState += added;
            }
          }
          continue;
        }

        // Non-JSON files: copy if not already in root
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          process.stdout.write(`    state/${se.name}: copied\n`);
          mergedState++;
        }
      }
    }
  }

  // Remove nested .shmakk dirs after successful merge
  for (const nsm of nested) {
    try { fs.rmSync(nsm, { recursive: true, force: true }); } catch {}
  }

  // Summary
  const total = mergedMemory + mergedRules + mergedSkills + mergedMcp + mergedHosts + mergedState;
  process.stdout.write('\nshmakk: consolidation complete\n');
  process.stdout.write(`  memory:      ${mergedMemory} line(s)\n`);
  process.stdout.write(`  rules:       ${mergedRules} line(s)\n`);
  process.stdout.write(`  skills:      ${mergedSkills} file(s)\n`);
  process.stdout.write(`  mcp.json:    ${mergedMcp} server(s)\n`);
  process.stdout.write(`  hosts.json:  ${mergedHosts} host(s)\n`);
  process.stdout.write(`  state:       ${mergedState} entry(ies)\n`);
  process.stdout.write(`  total merged: ${total}\n`);
  process.stdout.write(`\nshmakk: removed ${nested.length} nested .shmakk director${nested.length > 1 ? 'ies' : 'y'}\n`);

  return 0;
}

module.exports = { status, exitParent, restartParent, resetConversation, setProfileAndRestart, profileSignalPath, resumeStatus, compactContext, stats, loadSkill, listSkills, listSkillCategories, findSkills, skillStatus, unloadSkill, installSkill, showPlan, mcpStatus, consolidateWorkspace };
