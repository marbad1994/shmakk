---
name: shmakk-skill-creator
description: "Create or convert skills for shmakk. Two modes: (1) CREATE — guided authoring of a new shmakk skill from a plain description; (2) CONVERT — take a Claude Code .skill zip and produce a shmakk-native skill directory. Use CREATE when the user describes a new workflow or capability they want to package. Use CONVERT when the user drops a .skill file or references a .skill path. Both modes output an installable shmakk skill directory ready for ~/.config/shmakk/skills/ and shmakk-desktop."
category: workflow
---

# Shmakk Skill Creator

Two entry points. Read the user's message and pick one:

| Signal | Mode |
|---|---|
| User describes a new capability/workflow in plain language | → **CREATE** |
| User provides a `.skill` file path or drops a `.skill` zip | → **CONVERT** |

---

## MODE A — CREATE

Build a new shmakk skill from scratch. The output is a single `SKILL.md` (or a directory if the
skill has sub-agents) that works with the shmakk runtime and renders correctly in shmakk-desktop's
Skills Browser and Workflows view.

### Step 1 — Capture intent

Ask (or infer from context) only what changes the output meaningfully:

1. **Name** — short kebab-case identifier (`campaign-planner`, `pr-reviewer`)
2. **What it does** — one sentence trigger description
3. **Single-step or multi-agent?** — does this need parallel/pipeline sub-agents, or is it one focused prompt?
4. **Category** — `dev`, `workflow`, `backend`, `frontend`, `media`, `docs`, `system`, `business`, `productivity`, `security`, `planning`, `research`, `general`
5. **Argument hint** — what the user passes when invoking (`<business description>`, `<PR number>`, etc.)

Do not ask for things you can infer. If the description clearly implies multi-agent (research → synthesis,
audit → fix → verify, plan → execute → check), call it multi-agent without asking.

### Step 2 — Skill shape decision

**Single-step skill** — one `SKILL.md` with a strong system-prompt body. Use when the task is
self-contained and doesn't need separate agents for sub-phases.

**Multi-agent skill** — a directory with `SKILL.md` as the orchestrator plus agent role files. Use
when phases need isolation (independent research branches, synthesis that must not see each other's
drafts mid-flight, a verification step that shouldn't share context with the execution step).

```
<name>/
  SKILL.md                    ← orchestrator prompt + workflow metadata
  agents/
    <phase>/
      <NN>-<role>.md          ← one role file per sub-agent; NN = execution order
  references/                 ← shared docs injected into sub-agents as context
  assets/                     ← templates, schemas, examples
```

### Step 3 — Write the SKILL.md

Every SKILL.md starts with this frontmatter:

```yaml
---
name: <kebab-case-name>
description: '<trigger description — when to use this skill, what it does, key phrases that should load it>'
category: <category>
argument-hint: '<what the user passes>'
# For multi-agent skills only:
skill-type: orchestration
workflow:
  topology: <parallel|pipeline|staged>
  phases:
    - name: <phase-name>
      topology: <parallel|pipeline>
      agents: [<role-file-paths>]
---
```

The body of SKILL.md is the **orchestration prompt** — instructions for the agent that runs this
skill. Write it to the same standard as the rest of the shmakk skill library:

- Lead with a one-paragraph summary of what the skill produces.
- Describe each phase: what agents run, in what order, what each receives and returns.
- State quality gates explicitly (what a failing output looks like and what to do — bounce back, not
  silently accept).
- Name the final deliverable precisely: file path, shape, content contract.
- End with anti-patterns: the most common ways this skill produces bad output.

For sub-agent role files (`agents/<phase>/<NN>-<role>.md`), write each as a focused brief:
- Role in one line
- Inputs (what the orchestrator passes)
- What to produce (file path, format)
- Effort floor or quality bar
- Anti-fluff rule specific to this role

### Step 4 — Output the skill

For a **single-step skill**: write `SKILL.md` directly to the target path.

For a **multi-agent skill**: write the full directory tree. Then print:

```
✓ Skill created: <name>/
  Install:  cp -r <name>/ ~/.config/shmakk/skills/<category>/<name>/
  Or via:   shmakk install <name>.skill   (after packaging with: zip -r <name>.skill <name>/)
```

---

## MODE B — CONVERT

Take a Claude Code `.skill` zip and produce a shmakk-native skill that:
- Works with `shmakk run skill <name>`
- Renders in shmakk-desktop's Skills Browser (card with name, description, category, status)
- Shows phases and steps in shmakk-desktop's Workflows view

### Step 1 — Ingest the zip

```bash
unzip <path>.skill -d /tmp/skill-convert/
```

Read the extracted tree. Expected shape:

```
<name>/
  SKILL.md                    ← Claude Code orchestration prompt (frontmatter + prose)
  agents/
    research/                 ← parallel research sub-agents (optional)
    synthesis/                ← synthesis sub-agents; last one = assembler (optional)
    <other-phase>/            ← any other phase name
  references/                 ← shared context docs
  assets/                     ← templates, schemas
```

If the shape differs (flat directory, non-standard phase names, etc.) — adapt rather than fail.
The structure is a convention, not a contract.

### Step 2 — Analyse phases

Read `SKILL.md` body to understand the workflow. Then read each agent file header (first 20 lines)
to understand its role. Build a phase map:

| Phase dir | Topology | Notes |
|---|---|---|
| `agents/research/` | **parallel** | All research agents run concurrently |
| `agents/synthesis/` | **staged** | All except last run in parallel; last = assembler runs after |
| Single `agents/` flat | infer from filenames | NN- prefix → pipeline order; no prefix → parallel |
| Custom phase dirs | read SKILL.md | The orchestrator prose describes the order |

### Step 3 — Map Claude Code → shmakk conventions

Apply these substitutions throughout the orchestration prompt and agent role files:

| Claude Code | shmakk equivalent | Notes |
|---|---|---|
| `Task(prompt, ...)` / "spawn a sub-agent" | `subagent(role, task, context)` | shmakk's team.js dispatch |
| `WebSearch(query)` | `WebSearch` | Same name, keep as-is |
| `WebFetch(url)` / `web_fetch` | `WebFetch` | Same name, keep as-is |
| `Write(path, content)` | `Write` | Same |
| `Read(path)` | `Read` | Same |
| `Bash(cmd)` | `Bash` | Same |
| "read `references/X.md` first" | inject as `context` field in subagent call | shmakk passes context docs to sub-agents explicitly |
| "run in parallel in the same turn" | `topology: parallel` in workflow metadata | shmakk team.js runs parallel steps via Promise.all |
| "run sequentially, each sees prior output" | `topology: pipeline` | shmakk passes prior step output to next |
| `fallback.py` / stdlib fallback | note in SKILL.md as optional; shmakk uses LLM fallback | Strip if it references Claude-specific APIs |

Do **not** strip role files, references, or assets — they carry domain knowledge. Only touch the
tool-call syntax and the spawn patterns.

### Step 4 — Rewrite the orchestration SKILL.md

Keep the original prose and domain logic. Change only:

1. Replace the frontmatter entirely with shmakk frontmatter (see Step 3 of CREATE mode).
   - Detect `name` from the folder name or original frontmatter.
   - Detect `category` from the content (marketing → `business`; code → `dev`; etc.).
   - Copy `description` from original, trim if over 400 chars.
   - Add `skill-type: orchestration` and a `workflow:` block derived from the phase map.

2. In the body, replace every Claude Code spawn pattern with shmakk's:

   **Before (Claude Code):**
   ```
   Spawn three sub-agents in the same turn. Pass each: the path to its role file, references/research-standards.md, the brief.
   ```

   **After (shmakk):**
   ```
   Run three sub-agents in parallel (topology: parallel). For each, pass: its role file content, references/research-standards.md as context, the brief. shmakk will run these concurrently via the team runner.
   ```

3. Replace any reference to Claude Code tools by name (`claude`, `claude-code`, `/skill`, slash
   commands) with shmakk equivalents (`shmakk run skill`, `shmakk`). Keep all domain logic intact.

### Step 5 — Generate workflow.json

This file drives shmakk-desktop's Workflows view. One JSON object per workflow (most skills have one).

```json
{
  "id": "<name>",
  "description": "<one-line description>",
  "topology": "staged",
  "stages": [
    {
      "name": "<phase-name>",
      "topology": "parallel",
      "steps": [
        { "role": "<role>", "task": "<one-line task description>", "agentFile": "agents/<phase>/<file>.md" }
      ]
    }
  ]
}
```

For a simple pipeline (no parallel phases), use flat `steps` array instead of `stages`, matching
the format in `src/workflows.js`.

### Step 6 — Write the output directory

```
<name>/                            ← drop-in shmakk skill directory
  SKILL.md                         ← rewritten orchestration prompt
  workflow.json                    ← desktop Workflows view descriptor
  agents/                          ← agent role files (kept verbatim, paths unchanged)
  references/                      ← reference docs (kept verbatim)
  assets/                          ← asset templates (kept verbatim)
```

Then print:

```
✓ Converted: <original-name>.skill → <name>/

  What changed:
  - Frontmatter: replaced with shmakk format
  - Spawn patterns: Claude Code Task() → shmakk subagent dispatch
  - workflow.json: generated for shmakk-desktop Workflows view
  - Tool names: <list any that were remapped>
  - Kept intact: agent role files, references, assets

  Install:
    cp -r <name>/ ~/.config/shmakk/skills/<category>/<name>/

  Or package and install:
    zip -r <name>.skill <name>/
    shmakk install <name>.skill
```

If anything couldn't be cleanly mapped (custom tool calls, Claude-specific APIs, platform-specific
slash commands), list them explicitly under **Manual review needed** so the user knows what to check.

---

## Output quality bar (both modes)

A skill is ready to ship when:

- `SKILL.md` frontmatter is valid YAML with `name`, `description`, `category`.
- The description is specific enough that the shmakk dispatcher will match it correctly — not "does stuff", but the actual trigger phrases.
- Every sub-agent file has a clear role, explicit inputs, and a defined output (file path + format).
- Quality gates are named: what failing output looks like and what the orchestrator does about it.
- `workflow.json` (if present) is valid JSON and its `agentFile` paths resolve in the directory.
- The skill installs cleanly: `cp -r` to `~/.config/shmakk/skills/<category>/<name>/` and `shmakk run skill <name>` finds it.

A skill is **not** ready when:
- The description would match the wrong user intent (too broad) or never match (too narrow/technical).
- Sub-agent role files reference paths that don't exist in the directory.
- The orchestration prompt tells agents to "just do their best" with no quality gate — this produces variable-quality output that can't be improved systematically.
- `workflow.json` has hardcoded absolute paths or references files outside the skill directory.
