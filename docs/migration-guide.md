# Migration guide

Changes that need something from you, one section per change. If a section
does not apply to your project, skip it.

## Automation specs: spoken control names are now normalized

**Applies to:** recordings made before 2026-11-22, hand-written analyses, and
any `automation.json` you keep in version control.

### What changed

`normalizeAutomation` now turns a spoken description into the accessible name,
because the two have to agree for a step to resolve:

| Before | After |
|---|---|
| `the Save button` | `Save` |
| `Save button` | `Save` |
| `a Save button` | `Save` |
| `the Netherlands`, no role | `the Netherlands` (unchanged) |
| `Button`, role known | `Button` (unchanged) |

Both `name` and `target` on a step go through the same rule. Full rules:
[docs/automations.md](automations.md#control-names-the-save-button-is-save).

### Who is affected

Only specs whose stored names still carry an article or a widget noun. A spec
recorded as `Save` is untouched, and new recordings are normalized on the way
in.

### Why it matters at replay time

The browser backend resolves a step by `getByRole(role, { name })`. With a
stale name:

- `getByRole('button', { name: 'the Save button' })` matches nothing, because
  the accessible name of that control is `Save`
- the fallback strategies look for the literal text `the Save button`, which is
  not on the page either
- the step fails and the run stops there

On the desktop backend the step still resolves, but by a weaker rule: the exact
name match (4 points) drops to "target contains the name" (1 point), so a
control literally named `The Save Button` outranks the one you meant.

### What to do

**New recordings:** nothing. They are normalized at build time.

**Specs with a `sourceAnalysis` field** (produced by the recorder, which stores
the model's raw analysis next to the normalized spec) can be rebuilt without
another vision pass:

```js
// renormalize.js, run from the repo root
const fs = require('fs');
const { normalizeAutomation } = require('./src/services/automation');

const file = process.argv[2];
const old = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!old.sourceAnalysis) {
  console.error('no sourceAnalysis in this spec: rebuild it from the recording');
  process.exit(1);
}
const fresh = normalizeAutomation(old.sourceAnalysis);
fs.writeFileSync(file, JSON.stringify({ ...fresh, id: old.id }, null, 2));
console.log(`${fresh.steps.length} steps renormalized`);
```

```bash
node renormalize.js path/to/automation.json
```

`sourceAnalysis` is what the model returned; normalization is pure code, so
this produces the same spec the recorder would write today. The one thing it
cannot restore is `evidence`: the frame files are only known through the
`frames` option, which the recorder passes from the clip it just read. If you
still have the frames, list them in vision order and pass
`{ frames: [{ file: 'frame_000.png' }, ...] }` as the second argument;
otherwise the steps are correct and their screenshots are gone.

**Specs without `sourceAnalysis`:** regenerate from the recording. A hand-edited
spec can also be fixed in place, which is quick for one or two names:

```json
{ "action": "click", "role": "button", "name": "the Save button" }
```

becomes

```json
{ "action": "click", "role": "button", "name": "Save" }
```

Then check the rest of the file for the same pattern, and for any `target` that
repeats the name.

### Do not

- Do not lowercase names. Accessible names are matched case insensitively, but
  the stored name is also what the review list shows a person.
- Do not replace a name with a CSS selector to make a step resolve. Selectors
  break on the next re-render; that is why they are last in the strategy order.
- Do not delete steps that warn `could not be mapped to an action`. `manual`
  steps are kept on purpose so a person can fix them; removing them silently
  changes what the run does.

### Checking a spec before you trust it

```js
const { normalizeAutomation } = require('./src/services/automation');
const spec = require('./automation.json');
spec.steps.forEach((s) => console.log(s.index, s.action, s.name, s.role || ''));
console.log(spec.warnings);
```

A name that still contains a space followed by `button`, `link`, `field`,
`tab`, `menu` or `entry` did not come through the new path and should be
rebuilt.
