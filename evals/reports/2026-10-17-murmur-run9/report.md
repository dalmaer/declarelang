# Murmur run 9: Declare 611b696f, Opus 5.5

**Run:** 2026-10-17 21:08 UTC, launched with `evals/craft/launch.sh murmur ~/Code/eval-murmur-9 claude-opus-5-5 611b696f`
against GitHub main `611b696f`: the overlay and focus build, the same one as Cadence 14. The service runs at `--scale=100`
(about 44,000 messages; the longest conversation has 30,500). One round, one phase. The standard strip applied.

**Try it:** http://127.0.0.1:8217/my-apps/murmur/murmur.declare, served from the run's own copy; the service is on :8330.

## The comparison

Run 8's logs no longer exist; its source survives (`evals/runs/2026-10-07-murmur-run8`) but no longer compiles on today's
main. Runs 6 and 7 are from their reports.

| | run 6 | run 7 | **run 9** | React-2 |
|---|---|---|---|---|
| Declare commit | `75d710da` | `609f04f0` | **`611b696f`** | — |
| time | 42.0 min | 37.7 min | **23.4 min** | 17.6 min |
| turns · tool calls | 226 · 225 | 170 | **124 · 123** | — |
| cost (build) | $15.62 | $15.27 | **$9.33** | — |
| code, raw · excluding comments and blanks | — | — · 1,132 | **1,368 · 955** (5 files) | — |
| output tokens (thinking) | — | — | **102k (44k)** | — |
| cached input re-read | — | — | **23.8M** | — |
| download (gzip) | — | 131.5 KB | **148.5 KB** ¹ | 189 KB |
| DOM nodes, at rest · longest thread open | 6,293 | ~6,050 | **293 · 531–924** | 452 |
| JS heap | 96 MB | 73 MB | **24–60 MB** | — |

¹ `declarec` production build from the main tree at `611b696f`. The platform grew about 22 KB since run 7 (see Cadence 14).

The account cost $0.22 and took 1.1 min.

Where the time went (`measure.mjs`):

| activity | time | share |
|---|---|---|
| model | 17.8 min | 76% |
| reading | 2.4 min (59 calls) | 10% |
| editing | 1.2 min | 5% |
| rendering screenshots | 1.0 min | 4% |

Also: 46 `declare-help` lookups across 45 topics, and 7 checks that reported failure.

**The headline:** about 40% less time and cost than runs 6 and 7. The list problem those runs had is gone: one conversation
of 30,500 messages is about 900 DOM nodes, not 6,000.

## Against React and Svelte, at run time

Measured 2026-10-17 with `my-apps/sweep/compare-murmur.mjs`: production builds of React-2 (`evals/runs/2026-10-04-murmur-react-2`),
Svelte-1 (`evals/runs/2026-10-07-murmur-svelte-1`) and this run (`declarec`, main tree), against the same service (`--scale=100`),
headless Chrome at 1440×900, median of 3; heap after a forced GC; "open" is from the press to the frame in which the thread's text is visible.
Build figures for React and Svelte are from their 2026-10-08 measurements.

| metric | React-2 | Svelte-1 | **Declare 9** |
|---|---|---|---|
| build time | 17.6 min | 20.5 min | **23.4 min** |
| build cost | $4.21 | $4.65 | **$9.33** |
| code lines | 2,815 | 2,922 | **955** |
| download (gzip; JS, CSS, HTML; no fonts) | 185.3 KB | 66.8 KB | **147.6 KB** |
| DOM at rest | 116 | 121 | **289** |
| JS heap at rest | 10 MB | 10 MB | **17 MB** |
| renderer memory at rest | 207 MB | 194 MB | **246 MB** |
| DOM, all six threads opened in turn | 286 | 283 | **2,167** |
| JS heap, all six opened | 12 MB | 11 MB | **33 MB** |
| renderer memory, all six opened | 250 MB | 227 MB | **326 MB** |
| first open | 307 ms | 31 ms | **75 ms** |
| open the 30,500-message thread | 261 ms | 26 ms | **87 ms** |
| median of all six opens | 261 ms | 28 ms | **73 ms** |
| reopen a thread already seen | 231 ms | 31 ms | **6 ms** |

The program keeps each thread's view built once opened (its per-thread place and draft), so its all-six footprint and its reopen
time both come from that design; React and Svelte rebuild one thread at a time. The platform's own gaps are first open, the resting
footprint and the download.

## What it built

Two surfaces placed by the width:
- **At a desk:** a sidebar of conversations beside the open one.
- **On a phone:** the list is home, and a conversation slides over it on one sprung number.

How it's built:
- **Data and the live feed:** one `Conversations extends DataSource` holds the whole history. A `Wire extends Socket`
  writes the live feed into it, and sending appends locally before the frame leaves.
- **The conversation list:** derived from it (`inbox: Dataset`), so its order is never maintained by hand.
- **One `ConversationView` per thread,** built once, only the open one visible. Each keeps its own scroll position and
  draft for free.
- **The history:**
  - `virtualize = true` with `classFor` per message kind (text, photo, voice);
  - `scrollAnchor = end`;
  - day headings, sender names, run corners and faces all derived per row from its neighbours.
- **Reactions:** a `Popover` (a bottom sheet on a phone) opened by holding a bubble or right-clicking it, or by a
  hover-revealed button at a desk.
- **Voice:** a drawn waveform that is also the scrubber.
- **Photos:** a full-screen `Dialog` viewer.
- **`DESIGN.md`:** builds nothing by hand that the platform provides.

### Used as a person would

- **Loading:** 2.2 s to the history (5.5 MB).
- **The longest conversation, by its scroll thumb.** I set the scroller's position as a thumb drag does: to half, a
  quarter, the very top, and back to the end. Each landed immediately, and at the top it reads the first message, from
  4 October 2020, correctly grouped. The agent drove a real thumb drag in its own probes, from index 30,499 to 0 and back.
- **Memory:** the DOM stays under 1,000 nodes throughout, and the heap falls to 24 MB after jumping around.
- **One rough edge:** the date chip shown while scrolling back read the same date (9 Aug) after each of my jumps. Its
  source, rows reporting when they reach the top edge, only fires on a change. The agent found and patched a variant of
  this (finding 2). Jumps through a virtualized list may still miss it.

## Findings for the platform

1. **Behaviour checks run on a virtual clock, and nothing says so where a script author would look.** A probe that held
   the mouse for 800 ms never fired `onHold`: `verify-behave.mjs` virtualizes `setTimeout`, so time passes only on
   `drive.wait(ms)`. The agent found it by reading the harness and the runtime's `input.ts` (for the hold delay). It also
   stripped `selectable` from message text while chasing it, possibly for nothing. `verify.md` should state the clock
   model, and the whole `drive` API should be listed in one place.
2. **No fact for "the first visible row".** For the date chip, each row computes `atTop` and reports to the App by
   `trackChanges`. A recycled virtual row that stays at the top while it is handed another record fires no change, which
   showed a stale date. The agent patched it by also tracking `:at`. Either a scroller fact (`firstVisible`) or a
   16-collections note on recycling.
3. **Text that shrink-wraps when it wraps.** A bubble as wide as its text up to a cap needs `measureText`, since
   `contentWidth` of wrapping text depends on the width (messages.declare:103). A real gap, also met by Cadence 14
   (`fitLine`).
4. **Re-keying a record keeps its row.** An optimistic send that learns its server id would rebuild its row if the key
   changed, so the agent kept the local id and added `sid`/`pending`, and every lookup checks both.
5. **A library class name took the program's (DECLARE5000, `Pane`):** the second run in a row, after Cadence 12's `Sheet`.
   See Cadence 14's finding 8.
6. **`settleMotion` never settles while a decorative loop runs** (the typing dots, `repeat = 100000`). A way to mark a
   loop as decoration, or to settle everything else, is wanted.
7. **Smaller:**
   - `declare-look --read` reaches attributes only;
   - library icons that declare `y = center` fail in a `SimpleLayout` with `align = center`;
   - `clip = { … }` was refused where bare `clip = true` is accepted;
   - a literal `datapath` is refused, so each reaction row carries a derived `Dataset`.

## Is it idiomatic Declare?

I read all five files (1,368 lines) against the SKILL drift check, `declare.md` and the guide. This is the most
idiomatic Murmur yet.

### What it gets right

- **The long list exactly as taught:**
  - `virtualize = true` with `classFor` (chrome.declare:164);
  - `scrollAnchor = end` and `scrollTo(Infinity)` to follow (:154);
  - per-row facts from neighbours (`prev`/`next` by `rowIndex` over a provided `msgs`, messages.declare:26–35);
  - no windowing, rails or timers.

  Run 6's teaching item, in full.
- **One source of truth with writes through it.** Live frames and sends write into `Conversations` by path
  (model.declare:150–195), and the list is a derived dataset.
- **The live feed is a `Socket` class** with typed frames, active only while loaded.
- **Library overlays:** a `Popover` for reactions and photos (anchored by `showFor`), and `PhotoViewer extends Dialog
  [ presentation = "full" ]`. No hand-built scrims.
- **`waypoint` for the open conversation,** so Back closes it.
- **A phone and a desk from one tree,** carried by one spring (`slide`).
- **Its own controls `extend Control` with `press()`:** the waveform scrubber, chips, buttons and tiles.
- **Typed records throughout,** with drawn icons as `Icon` subclasses.

### Missteps, and how they should have been written

1. **The composer's height measured by hand** (chrome.declare:329). `08-controls.md` gives it: a multi-line field left
   unsized is as tall as its text, so `height = { Math.min(contentHeight, 125) }`.
2. **The inbox re-ordering animated by hand.** Each row has its own `Spring` on a `seat` and `y = { seat }`, inside a stack
   sized by `rowCount * rowH` (murmur.declare:179–185). Moving a whole arrangement is `22-animated-arrangements.md`'s
   job: a `TweenLayout`. The hand version also fixes every row's height at 78.
3. **The empty-hook pattern again:** `chosen() { }`, `seekTo() { }`, `step() { }`, `input() { }`, `submit() { }` on
   EmojiKey, Waveform and Composer, called from `press()`. A use site can override `press()`, or the class can take the
   value pattern (`input(v)`).
4. **A program-wide Esc in a `Keys` member** to close the thread on a phone (murmur.declare:152). Back already closes it
   through `waypoint`. Esc wants to be a `Shortcuts` record, or simply the system Back.
5. **The emoji row in the reaction popover is six separate Tab stops.** As a choice of one, it's `focusScope = stop`, and
   arrows come free (#34).

### Workarounds the platform forced

- **Bubble widths and the pill's text by `measureText`** (finding 3).
- **`atTop` and `noteTop` reporting to the App for the date chip** (finding 2).
- **`sid` and `pending` beside `id`** (finding 4).
- **A derived `Dataset` in each `Reactions`,** because a literal `datapath` is refused (finding 7).

## The agent's account, verbatim

Asked by resuming the finished session with read-only tools (`impressions.txt`). Cost $0.22, 1.1 min.

# Building Murmur in Declare: an account for the Declare team

I didn't change anything for this. It's written from memory of the build, and I've said where I'm unsure.

## (a) Getting up to speed

**What I read, in order.** README → `skill/SKILL.md` → `docs/declare.md` in full → guide chapters 01, 04 and 05 → `apps/calendar/calendar.declare` whole. After that I read only when I hit a need: 07 (scrolling), 16 (collections), 13 (media), the streams section of 14, 06 (layout), 10 (touch), 18 (overlays), 11 (paint and themes), 20 (motion), 15 (schemas), and parts of 17. That came to roughly 250 KB of reading before I wrote anything serious. It was worth it, but it's a lot.

**What taught me the most:**
- **The "What Declare handles for you" table in SKILL.md** was the most useful page in the repo. Nearly every hard requirement in the brief mapped to one of its rows, and that table stopped me from rebuilding things that already exist.
- **The "Following the end" section of 07-scrolling** is close to a specification for a chat view:
  - `scrollAnchor = end`
  - keeping the reader's place when they've scrolled up
  - a ready-made `newBelow` constraint
  - `scrollTo(Infinity)` that keeps following while it travels

  I trusted it, and it held up under testing.
- **13-media's scrubber pattern** I adapted almost line for line. That includes the smooth playhead driven by a frame `Time`, and `claim = x`.
- **The `class Viewer extends Dialog [ presentation = "full" ]` fragment in 18-overlays** became my photo viewer in about fifteen lines.
- **`declare.md` is genuinely readable whole.** Its "Seven differences" section corrected instincts I didn't know I had.

**What was missing or misleading:**
- **The timer virtualization in the test harness cost me the most time.** I wrote a probe that pressed the mouse, slept 800 ms and released. `onHold` never fired, not even in a minimal two-view program. I only found the cause by reading `tools/internal/verify-behave.mjs`. It virtualizes `setTimeout`, so a delayed timer fires only on `drive.wait(ms)` or a clock step, and never on wall-clock time. `verify.md` doesn't say this where an assert-script author would look. Its phrase "the asserts' clock.step" is in source comments only.
- **I'm not certain I diagnosed the failed hold correctly.** Before I found the timer issue, I removed `selectable = true` from message text, suspecting text selection was swallowing the press. That change may have been unnecessary. Message text in Murmur is now unselectable possibly for no reason, and I didn't go back to test it.
- **The `drive` vocabulary isn't documented in one place.** `introspection.md` mentions `drive.click` and `settleMotion`, but I learned `drive.wait`, `drive.attr` and the rest by grepping the harness.
- **`--read PATH.ATTR` only reads attributes.** `--read …col.childViews.length` answered "no view at …", which suggests a path can't reach into a property's value. For anything structural I fell back to `page.evaluate` with `window.__declare.find("app")`. That was powerful, but felt like going around the tools.

## (b) Expressing what I wanted to express

### Where the language fit my intent

- **One conversation view per thread, replicated and only the open one visible.** This gave me per-thread scroll position and per-thread drafts with no code. I checked it with a 30-line prototype before committing to the design:

  > `app.main.0.scrollY = 106100`, before and after switching away and back.

  That was the single most satisfying moment of the build.
- **`virtualize = true` on 30,500 rows of mixed heights, including a dragged scroll thumb.** The thumb went from index 30499 to index 0 and back. Content height corrected itself from about 2.37M to 2.86M px when I released the thumb. Nothing jumped.
- **`classFor` for text, photo and voice rows, with `defaultplacement = bubble`.** The placement pointed at a nested child, and the reference confirms that's allowed ("at any depth"). The shared frame plus a class per kind read cleanly.
- **Grouping from neighbours.** `provided("msgs")` plus `rowIndex`, as in 16-collections ("what sits between records belongs to the row after it"), handled grouping well. Day headings, sender names, tight corners between messages in a run, and avatars only on a run's last message are all derived from neighbours, with nothing stored.
- **Small things that just worked:**
  - `waypoint` for the open conversation, so Back closes it.
  - A `Socket` that's active only while the history is loaded.
  - One `Spring` per inbox row, with `arrive()` in `onInit`, so re-ordering animates but first load doesn't.
  - Theme records spread over `SanFrancisco` for dark mode.
  - Drawn `Icon` subclasses for the send, photo and smile marks.

### Where I worked around it

- **Knowing which message is at the top of the viewport (for the date chip).** There's no fact for this. Each row computes `atTop` from its own `y` and a provided `readTop`, uses `trackChanges` to call `app.noteTop(thread, at)`, and the App keeps a `tops` object that it copies on every change.
  - This had a real bug. A recycled virtualized row stays `atTop` when it's handed a new record, so `onChange` never fires and the chip showed a stale date.
  - I fixed it by also tracking a `stamp: string = { :at }`.
  - I suspect the interaction between recycled rows and `trackChanges` will catch others. A documented `firstVisibleRow`-style fact on a scroller, or a note in 16-collections about recycling, would help.
- **Keeping a row's identity through the send confirmation.** Rows are keyed on `id`, so replacing a pending message's local id with the server's id would rebuild the row. For a photo, that could flash the placeholder and change the height. So I kept the local id and added `sid` and `pending` to the schema. Every lookup by id then has to check both fields. A way to re-key a record while keeping its instance would remove this.
- **A text bubble that's only as wide as its text, up to a cap.** I needed `width = { Math.min(Math.ceil(measureText(text, providedTextStyle({ fontSize: this.fontSize })).width) + 1, max) }`. The `providedTextStyle` override is easy to get wrong if the size is set locally rather than inherited. The composer's height that grows with the text is the same trick using `.lines`.
- **Reaction chips.** `datapath = { { chips: … } }` was refused with DECLARE3006 ("a literal is in none"). Its fix was correct, but I had to put a derived `Dataset` inside every row that has reactions. That works, but it's heavy for a list of three chips.
- **Typing gaps:**
  - `provided("theme").inks as number[]` needed a cast.
  - `tops` needed `as Record<string, string>`.
  - The live-feed `Frame` interface has `message?: any`.

  Script-declared interfaces work fine; the casts are minor.
- **Small inconsistencies:**
  - `clip = true` is legal bare, but `clip = { boolean }` is refused, because the slot's type is `Shape`.
  - `inset: object = [8, 12, 9, 12]` was refused; the fix was `inset: Inset`.
  - Library icons declare `y = center`, so putting one in a `SimpleLayout` with `align = center` fails at boot.

  Each diagnostic was clear. They were still surprises.

## (c) Verifying it

**My loop:**
1. `declare-verify` for rungs R1–R4, about 1–2 s each time.
2. `declare-look` for screenshots at 1440×900 and 390×844.
3. Assert scripts I wrote as probes, run as rung R5. They covered the live feed, thumb drag, voice seek, hold-to-react, the photo viewer, position memory, and phone flows in dark mode with touch.

**How the tools served me:**
- **Diagnostics were excellent.** Every compile error named its fix and I applied it directly, including:
  - DECLARE5000 (my class was named `Pane`, which the library already uses)
  - DECLARE4005 (bare `bold` inside braces)
  - DECLARE6001 (the `clip`/`padding` types)
  - the boot error naming `ArrowIcon.y` against `BelowPill`'s layout

  I never had to guess.
- **R4 is truly fast.** But it boots with schema samples rather than real data, so it caught structure problems and nothing about real geometry.
- **Assert scripts against a real browser** were what actually verified behaviour, through view paths like `app.list.rows.stack.N` plus `page.evaluate`. They were good to work with, apart from the timer issue above.
- **`settleMotion` failed whenever someone was typing:** "motion did not settle within 5000 ms". The typing dots are an `Animator` with `repeat = 100000`. That's arguably correct behaviour, but a way to exclude decorative looping animations would help.
- **Under the harness clock, a spring didn't seem to advance on `drive.wait`.** So I could never watch the date chip fade out. I confirmed `scrolling` went false and stopped there. I'm not sure whether that's by design.
- **I never knew what to do with the coverage figure.** Verify reported "351 of 460 constraints statically wired", and nothing told me whether the remaining 109 needed attention.
- **What I didn't verify:**
  - real-device gesture arbitration
  - the cost of validating the 5.5 MB history against its schema on a phone
  - `edges = cover` and the safe-area insets
  - performance profiling of any kind

## Surprises

- **Scroll anchoring, `scrollAnchor = end` and virtualization combined correctly on the first try.** That combination is usually where chat apps spend weeks. When a message arrived while I was scrolled back, `scrollY` moved by 421 px and the screenshot showed the visible words had not moved.
- **Hidden replicated views keep their scroll offset**, even when their parent is hidden on the phone.
- **The amount of finished behaviour I got for free:** popovers that become bottom sheets on narrow screens, focus restored when dialogs close, Esc handling and Tab scoping.

## Good and bad

**Good:**
- The constraint model.
- A small, legible surface.
- Diagnostics written for the next action.
- The skill's routing table.
- Animation that costs about the same as not animating.
- A library that solves the hard 10% (virtualization, anchoring, overlays).

**Bad:**
- Harness behaviour and the `drive` API are hidden in source.
- Recycled rows can catch `trackChanges` users out.
- No shrink-wrapping wrapped text.
- No way to re-key a record without rebuilding its row.
- A lot of reading is needed before the first line.
- I can't judge production performance or accessibility depth from this build.

## Differences from what I'm used to

- **No render function and no keys to manage.** The awkward parts are where React's escape hatches would be: anything that wants to know about rendered geometry, like "which row is on top", becomes a fact you emulate with `onChange`.
- **Events don't bubble.** This forced cleaner ownership. For example, `ReactButton` takes a `row` attribute rather than climbing up the tree.
- **The `exists` / `visible` / `opacity` split was clarifying.**
- **Datapaths instead of props for lists** took a while to feel natural, especially the rule that a datapath can't point at a fresh literal.

## What it reminded me of

Most of all **QML**: property bindings, `State`, anchoring-style `x = center`, and `Component` with delegates. It also reminded me of Flex/MXML, and of course OpenLaszlo, its stated ancestor. Its springs and declared destinations are close to SwiftUI. Its dependency tracking is closer to MobX or Solid signals, but checked at compile time.

## Where I'd most want improvement

1. **Document the test harness's timer and clock model in `verify.md`,** and publish the full `drive` API.
2. **A scroller fact for the first and last visible row**, or at least guidance on recycled rows with `trackChanges`.
3. **Text that shrink-wraps up to a maximum width** (`maxWidth` or similar).
4. **Keep a row's instance when its record's id changes**, for optimistic UIs.
5. **Lightweight derived lists for replication**, without a `Dataset` per row.
6. **A way to mark animations as decorative so `settleMotion` ignores them.**

## Would I use it again?

For interfaces that are mostly long lists, live data and continuous motion, such as messaging, feeds, dashboards and timelines, yes, and gladly. This build suggests Declare makes the hardest parts of those cheap and correct.

I'd hesitate on three things:
- projects that lean on a large third-party UI ecosystem
- products that need deep, audited accessibility now
- teams that need to hire people who already know the stack

My uncertainty there is real, because I saw none of those pressures in this build.