// Convert sessions between Claude Code format and shmakk format.
//
// claude2shmakk: reads a Claude session directory (containing audit.jsonl
//   and the parent {sessionId}.json metadata) and imports it into shmakk's
//   SQLite session database and audit log.
//
// shmakk2claude: reads a shmakk session from its SQLite database and
//   exports it as a Claude-compatible session directory with audit.jsonl
//   and session JSON.
//
// Usage:
//   node src/session-convert.js claude2shmakk <claude-session-dir> [shmakk-session-id]
//   node src/session-convert.js shmakk2claude <shmakk-session-id> <output-dir>

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeShmakkSessionId() {
  const date = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${date}-${rand}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function uid() {
  return crypto.randomUUID();
}

// ── Claude audit.jsonl parsing ────────────────────────────────────────────

// Parse a Claude audit.jsonl file. Returns an array of normalized turns
// where each turn has { role, content, tool_calls, tool_results }.
// Multiple consecutive assistant content pieces are merged into one turn.
function parseClaudeAudit(jsonlPath) {
  const raw = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath),
    crlfDelay: Infinity,
  });

  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      try { raw.push(JSON.parse(line)); } catch {}
    });
    rl.on('close', () => resolve(normalizeClaudeLines(raw)));
    rl.on('error', reject);
  });
}

function normalizeClaudeLines(raw) {
  const turns = [];
  let pendingAssistant = null;

  // CLI system messages that we don't want as user turns
  const SKIP_USER_PREFIXES = [
    '<command-message>',
    '<command-name>',
    '<system-message>',
    '<bash-input>',
    '<bash-stdout>',
    '<bash-stderr>',
  ];

  function isSkippableUserContent(content) {
    if (typeof content !== 'string') return false;
    for (const prefix of SKIP_USER_PREFIXES) {
      if (content.startsWith(prefix)) return true;
    }
    return false;
  }

  function flushAssistant() {
    if (!pendingAssistant) return;
    const t = pendingAssistant;
    const hasText = t.parts.some(p => p.type === 'text' && p.text.trim());
    const hasToolCalls = t.parts.some(p => p.type === 'tool_use');

    // Drop empty assistant blocks and thinking-only blocks
    if (!hasText && !hasToolCalls) {
      pendingAssistant = null;
      return;
    }

    const turn = {
      role: 'assistant',
      content: t.parts.filter(p => p.type === 'text').map(p => p.text).join('') || null,
      reasoning: t.parts.filter(p => p.type === 'thinking').map(p => p.thinking).join('\n') || null,
      tool_calls: t.parts.filter(p => p.type === 'tool_use').map(p => ({
        id: p.id,
        name: p.name,
        input: p.input,
      })),
    };
    if (!turn.content && !turn.tool_calls.length) {
      pendingAssistant = null;
      return;
    }
    turns.push(turn);
    pendingAssistant = null;
  }

  for (const line of raw) {
    const msg = line.message;
    if (!msg) continue;

    if (line.type === 'user' && msg.role === 'user') {
      // Could be text or tool_result
      const content = msg.content;
      if (typeof content === 'string') {
        if (!isSkippableUserContent(content)) {
          flushAssistant();
          turns.push({ role: 'user', content, tool_calls: [], tool_results: [] });
        }
      } else if (Array.isArray(content)) {
        const toolResults = [];
        const userTexts = [];
        for (const part of content) {
          if (part.type === 'tool_result') {
            toolResults.push({
              tool_call_id: part.tool_use_id,
              content: part.content,
              is_error: part.is_error || false,
            });
          } else if (part.type === 'text') {
            userTexts.push(part.text);
          } else if (typeof part === 'string') {
            userTexts.push(part);
          }
        }
        flushAssistant();

        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            turns.push({
              role: 'tool',
              tool_call_id: tr.tool_call_id,
              content: tr.content,
              is_error: tr.is_error,
            });
          }
        }
        if (userTexts.length > 0) {
          turns.push({ role: 'user', content: userTexts.join('\n'), tool_calls: [], tool_results: [] });
        }
      }
    } else if (line.type === 'assistant') {
      // Accumulate parts into pendingAssistant
      if (!pendingAssistant) {
        pendingAssistant = { model: msg.model, parts: [] };
      }
      for (const part of msg.content) {
        pendingAssistant.parts.push(part);
      }
    }
    // Skip system, rate_limit_event, etc.
  }
  flushAssistant();

  return turns;
}

// ── Read Claude session metadata ──────────────────────────────────────────

function readClaudeSessionMeta(sessionDir) {
  const dirName = path.basename(sessionDir); // e.g. "local_2a11b98e-..."
  const parentDir = path.dirname(sessionDir);
  const jsonPath = path.join(parentDir, `${dirName}.json`);

  if (!fs.existsSync(jsonPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return {
      sessionId: meta.sessionId,
      title: meta.title || 'Untitled',
      cwd: meta.cwd || process.cwd(),
      workspaces: (meta.userSelectedFolders || []).slice(),
      model: meta.model || 'unknown',
      createdAt: meta.createdAt || Date.now(),
      lastActivityAt: meta.lastActivityAt || Date.now(),
    };
  } catch {
    return null;
  }
}

// ── claude2shmakk ─────────────────────────────────────────────────────────

async function claude2shmakk(claudeSessionDir, shmakkSessionId) {
  const sessionDir = path.resolve(claudeSessionDir);

  // Validate input
  const auditPath = path.join(sessionDir, 'audit.jsonl');
  if (!fs.existsSync(auditPath)) {
    // Try audit.json2 as fallback
    const altPath = path.join(sessionDir, 'audit.json2');
    if (fs.existsSync(altPath)) {
      // audit.json2 is same format, just rename reference
    } else {
      console.error(`No audit.jsonl found in ${sessionDir}`);
      process.exit(1);
    }
  }

  const actualAuditPath = fs.existsSync(auditPath) ? auditPath : path.join(sessionDir, 'audit.json2');

  // Read metadata
  const meta = readClaudeSessionMeta(sessionDir);
  const workspace = (meta && meta.workspaces && meta.workspaces.length > 0) ? meta.workspaces[0] : (meta ? meta.cwd : claudeSessionDir);

  // Parse audit
  console.error(`Parsing ${actualAuditPath}...`);
  const turns = await parseClaudeAudit(actualAuditPath);
  console.error(`Found ${turns.length} turns.`);

  // Generate session ID
  const sessionId = shmakkSessionId || makeShmakkSessionId();

  // Load shmakk modules
  const sessionSearch = require('./session-search');
  const audit = require('./audit');

  if (!sessionSearch.isAvailable()) {
    console.error('better-sqlite3 not available. Cannot write session.');
    console.error('Install with: npm install better-sqlite3');
    process.exit(1);
  }

  // Use public API for session management
  const startedAt = meta ? meta.createdAt : Date.now();
  const endTs = meta ? meta.lastActivityAt : Date.now() + 100;

  sessionSearch.recordSessionStart({ sessionId, workspace, pid: process.pid });

  // Use the same DB connection from session-search instead of opening a new one
  const db = sessionSearch.getDB();
  db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(startedAt, sessionId);

  // Write turns
  const insertTurn = db.prepare(
    'INSERT INTO turns (session_id, ts, role, content) VALUES (?, ?, ?, ?)'
  );

  let turnTs = startedAt;
  for (const turn of turns) {
    turnTs += 100; // 100ms between turns to preserve ordering

    if (turn.role === 'assistant') {
      const text = turn.content || '';
      if (text.trim()) {
        insertTurn.run(sessionId, turnTs, 'assistant', text.slice(0, 50000));
      }
      if (turn.tool_calls && turn.tool_calls.length > 0) {
        for (const tc of turn.tool_calls) {
          const tcText = `[tool_use: ${tc.name}] ${JSON.stringify(tc.input)}`;
          insertTurn.run(sessionId, turnTs + 1, 'assistant', tcText.slice(0, 50000));
        }
      }
    } else if (turn.role === 'user') {
      insertTurn.run(sessionId, turnTs, 'user', (turn.content || '').slice(0, 50000));
    } else if (turn.role === 'tool') {
      const toolText = `[tool_result: ${turn.is_error ? 'ERROR ' : ''}${turn.content || ''}]`;
      insertTurn.run(sessionId, turnTs, 'tool', toolText.slice(0, 50000));
    }
  }

  // Finalize session
  sessionSearch.recordSessionEnd({
    sessionId,
    summary: meta ? `Imported from Claude: ${meta.title}` : 'Imported from Claude',
  });
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endTs, sessionId);

  // Write to audit log
  audit.append({ kind: 'session-start', workspace, pinnedWorkspace: null, review: false, pid: process.pid, import: { from: 'claude', source: claudeSessionDir } });
  audit.append({ kind: 'session-end', exitCode: 0, import: true });

  // Don't close the shared DB connection — session-search owns it

  console.log(`Imported Claude session -> shmakk session ${sessionId}`);
  console.log(`  Title: ${meta ? meta.title : 'Unknown'}`);
  console.log(`  Turns: ${turns.length}`);
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Model: ${meta ? meta.model : 'unknown'}`);

  return sessionId;
}

// ── shmakk2claude ─────────────────────────────────────────────────────────

async function shmakk2claude(shmakkSessionId, outputDir) {
  const outDir = path.resolve(outputDir);
  ensureDir(outDir);

  // Load shmakk DB
  let D;
  try {
    D = require('better-sqlite3');
  } catch {
    console.error('better-sqlite3 not available.');
    process.exit(1);
  }

  const dbPath_ = path.join(os.homedir(), '.config', 'shmakk', 'sessions.db');
  if (!fs.existsSync(dbPath_)) {
    console.error('No shmakk session database found.');
    process.exit(1);
  }

  const db = new D(dbPath_, { readonly: true });
  db.pragma('journal_mode = WAL');

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(shmakkSessionId);
  if (!session) {
    console.error(`Session ${shmakkSessionId} not found.`);
    db.close();
    process.exit(1);
  }

  const turns = db.prepare(
    'SELECT * FROM turns WHERE session_id = ? ORDER BY ts, id'
  ).all(shmakkSessionId);

  db.close();

  // Generate Claude session ID
  const claudeSessionId = `local_${uid()}`;
  const cliSessionId = uid();

  // Create audit.jsonl
  const auditLines = [];
  const now = new Date().toISOString();

  // System init
  auditLines.push(JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: outDir,
    session_id: cliSessionId,
    tools: [], // shmakk tools not mapped
    _audit_timestamp: now,
  }));

  // Convert turns
  for (const turn of turns) {
    const ts = new Date(turn.ts).toISOString();
    const msgUuid = uid();

    if (turn.role === 'user') {
      auditLines.push(JSON.stringify({
        type: 'user',
        uuid: msgUuid,
        session_id: cliSessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: turn.content },
        _audit_timestamp: ts,
      }));
    } else if (turn.role === 'assistant') {
      // Check if this is a tool_use representation
      const toolMatch = turn.content.match(/^\[tool_use:\s*([^\]]+)\]\s*(.*)$/s);
      if (toolMatch) {
        let input = {};
        try { input = JSON.parse(toolMatch[2].trim()); } catch { input = { raw: toolMatch[2].trim() }; }
        auditLines.push(JSON.stringify({
          type: 'assistant',
          message: {
            model: 'unknown',
            id: `msg_${uid()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: `toolu_${uid()}`, name: toolMatch[1].trim(), input }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          parent_tool_use_id: null,
          session_id: cliSessionId,
          uuid: uid(),
          _audit_timestamp: ts,
        }));
      } else {
        auditLines.push(JSON.stringify({
          type: 'assistant',
          message: {
            model: 'unknown',
            id: `msg_${uid()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: turn.content }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          parent_tool_use_id: null,
          session_id: cliSessionId,
          uuid: uid(),
          _audit_timestamp: ts,
        }));
      }
    } else if (turn.role === 'tool') {
      const errMatch = turn.content.match(/^\[tool_result:\s*(ERROR\s*)?(.*?)\]$/s);
      const isError = !!errMatch && !!errMatch[1];
      const content = errMatch ? errMatch[2] : turn.content;

      auditLines.push(JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            content: content,
            is_error: isError,
            tool_use_id: null, // can't recover exact ID
          }],
        },
        parent_tool_use_id: null,
        session_id: cliSessionId,
        uuid: uid(),
        _audit_timestamp: ts,
      }));
    }
  }

  // Write audit.jsonl
  fs.writeFileSync(path.join(outDir, 'audit.jsonl'), auditLines.join('\n') + '\n');

  // Write session metadata JSON
  const sessionMeta = {
    sessionId: claudeSessionId,
    processName: `shmakk-import-${shmakkSessionId.slice(0, 8)}`,
    cliSessionId: cliSessionId,
    cwd: outDir,
    userSelectedFolders: session.workspace ? [session.workspace] : [],
    createdAt: session.started_at,
    lastActivityAt: session.ended_at || Date.now(),
    model: 'unknown',
    isArchived: false,
    title: session.summary || `Imported from shmakk: ${shmakkSessionId}`,
    hostLoopMode: false,
    webFetchAllowedUrls: [],
    slashCommands: [],
    enabledMcpTools: {},
    isAgentCompleted: true,
    accountName: 'shmakk-import',
    emailAddress: '',
  };

  fs.writeFileSync(
    path.join(outDir, `${claudeSessionId}.json`),
    JSON.stringify(sessionMeta, null, 2)
  );

  // Create session subdirectory
  const subDir = path.join(outDir, claudeSessionId);
  ensureDir(subDir);
  fs.writeFileSync(path.join(subDir, 'context.txt'), '');

  console.log(`Exported shmakk session ${shmakkSessionId} -> Claude session`);
  console.log(`  Output: ${outDir}`);
  console.log(`  Claude session ID: ${claudeSessionId}`);
  console.log(`  Turns: ${turns.length}`);
  console.log(`  Title: ${sessionMeta.title}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const direction = args[0];
  const source = args[1];
  const target = args[2];

  if (!direction || !source) {
    console.error('Usage:');
    console.error('  node src/session-convert.js claude2shmakk <claude-session-dir> [shmakk-session-id]');
    console.error('  node src/session-convert.js shmakk2claude <shmakk-session-id> <output-dir>');
    process.exit(1);
  }

  if (direction === 'claude2shmakk') {
    await claude2shmakk(source, target);
  } else if (direction === 'shmakk2claude') {
    if (!target) {
      console.error('Output directory required for shmakk2claude');
      process.exit(1);
    }
    await shmakk2claude(source, target);
  } else {
    console.error(`Unknown direction: ${direction}. Use claude2shmakk or shmakk2claude.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERROR:', e.message || e);
    if (process.env.SHMAKK_DEBUG) console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { claude2shmakk, shmakk2claude, parseClaudeAudit };
