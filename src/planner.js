// Planner — handles approval-first execution for very large multi-day projects.
// Most work is handled by:
//   - Team PM agent: decomposes multi-agent tasks, runs agents in parallel/pipeline
//   - Single agent: handles individual tasks directly
//
// Planner only triggers for enormous projects (500+ chars with explicit scope signals).
// Use '+' prefix to force planning, '!' prefix to skip it.
//
// Flow (rare):
//   session receives input
//     → shouldPlan(input)? only for massive projects
//     → generatePlan(input) → plan JSON
//     → user approves
//     → execute tasks via agents

const fs = require('fs');
const path = require('path');
const { makeClient, modelFor } = require('./llm');

// Questions and conversational inputs that should bypass planning.
// These get direct answers from the agent without plan overhead.
const SKIP_PLAN = [
  // Wh-questions: "what does X do", "how does Y work"
  /^(?:what|how|why|when|where|who|which)\s+(?:is|are|does|do|did|was|were|can|could|should|would|will)\b/i,
  // Ends with question mark (most natural questions)
  /\?$/,
  // Explanation requests without action
  /^(?:explain|describe|tell\s+me\s+(?:about|what|how)|show\s+me\s+(?:what|how)|what\s+is\s+(?:a\s+)?|what\s+are\s+|how\s+does\s+|how\s+do\s+)/i,
  // Conversational acknowledgements
  /^(?:yes|no|ok|okay|sure|thanks|thank\s+you|got\s+it|sounds\s+good|alright|great|perfect|cool|nice|agreed)\b/i,
  // Very short (one-liners under 30 chars almost never need a plan)
];

// Action verbs that signal multi-step implementation work — these get a plan.
// Excludes read-only queries and trivial modifications.
const PLAN_SIGNALS = [
  // Create/build work (substantial)
  /\b(?:add|create|build|implement|write|develop|generate)\b/i,
  // Debugging (substantial)
  /\b(?:debug|resolve|solve|diagnose)\b/i,
  // Refactoring (substantial, multi-file)
  /\b(?:refactor|rewrite|migrate|restructure|reorganize)\b/i,
  // Infrastructure (substantial)
  /\b(?:set\s+up|configure|install|integrate|deploy|connect|wire\s+up)\b/i,
  // Removal/cleanup (needs care)
  /\b(?:remove|delete|purge)\b/i,
  // Testing (substantial)
  /\b(?:test|spec|coverage)\b/i,
];

// Multi-word phrases that indicate complexity (plan these if 60+ chars)
const COMPLEXITY_SIGNALS = [
  /\b(?:multiple|across)\s+(?:files|modules|components)\b/i,
  /\bfrom\s+scratch\b/i,
  /\b(?:end.to.end|integration)\b/i,
  /\b(?:architecture|design|system)\b/i,
  /\b(?:migration|upgrade|conversion)\b/i,
];

// shouldPlan returns true only for very large, multi-day projects.
// The team PM agent handles planning for multi-agent tasks.
// Single agents handle most work directly without explicit plans.
// Prefix input with '!' to bypass, or '+' to force planning.
function shouldPlan(input) {
  const text = String(input || '').trim();
  if (text.startsWith('!')) return false;          // explicit bypass
  if (text.startsWith('+')) return true;           // force plan

  // Skip conversational inputs
  if (SKIP_PLAN.some((p) => p.test(text))) return false;

  // Only plan for enormous multi-day projects with explicit scope signals
  // Most reasonable work goes to team PM (multi-agent) or single agent
  const isLargeScope = text.length > 500 && (
    /\b(?:build|create|implement).+(?:from\s+scratch|complete|entire)/i.test(text) ||
    /\b(?:multi-day|week|sprint|phase)/i.test(text) ||
    /\b(?:migrate|rewrite|refactor).*\b(?:entire|complete|whole|full|comprehensive)\b/i.test(text)
  );

  return isLargeScope;
}

// generatePlan calls the LLM to decompose the user's request into a plan.
// Returns a plan object or throws.
async function generatePlan(input, { signal, model: modelOverride } = {}) {
  const client = makeClient('agent');
  const model = modelOverride || modelFor('agent');

  // Estimate complexity: longer requests with more context likely need more steps
  const textLen = String(input).length;
  const hasCode = /```|file:/.test(input);
  const hasMultiFile = /multiple\s+files|several\s+files|across\s+files/i.test(input);

  let maxSteps = 3;
  if (textLen > 150) maxSteps = 4;
  if (textLen > 300 || hasCode) maxSteps = 5;
  if (hasMultiFile) maxSteps = 6;

  const systemPrompt = `You are a planning assistant that decomposes tasks into ordered, minimal steps.
Each step must be:
- Atomic: completable in one focused session
- Specific: clear about what action and why
- Ordered: each step builds on the previous

Be concise. Avoid unnecessary steps. Group related work together.
Output ONLY valid JSON. No prose.`;

  const userPrompt = `Break this task into ${Math.min(maxSteps, 6)} or fewer ordered steps (minimum 2):

"${input}"

Output format (JSON only):
{
  "title": "Short overall goal (under 60 chars)",
  "tasks": [
    {
      "id": "1",
      "title": "Short action title (under 10 words)",
      "description": "What this step does and why"
    }
  ]
}`;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    stream: false,
  }, { signal });

  const raw = response.choices?.[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('plan generation returned no valid JSON');

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.tasks) || !parsed.tasks.length) {
    throw new Error('plan has no tasks');
  }

  return {
    id: Math.random().toString(36).slice(2, 10),
    title: String(parsed.title || 'Plan').slice(0, 80),
    status: 'pending_approval',
    currentTaskIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    originalRequest: String(input).slice(0, 500),
    tasks: parsed.tasks.slice(0, 15).map((t, i) => ({
      id: String(t.id || i + 1),
      title: String(t.title || `Step ${i + 1}`).slice(0, 100),
      description: String(t.description || '').slice(0, 300),
      status: 'pending',
      completedAt: null,
    })),
  };
}

// formatPlan produces a terminal-friendly plan display string.
function formatPlan(plan) {
  const STATUS_ICON = {
    completed: '\x1b[32m✓\x1b[0m',
    failed:    '\x1b[31m✗\x1b[0m',
    skipped:   '\x1b[33m–\x1b[0m',
    in_progress: '\x1b[36m▸\x1b[0m',
    pending:   ' ',
  };
  const sep = '─'.repeat(44);
  const lines = [
    '',
    `\x1b[1mPLAN: ${plan.title}\x1b[0m`,
    sep,
  ];
  for (const t of plan.tasks) {
    const icon = STATUS_ICON[t.status] || ' ';
    lines.push(`  ${icon} ${t.id}. ${t.title}`);
    if (t.description) {
      lines.push(`       \x1b[2m${t.description}\x1b[0m`);
    }
  }
  lines.push('');
  return lines.join('\r\n');
}

// Plan persistence — stored separately from the task journal so --show-plan
// can read it without interfering with per-task resume behavior.

function activePlanPath(root) {
  return path.join(root, '.shmakk', 'state', 'active-plan.json');
}

function savePlan(root, plan) {
  try {
    const p = activePlanPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...plan, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

function loadPlan(root) {
  try {
    const p = activePlanPath(root);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function clearPlan(root) {
  try { fs.rmSync(activePlanPath(root), { force: true }); } catch {}
}

module.exports = { shouldPlan, generatePlan, formatPlan, savePlan, loadPlan, clearPlan, activePlanPath };
