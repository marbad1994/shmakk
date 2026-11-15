// Self-command detection — lets users type natural language like "list skills"
// instead of "shmakk --list-skills". Intercepted before the correction engine
// so it never hits the LLM.
//
// Each entry has:
//   patterns  — array of RegExp to match against input
//   action    — string key used by executeSelfCommand()
//   needsArg  — if true, the first capture group is passed as the arg
//   confirm   — if true, ask the user before executing (destructive commands)
//
// executeSelfCommand(match, write, ctx) accepts an optional ctx object:
//   ctx.opts      — mutable session opts (review, colors, debug, etc.)
//   ctx.HELP      — help text string from cli.js
//   ctx.setColors — fn(bool) to update the session color closure variable

const SELF_COMMANDS = [
  // ── Help ──
  {
    patterns: [
      /^(?:show\s+)?help$/i,
      /^what\s+can\s+(?:you|shmakk)\s+do[\s?]*$/i,
      /^how\s+does\s+(?:this|shmakk)\s+work[\s?]*$/i,
      /^(?:list\s+)?commands[\s?]*$/i,
      /^shmakk\s+help$/i,
    ],
    action: 'show-help',
  },

  // ── Skills ──
  // Default "list skills" shows category summary, not the 80-item flat list.
  {
    patterns: [/^(?:list|show|my)\s+skills?$/i, /^what\s+skills?\s+(?:do\s+I\s+have|are\s+(?:loaded|available|there))[\s?]*$/i, /^skills?$/i],
    action: 'list-skills',
  },
  // "list skills <category>" or "list skills all/*"
  {
    patterns: [
      /^(?:list|show)\s+skills?\s+(\S+)$/i,
      /^skills?\s+in\s+(\S+)$/i,
    ],
    action: 'list-skills-cat',
    needsArg: true,
  },
  // "list skill categories" — show all categories with counts
  {
    patterns: [
      /^(?:list|show)\s+skills?\s+categor(?:y|ies)$/i,
      /^skills?\s+categor(?:y|ies)$/i,
      /^categor(?:y|ies)$/i,
    ],
    action: 'list-skill-categories',
  },
  // "find skill <query>" — full-text-ish search
  {
    patterns: [
      /^find\s+skills?\s+(.+)$/i,
      /^search\s+skills?\s+(.+)$/i,
    ],
    action: 'find-skill',
    needsArg: true,
  },
  {
    patterns: [/^skill\s+status$/i],
    action: 'skill-status',
  },
  {
    patterns: [/^load\s+skill\s+(\S+)$/i],
    action: 'load-skill',
    needsArg: true,
  },
  {
    patterns: [/^unload\s+skill\s+(\S+)$/i],
    action: 'unload-skill',
    needsArg: true,
  },

  // ── Plan ──
  {
    patterns: [/^(?:show|current|view)\s+plan$/i, /^plan\s+(?:status|progress)$/i, /^plan$/i],
    action: 'show-plan',
  },

  // ── Agent overview ──
  {
    patterns: [
      /^(?:show\s+)?(?:agent\s+)?overview$/i,
      /^what\s+(?:agents?|specialists?)\s+(?:are|is)\s+(?:working|running|active)[\s?]*$/i,
      /^who\s+(?:is\s+)?working[\s?]*$/i,
      /^team\s+(?:status|overview)$/i,
    ],
    action: 'agent-overview',
  },
  // "agent skills" — show skills used by agents
  {
    patterns: [
      /^agent\s+skills?$/i,
      /^(?:show\s+)?agent\s+skills?$/i,
    ],
    action: 'agent-skills',
  },
  // "agent <role|id>" — drill into a specific agent
  {
    patterns: [
      /^agent\s+(\S[\s\S]*)$/i,
      /^show\s+agent\s+(\S[\s\S]*)$/i,
      /^(?:detail|inspect|follow)\s+agent\s+(\S[\s\S]*)$/i,
    ],
    action: 'agent-detail',
    needsArg: true,
  },

  // ── Session ──
  // NOTE: Bare "status", "stats" etc. are NOT intercepted — they may be
  // real shell commands. Use /status, /stats, shmakk status, etc. instead.
  {
    patterns: [/^status$/i],
    action: 'status',
  },
  {
    patterns: [/^stats$/i, /^session\s+stats$/i],
    action: 'stats',
  },
  {
    patterns: [/^resume\s+status$/i],
    action: 'resume-status',
  },
  {
    patterns: [/^(?:show|print|current)\s+config$/i, /^what(?:'s|\s+is)\s+(?:my\s+)?config[\s?]*$/i],
    action: 'print-config',
  },

  // ── MCP ──
  {
    patterns: [/^mcp\s+(?:status|servers?)$/i, /^(?:show\s+)?mcp$/i],
    action: 'mcp-status',
  },

  // ── Rules ──
  {
    patterns: [
      /^(?:show|list|view|my)\s+rules?$/i,
      /^rules?\s+(?:status|info)$/i,
      /^rules?$/i,
      /^what\s+(?:are\s+)?(?:my\s+)?rules?[\s?]*$/i,
    ],
    action: 'show-rules',
  },

  // ── Recall / session search (FTS5) ──
  {
    patterns: [
      /^recall\s+(.+)$/i,
      /^remember\s+when\s+(.+)$/i,
    ],
    action: 'recall',
    needsArg: true,
  },
  {
    patterns: [
      /^find\s+session(?:s)?\s+(.+)$/i,
      /^search\s+sessions?\s+(.+)$/i,
      /^search\s+history\s+(.+)$/i,
    ],
    action: 'find-session',
    needsArg: true,
  },
  {
    patterns: [
      /^(?:show\s+)?(?:last\s+|recent\s+)?sessions?$/i,
      /^sessions?$/i,
    ],
    action: 'last-sessions',
  },
  {
    patterns: [
      /^search\s+(?:db|database)\s+(?:status|info|stats)$/i,
      /^session\s+(?:db|database|search)\s+(?:status|stats)$/i,
    ],
    action: 'search-db-status',
  },

  // ── Memory ──
  {
    patterns: [
      /^(?:show|view|list|my)\s+memor(?:y|ies)$/i,
      /^memor(?:y|ies)\s+(?:status|info)$/i,
      /^memor(?:y|ies)$/i,
      /^what\s+(?:do\s+)?(?:i|you)\s+remember[\s?]*$/i,
    ],
    action: 'show-memory',
  },
  {
    patterns: [/^forget\s+(.+)$/i],
    action: 'forget-memory',
    needsArg: true,
    confirm: true,
  },

  // ── Workflows ──
  {
    patterns: [
      /^(?:list|show|view)\s+workflows?$/i,
      /^workflows?$/i,
      /^what\s+workflows?\s+(?:are\s+)?(?:available|there)[\s?]*$/i,
    ],
    action: 'list-workflows',
  },
  {
    patterns: [/^run\s+workflow\s+(\S+)$/i, /^workflow\s+(\S+)$/i],
    action: 'run-workflow',
    needsArg: true,
  },

  // ── Agents / specialists ──
  {
    patterns: [
      /^(?:list|show|view)\s+(?:agents?|specialists?|roles?)$/i,
      /^(?:agents?|specialists?)$/i,
      /^who\s+(?:can\s+)?(?:help|do\s+the\s+work)[\s?]*$/i,
    ],
    action: 'list-agents',
  },

  // ── Set model ──
  {
    patterns: [
      /^set\s+model\s+to\s+(\S+)$/i,
      /^use\s+model\s+(\S+)$/i,
      /^change\s+model\s+to\s+(\S+)$/i,
      /^model\s+(\S+)$/i,
    ],
    action: 'set-model',
    needsArg: true,
  },

  // ── Set base URL ──
  {
    patterns: [
      /^set\s+(?:base\s+)?url\s+to\s+(\S+)$/i,
      /^use\s+api\s+at\s+(\S+)$/i,
      /^set\s+(?:api\s+)?endpoint\s+to\s+(\S+)$/i,
      /^point\s+(?:to|at)\s+(\S+)$/i,
    ],
    action: 'set-base-url',
    needsArg: true,
  },

  // ── Set API key ──
  {
    patterns: [
      /^set\s+api\s+key\s+to\s+(\S+)$/i,
      /^use\s+api\s+key\s+(\S+)$/i,
    ],
    action: 'set-api-key',
    needsArg: true,
  },

  // ── Endpoint switching ──
  {
    patterns: [
      /^(?:list|show)\s+endpoints?$/i,
      /^endpoints?$/i,
    ],
    action: 'list-endpoints',
  },
  {
    patterns: [
      /^(?:use|switch\s+to|set)\s+endpoint\s+(\S+)$/i,
      /^use\s+(\S+)$/i,
    ],
    action: 'use-endpoint',
    needsArg: true,
  },

  // ── Review mode ──
  {
    patterns: [
      /^(?:enable|turn\s+on|start|use)\s+review(?:\s+mode)?$/i,
      /^review(?:\s+mode)?\s+on$/i,
    ],
    action: 'enable-review',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|stop)\s+review(?:\s+mode)?$/i,
      /^review(?:\s+mode)?\s+off$/i,
      /^auto(?:\s+mode)?$/i,
    ],
    action: 'disable-review',
  },

  // ── Correction ──
  {
    patterns: [
      /^(?:enable|turn\s+on)\s+correction$/i,
      /^correction\s+on$/i,
    ],
    action: 'enable-correction',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|no)\s+correction$/i,
      /^correction\s+off$/i,
    ],
    action: 'disable-correction',
  },

  // ── Yes-files ──
  {
    patterns: [
      /^(?:enable|turn\s+on)\s+yes[\s-]files?$/i,
      /^yes[\s-]files?\s+on$/i,
      /^auto[\s-]?accept\s+files?$/i,
    ],
    action: 'enable-yes-files',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off)\s+yes[\s-]files?$/i,
      /^yes[\s-]files?\s+off$/i,
    ],
    action: 'disable-yes-files',
  },

  // ── Notify ──
  {
    patterns: [
      /^(?:enable|turn\s+on)\s+notify$/i,
      /^notify\s+on$/i,
    ],
    action: 'enable-notify',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|no)\s+notify$/i,
      /^notify\s+off$/i,
    ],
    action: 'disable-notify',
  },

  // ── Colors ──
  {
    patterns: [
      /^(?:enable|turn\s+on)\s+colou?rs?$/i,
      /^colou?rs?\s+on$/i,
    ],
    action: 'enable-colors',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|no)\s+colou?rs?$/i,
      /^colou?rs?\s+off$/i,
    ],
    action: 'disable-colors',
  },

  // ── Debug ──
  {
    patterns: [
      /^(?:enable|turn\s+on)\s+debug(?:\s+mode)?$/i,
      /^debug(?:\s+mode)?\s+on$/i,
    ],
    action: 'enable-debug',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|no)\s+debug(?:\s+mode)?$/i,
      /^debug(?:\s+mode)?\s+off$/i,
    ],
    action: 'disable-debug',
  },

  // ── Voice modes ──
  {
    patterns: [
      /^(?:enable|turn\s+on|start)\s+stt$/i,
      /^stt\s+on$/i,
      /^(?:enable|turn\s+on|start)\s+speech[-\s]?to[-\s]?text$/i,
      /^(?:enable|turn\s+on|start)\s+voice(?:\s+input)?$/i,
      /^voice(?:\s+input)?\s+on$/i,
    ],
    action: 'enable-stt',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|stop)\s+stt$/i,
      /^stt\s+off$/i,
      /^(?:disable|turn\s+off|stop)\s+speech[-\s]?to[-\s]?text$/i,
      /^(?:disable|turn\s+off|stop)\s+voice(?:\s+input)?$/i,
      /^voice(?:\s+input)?\s+off$/i,
    ],
    action: 'disable-stt',
  },
  {
    patterns: [
      /^(?:enable|turn\s+on|start)\s+tts$/i,
      /^tts\s+on$/i,
      /^(?:enable|turn\s+on|start)\s+text[-\s]?to[-\s]?speech$/i,
      /^(?:enable|turn\s+on|start)\s+spoken\s+responses?$/i,
    ],
    action: 'enable-tts',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|stop)\s+tts$/i,
      /^tts\s+off$/i,
      /^(?:disable|turn\s+off|stop)\s+text[-\s]?to[-\s]?speech$/i,
      /^(?:disable|turn\s+off|stop)\s+spoken\s+responses?$/i,
    ],
    action: 'disable-tts',
  },
  {
    patterns: [
      /^(?:enable|turn\s+on|start)\s+sts$/i,
      /^sts\s+on$/i,
      /^(?:enable|turn\s+on|start)\s+speech[-\s]?to[-\s]?speech$/i,
      /^(?:enable|turn\s+on|start)\s+always[-\s]?on\s+voice$/i,
    ],
    action: 'enable-sts',
  },
  {
    patterns: [
      /^(?:disable|turn\s+off|stop)\s+sts$/i,
      /^sts\s+off$/i,
      /^(?:disable|turn\s+off|stop)\s+speech[-\s]?to[-\s]?speech$/i,
      /^(?:disable|turn\s+off|stop)\s+always[-\s]?on\s+voice$/i,
    ],
    action: 'disable-sts',
  },

  // ── Profile ──
  {
    patterns: [
      /^(?:set\s+profile\s+to|use\s+profile|switch\s+profile\s+to)\s+(\S+)$/i,
      /^profile\s+(tiny|balanced|deep|builder|large-app)$/i,
    ],
    action: 'set-profile',
    needsArg: true,
    confirm: true,
  },

  // ── Destructive (need confirmation) ──
  {
    patterns: [/^compact(?:\s+context)?$/i, /^clear\s+context$/i],
    action: 'compact',
    confirm: true,
  },
  {
    patterns: [/^reset(?:\s+conversation)?$/i],
    action: 'reset',
    confirm: true,
  },

  // ── Workspace consolidation ──
  {
    patterns: [
      /^consolidate\s+workspace$/i,
      /^merge\s+workspace$/i,
      /^merge\s+\.shmakk$/i,
      /^consolidate\s+\.shmakk$/i,
    ],
    action: 'consolidate-workspace',
    confirm: true,
  },

  // ── Edit review ──
  {
    patterns: [
      /^(?:go\s+through|review|show|view)\s+(?:the\s+)?(?:edits?|changes?|diffs?)$/i,
      /^(?:show|view)\s+(?:the\s+)?diffs?$/i,
      /^edits?$/i,
    ],
    action: 'review-edits',
  },

  // ── Sidebar (meta / out-of-band query) ──
  // "Sidebar: what files did you touch?" runs the agent with full context
  // but the query and response are never added to conversation history.
  // Use this for meta-questions, status checks, and side-channel queries.
  {
    patterns: [
      /^Sidebar:\s*(.+)$/i,
      /^sidebar\s+(.+)$/i,
    ],
    action: 'sidebar-query',
    needsArg: true,
  },

  // ── Vibedit ──
  // Visual editing workflow: screenshot running app → vision LLM analysis
  // → structured functional description → PM team delegation.
  // Accepts a natural language request (e.g. "make the header blue").
  {
    patterns: [
      /^\/?vibedit\s+(.+)$/i,
      /^shmakk\s+vibedit\s+(.+)$/i,
    ],
    action: 'vibedit',
    needsArg: true,
  },

  // ── Vibedit Electron ──
  // Visual editing overlay connected to a live Electron desktop app via CDP.
  {
    patterns: [
      /^\/?vibedit[\s-]electron\s*(.*)$/i,
      /^shmakk\s+vibedit[\s-]electron\s*(.*)$/i,
      /^\/?ve\s*(.*)$/i,
    ],
    action: 'vibedit-electron',
    needsArg: true,
  },
];

// Self-command prefixes accepted by the shell:
//   /cmd          — e.g. /status, /sessions, /compact
//   shmakk cmd    — e.g. shmakk status, shmakk show sessions
// Bare words like "status" are NOT intercepted (they go to the shell).
const SELF_PREFIX_RE = /^\/(.+)$/;
const SHMAKK_PREFIX_RE = /^shmakk\s+(.+)$/i;

function hasSelfCommandPrefix(input) {
  const text = String(input || '').trim();
  return SELF_PREFIX_RE.test(text) || SHMAKK_PREFIX_RE.test(text);
}

function stripSelfCommandPrefix(input) {
  const text = String(input || '').trim();
  let m = SELF_PREFIX_RE.exec(text);
  if (m) return m[1].trim();
  m = SHMAKK_PREFIX_RE.exec(text);
  if (m) return m[1].trim();
  return text;
}

function matchSelfCommand(input) {
  const text = String(input || '').trim();
  if (!text) return { matched: false };

  // Try matching with prefix stripped first (for /status, shmakk status, etc.)
  const stripped = stripSelfCommandPrefix(text);
  if (stripped !== text) {
    for (const entry of SELF_COMMANDS) {
      for (const pattern of entry.patterns) {
        const m = pattern.exec(stripped);
        if (m) {
          return {
            matched: true,
            action: entry.action,
            arg: entry.needsArg && m[1] ? m[1].trim() : null,
            confirm: !!entry.confirm,
          };
        }
      }
    }
    return { matched: false };
  }

  // Multi-word natural-language commands (no prefix needed).
  // Single bare words are NOT matched — they could be real shell commands.
  const wordCount = text.split(/\s+/).length;
  if (wordCount >= 2) {
    for (const entry of SELF_COMMANDS) {
      for (const pattern of entry.patterns) {
        const m = pattern.exec(text);
        if (m) {
          return {
            matched: true,
            action: entry.action,
            arg: entry.needsArg && m[1] ? m[1].trim() : null,
            confirm: !!entry.confirm,
          };
        }
      }
    }
  }

  return { matched: false };
}

// ctx is optional: { opts, HELP, setColors }
function executeSelfCommand(match, write, ctx = {}) {
  // Update terminal tab title so self-command activity is visible from other tabs
  const label = match.action.replace(/-/g, ' ');
  write(`\x1b]0;${label} — shmakk\x07`);
  const ctl = require('./control');
  const opts = ctx.opts || {};

  switch (match.action) {

    // ── Help ──
    case 'show-help': {
      const helpText = ctx.HELP_SESSION_SUMMARY || ctx.HELP_SUMMARY || ctx.HELP || '[shmakk] help text not available';
      write(helpText.replace(/\n/g, '\r\n'));
      break;
    }

    // ── Skills ──
    case 'list-skills':         ctl.listSkills(); break;
    case 'list-skills-cat':     ctl.listSkills(match.arg); break;
    case 'list-skill-categories': ctl.listSkillCategories(); break;
    case 'find-skill':          ctl.findSkills(match.arg); break;
    case 'skill-status':  ctl.skillStatus(); break;
    case 'load-skill':    ctl.loadSkill(match.arg); break;
    case 'unload-skill':  ctl.unloadSkill(match.arg); break;

    // ── Plan ──
    case 'show-plan':     ctl.showPlan(); break;

    // ── Agent overview ──
    case 'agent-overview': {
      const overview = require('./agent-overview');
      const agents = overview.getAll();
      const lines = overview.formatOverview(agents);
      for (const line of lines) write(line + '\r\n');
      break;
    }
    case 'agent-detail': {
      const overview = require('./agent-overview');
      const query = (match.arg || '').trim();
      // Try exact id match first, then role match
      let agent = overview.get(query);
      if (!agent) {
        const byRole = overview.findByRole(query);
        if (byRole.length === 1) {
          agent = byRole[0];
        } else if (byRole.length > 1) {
          write(`\x1b[36m[shmakk]\x1b[0m ${byRole.length} agents match "\x1b[1m${query}\x1b[0m":\r\n`);
          for (const a of byRole) {
            const icon = overview.statusIcon(a.status);
            write(`  ${icon} \x1b[36m${a.id}\x1b[0m  \x1b[2m${a.role} · ${a.status}\x1b[0m\r\n`);
          }
          write(`\r\n\x1b[2mUse "agent <id>" to drill into a specific one.\x1b[0m\r\n`);
          break;
        }
      }
      if (!agent) {
        write(`\x1b[33m[shmakk] no agent found matching "\x1b[1m${query}\x1b[0m"\r\n`);
        write(`\x1b[2mTry "agent overview" to see all agents.\x1b[0m\r\n`);
        break;
      }
      const lines = overview.formatAgentDetail(agent);
      for (const line of lines) write(line + '\r\n');
      break;
    }
    case 'agent-skills': {
      const overview = require('./agent-overview');
      const agents = overview.getAll();
      if (!agents.length) {
        write('\x1b[2mNo agents registered.\x1b[0m\r\n');
        break;
      }
      const skillMap = new Map();
      for (const a of agents) {
        if (!a.skill) continue;
        if (!skillMap.has(a.skill)) {
          skillMap.set(a.skill, { skill: a.skill, source: a.skillSource, agents: [] });
        }
        skillMap.get(a.skill).agents.push(a.role);
      }
      if (!skillMap.size) {
        write('\x1b[2mNo skills used by agents (all using roster hints).\x1b[0m\r\n');
        break;
      }
      write(`\x1b[1mAgent Skills\x1b[0m\r\n\r\n`);
      for (const [name, info] of skillMap) {
        const roles = [...new Set(info.agents)].join(', ');
        write(`  \x1b[36m${name}\x1b[0m  \x1b[2mused by: ${roles}\x1b[0m\r\n`);
        if (info.source) write(`    \x1b[2msource: ${info.source}\x1b[0m\r\n`);
      }
      break;
    }

    // ── Session ──
    case 'status':        ctl.status(); break;
    case 'stats':         ctl.stats(); break;
    case 'resume-status': ctl.resumeStatus(); break;
    case 'mcp-status':    ctl.mcpStatus(); break;
    case 'compact':       ctl.compactContext(); break;
    case 'reset':         ctl.resetConversation(); break;
    case 'consolidate-workspace': ctl.consolidateWorkspace(); break;

    case 'show-rules': {
      const { loadRules, rulesStatus } = require('./rules');
      const status = rulesStatus();
      write(`\x1b[36m[shmakk] rule files:\x1b[0m\r\n`);
      write(`  global:    ${status.globalPath} ${status.globalExists ? `(${status.globalBytes} bytes)` : '\x1b[2m(missing)\x1b[0m'}\r\n`);
      write(`  workspace: ${status.workspacePath} ${status.workspaceExists ? `(${status.workspaceBytes} bytes)` : '\x1b[2m(not set)\x1b[0m'}\r\n`);
      const rules = loadRules();
      if (!rules) {
        write(`\r\n\x1b[2m[shmakk] no rules loaded. Create ${status.globalPath} or .shmakk/rules.md in your workspace.\x1b[0m\r\n`);
      } else {
        write(`\r\n${rules.replace(/\n/g, '\r\n')}\r\n`);
      }
      break;
    }

    case 'recall': {
      const sessionSearch = require('./session-search');
      if (!sessionSearch.isAvailable()) {
        write('\x1b[33m[shmakk] cross-session search unavailable — install with: npm install better-sqlite3\x1b[0m\r\n');
        break;
      }
      const hits = sessionSearch.searchTurns(match.arg, { limit: 10 });
      if (!hits.length) {
        write(`\x1b[33m[shmakk] no matches for "${match.arg}"\x1b[0m\r\n`);
        break;
      }
      const grouped = sessionSearch.expandHits(hits);
      write(`\x1b[36m[shmakk] found ${hits.length} hits across ${grouped.length} sessions:\x1b[0m\r\n\r\n`);
      for (const g of grouped.slice(0, 5)) {
        const date = new Date(g.startedAt).toLocaleString();
        write(`\x1b[1m${g.sessionId}\x1b[0m  \x1b[2m${date} · ${g.workspace || 'unknown workspace'}\x1b[0m\r\n`);
        for (const h of g.hits.slice(0, 3)) {
          // Strip bracket markers from snippet and re-add ANSI underline
          const snip = String(h.snippet || '').replace(/\[(.*?)\]/g, '\x1b[4m$1\x1b[24m');
          write(`  \x1b[2m${h.role}:\x1b[0m ${snip}\r\n`);
        }
        write('\r\n');
      }
      if (grouped.length > 5) write(`\x1b[2m... and ${grouped.length - 5} more sessions. Use "find session ${match.arg}" for the full list.\x1b[0m\r\n`);
      break;
    }

    case 'find-session': {
      const sessionSearch = require('./session-search');
      if (!sessionSearch.isAvailable()) {
        write('\x1b[33m[shmakk] cross-session search unavailable — install with: npm install better-sqlite3\x1b[0m\r\n');
        break;
      }
      const hits = sessionSearch.searchTurns(match.arg, { limit: 50 });
      if (!hits.length) {
        write(`\x1b[33m[shmakk] no matches for "${match.arg}"\x1b[0m\r\n`);
        break;
      }
      const grouped = sessionSearch.expandHits(hits, 0);
      write(`\x1b[36m[shmakk] ${grouped.length} session${grouped.length === 1 ? '' : 's'} match "${match.arg}":\x1b[0m\r\n\r\n`);
      for (const g of grouped) {
        const date = new Date(g.startedAt).toLocaleString();
        write(`  \x1b[1m${g.sessionId}\x1b[0m  \x1b[2m${date}  · ${g.hits.length} hit${g.hits.length === 1 ? '' : 's'}\x1b[0m\r\n`);
        write(`  \x1b[2m  ${g.workspace || 'unknown workspace'}\x1b[0m\r\n`);
      }
      break;
    }

    case 'last-sessions': {
      const sessionSearch = require('./session-search');
      if (!sessionSearch.isAvailable()) {
        write('\x1b[33m[shmakk] cross-session search unavailable — install with: npm install better-sqlite3\x1b[0m\r\n');
        break;
      }
      const sessions = sessionSearch.listSessions({ limit: 10 });
      if (!sessions.length) {
        write('\x1b[2m[shmakk] no recorded sessions yet\x1b[0m\r\n');
        break;
      }
      write(`\x1b[36m[shmakk] recent sessions:\x1b[0m\r\n\r\n`);
      for (const s of sessions) {
        const started = new Date(s.started_at).toLocaleString();
        const dur = s.ended_at ? `${Math.round((s.ended_at - s.started_at) / 1000)}s` : '\x1b[33mactive\x1b[0m';
        write(`  \x1b[1m${s.id}\x1b[0m  \x1b[2m${started}  · ${s.turn_count} turns · ${dur}\x1b[0m\r\n`);
        write(`  \x1b[2m  ${s.workspace || 'unknown'}\x1b[0m\r\n`);
      }
      break;
    }

    case 'search-db-status': {
      const sessionSearch = require('./session-search');
      const stats = sessionSearch.dbStats();
      if (!stats.available) {
        write('\x1b[33m[shmakk] session search DB unavailable\x1b[0m\r\n');
        if (stats.error) write(`  reason: ${stats.error}\r\n`);
        write('  install with: \x1b[1mnpm install better-sqlite3\x1b[0m\r\n');
        break;
      }
      write('\x1b[36m[shmakk] session search DB:\x1b[0m\r\n');
      write(`  path:     ${stats.path}\r\n`);
      write(`  sessions: ${stats.sessions}\r\n`);
      write(`  turns:    ${stats.turns}\r\n`);
      write(`  files:    ${stats.files}\r\n`);
      if (stats.oldest) write(`  oldest:   ${new Date(stats.oldest).toLocaleString()}\r\n`);
      if (stats.newest) write(`  newest:   ${new Date(stats.newest).toLocaleString()}\r\n`);
      break;
    }

    case 'show-memory': {
      const { loadMemory, memoryStatus } = require('./memory');
      const status = memoryStatus();
      write(`\x1b[36m[shmakk] memory files:\x1b[0m\r\n`);
      write(`  global:    ${status.globalPath} ${status.globalExists ? `(${status.globalBytes} bytes)` : '\x1b[2m(empty)\x1b[0m'}\r\n`);
      write(`  workspace: ${status.workspacePath} ${status.workspaceExists ? `(${status.workspaceBytes} bytes)` : '\x1b[2m(empty)\x1b[0m'}\r\n`);
      const mem = loadMemory();
      if (!mem) {
        write(`\r\n\x1b[2m[shmakk] memory is empty. The agent will write facts here via the "remember" tool as it discovers them.\x1b[0m\r\n`);
      } else {
        write(`\r\n${mem.replace(/\n/g, '\r\n')}\r\n`);
      }
      break;
    }

    case 'forget-memory': {
      const { forgetMemory } = require('./memory');
      const r = forgetMemory(match.arg);
      if (r.removed === 0) {
        write(`\x1b[33m[shmakk] no memory entries matched "${match.arg}"\x1b[0m\r\n`);
      } else {
        write(`\x1b[32m[shmakk] forgot ${r.removed} memory entr${r.removed === 1 ? 'y' : 'ies'} matching "${match.arg}"\x1b[0m\r\n`);
      }
      break;
    }

    case 'list-workflows': {
      const { listWorkflows } = require('./workflows');
      const all = listWorkflows();
      write(`\x1b[36m[shmakk] available workflows (${all.length}):\x1b[0m\r\n\r\n`);
      for (const w of all) {
        write(`  \x1b[1m${w.id.padEnd(22)}\x1b[0m \x1b[2m(${w.topology}, ${w.steps} steps)\x1b[0m\r\n`);
        write(`  \x1b[2m${w.description}\x1b[0m\r\n\r\n`);
      }
      write(`\x1b[2mRun one with: "run workflow <name>" or describe your task and the PM will auto-match.\x1b[0m\r\n`);
      break;
    }

    case 'run-workflow': {
      const { getWorkflow } = require('./workflows');
      const wf = getWorkflow(match.arg);
      if (!wf) {
        write(`\x1b[31m[shmakk] no workflow named "${match.arg}"\x1b[0m\r\n`);
        write(`\x1b[2mUse "list workflows" to see available templates.\x1b[0m\r\n`);
        break;
      }
      write(`\x1b[36m[shmakk] workflow "${wf.id}" defined:\x1b[0m\r\n\r\n`);
      write(`  topology: ${wf.topology}\r\n`);
      write(`  steps:    ${wf.steps.length}\r\n\r\n`);
      for (let i = 0; i < wf.steps.length; i++) {
        const s = wf.steps[i];
        write(`  ${i + 1}. \x1b[36m${s.role.padEnd(10)}\x1b[0m ${s.task.replace(/\{input\}/g, '<your task description>')}\r\n`);
      }
      write(`\r\n\x1b[2mTo execute: describe what you want the workflow to do and the PM will run it automatically.\x1b[0m\r\n`);
      write(`\x1b[2mExample: "${wf.triggers && wf.triggers[0] ? wf.triggers[0].source.replace(/\\b|\(|\)|\?|\|/g, '').slice(0, 40) : wf.id.replace(/-/g, ' ')}"\x1b[0m\r\n`);
      break;
    }

    case 'list-agents': {
      const { AGENT_ROSTER } = require('./team');
      const roles = Object.keys(AGENT_ROSTER);
      write(`\x1b[36m[shmakk] agent roster (${roles.length} specialists):\x1b[0m\r\n\r\n`);
      for (const role of roles) {
        const spec = AGENT_ROSTER[role];
        const firstLine = spec.hint.trim().split('\n').find((l) => l.startsWith('Specialist:')) || `Specialist: ${role}`;
        write(`  \x1b[1m${role.padEnd(10)}\x1b[0m \x1b[2m[${spec.profile}]\x1b[0m  ${firstLine.replace(/^Specialist:\s*/, '')}\r\n`);
      }
      write(`\r\n\x1b[2mThe PM picks from these automatically. Use "list workflows" to see pre-built templates.\x1b[0m\r\n`);
      break;
    }

    case 'print-config': {
      const cfg = {
        workspace: process.cwd(),
        shell: process.env.SHELL,
        baseUrl: process.env.SHMAKK_BASE_URL || null,
        model: process.env.SHMAKK_MODEL || null,
        review: opts.review || false,
        colors: opts.colors !== false,
        noCorrection: opts.noCorrection || false,
        yesFiles: opts.yesFiles || false,
        debug: opts.debug || false,
        profile: opts.profile || null,
      };
      write(JSON.stringify(cfg, null, 2).replace(/\n/g, '\r\n') + '\r\n');
      break;
    }

    // ── Set model ──
    case 'set-model': {
      const model = match.arg;
      process.env.SHMAKK_MODEL = model;
      write(`[shmakk] model → ${model}\r\n`);
      write('[shmakk] takes effect on the next agent invocation\r\n');
      break;
    }

    // ── Set base URL ──
    case 'set-base-url': {
      const url = match.arg;
      process.env.SHMAKK_BASE_URL = url;
      write(`[shmakk] base URL → ${url}\r\n`);
      write('[shmakk] takes effect on the next agent invocation\r\n');
      break;
    }

    // ── Set API key ──
    case 'set-api-key': {
      const key = match.arg;
      process.env.SHMAKK_API_KEY = key;
      const masked = key.slice(0, 8) + '...' + key.slice(-4);
      write(`[shmakk] API key → ${masked}\r\n`);
      write('[shmakk] takes effect on the next agent invocation\r\n');
      break;
    }

    // ── Endpoints ──
    case 'list-endpoints': {
      const { listEndpoints, getCurrentEndpointName } = require('./endpoints');
      const list = listEndpoints(opts.workspace || process.cwd());
      const current = getCurrentEndpointName();
      if (!list.length) {
        write('[shmakk] no endpoints configured in ~/.config/shmakk/endpoints.json\r\n');
        break;
      }
      write('[shmakk] available model endpoints:\r\n');
      for (const ep of list) {
        const marker = ep === current ? ' \x1b[1m*\x1b[0m ' : '   ';
        write(`${marker}${ep}\r\n`);
      }
      break;
    }

    case 'use-endpoint': {
      const { applyEndpoint, getCurrentEndpointName } = require('./endpoints');
      const endpointName = match.arg;
      const ok = applyEndpoint(endpointName, opts.workspace || process.cwd());
      if (!ok) {
        write(`\x1b[33m[shmakk] endpoint "${endpointName}" not found\x1b[0m\r\n`);
        break;
      }
      write(`[shmakk] switched to endpoint: \x1b[1m${endpointName}\x1b[0m\r\n`);
      write('[shmakk] takes effect immediately on the next agent invocation\r\n');
      break;
    }

    // ── Review mode ──
    case 'enable-review': {
      if (ctx.opts) ctx.opts.review = true;
      write('[shmakk] review mode on — every AI action requires confirmation\r\n');
      break;
    }
    case 'disable-review': {
      if (ctx.opts) ctx.opts.review = false;
      write('[shmakk] auto mode on — safe actions run without confirmation\r\n');
      break;
    }

    // ── Correction ──
    case 'enable-correction': {
      if (ctx.opts) ctx.opts.noCorrection = false;
      write('[shmakk] command correction enabled\r\n');
      break;
    }
    case 'disable-correction': {
      if (ctx.opts) ctx.opts.noCorrection = true;
      write('[shmakk] command correction disabled\r\n');
      break;
    }

    // ── Yes-files ──
    case 'enable-yes-files': {
      if (ctx.opts) ctx.opts.yesFiles = true;
      write('[shmakk] yes-files on — write_file, edit_file, make_dir auto-accepted\r\n');
      break;
    }
    case 'disable-yes-files': {
      if (ctx.opts) ctx.opts.yesFiles = false;
      write('[shmakk] yes-files off — file writes will prompt for confirmation\r\n');
      break;
    }

    // ── Notify ──
    case 'enable-notify': {
      if (ctx.opts) ctx.opts.notify = true;
      write('[shmakk] desktop notifications enabled\r\n');
      break;
    }
    case 'disable-notify': {
      if (ctx.opts) ctx.opts.notify = false;
      write('[shmakk] desktop notifications disabled\r\n');
      break;
    }

    // ── Colors ──
    case 'enable-colors': {
      if (ctx.opts) ctx.opts.colors = true;
      if (ctx.setColors) ctx.setColors(true);
      write('[shmakk] colors enabled\r\n');
      break;
    }
    case 'disable-colors': {
      if (ctx.opts) ctx.opts.colors = false;
      if (ctx.setColors) ctx.setColors(false);
      write('[shmakk] colors disabled\r\n');
      break;
    }

    // ── Debug ──
    case 'enable-debug': {
      if (ctx.opts) ctx.opts.debug = true;
      write('[shmakk] debug mode on\r\n');
      break;
    }
    case 'disable-debug': {
      if (ctx.opts) ctx.opts.debug = false;
      write('[shmakk] debug mode off\r\n');
      break;
    }

    // ── Voice modes ──
    case 'enable-stt': {
      if (ctx.setVoiceMode) ctx.setVoiceMode('stt', true);
      else {
        if (ctx.opts) {
          ctx.opts.stt = true;
          ctx.opts.tts = false;
          ctx.opts.sts = false;
          ctx.opts.voice = true;
        }
      }
      write('[shmakk] STT enabled — press Ctrl+O for voice input\r\n');
      break;
    }
    case 'disable-stt': {
      if (ctx.setVoiceMode) ctx.setVoiceMode('stt', false);
      else {
        if (ctx.opts) { ctx.opts.stt = false; ctx.opts.voice = !!ctx.opts.sts; }
      }
      write('[shmakk] STT disabled\r\n');
      break;
    }
    case 'enable-tts': {
      if (ctx.setVoiceMode) ctx.setVoiceMode('tts', true);
      else if (ctx.opts) {
        ctx.opts.stt = false;
        ctx.opts.tts = true;
        ctx.opts.sts = false;
        ctx.opts.voice = false;
      }
      write('[shmakk] TTS enabled — agent replies will be spoken\r\n');
      break;
    }
    case 'disable-tts': {
      if (ctx.setVoiceMode) ctx.setVoiceMode('tts', false);
      else if (ctx.opts) ctx.opts.tts = false;
      write('[shmakk] TTS disabled\r\n');
      break;
    }
    case 'enable-sts': {
      if (ctx.setVoiceMode) ctx.setVoiceMode('sts', true);
      else if (ctx.opts) {
        ctx.opts.stt = false;
        ctx.opts.tts = false;
        ctx.opts.sts = true;
        ctx.opts.voice = true;
      }
      write('[shmakk] STS enabled — always-on speech-to-speech started\r\n');
      break;
    }
    case 'disable-sts': {
      if (ctx.setVoiceMode) ctx.setVoiceMode('sts', false);
      else if (ctx.opts) { ctx.opts.sts = false; ctx.opts.stt = false; ctx.opts.tts = false; ctx.opts.voice = false; }
      write('[shmakk] STS disabled\r\n');
      break;
    }

    // ── Profile ──
    case 'set-profile': {
      const validProfiles = ['tiny', 'balanced', 'deep', 'builder', 'large-app'];
      const p = (match.arg || '').toLowerCase();
      if (!validProfiles.includes(p)) {
        write(`[shmakk] unknown profile: ${match.arg}\r\n`);
        write(`[shmakk] valid profiles: ${validProfiles.join(', ')}\r\n`);
        break;
      }
      write(`[shmakk] switching to profile '${p}' — restarting inner shell…\r\n`);
      ctl.setProfileAndRestart(p);
      break;
    }

    // ── Edit review ──
    case 'review-edits': {
      const { hasEdits } = require('./edit-tracker');
      if (!hasEdits()) {
        write('[shmakk] no edits to review this session\r\n');
      } else {
        const { openEditViewer } = require('./edit-viewer');
        openEditViewer(write);
      }
      break;
    }

    default:
      write(`[shmakk] unknown self-command: ${match.action}\r\n`);
  }
  // Clear terminal title — shell will restore normal title on next prompt
  write('\x1b]0;\x07');
}

module.exports = { matchSelfCommand, executeSelfCommand, hasSelfCommandPrefix, stripSelfCommandPrefix, SELF_COMMANDS };
