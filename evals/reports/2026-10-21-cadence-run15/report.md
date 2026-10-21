# Cadence run 15: Declare 9444a776, Opus 5.5

**Run:** 2026-10-21 15:00 UTC, launched with `evals/craft/launch.sh cadence ~/Code/eval-cadence-15 claude-opus-5-5 9444a776`
against GitHub main `9444a776`, the same build as Venue run 1 the same day. It is the first Cadence run since the
accessibility merge and `TextInput.purpose`.

It used Opus 5.5 (`claude-opus-5-5`), with web tools available and the brief's idiom sentence included. One round.
`evals/`, `docs/system-design/` and `test/` were removed from the agent's copy (the standard strip).

**Try it:** http://127.0.0.1:8203/my-apps/cadence/cadence.declare. The agent left no server running, so this is one
started afterwards from the run's own copy. The data service is on :8320.

## The comparison

Build figures come from the build's own final record. The account was asked for afterwards, in a separate resume, and
is counted separately.

| | run 12 | run 14 | **run 15** | React |
|---|---|---|---|---|
| Declare commit | `609f04f0` | `611b696f` | **`9444a776`** | — |
| time | 22.3 min | 19.2 min | **18.2 min** | 15.4 min |
| turns | 87 | 94 | **86** | 63 |
| tool calls | 85 | 93 | **85** | — |
| code, raw lines | 1,089 (1 file) | 1,242 (3 files) | **1,321 (2 files)** | 2,943 |
| code, excluding comments and blanks | 823 | 921 | **927** | 2,537 |
| **Tokens** | | | | |
| output (incl. thinking) | 69k (26k) | 87k (38k) | **94k (45k)** | 89k |
| fresh input (cache writes) | 242k | 252k | **253k** | 129k |
| cached input re-read | 14.6M | 15.5M | **15.1M** | 3.5M |
| read before first app write | 344 KB | 328 KB | **334 KB** | 23 KB |
| context at first write → end | 165k → 247k | 156k → 257k | **167k → 259k** | 30k → 134k |
| first app write at | 8.3 min | 6.0 min | **7.3 min** | 2.6 min |
| **Download (gzip)** | | | | |
| app + runtime | 141 KB | 163.5 KB | **151.7 KB** ¹ | 99 KB (+ a 90 KB web font) |

¹ `declarec --sizes` in the run's copy at `9444a776`, built to a scratch directory. The app's own share is about 7 KB
(App 4.5, script 1.1, History 1.0). The 12 KB drop from run 14 is the platform, not this app: Venue's build on the same
commit is 152.9 KB.

The build is level with run 14 on every measure. The accessibility merge and everything else since `611b696f` added
nothing here.

The account took 1.1 min, in a separate resume; its tokens are not counted in the build's.

Where the time went (`measure.mjs`):

| activity | time | share |
|---|---|---|
| model | 15.5 min | 85% |
| rendering screenshots | 1.5 min (13 calls) | 8% |
| editing | 0.8 min (18 calls) | 5% |
| everything else | under 0.5 min | 2% |

21 `declare-help` topics; seven render-then-edit corrections; seven checks that reported failure, all ordinary compile
corrections.

### Onboarding

- **It followed the SKILL's required reading in order:** README, SKILL, `declare.md` in full, chapters 01, 04 and 05,
  and the calendar whole. It again skipped `27-calendar.md`.
- **Then it read on demand:** ch06, ch10, the data-source parts of ch14, the Sheets and Dialogs parts of ch18, ch08's
  controls, ch21's springs, ch17's drawing, the opening of ch22 and the App section of `weather.declare`, with 21
  `declare-help` lookups.
- **No runtime source.** Three library reads, each for something the reference should have answered:
  - `declare-help Sheet --all`, then `library/sheet.declare` lines 1–150: how a Sheet is opened and what goes in it;
  - a grep of `library/` for `theme SanFrancisco [`, printing the record: the theme's token names;
  - `grep "class Button" -A40 library/button.declare`: which tokens a button reads.

  These are the same three Venue run 1 made, so they are the reference's gaps, not the app's (findings 4 and 5).

## What it built

One page, arranged two ways:

- **At a desk:** Today on the left (the week, the streak, the week's shape, the running session, the last session), and
  the Year on the right (what is in view, the chart, and the sessions in view as a list that scrolls on its own).
- **On a phone:** one column on the page's own scroll, with a floating "+ Log session" button under the thumb.

The pieces:

- **The record:** `History extends DataSource` holds every session and every query over them: a period, the streak,
  daily totals with a trailing week, what this person usually does on a weekday or for a sport, and where a session
  stands among its sport (`cadence.declare:138–223`).
- **Writes:** POST, PUT and DELETE are three `DataSource`s; each `onLoad` writes the confirmed record into `History`
  with `insert` and `removeAt` (`:213–222`, `:438–446`). Run 14 avoided `insert` and rewrote whole arrays; this run used
  them.
- **The live session:** polled once a second, as the service describes it ("re-reading gives fresh numbers"); its dot
  beats once per reading with an `Animator`.
- **The year:** a drawn chart (`YearChart`, `cadence-parts.declare:319–455`). It pans by drag, zooms about the point
  under the hand by pinch, trackpad pinch or wheel, glides to presets (2 wks, 3 mo, 6 mo, All), draws the trailing
  week's minutes as a silhouette when zoomed out, and opens the session nearest a tap.
- **Opening a session:** a `Sheet` with the figures set large and a drawn scatter of the session against every other of
  its sport.
- **Logging:** a second `Sheet` (`SessionForm`, `:608–745`): four sport choices, a strip of recent days plus a
  `DatePicker`, duration and distance between − and + nudges, duration presets, a ten-step drawn effort scale that is
  one slider, and a note field.
- **Defaults for a new session** are declared defaults with computed values: sport, duration, distance and effort
  follow this person's usual values, and a change of sport re-suggests the rest, until the person sets one. There are
  no "touched" flags (run 14's finding 5 is gone; see "What it gets right").
- **Delete** asks through the library `Dialog`, themed so its default button is ink rather than the accent.
- **Shortcuts:** six on the page and ⌘↩ in the form, all as `Shortcuts` records.

### Used as a person would

- **Desktop and phone at rest** (screenshots at 1280×800 and 390×844, touch, in `shots/`): on brief.
  - Big black figures with small muted words, in a sans and a monospace; one accent that means effort.
  - The running session is a black card with a running clock, unmistakably not finished.
  - The week's bars are on a fixed scale and coloured by effort.
- **Logging on a phone, the brief's case to get right: two taps.** I tapped + and then "Save ride". It saved a
  1h 40m ride today at effort 5, all suggested. At once, this week went from 4 to 5 sessions, the streak went from 2 to
  3 days, and the last session became the ride. I deleted it afterwards; the service is back at 248 sessions.
- **The form's layout:** the day strip scrolls sideways with a visible scrollbar under it in headless Chrome (the
  agent noticed it too), and the effort scale's selected step stands taller than the rest.
- **Not driven:** pinch, and the year chart's pan (both were checked by the agent; pinch can't be driven headless).

## Findings for the platform

1. **The guide's own Sheet example produces the "sliver" bug, and both runs today copied it.** `14-data.md:577`, "A
   form in a sheet", ends `sheet: Sheet [ … form: NewPage [ exists = { app.adding } ] ]`. That line has two faults:
   - **A child named `form` collides with `Sheet.form`** (how the sheet presents) and nothing says so. The compiler has
     the check — it refused a child named `scale` on a View with `View.scale is an attribute — a child may not take an
     attribute's name [DECLARE2000]` — but it does not fire for an attribute a library class declares.
   - **A child with `exists` is not placed in the sheet's body.** After renaming, `app.entry.body.childViews.length`
     read 0 and the sheet opened 48 px tall; the agent wrapped the form in a plain `View` (`cadence.declare:527`).
     Venue run 1 hit the same thing with its sign-in sheet.

   The fix is in three parts: the collision check for library attributes, placement of `exists` children in an
   overlay's body, and the example.
2. **A method named `on…` is refused as an unknown event.** `dayPhrase` was first `onDay`, and the compiler said `App
   has no 'onDay' event — its handlers: onInit, onChange, …`. `declare.md:663` says the prefix is "a naming convention,
   not syntax", which is the intended rule, so this is a compiler bug. A warning would still help where an `on…` method
   matches no event of its class, since a misspelt handler (`onPointerdown`) otherwise never fires.
3. **`declare-look`:**
   - it can't click at a point inside a view, so a drawn control (the effort scale) is reachable only by `--drag` with
     an offset;
   - it can't drive a pinch (open item 31);
   - headless Chrome draws classic scrollbars, so screenshots show bars a Mac or a phone would not.
4. **The theme tokens page is unreachable from `declare-help`.** The guide says "The reference page *Theme tokens* lists
   which tokens are required, which are optional, and which classes read each one". The docs build generates that page
   (`tools/internal/doc/assemble.mjs:927`), but `npx declare-help "Theme tokens"` falls through to the `SanFrancisco`
   entry, which points to the source file. Both runs today read library source for this.
5. **`declare-help Sheet` doesn't say how to open one.** Its summary lists Sheet's own members; `shown` and `input` are
   documented on `Floating`. Both runs read `sheet.declare` to learn it.
6. **`declare-verify` passed while the sheet was a sliver.** R4 runs on synthetic metrics, so it cannot see sizes, but a
   body with no children is a fact about the tree, not about pixels, and R4 could report it.
7. **DECLARE7001 on a method passed a record.** `standing(app.history.byId(…))` could not be wired, so three methods
   take scalars instead. The diagnostic was clear; the pressure it puts on code is away from passing records, which is
   how the code reads most naturally.
8. **Resolved since run 14:** "a value until the user sets it, then theirs" (#41). This is the first Cadence run with no
   `tuned` flags. The agent learned it from the table in `declare.md` §5 and called it the best idea in the build.

## Is it idiomatic Declare?

I read both files (1,321 lines) against the SKILL drift check, `declare.md` and the guide.

### What it gets right

- **One source of truth with its queries on it** (`cadence.declare:138–223`). `History` owns every read and every
  confirmed write, and everything on screen derives from it. No refresh code.
- **Defaults that follow until the person sets them** (`cadence-parts.declare:611–616`). Six declarations do what run 14
  needed flags and handlers for. A fresh form per opening (`exists = { app.formOpen }`) means every opening starts from
  the current suggestion.
- **Writes as DataSources, errors as constraints.** `saving` and `saveError` derive from the sources' flags
  (`cadence.declare:447–453`); no error is set from an event.
- **Overlays and commands from the library.** Two `Sheet`s opened by `shown`/`input`, the delete confirm through
  `Dialog.open`, and shortcuts as `Shortcuts` records, the form's scoped to the form.
- **A token changed where it applies.** The design keeps the accent for effort, so the `Dialog` gets the theme with
  `accent` set to ink (`cadence.declare:534`): the way the guide teaches a token changed at one point in the tree.
- **Motion:**
  - the chart's window is two numbers with springs; under the hand the value and target are written together
    (`handView`, `:345`), and presets move only the targets (`glideView`, `:352`): the guide's pattern exactly;
  - every headline figure reads a sprung copy and `arrive()`s on first load (`:268`), so figures travel on change and
    don't count up on arrival.
- **Gestures by declaration:** `claim = x` on the chart and the effort scale, so vertical scrolling survives on a
  phone; `onPinch*` and `onWheel` with `e.pinch`.
- **The week's shape is replicated with `flexes`** (`cadence-parts.declare:179`): `DayBar [ datapath = :days[],
  key = :n, flexes = true ]`. Run 14 sized its bars by arithmetic.
- **The effort scale is one control** with `accessibilityRole = slider`, value, bounds and increment/decrement
  (`:755–785`). Run 14 had ten separate Tab stops.
- **The recent days are a literal dataset replicated** (`cadence.declare:401`, `cadence-parts.declare:657`).
- **Typed records throughout:** `schema Session`, `LiveSession`, `WeekDay`, `YearDay`. No `as any` on its own data.

### Missteps, and how they should have been written

1. **Hand-repeated controls with width arithmetic**, the same miss as runs 12 and 14:
   - four sport `Choice`s, each `width = { (parent.width - 18) / 4 }` (`cadence-parts.declare:637–648`);
   - five duration presets written out (`:684–698`).

   The repetition is in what each line restates: its label, its `chosen` test and its `press()` all spell the same
   value. A small subclass that takes the value once does it: a `SportChoice` whose label, `chosen` and `press()` all follow
   from one `sport` attribute, used as `SportChoice [ sport = "ride" ]`, and the same for the presets. The width is `flexes = true` on each. Replicating
   over a literal dataset would also work, but a fixed set of four controls isn't data, and it isn't what a developer
   reaches for. (The recent-days strip is different: its days are computed from today, and replication fits it.)

   Each group is also a choice of one, so it is a one-stop group: `focusScope = stop` and `focusEntry()` returning the
   chosen one. As written, the sports and presets are nine Tab stops.
2. **Desk geometry by arithmetic.** `year` is `width = { parent.width - app.todayW - 56 }` and `main`'s desk height is
   `app.height - 110` (`cadence.declare:498–504`). The year column wants `flexes = true` beside a fixed `today`, and the
   height wants to come from the page's layout, not a measured constant for the top bar.
3. **The chart's viewport lives on the App** (`:326–382`): `back`, `span`, their targets, springs, the fit and zoom
   methods and six derived values. It is machinery several views drive, which `04-structure.md` puts in its own `Node`
   class (`viewport: YearView [ … ]`). The agent says so itself.
4. **`LiveCard extends Control` with no `press()`** (`cadence-parts.declare:212`). It is focusable and does nothing. It
   wants to be a `View` with its label, as `WeekShape` is.
5. **The form's Save is a hand-built `Control` with `accessibilityRole = button`** (`:734–744`). That is legitimate
   given the ink-not-accent rule, but the same theme override it used on the `Dialog` would have let it be a primary
   `Button`. The redundant role is harmless.
6. **Sport names by a chain of ternaries in script** (`cadence.declare:112–114`). A small record (`{ run: "Run", … }`)
   reads better and is one place to add a sport.
7. **No checks left behind.** As in run 14, verification was ad hoc `declare-look` runs; an R5 `--assert` for the
   two-tap save would have cost minutes.

### Workarounds the platform forced

- **A plain `View` around the form inside the sheet** (`cadence.declare:527`), and the rename from `form`. The fix is
  finding 1.
- **`dayPhrase` for `onDay`.** The fix is finding 2.
- **Three methods taking scalars instead of a record**, among them `standing` and `paceOf`. See finding 7.
- **`TextStyle` annotations on the drawing styles** (`cadence-parts.declare:379–380`) so `"bold"` keeps its literal
  type. The diagnostic explained it; it is TypeScript showing through.
- **Centring numbers in a drawing with `measureText`** (`:781`). Legitimate in a `draw`, though a scale of ten could be
  ten views.

## The agent's account, verbatim

Asked after the build by resuming the finished session with read-only tools, with the standard questions
(`impressions.txt`).

# Building Cadence in Declare: an account for the Declare team

## (a) Getting up to speed

**What I read.** I followed `skill/SKILL.md` almost exactly. I read all of `docs/declare.md`, then guide chapters 01, 04 and 05, then the whole of `apps/calendar/calendar.declare`. After that I read sections only when I needed them: 06 (layout), 10 (touch), the "Where data comes from" and "Talking to a server" parts of 14, the Sheets and Dialogs parts of 18, the springs part of 21, custom drawing in 17, and the opening of 22. Everything else came from `npx declare-help`: `Sheet --all`, `DataSource --all`, `PinchEvent`, `WheelEvent`, `Dataset.insert`, `Spring.arrive`, `Animator`, `Shortcuts`, `Draw`, and others.

**What taught me the most:**
- **`declare.md`.** It's dense, but nearly every paragraph changed what I wrote. The table in §5 separating a set `{ }` from a declared default with a computed value was the most useful idea in the whole build. It became the basis of the add form: sport, duration, distance and effort are computed defaults that follow the person's usual values until they touch them. I don't think I'd have found that pattern on my own. The "A form in a sheet" example in chapter 14 confirmed it.
- **The "Under the hand, write the value and its target together" passage in 21.** This is the year chart's drag, nearly line for line. Because that passage also says writing only the value won't wake a sleeping spring, I didn't use a Spring for the live dot's pulse and used a restarted `Animator` instead. Without that sentence I'd have shipped a dot that pulsed once and then stopped.
- **The calendar.** It's expensive to read (about 48 KB), but it showed me the overall shape of an app: data on the App, sprung geometry numbers that everything reads, and a DataSource subclass holding its own queries. My `History extends DataSource` follows its `Events` class.

**What was missing or misleading:**
- **§8 says "the `on` prefix is a naming convention, not syntax."** In practice, a method I named `onDay` was rejected with "App has no 'onDay' event." The rule is clearly real. The spec should say that any member named `on…` is read as a handler.
- **The chapter 14 "A form in a sheet" example names its child `form: NewPage [ exists = … ]` inside a `Sheet`, and `Sheet` already has an attribute called `form`.** I copied that pattern and my sheet rendered as a 48px sliver. I'm not sure the guide's example is broken as written, since its `App` is fixed-size and simpler. But a child silently shadowing a library attribute should be a compile error. The compiler did refuse a child named `scale` on a View, so that check exists, but it didn't fire here.
- **After renaming the child, the anonymous `SessionForm [ exists = … ]` still wasn't moved into the sheet's `body`.** `app.entry.body.childViews.length` read 0, while the always-present `SessionDetail` in the other sheet was placed correctly. I worked around it by wrapping the form in a plain `View`. I think this is a bug in how `defaultplacement` handles `exists` children, but I didn't isolate it, so treat that as a lead, not a diagnosis.
- **I found no clear statement of whether `flexes = true` can coexist with a class's default `width = { … }`.** I didn't test it. I wrote `width = { (parent.width - 18) / 4 }` on the sport buttons, which is the exact drift tell the skill warns about.

## (b) Expressing what I wanted to express

**Where it fit closely:**
- **Derived state.** "This week", the streak, the week's shape, the in-view summary, the derived `inView` dataset: each is one constraint over `history`. The brief's "nothing is stale" requirement was satisfied with no code written specifically for it. Saving a session moved the week from 4 to 5 sessions and the streak from 2 to 5 days in one step.
- **Moving numbers.** "Numbers travel" was one Spring per figure, plus `arrive()` in `onLoad` so the first load doesn't count up from zero. The docs anticipated exactly that problem.
- **Gestures.** `claim = x` on the chart (a sideways drag is the chart's, a vertical one still scrolls the page) and declaring a handler as the way to claim a gesture map well onto how a person uses a phone. I could follow the rules without guessing.
- **Drawing.** Using `draw(d: Draw)` as a reactive method for a 425-day bar chart felt natural.
- **Server writes.** POST, PUT and DELETE were each a `DataSource` with `fetch()`, and the rule that `fetch()` settles first made aiming a PUT at a session id trivial.

**Where I worked around it:**
- **DECLARE7001 on `standing(app.history.byId(...))`.** A method that reads a record passed in can't be wired. I rewrote three methods to take scalars (sport, minutes, effort). The fix was clear, but it pushes you away from passing records around, which is how the code most naturally reads.
- **`TextStyle` literal widening.** `fontWeight: "bold"` in a local object lost its literal type, so I had to annotate `const small: TextStyle`. The diagnostic explained this well, but it's a TypeScript cost the DSL can't hide.
- **Bare names don't work inside `{ }` for enum values.** I wrote `fontWeight = { :today ? black : medium }` and needed strings, and I wrote `accessibilityRole = img` where the role is `image`. Both errors were caught immediately and clearly.
- **Responsive layout.** I mixed constraints on `app.phone` with `State` overrides that set `height`, `scrolls` and `flexes`. It works, but I'm not confident it's the intended idiom, versus `ResponsiveLayout` or a `desk: State` placed the way the weather app does it. There's also some hand-written width arithmetic I'd want a reviewer to challenge.
- **Possible misplacement of the year chart's viewport.** It lives on the App as `back`/`span` plus targets and helper methods. By chapter 04's own test (a piece of machinery that several views drive), it should probably have been a `Node` class.

## (c) Verifying it

**`declare-verify`** was fast, about 2 seconds, and its error messages were unusually good. Several told me the exact rewrite:
- "give the object its own braces: { { a: 1, b: 2 } }"
- the WrappingLayout baseline message
- the slider-role check listing `accessibilityValue/Min/Max/Increment/Decrement`
- the warning that `km` shadowed my script function

Each time, applying the named fix and re-running converged. The note "5 data source(s) fed a sample of their schema" told me R4 had exercised rows with fake data, which I appreciated.

Its limit: everything through R4 passed while the sheet rendered as a sliver. The synthetic backend can't catch layout and placement bugs. The docs say this plainly; it's still worth repeating.

**`declare-look`** was the tool that actually found problems. I found these from screenshots, not from verify:
- the sheet bug
- the overlapping month labels
- the today column overflowing at 800px tall
- the effort colours being too flat
- "Today" being truncated under the week's last bar

Things that helped:
- Paths named by label (`app.entry."Save ride"`, `app.detail.Delete`).
- `--call` and `--read` let me drive a full add → correct → delete cycle against the real service and check the results with `curl`.

Gaps I hit:
- There's no way to click at an offset inside a view. My effort scale is drawn, so its numbers aren't views. `--click 'app.entry."9"'` matched something offscreen, and I resorted to `--drag … 130,0`.
- Two-finger pinch can't be tested at all.
- Headless Chrome shows classic scrollbars, which made several screenshots look worse than a Mac would. I couldn't tell how much to care.
- Every screenshot stays in my context for the rest of the session, so I rationed them.

**What I didn't verify:**
- frame rate while the chart redraws every spring frame
- `virtualize = true` on rows inside the page's own scroll
- the screen-reader tree (`--semantics`, which I never ran)
- whether the week bars' `onInit() { grow.arrive() }` actually prevents bars growing from zero on first load

## Surprises

- Computed defaults that the person can then take over were the best idea I met. They're the right model for "suggest until the person decides".
- The compiler refuses `fetch` and timers in handler and constraint bodies and names the member to use instead. That pushed me into the right design without my having to think about it.
- The library `Dialog` used the theme accent for its default button. That collided with my rule that the accent means effort, and I had to override the theme locally. It's reasonable behaviour, but it shows the library assumes accent means "primary".
- A child's name can silently collide with a parent class's attribute (the `form` case above).

## Good and bad

**Good:**
- A small, coherent surface.
- Diagnostics written for the next edit.
- `declare-help` answering any name.
- Springs and states as the default way to animate.
- Gesture ownership you can reason about.
- One tree for phone and desktop.

**Bad:**
- The two sheet placement issues.
- A spec line (§8 on the `on` prefix) that contradicts the compiler.
- TypeScript's literal-type rules showing through inside a DSL that otherwise hides a lot.
- The cost of the onboarding reads in context: the calendar alone is large.
- No tool support for multi-touch or for clicking at a point inside a drawn control.

## Differences from what I usually use

Compared with React there are no renders, hooks, keys or effects. The closest equivalent to an effect, `onChange`, is explicitly discouraged. Lists come from data paths rather than `.map`. Styling is attributes plus provided values rather than CSS. Writes to the server are declarative objects rather than imperative fetch calls. I never thought about stale closures or dependency arrays, and that absence was the biggest practical difference.

## What it reminded me of

- QML most strongly: property bindings, states, a declarative tree with script inside it.
- Flex/MXML, and, as the README says, OpenLaszlo.
- A spreadsheet's recalculation model.
- In places, Svelte's reactivity, and SwiftUI's springs and value-driven views, though Declare is stricter about who owns which value.

## Where I'd most want improvement

1. Make child-name collisions with inherited attributes a compile error, and fix or document how `exists` children interact with `defaultplacement`. Then check the chapter 14 sheet example against both.
2. Correct §8 on the `on` prefix.
3. In `declare-look`: click at an offset within a view, synthetic pinch, and an option to hide scrollbars or emulate overlay scrollbars.
4. A verify rung that measures real layout, even roughly ("this sheet's body has zero children" or "its height is smaller than its content" would have caught my bug in seconds).
5. A shorter model app for the "read first" step, or a compact digest of the calendar. Its lessons are excellent, but it is a lot of context to pay for.

## What I'd use it for

I'd choose Declare for interactive, data-backed apps where motion and gesture matter and the logic is mostly derivation: dashboards, trackers, schedulers, internal tools, and anything with a surface the user manipulates directly. I'd be more hesitant where a project depends on a large component ecosystem, where a team needs a hiring pool, or for performance-critical surfaces at a scale I didn't measure here. My uncertainty there is real: one 425-bar chart tells me little about 50,000 points.
