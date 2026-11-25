# Recorded automations

Record a screen, say what you are doing, and shmakk turns the clip into a
replayable spec: an ordered list of actions with semantic targets, plus the
values you typed lifted out as variables.

```
shmakk show2plan clip.mp4 --automation      # recording to spec, with a review list
```

The spec is plain JSON (`automation.json` next to the recording, and
`spec.automation` in the show-and-tell result). Everything below is what the
replay engine reads. If you write a spec by hand, write it in this shape.

## Why targets are semantic

A screenshot cannot tell you a CSS selector, and guessing one is what made
earlier recordings unusable. A step therefore names a control the way a person
reads it off the screen: a role plus an accessible name. That pair is resolved
against the live page or the live accessibility tree at replay time, so a
re-render or a new build does not break the run.

CSS is accepted as a last resort when a spec supplies `selector`, never as the
primary strategy.

## Step shape

| Field | Meaning |
|---|---|
| `index` | 1-based position in the run |
| `surface` | `browser` or `desktop` |
| `action` | one of the actions below |
| `target` | the spoken description, normalized |
| `name` | the accessible name, normalized |
| `role` | ARIA or AT-SPI role, lowercased (`button`, `textbox`, `menuitem`) |
| `value` | what was typed, selected, or opened |
| `key` | the key for `press` |
| `detail` | the model's own wording, kept for review |
| `expected` | what should be true after the step |
| `confidence` | the model's confidence, when it gave one |
| `evidence` | frame files the step was read from |
| `input` | the variable this step's value comes from (set automatically) |

### Actions

`navigate`, `launch`, `focus`, `click`, `dblclick`, `rightclick`, `type`,
`press`, `select`, `scroll`, `hover`, `drag`, `wait`, `manual`.

Synonyms collapse onto these, so `go to`, `open` and `visit` all become
`navigate`, and `fill`, `write` and `paste` all become `type`. A step whose
action maps to nothing becomes `manual`: it stays in the list with a warning
for a person to fix, and it is never guessed into a click.

On a desktop spec a `navigate` step becomes `launch`, because a desktop app is
started by command, not by URL.

### Control names: "the Save button" is "Save"

People say the widget noun out loud; screen readers do not. Normalization
removes the trailing noun, then the article:

| Spoken | Role known | Stored `name` |
|---|---|---|
| `the Save button` | yes | `Save` |
| `Save button` | yes | `Save` |
| `a Save button` | yes | `Save` |
| `the Save` | yes | `Save` |
| `the Netherlands` | no | `the Netherlands` |
| `Button` | yes | `Button` |
| `https://example.com/the-save-button` | any | unchanged |

The rules, in the order they apply:

1. Surrounding quotes and extra whitespace are trimmed.
2. A trailing role noun is dropped (`button`, `link`, `field`, `input`, `tab`,
   `menu`, `checkbox`, `check box`, `radio`, `radio button`, `textbox`,
   `text box`, `search box`, `combo box`, `entry`, `menu item`), case
   insensitive.
3. A leading `the`, `a` or `an` is dropped when step 2 fired, or when a role is
   already known. Otherwise the name is left alone, so a name that merely
   starts with "The" survives.
4. A name that is nothing but a role word is never stripped to empty.
5. A URL is a value, not a description, and passes through untouched.

`target` and `name` go through the same rule, so they cannot disagree about
which control a step means.

### Deduplication

Two consecutive screenshots of the same state produce repeated steps. A step
identical to the one before it in action, target, value and key is dropped, and
the surviving steps are renumbered from 1.

## Target resolution at replay time

### Browser

Tried in order, first match wins:

| Order | Strategy |
|---|---|
| 1 | ARIA role plus accessible name, exact |
| 2 | ARIA role plus accessible name, substring |
| 3 | label |
| 4 | placeholder |
| 5 | visible text |
| 6 | CSS `selector`, only when the spec carries one |

### Desktop

Candidates come from the AT-SPI tree. Each is scored and the highest wins:

| Match | Points |
|---|---|
| accessible name equals the target | 4 |
| name contains the target | 3 |
| target contains the name | 1 |
| same role | 2 |
| same application | 1 |

Disabled elements are skipped while any enabled candidate exists; if every
candidate is disabled the disabled ones are considered instead of failing with
nothing to click. An element without a `ref` cannot be acted on and is ignored.

Nothing is clicked at a guessed coordinate. A failed step stops the run,
because replaying later steps on a screen that never reached the expected state
would click blind.

Tuning, if a page settles slowly:

| Variable | Default | Meaning |
|---|---|---|
| `SHMAKK_REPLAY_SETTLE_MS` | 300 | pause after a step before the next one |
| `SHMAKK_REPLAY_STEP_TIMEOUT` | 8000 | how long one step may take |

## Inputs, so one recording runs over a list

Every `type` or `select` step with a value becomes an input. The recorded value
becomes the example, so a run with no overrides replays exactly what was
recorded.

```json
{
  "inputs": [{ "name": "email", "label": "Email", "example": "me@example.com" }]
}
```

The variable name comes from `inputName`, `input_name` or `variableName` on the
step when the model stated one; otherwise it is a slug of the control name,
falling back to `value_2`, `value_3` when the name has no leading letter. Two
steps with the same slug but different values get distinct variables
(`email`, `email_3`).

Supplying values replaces the step's `value`; a missing value falls back to the
recorded example rather than an empty field.

## Reviewing a spec before you trust it

`show2plan` lists the steps with their evidence frames. Three things are
reported rather than repaired:

- `warnings` — an action that could not be mapped, a click that names no
  control, or a clip with no actions at all
- `uncertain` — what the model was unsure about
- `notes` — what it worked around

Read the warnings before a run. A step that names no control cannot be
replayed, and replay will say so at that step instead of clicking something
plausible.

## Related

- [docs/web.md](web.md) — Cowork automations, triggers and schedules
- [docs/migration-guide.md](migration-guide.md) — moving specs written before
  spoken names were normalized
