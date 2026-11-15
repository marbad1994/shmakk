// DSML leak detection, sanitization, streaming guard, and mutation-tool
// approval helpers.  Used by agent.js and tools.js.
//
// See BUGFUXPAND.md for the full rationale — this module is the runtime
// enforcement of every item in that document.

// ── DSML leak detection ─────────────────────────────────────────────────────

// DSML uses fullwidth vertical bars (U+FF5C): <｜DSML｜tool_calls>
// Also catches double-bar variants and <function=name> format.
const DSML_LEAK_RE =
  /<(?:\s*\/?\s*(?:[｜|]+\s*(?:DSML\s*)?[｜|]+\s*(?:tool_calls|invoke|parameter)\b|[｜|]+(?:\s*tool_calls|\s*invoke|\s*parameter)\b)|\s*function\s*=\s*[a-zA-Z0-9_]+)/i;

const DSML_TOOL_CALL_BLOCK_RE =
  /<(?:\s*[｜|]+\s*(?:DSML\s*)?[｜|]+\s*tool_calls\s*>|\s*[｜|]+\s*tool_calls\s*[｜|]*\s*>)[\s\S]*?<\s*\/\s*(?:[｜|]+\s*(?:DSML\s*)?[｜|]+|[｜|]+)\s*tool_calls\s*[｜|]*\s*>/gi;

/** Returns true when visible assistant text contains leaked internal tool
 *  markup that should never reach the user. */
function isLeakedToolMarkup(text) {
  return DSML_LEAK_RE.test(text);
}

/** Remove complete leaked DSML blocks so remaining visible text can be used
 *  if we decide to strip rather than block. */
function stripInternalToolMarkup(text) {
  return text.replace(DSML_TOOL_CALL_BLOCK_RE, "").trim();
}

/** One-stop sanitizer: returns clean visible text + a leak flag. */
function sanitizeAssistantContent(raw) {
  const hadInternalLeak = isLeakedToolMarkup(raw);
  const visibleText = stripInternalToolMarkup(raw);
  return { visibleText, hadInternalLeak };
}

// ── Streaming guard: lookbehind buffer ──────────────────────────────────────

const PARTIAL_INTERNAL_PREFIXES = [
  "<｜",
  "<|",
  "<｜｜",
  "<||",
  "<｜｜DSML",
  "<||DSML",
];

/** Returns true when `tail` could be the beginning of an internal markup
 *  string that hasn't finished streaming yet. */
function mightBecomeInternalMarkup(tail) {
  return PARTIAL_INTERNAL_PREFIXES.some(
    (prefix) => tail.endsWith(prefix) || prefix.startsWith(tail),
  );
}

// ── Mutation tool classification ───────────────────────────────────────────

const MUTATION_TOOLS = new Set([
  "edit_file",
  "write_file",
  "delete_file",
  "make_dir",
  "run",
]);

/** True when the named tool mutates the workspace or runs an external process. */
function isMutationTool(name) {
  return MUTATION_TOOLS.has(name);
}

// ── Args hashing (for approval validation) ──────────────────────────────────

const crypto = require("crypto");

function hashArgs(args) {
  const raw = typeof args === "string" ? args : JSON.stringify(args || {});
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ── Retry message ───────────────────────────────────────────────────────────

const DSML_RETRY_USER_MESSAGE = {
  role: "user",
  content:
    "Your previous response emitted internal tool markup as visible text. " +
    "Do not print DSML/XML/tool markup. Use only native structured tool " +
    "calls or normal user-visible text.",
};

module.exports = {
  DSML_LEAK_RE,
  DSML_TOOL_CALL_BLOCK_RE,
  PARTIAL_INTERNAL_PREFIXES,
  isLeakedToolMarkup,
  stripInternalToolMarkup,
  sanitizeAssistantContent,
  mightBecomeInternalMarkup,
  MUTATION_TOOLS,
  isMutationTool,
  hashArgs,
  DSML_RETRY_USER_MESSAGE,
};
