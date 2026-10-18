# Cadence run 14: Declare 611b696f, Opus 5.5

**Run:** 2026-10-17 20:28 UTC, launched with `evals/craft/launch.sh cadence ~/Code/eval-cadence-14 claude-opus-5-5 611b696f`
against GitHub main `611b696f`, the head at launch. That build is the first run with the overlay and focus work:

- the library overlays (Menu, Popover, Dialog, Sheet, Toast, Window) and focus scopes;
- shortcuts as records;
- the theme defaults;
- the Tab-order review fixes;
- arrows in one-stop groups (#34).

It used Opus 5.5 (`claude-opus-5-5`), with web tools available and the brief's idiom sentence included. One round.
`evals/`, `docs/system-design/` and `test/` were removed from the agent's copy (the standard strip).

**Try it:** http://127.0.0.1:8201/my-apps/cadence/cadence.declare. This is the agent's own dev server (PID 29190). It
took 8201 because 8200 was taken. The data service is on :8320 (PID 4242).

## The comparison

Build figures come from the build's own final record. The account was asked for afterwards, in a separate resume, and
is counted separately. Run 13's logs no longer exist; only its source survives (`evals/runs/2026-10-07-cadence-run13`),
so it appears only where its source can answer.

| | run 11 | run 12 | run 13 | **run 14** | React |
|---|---|---|---|---|---|
| Declare commit | `75d710da` | `609f04f0` | — | **`611b696f`** | — |
| time | 16.6 min | 22.3 min | — | **19.2 min** | 15.4 min |
| turns | 92 | 87 | — | **94** | 63 |
| tool calls | 84 | 85 | — | **93** | — |
| code, raw lines | 1,272 (3 files) | 1,089 (1 file) | 1,135 (3 files) | **1,242 (3 files)** | 2,943 |
| code, excluding comments and blanks | 922 | 823 | 841 | **921** | 2,537 |
| cost (build) | $5.79 | $6.23 | — | **$6.84** | — |
| **Tokens** | | | | | |
| output (incl. thinking) | 85k (39k) | 69k (26k) | — | **87k (38k)** | 89k |
| fresh input (cache writes) | 227k | 242k | — | **252k** | 129k |
| cached input re-read | 11.4M | 14.6M | — | **15.5M** | 3.5M |
| read before first app write | 250 KB | 344 KB | — | **328 KB** | 23 KB |
| context at first write → end | 125k → 235k | 165k → 247k | — | **156k → 257k** | 30k → 134k |
| first app write at | 6.7 min | 8.3 min | — | **6.0 min** | 2.6 min |
| **Download (gzip)** | | | | | |
| app + runtime | 138 KB | 141 KB | 159 KB ¹ | **163.5 KB** ² | 99 KB (+ a 90 KB web font) |

¹ Run 13's source built today on `611b696f`.
² `declarec` production build from the main tree at `611b696f`.

On the same build, run 14's app is 4 KB over run 13's. The 22 KB rise from run 12 is the platform growing, not this app:
the library overlays and the focus and keyboard work arrived since. Separately, **run 12's app no longer compiles**. It
declared its own `class Sheet`, which now collides with the library's (`DECLARE5000`). See finding 8.

The account cost $0.22 and took 1.4 min (session total $7.06 minus the build's $6.84).

Where the time went (`measure.mjs`):

| activity | time | share |
|---|---|---|
| model | 16.3 min | 85% |
| rendering screenshots | 1.4 min (11 calls) | 7% |
| editing | 1.1 min (20 calls) | 6% |
| everything else | under 0.5 min | 2% |

Seven `declare-help` topics; six render-then-edit corrections; three checks that reported failure.

### Onboarding

- **It followed the SKILL's required reading in order:** README, SKILL, `declare.md` in full, chapters 01, 04 and 05,
  and the calendar whole. It skipped `27-calendar.md`, the calendar's commentary, "to save context".
- **Then it read on demand:** ch14's data sections, ch10, ch06, ch18 (Popovers through Toasts), ch20's springs, ch12's
  rich text, ch17's Control and drawing sections, the App section of `weather.declare`, and about 20 `declare-help`
  lookups.
- **It did not read the tracker** (no longer required) or ch08. ch08 is where the new keyboard and one-stop-group
  teaching lives.

## What it built

One page, arranged two ways:

- **At a desk:** two columns, Today on the left and the Year on the right.
- **On a phone:** one scrolling column, with a floating + button.

The pieces:

- **The record:** one `Sessions extends DataSource` holds the records and every query over them: this week, the streak,
  the week's shape, daily totals, typicals and "longest since".
- **The App:** derives `week`, `daily` and `inView` datasets from it.
- **Writes:** POST, PUT and DELETE are `DataSource`s whose `onLoad` puts the reply into `Sessions`.
- **The year:** a drawn chart under the hand. It pans by drag, zooms by pinch, trackpad pinch or wheel, cross-fades
  between daily and weekly bars, and splits a day into its sessions when opened far enough.
- **Opening a session:** a `Sheet`.
- **Logging:** another `Sheet`, made of choices and nudges:
  - four sport chips;
  - date and duration as large values between round − and + buttons;
  - distance following duration at the usual pace;
  - ten effort cells;
  - a note field, the only typing.
- **Defaults for a new session:** the sport usually done on this weekday, for the usual duration, today.
- **Moving figures:** the headline figures are sprung, and settle immediately (`arrive()`) when data first lands.

### Used as a person would

- **Desktop and phone at rest** (screenshots at 1280×800 and 390×844, touch): on brief.
  - Big black figures with small muted words; one accent that means effort.
  - The running session is a dark card with a ticking clock, unmistakably not finished.
  - The week's bars sit on a fixed scale, so a light week looks light.
  - It's recognisable from a thumbnail.
- **Logging on a phone, the brief's case to get right: two taps.** I tapped + and then Save. It saved a 1h 50m ride
  today at effort 5, all suggested. At once:
  - this week went from 2 sessions · 1h 24m to 3 sessions · 3h 14m;
  - the streak went from 2 to 3 days;
  - Wednesday's bar rose;
  - the last session became the ride.

  I deleted the session afterwards, and the service is back at 248 sessions.
- **The chart under the hand:**
  - a 300 px drag moved the window back 39 days, and the period and its totals followed;
  - the wheel zoomed it out to 247 days.

  Pinch couldn't be driven headless.
- **One layout flaw:** on the phone, the running card's "3.7 km · 143 bpm" runs to the card's right edge, past its
  padding.

## Findings for the platform

1. **Library overlays assume the App is the window (a confirmed bug).** `Dialog`, `Popover` and `Sheet` size and place
   themselves by `hostH`, which falls back to `app.height` when there is no host window (`library/dialog.declare:214`,
   `popover.declare:107`). On a page whose App is the scroller, that is the whole page, as in the weather pattern the
   agent copied: `height = { Math.max(app.hostHeight, app.page.height) }`. So on a phone:
   - the sheet rose to the bottom of a 2,000 px page, off screen;
   - the scrim showed and the sheet didn't.

   The agent found it from a screenshot and overrode `hostH = { app.hostHeight }` at all three use sites
   (`cadence.declare:170`, `:454`, `:511`). This is the overlay twin of the focus-reveal bug fixed in #33. The fix is the
   same: frame by the window (`hostWidth`/`hostHeight`) when the host is the root App.
2. **`declare-look`:**
   - a `--click` on a target below the fold presses nothing and reports nothing;
   - a segment or a replicated row can't be addressed;
   - it can't call a method or set an attribute to set up a state;
   - it can't drive a pinch (open item 31);
   - it re-prints the R1–R5 ladder on every run.
3. **`declare-help` gaps:**
   - Method entries give prose but no signatures. `Dataset.method.insert` has no argument order, so the agent avoided
     `insert` and `removeAt` and rewrote whole arrays with `set`.
   - `WheelEvent` lists only `pinch`. That `deltaX` and `deltaY` carry the amount is in a parenthesis under
     `PointerEvent`.
4. **Undocumented semantics the agent had to guess:**
   - whether a `Spring` created with data snaps to its target or grows from zero;
   - whether a constraint fires when an input recomputes to an equal value;
   - whether a computed default is cached.

   It guessed right on the first two, and made extra datasets "to be safe" on the third.
5. **A value until the user sets it, then theirs (#41), for the third Cadence run running.** The form keeps `tuned` and
   `kmTuned` flags so a change of sport re-suggests duration, distance and effort until the user adjusts them.
6. **Text that keeps together or shrinks to fit.** "3h 40m" must not break and the copy can't change, so the agent wrote
   `fitLine()` (`cadence.declare:93`), which measures text with `measureText` and scales the figure.
7. **Small fixed sets of controls.** Four sport chips and ten effort cells are written out one per line. The agent asked
   which form is idiomatic, a ten-record literal dataset or repetition, and the docs don't say. See idiom item 2.
8. **A new library class breaks programs that used its name.** Run 12's `class Sheet` no longer compiles. Every new
   library class can break existing programs this way. Either a program's own class should shadow the library's (with
   a hint), or the library's names need a reserved convention.

## Is it idiomatic Declare?

I read all three files (1,242 lines) against the SKILL drift check, `declare.md` and the guide.

### What it gets right

- **One source of truth with its queries on it** (`model.declare:133–253`). `Sessions` owns every read and both writes
  (`put`, `drop`), and everything on screen derives from it. No refresh code anywhere. This is the tracker's and
  calendar's shape without having read the tracker.
- **Writes as DataSources** (`cadence.declare:167`, `:255`, `:258`). The reply is put into the source in `onLoad`;
  `saving` and `saveError` derive from the sources' own flags. Unlike run 12, it doesn't set an error from events.
- **Derived datasets for the week, the days and what's in view** (`:73–76`, `:148`). `periodA` and `periodB` are
  integers, so the in-view list recomputes only when a pan crosses a day.
- **Presence as state.** Both sheets are `Sheet [ shown = …, input(open) … ]` (`:448`, `:505`). The delete confirm is
  the library `Dialog`, and save on ⌘↩ is a `Shortcuts` record scoped inside the sheet (`:514`). Each of these was
  hand-built in earlier runs.
- **Motion:**
  - the chart's window is two numbers with springs, and under the hand value and target are written together (`handTo`,
    `:118`): the guide's pattern exactly;
  - the headline figures are sprung and `arrive()` on first load, so they travel on change and don't count up on
    arrival.
- **Gestures by declaration:** `onPinch`, `onWheel` with `e.pinch`, and `claim = x` on the chart (`:407`), so vertical
  scrolling on a phone survives.
- **Responsive with `State`s:** `desk: State [ applied = { !app.phone }, … ]` on each column, not a forked tree.
- **Its own controls `extend Control` with `press()`,** including the last-session block (`:357`) and the + button.
- **Typed records:** `schema Session`, `Live`, `Draft`, `WeekDay`, `DayTotal` and others. No `as any` on its own data.

### Missteps, and how they should have been written

1. **Widths by arithmetic instead of `flexes`**, the same miss as run 12:
   - `Choice [ width = { (parent.width - 24) / 4 } ]` ×4 (`:521–530`);
   - `EffortCell [ width = { (parent.width - 36) / 10 } ]` ×10 (`:555–582`);
   - `WeekBar width = { (parent.width - 6 * 8) / 7 }` (`views.declare:126`);
   - the desk's two-column `(parent.width - 24) / 2` (`:346`, `:357`).

   Each is `flexes = true` on equal children of a `SimpleLayout`.
2. **Fourteen hand-repeated controls.** The sports and efforts should each be one replicated child over a literal
   dataset: `Choice [ datapath = :sports[] ]` and `EffortCell [ datapath = :levels[], level = :n ]`. Each group is also a
   choice of one, which makes it **a one-stop group**:
   - `focusScope = stop`;
   - `focusEntry()` returning the cell that is on.

   As written, the form is 14 separate Tab stops before the duration and distance buttons. Since #34 the arrows would
   come free.
3. **A no-op hook per control class.** `Choice`, `EffortCell`, `Nudge` and `TextAction` each declare an empty
   `picked()`, `nudged()` or `acted()` plus `press() { this.picked() }`. The use site can override `press()` directly,
   as the tracker's chips do. The extra layer adds four method names that mean "press".
4. **The form's logic lives on the App** (`:185–268`): draft, suggestions, nudges and the touched flags. The agent says
   itself that `04-structure.md` would put it in a `LogForm extends Node` beside the draft, leaving the App to hold where
   the person is. That would take the App from ~600 lines to about half.
5. **The running card's row overflows on a phone** (`:317–326`). A fixed 64 px clock and an unwrapping line beside it
   leave no room for the `Spacer`. The detail line wants to wrap under the clock at phone width (`axis = { app.phone ?
   "y" : "x" }`, as the agent did elsewhere).
6. **No checks left behind.** Verification was ad hoc `declare-look` runs. An R5 `--assert` for the save flow and an R6
   baseline or two would have cost minutes. The agent says so itself.

### Workarounds the platform forced

- **`hostH = { app.hostHeight }` on every overlay** (finding 1). It should be the library's default.
- **`fitLine()` with `measureText`** (finding 6). It should be a keep-together span or shrink-to-fit text.
- **`tuned` and `kmTuned`** (finding 5). They should be a value that follows its formula until set.
- **Rewriting arrays with `set` instead of `insert`/`removeAt`** (finding 3). This is a docs gap, not a language one.

## The agent's account, verbatim

Asked by resuming the finished session with read-only tools (`impressions.txt`). Cost $0.22, 1.4 min.

# Building Cadence in Declare: an account for the people who make it

I didn't change any files while writing this.

## (a) Getting up to speed

**What I read, in order.** I read `README.md`, then `skill/SKILL.md`, then `docs/declare.md` in full. Next came guide chapters 01 (core concepts), 04 (structure) and 05 (run and check). Last was `apps/calendar/calendar.declare` in full. I skipped `27-calendar.md`, the calendar's commentary, to save context; the source's own comments carried most of it. After that I followed the skill's advice to stop and read only when a need came up:
- `14-data.md` § Where data comes from and § Talking to a server
- `10-touch.md` in full
- `06-layout.md` in full
- `18-overlays.md` § Popovers through § Toasts
- `20-motion.md` § Springs
- `12-text.md` § Rich text and § Reusing a text style
- `17-your-own-views.md` § Control and § Custom drawing
- the opening and the App section of `weather.declare`, for the phone-as-document pattern

Beyond those, I used about twenty `npx declare-help` lookups.

**What taught me the most.** Three passages answered parts of the brief almost word for word:
- `20-motion.md`, "**A figure that arrives with its data appears; it does not count up**" and `arrive()`. The brief asked for "numbers travel" but also for restraint, and this resolved the conflict exactly.
- The same chapter's "**Under the hand, write the value and its target together.**" This became the chart's `handTo`/`glideTo` pair with no further design work. The brief's "never wait for them to let go" is this pattern.
- `12-text.md`'s "**A run is one thing**": a large figure with small unit letters is one `HTMLText` with a `style` on a span. This is how `4 sessions · 3h 40m` stays one string while the figures are 84px and the words 26px.

`declare.md` §5 ("What you can assign"), with its table of set constraints versus computed defaults, was the most useful conceptual page. It stopped me from assigning to constraint-owned attributes before I tried. The skill's drift checklist was also worth having. I re-checked my plan against "an overlay built by hand" and "something a person presses, built from a View", and used `Sheet`, `Dialog` and `Control` subclasses as a result.

**Missing or misleading:**
- **Method signatures in `declare-help`.** `Dataset.method.insert` gives prose ("splices v into the array at path, at index") but no argument order or types. I wasn't confident of the order, so I avoided `insert`/`removeAt` and rewrote the whole array with `set`. That's fine with keyed reconciliation, but it was a workaround for a documentation gap.
- **`WheelEvent`.** Its entry lists only `pinch`. That `deltaX`/`deltaY` carry the scroll amount on a wheel event is in the `PointerEvent` entry, in a parenthesis. I found it by luck.
- **Whether a `Spring` snaps to its target when constructed.** The only hint is a calendar comment ("where the focus rectangle's springs take their snap"). My week bars each carry a `Spring` and are created when data arrives. I *believe* they snap rather than grow from zero, but I didn't watch the first frames to confirm.
- **Whether a constraint re-fires when an input recomputes to the same value.** I made `periodA`/`periodB` integers so the in-view list would recompute only when a pan crossed a day boundary. That works only if unchanged values don't notify. I assumed so and didn't verify it.
- **"A computed default inlines the expression"** (`declare.md` §5). Does reading it re-evaluate every time, or is it cached? I couldn't tell. To be safe I used derived `Dataset`s for anything expensive (`daily`, `week`, `inView`). That may have been unnecessary.
- **Nothing warns that library overlays break when the App is taller than the window.** That's exactly what the weather app's phone pattern produces. More under surprises.

## (b) Expressing what I wanted

**Where it fit.** The data model was the best fit I've had for this kind of app. One `Sessions extends DataSource` holds the records and every query over them: week totals, streak, week shape, daily totals, typicals, "longest since". The App derives `week`, `daily` and `inView` from it. A save is a POST `DataSource` whose `onLoad` puts the reply into `Sessions`, and every figure on screen updates in that settle. I wrote no refresh logic, and the brief's "nothing is stale and nothing needs a refresh" came free. `fetch()` settling first made `remove: DataSource [ url = { API + "/sessions/" + app.removingId } ]` plus "set the id, then fetch" correct with no thought.

Gestures fit well too:
- Declaring `onPinch` on the chart claims two fingers.
- `claim = x` keeps vertical page scroll on a phone.
- `PinchEvent` gives `x` in view coordinates, so zoom-about-the-fingers took two lines.
- `onWheel` with `e.pinch` covered the trackpad.

`draw(d)` for the year chart was natural. It redraws when `viewStart`/`viewSpan` change and not otherwise. `d.globalAlpha` let me cross-fade between daily and weekly bars on the first try.

For responsiveness, `desk: State [ applied = { !app.phone }, height = 100%, scrolls = y ]` on each column, plus `axis = { app.phone ? "y" : "x" }` on a `SimpleLayout`, gave me "the same app, arranged for the room" without forking the tree. `Sheet [ shown = …, input(open) … ]` for both the session view and the form was exactly the "open as state" pattern, and it became a bottom sheet on a phone without my asking. `Shortcuts` as records (`N`, `T`, and `⌘↩` scoped inside the sheet) felt right.

**Where I worked around it, or wrote code I'm not proud of:**
- **Library overlays on a scrolling page.** On a phone, `Sheet` and `Dialog` compute `hostH` from the App's height. With the App as tall as the document (`height = { Math.max(app.hostHeight, app.page.height) }`, copied from the weather app), the sheet rose to the bottom of a 2,000px page, off screen. The scrim showed and the sheet didn't. I overrode `hostH = { app.hostHeight }` at all three use sites. It works, but every app using the weather pattern will hit this.
- **Keeping "3h 40m" together.** I wanted the duration not to break across lines, and rich text has no keep-together span. A non-breaking space would have changed the copy the brief asks for, so I wrote `fitLine()`, which uses `measureText` to shrink the figure until the line fits. It works, but shrink-to-fit is a common enough need that I'd expect it, or a no-wrap span, to exist.
- **Repetition in the form.** It has four `Choice` lines for sports and ten `EffortCell` lines for efforts, differing only by a constant. Replication needs a dataset, and a ten-record literal dataset felt like ceremony. I'm unsure which the authors consider idiomatic. The drift check says "a list built by a loop" is drift, but doesn't cover a fixed, enumerated set of controls.
- **The App got fat.** `cadence.declare` is about 600 lines, and the App holds the chart window, the form's draft logic (`suggest`, `nudgeMinutes`, `kmTuned`), the write sources and the delete flow. `04-structure.md` would probably have me move the form into a `class LogForm extends Node`. I didn't, and I think a reviewer would be right to ask for it.
- **Polling the live session.** I used `Time [ tick = 1000, onTick() { app.liveSrc.fetch() } ]`. The docs bless "refreshing on a schedule" but also say "nothing waits / never polls". I believe a one-second refresh of a remote value is the blessed case. The alternative was a slower poll with elapsed time interpolated from the clock, which needs a timestamp set in `onLoad` and looks like the "flag set when data arrives" drift. I'm genuinely unsure which the authors would prefer.

**Diagnostics I hit:**
- `App.save(…) is not a valid method body — ';' expected [DECLARE2000]`, from `if (a) x() else y()` on one line. That's TypeScript's rule and my error, but a hint about the missing semicolon would have saved a moment.
- `Sheet.form is an attribute — a child may not take an attribute's name`. Clear and immediate: I had named a child `form`.
- `Argument of type … is not assignable to parameter of type 'never'`, from `const days = []` in a method. Plain TS inference, and fine once you recognise it.
- The best one: a `FontWeight` in a local style record widened to `string`. The diagnostic explained why ("a word kept in a local object loses its exactness") and offered three concrete rewrites. This is the "every diagnostic names its fix" promise kept.

## (c) Verifying it

**What I did.** I ran `npx declare-verify` after every edit; it takes a couple of seconds. It feeds each `DataSource` a sample of its schema so boot exercises real rows ("5 data source(s) fed a sample of their schema"), which is clever. Then I used `npx declare-look`, the most useful tool in the kit for me:
- screenshots at `--size 390x844 --touch` and at 1280×800, plus `--dark`
- `--click` by view path (`app.log.entry.long.up`) and `--key n`
- `--wheel` and `--drag` on the chart
- `--read app.weekCount`, `app.streak`, `app.saveError`

With these I drove a full save of yesterday's ride and read week count and minutes going from 2/84 to 3/194. I drove an edit (PUT) and a delete through the confirm dialog, then cleaned up the service with curl.

**How well the tools served me.** Mostly very well. Being able to read reactive attributes after real input made checking behaviour cheap, and the screenshots caught every visual problem I fixed:
- the header saying "YESTERDAY" for today
- the desktop Today column overflowing
- the invisible sheet
- seasonal bars turning into hairlines
- "JAN 2026" overlapping "FEB"
- "Harder than 0%"

**Friction:**
- **Clicks below the fold do nothing, silently.** On the phone, `--click app.page.body.year.list.0` pressed nothing and reported nothing. I learned it from `selectedId` reading empty, then scrolled first with `--wheel app 1000`. Either scroll the target into view or report that it wasn't hittable.
- **Can't address a segment.** `--click` on a `Segmented` hits its centre, and individual choices aren't named paths, so I couldn't press "2W".
- **No way to call a method or set an attribute** from `declare-look`. I wanted `app.preset(14)` or `app.formOpen = true` to set up a state quickly.
- **No gestures.** Pinch can't be driven at all. As the brief predicted, the two-finger path is built to the docs but untested.
- **Noisy output.** Every `declare-look` run re-prints the R1–R5 ladder, so I filtered it with grep.

**What I didn't use.** I never opened the Inspector or called `__declare.explain`; nothing confused me enough to need them. More importantly, I didn't write R5 `--assert` scripts or R6 baselines. My verification was a set of ad hoc runs that leave nothing behind. A maintainer inherits no tests, and that's my omission, not the tool's.

## Surprises

- The `Sheet`/`Dialog` geometry problem on a document-scrolling App: the one real defect I found in the platform.
- `HTMLText` with a `style` on a span as *the* answer to mixed-size figure copy. I expected separate text views and a fight over baselines.
- How much was right first time once it compiled. Springs, gesture claims and states almost never needed a second attempt. Layout needed several, but those were design iterations, not misunderstandings of the language.
- The formatter adds blank lines between members and moves closing `]` onto their own line in places. I didn't expect that from "it fixes indentation, commas and spacing", but it's harmless.
- The dev server, finding port 8200 held by another tree, explained what was going on and named the fix (`PORT=8201 npm start`). Small, but exemplary.

## Good and bad

**Good:**
- one source of truth with derived datasets
- writes landing in the source and everything following
- `Spring` with `arrive()` and the hand-and-target pattern
- gesture claims declared by handlers
- `draw()` as a reactive method
- diagnostics that teach
- `declare-look`'s path addressing and attribute reads
- the skill file's "read these, then stop" discipline, which kept my context lean and was correct

**Bad:**
- overlays assuming the App is the viewport
- thin method signatures in `declare-help`
- undocumented edge semantics (spring snapping at construction, propagation of unchanged values, caching of computed defaults)
- no keep-together or shrink-to-fit text
- repetition for small fixed sets of controls
- a test tool that silently misses offscreen targets

## Differences from what I'm used to

Compared with React or Vue:
- There is no render function, and nothing is a component re-running. The question is never "when does this run?"
- I wrote no `useEffect`, no memoization and no dependency arrays.
- Lists come only from replication, not `map`.
- Events don't bubble.
- Handlers are synchronous, and `fetch` is refused in bodies, so the network is entirely a `DataSource`'s lifecycle flags plus `onLoad`. That last one felt restrictive for about ten minutes and then clearly better.

There's no CSS. Paint and layout are attributes, and "what a layout places, the child doesn't set" is enforced at compile time. I hit no errors there, because the docs had made the rule stick.

## What it reminded me of

- **QML, most strongly:** property bindings as standing relationships, `State`s that revert on their own, springs on properties, `id`-style named children, and declaration order as stacking order.
- **OpenLaszlo and Flex/MXML:** the README names OpenLaszlo as its ancestor, and the family resemblance is clear.
- **Spreadsheets**, for the constraint model.
- **SwiftUI's `.sheet(isPresented:)`**, for `shown`/`input`.

## Where I'd most want improvement

1. Overlays that work under a document-scrolling App, or a documented, supported way to size them.
2. `declare-look`: scroll targets into view or report misses; address replicated or choice items; call methods and set attributes; synthetic pinch.
3. Full method signatures in `declare-help`, and an event-payload page per event type.
4. Spell out three semantics: whether a constructed spring snaps; whether a constraint fires when an input recomputes to an equal value; and how computed defaults are evaluated.
5. A keep-together span in rich text, and shrink-to-fit text.
6. A guide example of a real form in a sheet, with your own controls, a draft, defaults and save errors. That was the part of this build where I was least sure what idiomatic looked like.

## What I'd use it for

If I had the option, I'd use it for exactly this class of thing: status-at-a-glance dashboards, data you handle with your hands (timelines, charts, maps), and tools where continuity and touch matter. Here it made the hard part (a direct-manipulation chart, figures that move) about as cheap as the easy part.

I'd hesitate on accessibility-critical public products until the ARIA story the docs call "still growing" matures. I'd also hesitate on large team codebases: my maintainability judgement rests on one 1,240-line build by one author, which isn't enough evidence.

I also didn't measure performance on a real low-end phone. A per-frame `draw` over 430 days, plus a recomputing list during a pan, is where I'd look first if it stuttered.