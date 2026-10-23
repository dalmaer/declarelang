# Cadence run 16: Declare b3012b76, Opus 5.5

**Run:** 2026-10-22 23:29 UTC, launched with `evals/craft/launch.sh cadence ~/Code/eval-cadence-16 claude-opus-5-5 b3012b76`
against GitHub main `b3012b76`. It is the first run since Venue run 2's fixes: verify boots every program in Chrome at a
laptop and a phone size, the browser rungs wait on conditions rather than sleeps, a program that never settles is
stopped at its line, theme tokens are checked, and the accessibility warnings cover unnamed and nested controls.

Opus 5.5 (`claude-opus-5-5`), web tools available, the brief's idiom sentence included, one round. `evals/`,
`docs/system-design/` and `test/` were removed from the agent's copy (the standard strip). The SKILL's checking guidance
was not changed for this run, so it is a baseline for the verification work that follows it.

This is the first report in the three-area form: **reading and docs**, **API and language**, and **debugging and
verification** are each costed in time and tokens and carry their own findings, and one list ranks the fixes across all
three by their general leverage.

**Try it:** the app, its assert script and four pictures are filed beside this report (`cadence.declare`,
`model.declare`, `parts.declare`, `tests/assert.mjs`, `shots/`).

## The comparison

Build figures come from the build's own final record. The account was asked for afterwards, in a separate resume
(1.0 min, 5.5k output tokens), and is counted separately.

| | run 14 | run 15 | **run 16** | React |
|---|---|---|---|---|
| Declare commit | `611b696f` | `9444a776` | **`b3012b76`** | — |
| time | 19.2 min | 18.2 min | **19.4 min** | 15.4 min |
| turns | 94 | 86 | **86** | 63 |
| tool calls | 93 | 85 | **85** | — |
| code, raw lines | 1,242 (3 files) | 1,321 (2 files) | **1,455 (3 files)** | 2,943 |
| code, excluding comments and blanks | 921 | 927 | **1,093** | 2,537 |
| **Tokens** | | | | |
| output (incl. thinking) | 87k (38k) | 94k (45k) | **101k (49k)** | 89k |
| fresh input (cache writes) | 252k | 253k | **317k** | 129k |
| cached input re-read | 15.5M | 15.1M | **17.2M** | 3.5M |
| read before first app write | 328 KB | 334 KB | **≈450 KB** ¹ | 23 KB |
| context at first write → end | 156k → 257k | 167k → 259k | **212k → 323k** | 30k → 134k |
| first app write at | 6.0 min | 7.3 min | **7.1 min** | 2.6 min |
| **Download (gzip)** | | | | |
| app + runtime | 163.5 KB | 151.7 KB | **147.1 KB** ² | 99 KB (+ a 90 KB web font) |

¹ Tool results before the first write, as returned. The extra ~115 KB over run 15 is mostly `weather.declare` (73 KB,
read whole in two calls), which run 15 did not read.
² `declarec --sizes` in the run's copy, built to a scratch directory: program 28.5 KB (its own files 16.6 KB), runtime
105.7 KB, kernel 12.6 KB.

Time and turns are level with run 15. The tokens are not: the context was 45k larger at the first write and 64k larger
at the end, and since every later turn re-reads it, cached input rose by 2.1M (14%). That is the reading below.

## Where the time and the tokens went

Phases from the build stream, by wall-clock and by the cached input each phase's API calls re-read (the measure of
token cost once a session is under way; output tokens are not reported per call in the stream).

| phase | time | API calls | cached input re-read | share of tokens |
|---|---|---|---|---|
| **Reading and planning** (0–7.1 min) | 7.0 min | 22 | 2.60M | 15% |
| **Writing** the three files (7.1–11.9) | 4.9 min | 5 | 1.13M | 7% |
| **Debugging and verification** (11.9–19.4) | 7.5 min | 46 | 13.42M | **78%** |

Verification is 39% of the time and 78% of the tokens, because it runs last, at the largest context (264k–323k), and
each step is a turn. The reading phase sets that context: every kilobyte read before the first write is re-read by each
of the 46 verification calls. `weather.declare` alone (≈20k tokens) is re-read about 64 times after it lands, roughly
1.3M tokens, or 7% of the run.

## Reading and docs

**The order the SKILL gives, followed exactly:** README, SKILL, `declare.md` whole, chapters 01, 04 and 05, the calendar
whole with `28-calendar.md`. Then, by need: chapters 10, 14, 06, 18, 21 and 08; `weather.declare` whole; the service's
`server.mjs`; two batches of `declare-help` (about 25 names). It asked `declare-help` about 10 topics after it started
writing (`Sheet`, `Shortcuts`, `errorSchema`, `Text.lineHeight`, `Button`, `ResponsiveLayout`, `Dialog`, `View.flexes`,
`View.scrolls`, `KeyEvent`).

**What it says taught it most** (account, (a)): `declare.md` §5 (set versus declare, who owns a value, the settle); the
calendar, whose four sprung scalars became the year chart's `span` and `vEnd` almost directly; and three short passages
in the guide — "write the value and its target together" (21), the computed-default `NewPage` (14), and "a figure that
arrives with its data appears". The form's defaults that follow the sport until a number is touched are that pattern
exactly.

**Source reads, which count as reference gaps:**

| read | times | what it wanted | what answers it |
|---|---|---|---|
| `runtime/src/keys.ts` | 7 (4 calls) | why the form's `Shortcuts` don't fire inside its open `Sheet` | nothing: the reference says an open dialog's "keys are its own", and the agent read that as including a set declared inside it. It doesn't. (Finding L1) |
| `library/shortcuts.declare` | 4 | how a `Shortcuts` item spells a key | `declare-help Shortcuts --all` has it; the agent read the source first |
| `library/sheet.declare` | 2 | the sheet's own padding and members | `declare-help Sheet --all`; read alongside it |
| `library/toast.declare` | 1 | how an action is offered and picked | `declare-help Toast` |

**Read and not needed:** most of `weather.declare` (1,470 lines). The agent's own words: "excellent but expensive …
much of it about phone scroll and handoff physics I didn't need. A short 'what this file demonstrates, by line range'
index at the top would have let me read a third of it."

**Not found, though it exists:**
- `WrappingLayout [ align = baseline ]` — a line of mixed sizes on one baseline that wraps. The agent wanted exactly this
  for "4 sessions · 4h 11m" on a narrow phone, concluded it didn't exist, and sized the font from the digit count
  (`cadence.declare:127–129`).
- `Floating.present` — "open, or closing until its motion lands". The agent wrote `exists = { app.formOpen ||
  app.form.openT > 0 }` (`:506`) for the same thing, and said it wasn't sure it worked.
- `Segmented` / `RadioGroup` for one-of-many: not asked about; the sport, effort and range choices are hand-built.

## API and language

**What the compiler caught** (one round of three `declare-verify` runs, 0.5 min, every message with its fix):

| message | site | note |
|---|---|---|
| `Button.width` — a flexing child declares no width (DECLARE2000) | parts | fixed in one edit |
| `class Pick` takes a TypeScript lib name (DECLARE4015) | parts | renamed `SportChoice`; "surprising, but fine" |
| `'?' at the end of a type is not valid TypeScript` | `let me: Session? = null` | Declare writes `Session?` in declarations and schemas, TypeScript doesn't in a `let`; the message is TypeScript's, with no Declare hint (L6) |
| `'reveal' overrides App's 'reveal'` with an incompatible signature (TS2416) | App method | renamed; the agent asked for a list of names App and View reserve (L6) |
| `DurationFig declares no baseline` | parts | fixed with the line the message gave |
| `bare 'kmStep' means SessionForm's member here` (DECLARE4002) | parts | fixed |

**Where the language fit** (account, (b), and the code agrees): one source of truth in `Sessions extends DataSource`,
with writes splicing replies into its records (`model.declare:206–244`), so adding a session moved every figure with no
update code; a `Spring` per displayed figure; `ResponsiveLayout` for the two rooms; overlays as state; `draw(d)` for the
year; `claim = x` so the page still scrolls under a vertical finger.

**Where it did not:**
- **Shortcuts inside a modal (L1).** An open `Sheet` holds the keyboard, and every `Shortcuts` set stands down while it
  does — including one declared inside the sheet. So a form in a sheet can't have its own shortcuts; the agent wrote a
  `Keys` chain of key tests (`parts.declare:559–574`), the form the drift check warns against, and said so.
- **Telling the requester a write finished (L4).** `Sessions.create.onLoad` calls `app.saved(…)` (`model.declare:214`),
  so the model reaches up into the App. The agent found no documented alternative; the calendar's `Drag` does the same.
- **Equal cells in a wrapping row (L5).** Ten effort cells, 2×5 on a phone and 1×10 at a desk, sized by
  `floor((width − 54) / 10)` (`parts.declare:644`), because `flexes` shares one row. `WrappingLayout [ justify = fill ]`
  spreads a row's gaps, not its children's widths, so nothing in the library does this: a grid of N equal columns is
  missing.

## Debugging and verification

Six episodes, in order. "Cheapest answer" is the step that would have settled the question soonest, had the platform
offered it.

| # | the question | steps | time · calls · cached input | outcome | cheapest answer |
|---|---|---|---|---|---|
| E1 | does it compile and boot? | 3 × `declare-verify` (R1–R4) | 0.5 min · 4 · 1.05M | six errors fixed, each from its message; two R4 layout notes (a stats line past the phone's edge, seven small targets) | — this is the ladder working |
| E2 | does it look right? | 2 × `declare-look` at desk and phone, 5 pictures | 1.3 min · 7 · 1.90M | three real fixes: a desk column overflowing, the volume silhouette overpowering bars when zoomed in, month labels lost off the left edge | — pictures were the right tool |
| E3 | why don't the form's keys work in the sheet? | an assert fails (`effort` 6, expected 8) → `declare-look --key` → grep and read `runtime/src/keys.ts` ×4 → `declare-help KeyEvent` → rewrite as a `Keys` chain | 1.3 min · 10 · 2.85M | works, by the drift form | the `Shortcuts` entry saying a set inside an open overlay is in force — or the platform making it so (L1). The agent also notes an `expect.trace` of "keydown → no shortcut in force (an overlay holds the keys)" would have shown it at once; it didn't try the trace. |
| E4 | why didn't the streak grow? | assert fails → reasoning → `curl` to find and delete the session its failed run left on the service | 0.4 min · 3 · 0.88M | the test's own mistake (the day it picked already had a session); the service restored to 248 sessions | `--fixtures` (verify.md) would have kept the test off the real service; nothing in its path suggested it (T4) |
| E5 | why doesn't a tap on the chart open a session on a phone? | `declare-look --touch --click-at app.main.year.chart 300,240` does nothing → a `console.log` in `onClick` → `--console --js "window.scrollTo(…)"` | 0.9 min · 6 · 1.78M | the app was right: the tool's tap landed on the pinned "Log a session" button after scrolling the chart into view, and said nothing | `--click-at` refusing a covered point and naming what it would hit, as `--click` does for a view's centre (T2) |
| E6 | do the detail, the form at a desk, the ranges, edit and delete hold up? | 7 × `declare-look` (7 pictures), `--read app.winA --read app.vEnd`, one assert run | 3.1 min · 16 · 4.96M | four real fixes: the phone stats line, a redundant date, the desk column clipping its last card, and "All" showing 247 of 248 (found in one `--read`) | — mostly the right tools; the pictures are the dear part |

**What it never did:** write a browser harness of its own (Venue run 2's agent spent half an hour in one), use
`--semantics`, use R6 baselines, or run on real touch hardware. Its first `declare-look` came at 12.5 minutes, one
minute after the first compile — Venue run 2's came at 16. The assert script (85 lines, two flows: a desk keyboard add
and undo, a phone two-tap add and undo) checks both what was sent (`expect.request`) and the derived figures.

**What the account says served it** (c): diagnostics with the fix named; R4's layout notes ("findings I'd normally only
get from a designer staring at a phone"); `--read` for the 247-of-248 question; `settleMotion`/`settleData` making
sprung values testable. **Less well:** the silent touch miss (E5); tests that write to the real service (E4).

**Scored from the main tree** (`declare-verify` against the run's file): R1–R3 pass, **R4 fails** — "the drawing on
`app.main.year.chart` (YearChart) came back blank from the browser: a 172433×483 raster (318 MB)", and at the phone
size, on some boots, the same about a 359×254 raster. In the run's own copy the same commit passes R4, every time the
agent ran it and again afterwards. Both are platform faults, not the app's (T1):

- **A clipped view's raster is sized to all its ink.** Before the data arrives `vEnd` is 0, so the chart's first frame
  draws its silhouette tens of thousands of days to the right. The chart has `clip = true` and can show none of it, but
  the DOM backend sizes the canvas to the drawing's bounds regardless (`dom-backend.ts:2540–2565`). Whether that first
  frame happens depends on timing, which is why one tree fails and the other passes.
- **The deferred blank check reads the wrong raster.** Before first paint the check is deferred, keeping the *first*
  raster's origin and density, and then samples whatever canvas is current when it runs — so a small, correct 359×254
  canvas is "blank" at the huge one's coordinates (`dom-backend.ts:2608–2617`).

An agent that met this would have been told, at the first rung, to "draw less area" in an app whose drawing is already
the size of its view.

## What it built

One page, in two rooms (pictures in `shots/`):

- **At a desk:** Today in a third — the week's count and hours set large, the streak, the week's shape as seven bars in
  effort colour, the running session in an inverted block with a ticking clock, the last session — and the year in two
  thirds: the period in view and its totals, the hardest session in it, the drawn chart, and range chips.
- **On a phone:** one column on the page's scroll, with "Log a session" pinned where the thumb is.

The pieces:

- **The record:** `Sessions extends DataSource` (`model.declare:136–245`) holds every session and every query over them —
  by day, between two days, what this person usually does on a weekday and for a sport, where a session stands among its
  sport. Its three writes (`create`, `change`, `drop`) splice the reply into the same records.
- **The year:** `YearChart` (`parts.declare:224–343`) draws stacked bars and a trailing-week silhouette whose weight
  follows the zoom, with months and (zoomed in) days as views placed from `viewStart` and `dayW`. Drag, pinch, trackpad
  pinch and wheel write the view and its target together; the chips write only the target, so the surface glides.
- **A session, opened:** a `Sheet` with the duration set large, the effort as ten cells, the note, and a drawn scatter of
  every session of its sport with this one lit.
- **Logging:** a second `Sheet` (`SessionForm`, `:523–696`), with sport, day, duration, distance and effort as choices,
  steps and nudges; every field a computed default from this person's habits, until touched; the Save button says what
  it will save; at a desk, the whole form is keys.
- **Delete** asks through the library `Dialog`; **undo** of an add is the toast's action.
- **A theme of its own:** `theme Paper` — ink on paper, and one colour, effort, from stone to vermilion, used for nothing
  else.

## Is it idiomatic Declare?

Mostly, and in the places that matter most.

### What it gets right

- **One source of truth, written through** (`model.declare:206–244`). Writes land in the records the first fetch filled;
  nothing re-fetches, nothing derived is ever stale.
- **The form's defaults** (`parts.declare:530–535`) are computed defaults: changing the sport brings that sport's usual
  numbers until a number is touched. No "touched" flags.
- **The year is a scene placed from two sprung numbers** (`cadence.declare:196–252`), the calendar's lesson applied, and
  "write the value and its target together" under the hand.
- **Figures that travel** — a `Spring` per shown figure, with `arrive()` when the data first lands (`:131–148`).
- **A theme as the design's token plan** (`parts.declare:11–19`), not colours in script.
- **Accessibility where it built its own controls:** every hand-built control has an `accessibilityLabel`.

### Missteps, and how they should have been written

1. **One-of-many, built by hand three times.** `SportChoice` ×4 (`parts.declare:580–591`), `EffortCell` ×10
   (`:645–674`) and `RangeChip` ×5 (`cadence.declare:470–474`) are each a `Control` with an `on` flag. None reports which
   is chosen to a screen reader (no `accessibilitySelected` or `accessibilityChecked`), and the arrows don't move
   between them. `Segmented` or a `RadioGroup` with its `Radio`s styled is the platform's one-of-many, with both.
2. **Lists written out instead of replicated.** The ten effort cells and the ten meter segments (`:372–381`) are ten
   literal siblings each; one child with a `datapath` over `[1…10]` replicates them.
3. **A `Keys` chain for the form's keys** (`:559–574`) — forced by L1, and the agent said so.
4. **Font size estimated from digit counts** (`cadence.declare:127–129`) where `WrappingLayout [ align = baseline ]`
   wraps the line.
5. **`exists = { app.formOpen || app.form.openT > 0 }`** (`:506`) is `exists = { app.form.present }`.
6. **Heights as arithmetic over the padding** (`:337`, `:366`, `:416`: `hostHeight - 60`, `main.height + 96 +
   safeBottom`). The desk column and the year can flex to fill; the phone page's room for the pinned button is a
   padding.
7. **The model calls up into the App** on a write (`model.declare:214, 220`) — L4.

### Workarounds the platform forced

- The `Keys` chain (L1), and the digit-count font size (a discoverability gap, D3), above.
- `vEnd` starting at 0 makes the chart's first frame draw far off-screen; harmless in a browser that clips, but it is
  what trips T1.

## Findings, by area

### Reading and docs
- **D1 — Exemplars cost their whole length.** Weather (1,470 lines) was read whole for a few hundred lines of use, and
  re-read with every later turn (≈1.3M tokens). A header index on each exemplar — what it demonstrates, by line range —
  lets an agent read the slice it needs.
- **D2 — Shortcuts and overlays.** The `Shortcuts` entry's "its keys are its own" reads as including a set inside the
  overlay. It must say which sets are in force while an overlay is open — or, better, L1 makes the natural reading true.
- **D3 — Things that exist and weren't found:** `WrappingLayout`'s baseline alignment (ask `declare-help baseline` and
  `SimpleLayout.align` should point there); `Floating.present` (the `Sheet` entry should show content kept with `exists =
  { parent.present }`); `Segmented`/`RadioGroup` for a row of choices (the SKILL table has the row; the agent built from
  `Control` anyway).
- **D4 — Library source reads that `declare-help` answers** (`shortcuts`, `toast`, `sheet`): the agent reached for the
  source first. The SKILL already says not to; the reference lookups it made just before should have been enough.

### API and language
- **L1 — A `Shortcuts` set inside an open overlay should be in force.** A dialog's or sheet's keys are its own: its
  own declared shortcuts are exactly those keys. Today they're suppressed with everything else.
- **L4 — A pattern for "the write finished"** that doesn't reach from the model into the App: document the App
  watching the write source (`trackChanges` on its `loaded`), or give a write source an event the requester can hear.
- **L5 — Equal cells that wrap:** no layout gives N equal columns that reflow (2×5 on a phone, 1×10 at a desk);
  `WrappingLayout`'s `justify = fill` widens gaps, not cells. A `columns` count on `WrappingLayout` would do it.
- **L6 — Script typing hints:** a `Type?` in a `let` gets TypeScript's message; Declare should add "in a `{ }` body,
  write `Session | null`". And name the members App and View reserve, when an override clashes.

### Debugging and verification
- **T1 — R4 fails a correct drawing.** Size a clipped view's raster to the view, not its ink; and have the deferred
  blank check sample the raster it was deferred for, or skip one that has been replaced.
- **T2 — `--click-at` (and `drive.clickAt`) press a covered point in silence.** The cover check looks at the view's
  centre, not the point pressed. Check the point, and refuse and name what is there, as `--click` does.
- **T3 — `expect.trace` was the right tool for E3 and wasn't reached for.** A failed `expect` on an attribute that a key
  should have changed could end its message with the trace of that key: who heard it, or that nothing did and why.
- **T4 — Tests against the real service** left a record behind. verify.md's `--fixtures` should be offered where an
  assert script first sends a write.

## What changes next

Ranked by general leverage — how much each helps agents across apps and runs, not what it cost here.

1. **T1 — R4's drawing check fails correct programs.** Any app that draws, on the first rung, with advice that sends
   the agent the wrong way. Fix the raster bounds for a clipped view and the deferred check's pairing.
2. **L1 — Shortcuts inside an open overlay.** Every form in a sheet or dialog meets it; today it forces runtime source
   reads and the drift form.
3. **D1 — Exemplar indexes.** Every run reads one or two exemplars whole, and reading volume multiplies the cost of all
   the verification after it (78% of this run's tokens).
4. **T2 — `--click-at` honesty.** A silent miss sends an agent into `console.log` debugging of a correct app.
5. **One-of-many built by hand** (misstep 1, D3) — three times in this app, with no selected state for assistive
   technology. Make `Segmented`/`RadioGroup` the obvious answer in `declare-help` for "choice", "toggle group" and
   "chips", and consider a warning for a `Control` that shows a chosen state but reports none.
6. **D3 — Discoverability of what exists:** baseline wrapping and `present`; and **L5**, equal cells that wrap, which
   doesn't exist yet.
7. **T3 — a failed expectation points to the trace.**
8. **L4 — the write-finished pattern.**
9. **T4 — fixtures offered for tests that write.**
10. **L6 — script typing hints and reserved names.**

## The agent's account, verbatim

Asked after the build by resuming the session with read-only tools (`impressions.txt`); 1.0 min, 5.5k output tokens,
counted separately from the build.

### Building Cadence in Declare: an account for the people who make it

#### (a) Getting up to speed

**What I read.** I started at the README, then followed `skill/SKILL.md` exactly as written:
- `docs/declare.md` in full;
- guide chapters 01, 04 and 05;
- `apps/calendar/calendar.declare` alongside `28-calendar.md`.

After planning I read, as needed:
- chapters 06 (layout), 08 (controls), 10 (touch), 14 (data), 18 (overlays) and 21 (motion);
- `apps/weather/weather.declare`, the nearest model for "status at a glance, phone and desktop";
- `library/sheet.declare`, and about a dozen `npx declare-help` lookups (`PinchEvent`, `WheelEvent`, `Text.numeralWidth`, `Spring.arrive`, `App.underlapBottom`, `Shortcuts --all`, and others).

**What taught me the most.** Three things.
- **`declare.md` §5.** "Set vs declare", the table on who owns a value, and the settle. It explains most of the runtime's behaviour in about two pages. The rule "derived state is never assigned — change its inputs instead" shaped the whole model file.
- **The calendar.** It's the right exemplar for anything surface-like. The four sprung scalars (`c0`, `r0`, `nc`, `nr`) that every cell reads gave me the year chart's design almost directly: `span` and `vEnd`, each with a spring and a target, and everything placed from `viewStart` and `dayW`. The `blockness` idea ("derive character, not just geometry") became my volume silhouette, which fades as bars take over when you zoom in.
- **Small, decisive passages in the guide.** Three of them each answered a design question I'd otherwise have fumbled:
  - "Under the hand, write the value and its target together", from 21-motion;
  - the `NewPage` computed-default example in 14-data, where the address follows the title until the user writes their own;
  - "A figure that arrives with its data appears; it does not count up."

  The second one is the most useful idea in the docs for form design. My form's "defaults follow the sport until you touch a number" behaviour is exactly that pattern, at no cost.

**What was missing or misleading.**
- **Shortcuts inside a modal.** `Shortcuts --all` says: "Nothing fires while an open menu or dialog holds the keyboard: its keys are its own." I read "its keys" as including a `Shortcuts` set declared *inside* the dialog or sheet. It doesn't: `shortcutFor` in `runtime/src/keys.ts` returns null whenever `navClaimed()` is true, wherever the set lives. I only found this by reading runtime source, which the skill tells agents not to need. The docs should state it plainly, ideally with the sanctioned alternative. I used a `Keys` member inside the form, which is the very "chain of key tests" the drift check warns against. I'm still not sure that was the intended answer.
- **Weather is long.** The weather app was excellent but expensive: about 1,470 lines, much of it about phone scroll and handoff physics I didn't need. A short "what this file demonstrates, by line range" index at the top would have let me read a third of it.
- **Time-of-day guidance.** Nothing told me how to think about the brief's "the sport they always do at this hour" when the data carries no time. That's a brief/data problem, not a Declare one, but worth noting.
- **Mildly misleading.** I didn't know a class may not share a name with a TypeScript lib global (`Pick`) until DECLARE4015 said so. That's fine as a diagnostic, but surprising.

#### (b) Expressing intent

**Where it fit well.**
- **One source of truth with derivations.** `Sessions extends DataSource` holds the records, and its write sources' `onLoad` handlers splice replies into those same records. Week, streak, week shape, year series, month totals and the open session are all constraints or derived datasets. Adding a session moved every number with no update code at all. That's the headline promise, and it held.
- **Springs on displayed figures.** Five `*Shown` attributes, each with a `Spring` to the true value, gave "numbers travel" for almost nothing. The `DayBar` height spring is the same idea.
- **Responsive layout.** `ResponsiveLayout` with a two-entry plan (row 33/67 above 700 wide, a stack below) was the right size of tool for the phone/desk split.
- **Overlays as state.** `Sheet [ shown = { app.formOpen }, input(open) { … } ]` and `Dialog.open(...)` with button records were clean. I never thought about scrims, focus or Esc.
- **`draw(d)` for the chart.** Canvas-style drawing that re-records only when its reads change was the right primitive, and reading app state inside it just worked.
- **Gesture claims.** `claim = x` plus `onPointerMove` and `onPinch*` on the chart was exactly what I wanted: the page still scrolls vertically on a phone. That's how the touch model should be, and §8 and chapter 10 explain it well.

**Where I worked around it, or I'm unsure I did it idiomatically.**
- **Mixed-size figure lines.** "4 sessions · 3h 40m", with big figures and small words on one baseline, took a flat `SimpleLayout [ align = baseline ]` of `Text`s, with spacing faked through `padding` on the unit words. A composite like `DurationFig` needed an explicit `baseline` declaration (the compiler told me how, which was good). Line *wrapping* with baseline alignment didn't seem available. So for narrow phones I wrote `weekFig`, which estimates font size from digit counts. That's a heuristic I'm not proud of. A rich-text run with per-span sizes that wraps would be the real answer, and maybe `HTMLText` with styles does this; I didn't check.
- **Equal widths by arithmetic.** For the ten effort cells in a `WrappingLayout` I wrote `cellW = floor((width − 54) / 10)`. That's a drift-check tell. The `floor` was needed because rounding wrapped the tenth cell. `flexes` only works for one row, and I wanted 2×5 on a phone and 1×10 at a desk.
- **Coupling inside the model.** `Sessions.create.onLoad` calls `app.saved(...)`, so the model reaches up into the App. The calendar's `Drag` does the same, so it may be accepted, but it felt wrong. I couldn't find an idiom for "tell the requester the write finished" besides the App watching `loading`/`failed`. I'd welcome a documented pattern.
- **Keeping the form alive while its sheet closes.** I wrote `exists = { app.formOpen || app.form.openT > 0 }` so the form survives the slide-out animation. I never confirmed it actually prevents the sheet emptying mid-animation; I didn't look.
- **`arrive()` at boot.** I call it from both data sources' `onLoad`, because the final value depends on both sessions and today's date. I did not verify that the figures don't roll up on first load. That's an honest gap.
- **Overrides of runtime methods.** Naming an App method `reveal` broke compilation (TS 2416, incompatible override). The error was clear, but a list of names reserved by App/View would have saved a cycle.

#### (c) Verifying

**How I checked.** The ladder, in order:
- **`declare-verify`, rungs 1–4.** Boot runs at both laptop and phone sizes, with sample data fed from my schemas.
- **`declare-look`, about eight times.** Pictures at 1280×800 and 390×844 with `--touch`, plus `--read`, `--call`, `--click-at`, `--drag`, `--pinch` and `--key`.
- **An assert script.** `tests/assert.mjs`, about 30 steps, drives two flows:
  - a desk keyboard add, then undo;
  - a phone two-tap add, then undo.

  It checks both the requests sent (`expect.request`) and the derived numbers.

**What served me well.**
- **Diagnostics with the fix named.** DECLARE2000 on a `Button` that both flexes and has a width, the "declares no baseline" message giving the exact line to add, and DECLARE4002 on a member shadowing a script function (`kmStep`). Each took under a minute to fix.
- **The rung-4 layout notes.** These were genuinely valuable: "stats.line runs past the window's right edge at 390 wide (it ends at 412)" and "7 controls smaller than 44 × 44" are findings I'd normally only get from a designer staring at a phone.
- **`declare-look --read app.winA --read app.vEnd …`.** It let me find in one call why "All" showed 247 of 248 sessions: the window was clamped to the right edge and cut a day off the left.
- **Virtual time.** `settleMotion` and `settleData` made assertions on sprung values deterministic.

**What served me less well.**
- **A silent touch miss.** `declare-look --touch --click-at app.main.year.chart 300,240` silently didn't reach the chart when it started below the fold, probably landing under my fixed "Log a session" button after scroll-into-view. The verify docs say assert-script presses report what covered the target. `declare-look` printed nothing, so I needed a `console.log` and a manual `--js "window.scrollTo"` to debug.
- **A false positive I nearly missed.** My first assert run "confirmed" the `b` (ride) shortcut worked, because ride was already the default for a Wednesday. Only the digit check failing exposed that *no* shortcuts fired in the sheet. That's on me, not the tool, but a trace of "keydown → no shortcut owner in force (nav claimed)" from `expect.trace` would have shown it immediately. I didn't try the trace.
- **The tests write to a real service.** Each run adds a session, and a failed run left one behind until I added a `finally` cleanup and deleted the leftover with curl. Mocking hooks exist (`--fixtures`), but I didn't use them.
- **Not exercised at all:** `--semantics`, the canvas renderer, rung 6 visual baselines, and any real touch hardware.

#### Surprises

- How much the "write value and target together" rule mattered. It's the whole difference between a surface that sticks to the finger and one that trails it, and it's two lines.
- That a `Spring` per displayed figure is normal and cheap. In most stacks number tweening is a library decision.
- That `{ }` is strict TypeScript with dependency tracking *through method calls*. I wrote `streakDays()` with a `while` loop over `sessions.on(n)` and it stayed reactive. I expected to have to restructure it.
- That an open modal suppresses *all* declared shortcuts, its own included (above).

#### Good and bad

**Good:**
- The update model has no update code.
- Diagnostics are written for the reader who has to fix them.
- The verify ladder plus `declare-look` gives an agent eyes and hands cheaply.
- The guide's prose is opinionated in useful ways ("Claim the least you need, on the smallest view that needs it").

**Bad:**
- **Typography is weak for a UI language.** A baseline-aligned line of mixed sizes can't wrap.
- **Some behaviour is only discoverable from runtime source.** The shortcut suppression above is the example from this build.
- **Exemplars are long.** Weather and calendar are long enough that reading them costs real context budget.
- **Drift warnings with no replacement.** The drift check warns against forms (arithmetic widths, `Keys` chains) that I sometimes couldn't replace, and nothing says what to do instead in those cases.

#### Differences from what I'm used to

Compared with React: no render, no effects, no keys, and no fetch-then-setState choreography. Writes go to data, and replication over `:path[]` replaces `.map()`. The bigger mental shift is that layout belongs to the parent (`a layout places its children, and what it places a child does not declare`). The compiler enforces this, which caught me twice. It resembles SwiftUI's environment (`provided`) and `isPresented` (overlays as state), but without the view-struct rebuild model.

#### What it reminded me of

- **QML is the closest match:** property bindings, `Behavior on x { SpringAnimation }`, `State` with property changes, and the anonymous-subclass-per-instance feel.
- **OpenLaszlo and Flex/MXML**, which the README cites.
- **Spreadsheets**, for the constraint model.
- **Processing/Canvas** for `draw`.
- The `[ ]`/`{ }` split recalled Svelte's markup versus `<script>` division, but with a much stricter boundary.

#### Where I'd most want improvement

1. **Typography.** Wrapping runs with per-span size, weight and tabular figures, aligned on a baseline. It's the core of "numbers are the hero" designs, and I faked it.
2. **Keyboard handling inside modals.** A documented, idiomatic way to give a sheet or dialog its own shortcut set.
3. **`declare-look` honesty.** When a press lands somewhere other than the named view, say so, as assert presses reportedly do.
4. **A write-completion pattern.** An idiom for telling the requester a dataset write finished, without the model reaching up to `app`.
5. **A "start here" index for each exemplar**, so agents read only the relevant slice.

#### What I'd use it for

Given the choice, I'd reach for Declare for the following, and I'd expect to write less code than in React, with more of it checked:
- data-dense, glanceable interfaces like this one: dashboards, logs, monitors;
- anything with a continuous, zoomable or draggable surface (timelines, calendars, charts you handle);
- small-to-medium tools where one person, or an agent, owns the whole thing.

I'd hesitate on text-heavy, typographically demanding content, on apps that need a wide ecosystem of third-party components (`DOMIsland` exists, but I didn't try it), and on anything where pre-1.0 churn is a risk. I'm least certain about how it scales across a team and over years. Nothing in a one-session build can tell me that.
