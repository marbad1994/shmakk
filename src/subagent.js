const { modelFor } = require('./llm');

// Auto-subagent planning pass. Runs short read-only sub-calls before the
// main agent loop to scope work, identify risks, and outline a plan.
// Extracted from agent.js.
//
// Force triggers: phrases like "use agent team", "team mode", "pm mode",
// "agent mode", "multi-agent", or "subagent mode" always enable subagents
// regardless of heuristics or SHMAKK_AUTO_SUBAGENTS=0.

const FORCE_SUBAGENTS = /(\buse\s+agent\s+team\b|\bteam\s+mode\b|\bpm\s+mode\b|\bagent\s+mode\b|\bmulti.?agent\b|\bsub.?agent\s+mode\b)/i;

// True when the user explicitly asked for the planning pass. Shared with the
// planner so an explicit request becomes a review-gated plan instead of a
// silent, invisible hint.
function isForcedSubagents(input) {
  return FORCE_SUBAGENTS.test(String(input || ''));
}

function shouldUseAutoSubagents(input, roots) {
  // Force team/PM mode when the user explicitly requests it, regardless of
  // auto-detection heuristics or SHMAKK_AUTO_SUBAGENTS env override.
  if (isForcedSubagents(input)) {
    return true;
  }
  if (String(process.env.SHMAKK_AUTO_SUBAGENTS || '1') === '0') return false;
  const minLen = Math.max(40, Number(process.env.SHMAKK_AUTO_SUBAGENTS_MIN_INPUT_LEN) || 140);
  const maxRoots = Math.max(1, Number(process.env.SHMAKK_AUTO_SUBAGENTS_MAX_ROOTS) || 2);
  const s = String(input || '');
  const broadSignals = /(large|across|multiple|refactor|architecture|investigate|analyz|codebase|project-wide|compare)/i.test(s);
  return (s.length >= minLen && broadSignals) || (Array.isArray(roots) && roots.length >= maxRoots && s.length >= Math.floor(minLen * 0.7));
}

// runAutoSubagents runs the read-only planning sub-calls in sequence and
// returns their findings joined as text. `onProgress` receives structured
// phase events (start / done / error) so callers can surface the pass
// instead of leaving it invisible. Errors are reported, never swallowed.
async function runAutoSubagents({ client, input, roots, signal, onProgress }) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const n = Math.max(1, Math.min(3, Number(process.env.SHMAKK_AUTO_SUBAGENTS_COUNT) || 2));
  const focuses = [
    'Scope and likely target files/modules',
    'Risks, edge cases, and verification strategy',
    'Concrete step-by-step implementation plan with minimal reads',
  ].slice(0, n);

  const total = focuses.length;
  const safeInput = String(input || '').replace(/[\r\n]+/g, ' ').trim();
  const safeRoots = (roots || []).map(r => String(r).replace(/[\r\n]+/g, ' ')).filter(Boolean);

  const out = [];
  for (let i = 0; i < focuses.length; i++) {
    const index = i + 1;
    const focus = focuses[i];
    const startedAt = Date.now();
    report({ phase: 'start', index, total, focus });
    try {
      const r = await client.chat.completions.create({
        model: modelFor('subagent-planning'),
        temperature: 0,
        stream: false,
        tool_choice: 'none',
        messages: [
          { role: 'system', content: `You are subagent ${index}. Read-only planning only. No tool calls. Be concise.` },
          { role: 'user', content: `Workspace roots: ${safeRoots.join(', ')}\nTask: ${safeInput}\nFocus: ${focus}\nReturn bullet points only.` },
        ],
      }, { signal });
      const text = String(r.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('empty response');
      out.push(`Subagent ${index} (${focus}):\n${text}`);
      report({ phase: 'done', index, total, focus, text, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      report({ phase: 'error', index, total, focus, error: err && err.message ? err.message : String(err) });
    }
  }
  return out.join('\n\n');
}

module.exports = { shouldUseAutoSubagents, isForcedSubagents, runAutoSubagents };
