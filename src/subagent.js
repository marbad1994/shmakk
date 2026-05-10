// Auto-subagent planning pass. Runs short read-only sub-calls before the
// main agent loop to scope work, identify risks, and outline a plan.
// Extracted from agent.js.

const { modelFor } = require('./llm');

function shouldUseAutoSubagents(input, roots) {
  if (String(process.env.AITERM_AUTO_SUBAGENTS || '1') === '0') return false;
  const minLen = Math.max(40, Number(process.env.AITERM_AUTO_SUBAGENTS_MIN_INPUT_LEN) || 140);
  const maxRoots = Math.max(1, Number(process.env.AITERM_AUTO_SUBAGENTS_MAX_ROOTS) || 2);
  const s = String(input || '');
  const broadSignals = /(large|across|multiple|refactor|architecture|investigate|analyz|codebase|project-wide|compare)/i.test(s);
  return (s.length >= minLen && broadSignals) || (Array.isArray(roots) && roots.length >= maxRoots && s.length >= Math.floor(minLen * 0.7));
}

async function runAutoSubagents({ client, input, roots, signal }) {
  const n = Math.max(1, Math.min(3, Number(process.env.AITERM_AUTO_SUBAGENTS_COUNT) || 2));
  const focuses = [
    'Scope and likely target files/modules',
    'Risks, edge cases, and verification strategy',
    'Concrete step-by-step implementation plan with minimal reads',
  ].slice(0, n);

  const out = [];
  for (let i = 0; i < focuses.length; i++) {
    try {
      const r = await client.chat.completions.create({
        model: modelFor('agent'),
        temperature: 0,
        stream: false,
        tool_choice: 'none',
        messages: [
          { role: 'system', content: `You are subagent ${i + 1}. Read-only planning only. No tool calls. Be concise.` },
          { role: 'user', content: `Workspace roots: ${roots.join(', ')}\nTask: ${input}\nFocus: ${focuses[i]}\nReturn bullet points only.` },
        ],
      }, { signal });
      const text = String(r.choices?.[0]?.message?.content || '').trim();
      if (text) out.push(`Subagent ${i + 1} (${focuses[i]}):\n${text}`);
    } catch {}
  }
  return out.join('\n\n');
}

module.exports = { shouldUseAutoSubagents, runAutoSubagents };
