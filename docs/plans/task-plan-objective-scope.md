# Task plan: objective and scope

## Objective

Produce a single, dependency-ordered task plan for the shared-browser pane
switching fix. The plan must let an engineer with zero project context start
executing immediately, with each task carrying an owner, an estimated size, and
its upstream dependency, and with milestones and review checkpoints called out
explicitly.

The plan is a planning artefact. It sequences work that is already scoped and
architected in three input documents; it does not re-derive or re-negotiate that
scope. Its output is consumed by a human reviewer and by the executing agents
that carry out the tasks.

Inputs the plan must remain consistent with:

- `docs/plans/backend-scope-and-success.md` (scope, success criteria 1-5,
  boundaries)
- `docs/plans/backend-architecture-and-workstreams.md` (components C1-C6,
  owners, execution ordering)
- `docs/plans/roadmap.md` (existing dependency chain T1-T7, milestones M0-M3,
  review points R1-R4)

## Success criteria

Each item is measurable; target is 100% unless stated.

1. **Dependency ordering:** every task is listed after the tasks it depends on,
   and no task references a deliverable produced by a later task. A task has an
   empty "Depends on" cell only if it is the first task in the chain.
2. **Owner and size:** every task states exactly one owner and one size
   estimate (XS/S/M/L with a day range), with no "TBD" or role left unnamed.
3. **Explicit milestones and review points:** the plan names each milestone and
   its exit criterion, and each review checkpoint states who reviews, when, and
   what they verify. A milestone is not considered complete without a stated
   exit condition.
4. **Executable granularity:** each task's deliverable references exact file
   paths, commands, and expected results where code or tests are involved, so
   the task can be run without re-reading the source documents. No placeholder
   text ("TBD", "TODO", "implement later", "as appropriate").
5. **Consistency with inputs:** every file path, line reference, command, and
   acceptance number in the plan matches the three input documents above.
   Verification includes a `git diff --check` clean run on the plan file.

## Constraints

- No new dependencies, no schema change, no wire-contract change. The plan may
  only sequence work whose scope is the `src/webui/chat.js` edit plus its unit
  tests, as bounded by `backend-scope-and-success.md`.
- The plan must not assign execution to a non-existent owner. Owners are drawn
  from the four roles already named in the architecture doc: backend, frontend,
  infra, reviewer.
- The plan is prose plus tables only. It must not embed emoji or non-ASCII
  status glyphs; completion is tracked by checkbox (`- [ ]`) or table cells.

## Out of scope

Explicitly excluded from this plan (and therefore from its tasks):

- **Implementing the fix.** This plan sequences the work; it does not edit
  `src/webui/chat.js` or `test/units.js` itself.
- **Team-mode pane switching.** Team sub-agents run `runAgent` without an
  `onEvent` sink (`src/team.js:509`), so a `browser show` from a team sub-agent
  navigates but does not switch the pane. This is tracked as a follow-up and is
  not a task in this plan.
- **Any change to `src/browser.js`, `src/core/browser-live.js`, the `browser`
  tool schema, `web/src/lib/types.ts`, or `web/src/store/app.ts`.** The
  existing wire message `{ t: 'browser.open', url }` and client handler stay
  unchanged.
- **Design-mode preview behaviour.** Design renders its own live preview and
  must continue to receive no `browser.open` broadcast; this plan does not add
  or modify design-mode work, only the suppression gate.
- **Markdown link interception.** Opening a markdown link in the shared browser
  is a frontend concern outside this plan.
- **Re-scoping the feature.** Redefining the success criteria or boundaries in
  the three input documents is a separate task and not part of producing the
  plan.
