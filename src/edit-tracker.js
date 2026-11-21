// Session-scoped edit tracker. Records before/after content for every
// write_file and edit_file so the user can review changes later.
//
// Edits are keyed by a scope string so concurrent sessions in the same
// process stay isolated: a scope of `undefined`/'' falls back to a single
// default bucket (used by the CLI, which runs one session per process).

const byScope = new Map(); // scope -> [{ filePath, oldContent, newContent, tool, timestamp }]

function scopeKey(scope) {
  return scope ? String(scope) : '__default__';
}

function list(scope) {
  const key = scopeKey(scope);
  if (!byScope.has(key)) byScope.set(key, []);
  return byScope.get(key);
}

function recordEdit({ filePath, oldContent, newContent, tool, scope }) {
  list(scope).push({
    filePath,
    oldContent: oldContent ?? null,  // null means new file
    newContent,
    tool,
    timestamp: Date.now(),
  });
}

function getEdits(scope) { return list(scope); }
// Union of every scope's edits, for process-wide "files changed this session"
// counters that are intentionally not tied to one conversation.
function getEditsAll() { return [...byScope.values()].flat(); }
function hasEdits(scope) { return list(scope).length > 0; }
function clearEdits(scope) { byScope.set(scopeKey(scope), []); }
function editCount(scope) { return list(scope).length; }

module.exports = { recordEdit, getEdits, getEditsAll, hasEdits, clearEdits, editCount };
