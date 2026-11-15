// Workflow templates — reusable multi-agent plans for common situations.
//
// The PM in src/team.js can either:
//   1. Match the user's input to a template here and run that template directly
//   2. Generate a custom plan if no template fits
//
// Templates are intentionally opinionated — they encode "this is how shmakk
// gets things like a full-stack feature or a bug fix done." If a user wants
// something different, they describe it and the PM builds a custom plan.
//
// Each template has:
//   - id, description: shown by `list workflows`
//   - topology: 'parallel' | 'pipeline'
//     parallel = agents run via Promise.all (no inter-dependencies)
//     pipeline = agents run sequentially, each sees prior agent's output
//   - triggers: regex patterns that match the user's input (used by PM)
//   - steps: array of { role, task, fileScope? } — task uses {input} for substitution

const WORKFLOWS = {
  // ── Pipeline workflows (sequential, with handoffs) ──────────────────────

  'full-stack-feature': {
    id: 'full-stack-feature',
    description: 'Build a complete user-facing feature: backend → frontend → tests → docs',
    topology: 'pipeline',
    triggers: [
      /\b(full.?stack|end.?to.?end)\b.*\bfeature\b/i,
      /\bbuild\s+(a|an|the)\s+(complete|full)\s+\w*\s*(feature|workflow|flow)\b/i,
      /\bship\s+(a|an|the)\s+\w*\s*feature\b.*\bwith\s+tests?\b/i,
    ],
    steps: [
      {
        role: 'backend',
        task: 'Design and implement the API endpoints and data layer for: {input}. Establish the contract (request/response shapes, error codes) before moving on.',
        fileScope: 'src/api/, src/server/, src/models/',
      },
      {
        role: 'frontend',
        task: 'Build the UI components that consume the API defined by the backend agent. Match existing component patterns.',
        fileScope: 'src/components/, src/pages/, src/styles/',
      },
      {
        role: 'testing',
        task: 'Write integration tests covering both the API and the UI flow for this feature. Cover happy path + at least 2 error paths.',
        fileScope: 'tests/, __tests__/, src/**/*.test.*, src/**/*.spec.*',
      },
      {
        role: 'docs',
        task: 'Document the new feature: API reference (endpoints, params, examples), user-facing description in README, and any setup notes.',
        fileScope: 'README.md, docs/, *.md',
      },
    ],
  },

  'bug-fix': {
    id: 'bug-fix',
    description: 'Investigate root cause → fix → add regression test',
    topology: 'pipeline',
    triggers: [
      /\b(fix|debug|resolve|investigate)\b.*\b(bug|error|crash|issue|failure|broken)\b/i,
      /\bsomething'?s?\s+(broken|wrong|failing|not\s+working)\b/i,
    ],
    steps: [
      {
        role: 'code',
        task: 'Investigate and identify the root cause of: {input}. Read the relevant files, reproduce if possible, and report exactly what is wrong and why.',
      },
      {
        role: 'code',
        task: 'Apply the minimal safe fix for the root cause identified above. Do not change unrelated code.',
      },
      {
        role: 'testing',
        task: 'Add a regression test that would fail before the fix and pass after. Cover the specific case that was broken.',
      },
    ],
  },

  'refactor': {
    id: 'refactor',
    description: 'Plan refactor → execute incrementally → verify behavior unchanged',
    topology: 'pipeline',
    triggers: [
      /\brefactor\b/i,
      /\b(restructure|reorganize|extract|split|consolidate|clean\s+up)\s+the\b/i,
    ],
    steps: [
      {
        role: 'code',
        task: 'Analyze the current implementation and propose a concrete refactor for: {input}. Identify public interfaces that must remain unchanged.',
      },
      {
        role: 'code',
        task: 'Execute the refactor incrementally. Preserve all existing behavior. Update internal call sites.',
      },
      {
        role: 'testing',
        task: 'Run the existing test suite to verify no behavior changed. If tests pass, the refactor is complete. If they fail, identify what broke.',
      },
    ],
  },

  'migration': {
    id: 'migration',
    description: 'Plan migration → migrate code → migrate tests → verify',
    topology: 'pipeline',
    triggers: [
      /\bmigrat(e|ion)\b/i,
      /\bconvert\s+(from|all)\s+\w+\s+to\s+\w+/i,
      /\b(upgrade|move)\s+to\s+\w+/i,
    ],
    steps: [
      {
        role: 'code',
        task: 'Analyze the migration scope for: {input}. List every file affected and the order in which they must change.',
      },
      {
        role: 'code',
        task: 'Execute the migration on production code files. Preserve behavior. Use a consistent pattern.',
      },
      {
        role: 'testing',
        task: 'Update tests to match the migrated code. Run the suite to verify nothing regressed.',
      },
      {
        role: 'docs',
        task: 'Update README, changelog, and migration guide notes to reflect the new pattern.',
      },
    ],
  },

  // ── Parallel workflows (independent, fan-out then synthesize) ───────────

  'security-audit': {
    id: 'security-audit',
    description: 'Audit authentication, injection vectors, secrets, and dependencies in parallel',
    topology: 'parallel',
    triggers: [
      /\b(security|vuln(erability)?)\s+(audit|review|scan|check)\b/i,
      /\baudit\s+(the\s+)?(code|app|application|project)\s+for\s+security/i,
    ],
    steps: [
      {
        role: 'security',
        task: 'Audit authentication, authorization, session handling, and access control for: {input}',
      },
      {
        role: 'security',
        task: 'Scan for injection vulnerabilities (SQL, command, XSS, SSTI, path traversal) across the codebase',
      },
      {
        role: 'security',
        task: 'Review secret management: hardcoded credentials, .env handling, git history for accidentally committed secrets',
      },
      {
        role: 'security',
        task: 'Audit dependencies for known CVEs, unmaintained packages, and overly permissive version ranges',
      },
    ],
  },

  'design-system-setup': {
    id: 'design-system-setup',
    description: 'Design tokens + component library + storybook docs (parallel)',
    topology: 'parallel',
    triggers: [
      /\bset\s+up\s+(a\s+)?design\s+system\b/i,
      /\b(create|build)\s+(a\s+)?design\s+system\b/i,
      /\b(create|build)\s+(a\s+)?component\s+library\b/i,
    ],
    steps: [
      {
        role: 'design',
        task: 'Define design tokens: colors (with light/dark pairs), type scale, spacing scale, radii, shadows. Create CSS custom properties or theme config.',
        fileScope: 'src/styles/tokens.*, src/theme/, tailwind.config.*',
      },
      {
        role: 'frontend',
        task: 'Build the core component primitives (Button, Input, Card, etc.) consuming the design tokens.',
        fileScope: 'src/components/ui/, src/components/primitives/',
      },
      {
        role: 'docs',
        task: 'Set up Storybook (or equivalent) with stories for each component variant and state. Include accessibility notes.',
        fileScope: '.storybook/, stories/, src/**/*.stories.*',
      },
    ],
  },

  'release-prep': {
    id: 'release-prep',
    description: 'Prepare a release: changelog + version bump + docs + final review',
    topology: 'parallel',
    triggers: [
      /\b(prepare|prep)\s+(a\s+|the\s+)?release\b/i,
      /\brelease\s+(prep|preparation|checklist)\b/i,
      /\bcut\s+(a\s+|the\s+)?release\b/i,
    ],
    steps: [
      {
        role: 'docs',
        task: 'Generate a changelog entry for: {input}. Read recent commits, group by category (feat/fix/refactor), and write user-facing release notes.',
        fileScope: 'CHANGELOG.md, RELEASE_NOTES.md',
      },
      {
        role: 'code',
        task: 'Bump version numbers in package.json (and any other manifest files). Update version strings in code if present.',
        fileScope: 'package.json, pyproject.toml, Cargo.toml, *.json',
      },
      {
        role: 'testing',
        task: 'Run the full test suite and capture results. Verify all tests pass before release.',
      },
      {
        role: 'code',
        task: 'Final code review pass: check for TODO/FIXME comments, debug logging, hardcoded values, and accidental commits of dev-only code.',
      },
    ],
  },

  // ── Hybrid workflows (pipeline with parallel sub-stages) ─────────────────

  'video-production': {
    id: 'video-production',
    description: 'Produce a video: script → voiceover + visuals → composite',
    topology: 'pipeline',
    triggers: [
      /\b(create|make|produce|generate|render)\s+(a\s+)?video\b/i,
      /\bvideo\s+(production|editing|creation|demo|explainer)\b/i,
      /\b(voice.?over|narration)\s+.*\bvideo\b/i,
      /\b(composite|assemble|stitch)\s+.*\b(video|mp4|clip)\b/i,
    ],
    steps: [
      {
        role: 'script',
        task: 'Turn the user prompt into a timed JSON storyboard. Output an array of segments, each with: startTime (seconds), endTime (seconds), narration (text for TTS), visualDesc (prompt for image generation). Total duration must match the user request. For: {input}',
      },
      {
        role: 'voice',
        task: 'Generate TTS audio files for each segment from the narration text in the script output. Use tts_generate tool. Return per-segment audio file paths.',
      },
      {
        role: 'visual',
        task: 'Generate images for each segment from the visualDesc in the script output. Use image_gen tool. Return per-segment image file paths.',
      },
      {
        role: 'compositor',
        task: 'Assemble the final video from the per-segment audio and image files using video_compose, then concatenate segments with video_concat. Apply transitions, fit images to duration, mix audio tracks. Output a single .mp4 file.',
      },
    ],
  },
};

function listWorkflows() {
  return Object.values(WORKFLOWS).map((w) => ({
    id: w.id,
    description: w.description,
    topology: w.topology,
    steps: w.steps.length,
  }));
}

function getWorkflow(id) {
  if (!id) return null;
  const key = String(id).toLowerCase().trim();
  return WORKFLOWS[key] || null;
}

// Match user input against workflow triggers. Returns the matching workflow
// or null. The PM calls this before generating a custom plan.
function matchWorkflow(input) {
  const text = String(input || '');
  for (const w of Object.values(WORKFLOWS)) {
    if (w.triggers && w.triggers.some((re) => re.test(text))) {
      return w;
    }
  }
  return null;
}

// Convert a workflow into the agent-list format that runTeam expects.
// {input} is substituted into each step's task description.
function expandWorkflow(workflow, userInput) {
  if (!workflow || !Array.isArray(workflow.steps)) return null;
  const safeInput = String(userInput || '').slice(0, 500);
  return workflow.steps.map((step) => ({
    role: step.role,
    task: String(step.task).replace(/\{input\}/g, safeInput),
    fileScope: step.fileScope || null,
  }));
}

module.exports = { WORKFLOWS, listWorkflows, getWorkflow, matchWorkflow, expandWorkflow };
