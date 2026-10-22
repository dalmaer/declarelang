# Venue (checkout) run 2: Declare a2f8bf3a, Opus 5.5

**Run:** 2026-10-22 14:18 UTC, launched with
`evals/craft/launch.sh venue-checkout ~/Code/eval-venue-checkout-2 claude-opus-5-5 a2f8bf3a` against GitHub main
`a2f8bf3a`, the head at launch. It is the second run of the Venue brief, after the fix pass that run 1 and Cadence 15
prompted (`e5a32407`, `dcc5dace`, `a2f8bf3a`):

- library internals named `_name`, and `declare-help` showing what a library base adds, the theme tokens and the icons;
- an `exists` child placed where its class places children, and held to the same name rules;
- a warning for an `on…` method that answers no event (DECLARE4019);
- DataSource refusals, `Intl`, `purpose`, roles and stop groups documented;
- `declare-look --click-at` and `--pinch`;
- rows that read their own record while their list changes, and scroll requests that wait for content.

It used Opus 5.5 (`claude-opus-5-5`) with web tools available, and the brief included the idiom sentence. One round,
with no intervention. The standard strip removed `evals/`, `docs/system-design/` and `test/`. The service ran from
outside the sandbox (this app has `fixtures/`), so the agent had `brief.md` and `api/API.md` and nothing else of the task.

**Try it:** http://127.0.0.1:8231/my-apps/venue/venue.declare. This is the agent's own copy, served by its own dev
server (8231, because 8200 was taken; I restarted it after the build, unchanged). The service is on :8350. Open the page
at `127.0.0.1`, not `localhost`, or the session cookie won't stick. The one account is `ada@example.com`, password
`correct horse battery`. Sign-in is on the checkout page only (finding 1).

## The comparison

The build figures come from the build's own final record. The account was asked for afterwards, in a separate resume
(1.4 min, 7.4k output tokens), and is counted separately.

| | Venue 1 (Declare) | **Venue 2 (Declare)** | Venue React 1 |
|---|---|---|---|
| Declare commit | `9444a776` | **`a2f8bf3a`** | — |
| time | 44.2 min | **56.0 min** | 31.4 min |
| turns · tool calls | 184 · 179 | **182 · 173** | 101 · 97 |
| code, raw lines | 1,885 (5 Declare + 1 TS) | **1,908 (5 Declare)** | — |
| code, excluding comments and blanks | 1,499 (Declare 1,338 · TS 161) | **1,449** (of it, script 128) | 4,861 |
| **Tokens** | | | |
| output (incl. thinking) | 162k (68k) | **159k (68k)** | 147k (51k) |
| fresh input (cache writes) | 399k | **390k** | 199k |
| cached input re-read | 46.6M | **42.5M** | 9.3M |
| read before first app write | 391 KB | **416 KB** | 23 KB |
| context at first write → end | 185k → 405k | **208k → 396k** | 42k → 205k |
| **Download (gzip)** | 152.9 KB | **151.8 KB** (program 32.4 · runtime 106.6 · kernel 12.5) | 158.5 KB + ~85 KB fonts |
| hidden acceptance (`drive.mjs`) | 11 of 11 | **9 of 11** | 11 of 11 |
| runtime source read | 5 files | **1 call** (a grep) | — |
| library source read | 2 files | **11 calls** (8 files) | — |

Download from `declarec --sizes` in the main tree. The serif is the system's, as in run 1.

Where the time went (`measure.mjs`):

| activity | time | share |
|---|---|---|
| model | 28.1 min | 50% |
| shell (its own browser scripts, the dev server, probes) | 13.1 min (65 calls) | 23% |
| editing | 7.9 min (29 calls) | 14% |
| rendering (`declare-look`, screenshots) | 6.4 min (14 calls) | 12% |
| reading | 0.4 min (59 calls) | 1% |

It asked `declare-help` 36 times about 32 topics. 14 checks reported failure. Two messages were met on more than one
compile: "'Card' is a library class" (DECLARE5000, 3 times on one site) and the `scrollIntoView` arity error (2 times;
finding 3 — the error was the platform's, not the agent's).

**The time is longer than run 1's, and nearly all of the difference is testing.** Its first `declare-look` came at about
16 minutes; from about 21 minutes it wrote its own Puppeteer harness and spent most of the next half hour on one phone
path (Pay after a declined card), which turned out to be its harness pressing through a pinned bar, not the app. The
account says so plainly.

### Onboarding

- **The SKILL's required reading, in order:** README, SKILL, `declare.md`, chapters 01, 04 and 05, the calendar whole
  with its chapter.
- **Then on demand:** ch08, 14, 06, 19, 18, 10, 07, and parts of 11, 12 and 20.
- **Source reads:**
  - **runtime, once:** a `grep` of `runtime/src` for how a pinned bar counts when a field is scrolled into view
    (finding 6);
  - **library, eleven calls:** `field`, `button` and `control` for how a field and a button are made; the themes and
    `sanfrancisco.declare` for the token names (though `declare-help` now lists them); `segmented`, `radiogroup` and
    `combobox` for accessibility; `sheet`; the icons twice; `floating`'s `toScreen` for a coordinate frame;
  - **tools, once:** a grep of `tools/*.mjs` for how the toolchain launches Chrome, to copy it into its own harness.

  Library reads now count against the reference as runtime reads do. Each of these is a question `declare-help` or the
  guide should have answered first (finding 10).

## What it built

Four steps, with the performance carried by `location` (`#p01`) and the step by `waypoint`, so Back undoes a step:

- **The list:** performances under month headings, each with its date, time, price and seats left.
- **The hall:** a dark house facing a stage, four sections drawn as curved rows, seats as rounded marks — free, yours
  (gold with a tick), taken (a small dot) — with row letters at both ends. At a desk the whole house fits beside a panel
  with the date, the free count, a legend, the prices, the chosen seats with a remove button each, the running total and
  Checkout. On a phone the house is a pan pane at thumb size, with a miniature of the whole house you can drag to move
  the view, and the total and button in a bar at the bottom.
- **Checkout:** at a desk the form scrolls on the left while the order and "Pay $174.00" stay put on the right; on a
  phone the order comes first and Pay is pinned to the bottom. Signed in, the saved cards appear as radios, the expired
  Mastercard dimmed and marked "Expired 08/26". The card number groups as typed, the country is a three-way
  `Segmented` that follows the postal code until chosen, and every refusal lands on its field in the service's words.
- **Tickets:** one at a time, sprung, with a dark header, the row and seat set large, a perforation, and a Code 39
  barcode it draws itself.

Screenshots: `shots/desk-*.png` (list, hall, checkout at 1280×860, taken from the running app after the build;
tickets from the agent's own run) and `shots/phone-*.png` (the agent's final phone run at 390×844: hall, a seat lost,
sign-in, saved cards, a decline, a postcode refusal, tickets).

### Scored

`evals/apps/venue-checkout/drive.mjs`, the hidden acceptance, unchanged since run 1. **9 of 11 pass**
(`drive/results.json`):

| scenario | result |
|---|---|
| guest_pays · phone_guest_pays · double_press_sends_one · declined_then_retry · security_code_wrong · seat_taken_before_paying · seat_taken_while_choosing · bad_postcode_stays_home · sign_in_midway_keeps_choice | pass |
| **wrong_password** | **fail** — from the hall, there is no way to sign in (`drive/wrong_password.png`) |
| **signed_in_saved_card** | **fail** — paid with the saved Visa correctly; after a reload the app lands on the hall, which shows no sign of who is signed in (`drive/signed_in_saved_card.png`) |

Both failures are one design gap, not two: **sign-in, sign-out and the account are reachable only on the checkout
page.** The brief says "Someone who has one can sign in at any time" (§3). The only write of `app.signingIn = true` is
`AccountLine`'s button (`checkout.declare:478-481`), and `AccountLine` is placed only in the checkout form (`:561`).
The model would have supported it from anywhere — the `Sheet` and the account are on the App — only the trigger is in
the wrong place. This is the agent's miss, not the platform's.

## Findings for the platform

Each claim in the agent's account was checked against the code and with a probe program; the verdicts are below. Four
are real bugs.

**Bugs**

1. *(the app's, above — listed for the count)* Sign-in only at checkout.
2. **A branch not taken still makes a child "sized from its parent", and its parent's content size silently collapses.**
   The agent wrote `height = { app.phone ? this.contentHeight : app.hostHeight }` on its checkout screen, whose pane
   read `parent.height` in the branch not taken. On a phone the screen came out 64 px tall — its header — and the page
   stopped scrolling, with no diagnostic at any rung. Minimal: `box: View [ height = { this.contentHeight }, kid: View
   [ height = { app.flag ? 300 : parent.height } ] ]` with `flag` true gives `box.height = 0`. The rule
   (`runtime/src/bind.ts:280`, `sizeFromParent`) reads the source, not the branch taken, and the only report for a
   collapse (the negative-size report) needs a negative size. This cost the agent its largest bug, which it
   misattributed to `app.height` (claim 1 below).
3. **The compiler's `scrollIntoView` takes two arguments; the runtime and the reference take three.**
   `scrollIntoView("start", true, 120)` is refused: "this call passes 3 arguments but the method declares 2
   parameters" (DECLARE6001). The compiler's hand-written signature (`compiler/src/scaffold.ts:815`) predates `inset`;
   the runtime (`view.ts:1687`) and `declare-help` have it.
4. **A wrapping `Text` that `flexes`, built after boot, is laid out on one line and painted on two (or the reverse).**
   At boot the same row is right. `Text.$bounded()` (`runtime/src/text.ts:148`) asks who owns `width` in a way that
   isn't tracked, so when a layout later takes over the width of a flexing child, neither the height nor the style push
   re-runs. The agent saw its account line run under the Sign in button and worked round it with an extra `View`.
5. **Size conflicts with a layout are caught at different rungs.** A child `y` inside a `SimpleLayout` is refused at R1;
   a `Spacer [ height = 20 ]` in a column, or a flexing child with `width = 100%`, only at R4 boot — and only if that
   subtree exists at boot, so the agent met one as a page error at run time. The static check
   (`check.ts:1362`) knows what a layout places, not what `flexes` makes it size.

**Gaps**

6. **Moving focus to a field under a pinned bar.** `07-scrolling.md` promises a field brought in by Tab scrolls clear of
   a pinned bar, but doesn't say whether `Focus.focus(…)` or a phone keyboard's Next is covered — the question that sent
   the agent to `runtime/src` and then to hand-written scrolling (`checkout.declare:524-529`).
7. **No invalid, required or error-message semantics for assistive technology.** There is no `accessibilityInvalid`
   or `accessibilityRequired`, the runtime never writes `aria-invalid`/`aria-required`/`aria-errormessage`, and a field's
   `error` reaches a screen reader only if the program copies it into `accessibilityHint`.
8. **`DataSource.errorBody` can't be typed.** It is a bare `object` with no schema slot, so reading the service's
   `message`, `field` and `conflicts` needs casts in script (`venue.declare:61-73`).
9. **No way to find a view by a key**, so focusing the field a refusal names is a table of paths
   (`checkout.declare:508-515`). Run 1's finding 5, still open.
10. **The reference didn't answer what the library reads were for:** how a `Field` and a `Button` are put together
    (the reference describes members, not composition), which tokens a control reads, the icon names, the frame of
    `toScreen`. With library reads now counted as gaps, each wants an answer in `declare-help` or the guide.
11. **`Editor` judges a field on every edit.** The brief (like most forms) wants a field marked wrong only once it has
    been left or Pay pressed; the agent hand-built `touched` and `attempted`. An option on `Editor` would do it. And
    `14-data.md` shows `validate(v)` while `declare-help Editor.validate` has no entry.

**Documented, but not where the agent looked**

12. `transformTo(app).y` is measured in the window, not the page; its entry says "read as `rootTransform()` is", which
    adds the scroll back. The entry is wrong about the frame.
13. `scrollToX` exists, but `View.method.scrollTo`, guide 07's "Moving a scroller" and a search for "horizontal scroll"
    don't mention it. The agent concluded `scrollTo` "only takes y" and used `scrollBy` for both axes.
14. A pop-up choice exists (`Control.menu` on a `Button`, with a `Menu` of `checked` records), but `declare-help select`
    answers `Combobox` and "dropdown" answers `Menu` without saying `menu =` up front. (`Segmented` was a fair choice
    for three countries.)
15. `ChevronIcon` has `dir = "left"`, and `iconLeft` takes any icon class, so `class BackChevron extends ChevronIcon
    [ dir = "left" ]` is a left chevron on a library `Button`. Nothing says a button's icon can be your own subclass;
    the agent wrote a `BackButton` control.
16. `onBlur` and `onFocus` exist and work, but no guide chapter mentions them, and `declare-help blur` answers the blur
    *filter*. The agent built a blur detector from `trackChanges = ["focused"]`.
17. `DataSource.failed` documents acting on a refusal (`trackChanges = ["failed"]`, and "each refusal is a change, a
    second one included"). The agent watched `loading` instead, unsure a second failure would register.

**Claims that did not hold**

- **"`app.height` on a scrolling App is the page's height."** It is the window's: `app.height` and `hostHeight` both
  read 844 on a phone, as the App reference says. The agent's own `explain` showed 844. What actually stopped the page
  scrolling was the collapse in finding 2, and switching to `hostHeight` changed nothing.
- **"`onChange` for `focused` fired on fields that had never had focus."** Not reproduced on hidden, created-later or
  grouped fields; it fires only on real transitions. Likely the program's own logic.

### The tools, and why it built its own

The agent used `declare-verify` as its inner loop and `declare-look` for screenshots ("excellent"), then wrote a
Puppeteer harness for the flows (`agent-driver/`), as run 1's agent did. Its reasons, from the transcript and the
account: it wanted to find things by accessible role and name and to watch requests reach the service, as a grader
would; and the docs present Puppeteer as part of the toolchain (README: "puppeteer-core for builds and visual tests";
the verify guide calls `page` "the puppeteer page"). It never used `declare-verify --assert`.

Two of those reasons were real gaps in our tools, and one was ours alone:

- **Under `--touch`, the driver pressed with a mouse.** Every press, drag and click `declare-look --touch` and the
  verify driver made was a mouse event in a phone-sized window; only `--pinch` used fingers. The agent's own taps were
  real touch, so on touch its harness was more truthful than ours. **Fixed in main after this run** (not in the build
  it used): on a touch device every press, drag and hold is a finger; `drive.hold` / `--hold` press and hold;
  `drive.device({ width, height, touch })` makes an assert script a phone; visual states take `touch: true`; and
  `--pinch` is two fingers on touch and a trackpad pinch (`onWheel` with `e.pinch`) otherwise. `test/look-touch.test.mjs`
  holds it.
- **The assert vocabulary can't see requests.** An `expect` on what the app sent the service would have answered the
  agent's main question without a harness.
- **Paths already name a view by its accessible name** (`app.pay."Pay $174.00"`), but nothing in the agent's reading
  said so prominently.

Its harness also cost it most of its debugging time: Puppeteer clicks an element's centre without asking what covers
it (so it pressed the pinned Pay bar through a field), and its `aria/` selector ignores `inert` (so it found the
checkout's Email behind the open sign-in sheet). `drive.click` refuses a press on a covered view and names what it would
reach — exactly the check the agent lacked.

## Is it idiomatic Declare?

Mostly yes, and line for line a little more disciplined than run 1: one service address with every `url` built from
it, one source for a seat's name, the form's wording kept in Declare rather than script, the hall screen laid out by
`flexes`, and a derived `chosenSeats` dataset that makes every total agree. Its missteps differ in kind from run 1's:
**run 1's were mostly the platform's gaps; most of this run's are documented features it didn't find** — `Intl`,
`onBlur`, `failed`, `RadioGroup`, `link`, computed defaults. None of them is on the SKILL's read-first path, and the
"What Declare handles for you" table names only some.

### What it gets right

- **The work divides the way the calendar teaches** (`venue.declare:7-19`): the service's records are `DataSource`
  classes with their own derived facts (`Season`, `House`, `Account`, `:217-310`); the payment is a class with no view
  (`Checkout extends Node`, `checkout.declare:14`); where the person is lives on the App (`venue.declare:379-390`);
  views derive from all of it.
- **The step is derived, never set.** `location` carries the performance, validated through `perfId` (`:382`);
  `waypoint` carries the step, so Back undoes it (`:474-475, 488`).
- **One service address** (`venue.declare:376`), and **one source for a seat's name** (`House.seatInfo`, `seatName`,
  `:238-246, 59`) feeding the seat's label, the summary, the order lines and the loss notice. Both were run 1's
  missteps.
- **The choice is a derived dataset** (`chosenSeats`, `:429-430`), and the subtotal, fees and total derive from it
  (`:431-434`).
- **The live house is kept true the right way:** `markSold` writes into the `DataSource` (`:257-265`), the stream's
  `active` is derived (`:402`), a reconnect re-fetches (`:407-408`), and a fresh map is reconciled against the choice
  (`:396, 465-468`).
- **Things people press are controls** — `SeatView`, `PerformanceRow`, `CardChoice`, `BackButton`, `StepArrow` each
  `extends Control` with `press()`.
- **The hall is a scene**, so hand-placed `x`/`y` belongs there: `HallMap` provides `unit` and the origin
  (`hall.declare:131-135`), sections and rows provide their radius and tier, and every seat reads them — the calendar's
  springs, in a different room.
- **One theme holds every colour**, including the darkened house (`venue.declare:320-339`); the checkout's desk/phone
  split is a `desk: State` (`checkout.declare:504`).
- **Sign-in is the guide's form-in-a-sheet:** a library `Sheet` with `shown` constrained, a form that exists only while
  open, `purpose = username`/`password`, and the service's sentence derived from `errorBody`.
- **The field is a composition** (`Entry` with `defaultplacement = slot`, providing `fieldName` and `fieldError`), and
  every field has a `purpose`.
- **Accessibility is in the model:** seats as toggles with pressed state and a price hint, live regions on counts and
  totals, `Accessibility.announce` for losses and refusals.
- **The script** (`venue.declare:29-180`, 128 lines of code) holds no state, places nothing and carries no colour: card
  kind, grouping, Luhn, postal patterns and the barcode are legitimate pure functions; reading a refusal is forced
  (finding 8); money and dates are a misstep (below).

### Missteps, and how they should have been written

1. **Money and dates by hand** (`venue.declare:30-57`). `12-text.md` and `declare-help`'s concept table say `Intl`:
   `new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`, and `Intl.DateTimeFormat` with a locale
   and `timeZone: "UTC"` over the wall-clock parts. Run 1 had the excuse that this was undocumented; this run's docs had
   it.
2. **A refusal detected by watching `loading`** (`venue.declare:524-525`). `DataSource.failed`'s entry gives
   `trackChanges = ["failed"]`; every `fetch()` clears it first, so a second refusal is a change too.
3. **Leaving a field detected by tracking `focused`** (`checkout.declare:264-268`). `onBlur() { app.checkout.leave(…) }`
   is that event (finding 16).
4. **The signed-in prefill is copied imperatively** — a mirror attribute, `accountReady` (`venue.declare:515-517`),
   tracked so its `onChange` can copy the email, name and address into blank fields (`checkout.declare:115-130`), with a
   second copy of the blank record to reset from (`:23-28, 207`). The idiom (`14-data.md` § A form in a sheet,
   "computed default") is a field whose default follows the account — `email: string = { app.account.email }` — so the
   person's write replaces the formula, and starting again is rebuilding. Run 1 did exactly this, and called it the
   best moment of its build.
5. **The hall's arrows walk seats in member order** (`hall.declare:139-141`, `focusScope = stop`). The `focusScope`
   entry says a grid where Up means the row above answers the arrows itself and moves focus with `Focus.focus`. As
   built, reaching row M from row A takes hundreds of presses. Run 1 moved by geometry.
6. **The radio group is hand-built** (`CardChoice`, `checkout.declare:295-322, 575-583`), so the arrows move focus
   without choosing. A `RadioGroup` with the saved cards replicated as `Radio` subclasses does what every platform's
   radio group does. (If `Radio` won't take a card-row look, that is worth reporting; run 1 built its cards the same
   way.)
7. **Navigation written as handlers, not links.** `PerformanceRow.press()` and the "All performances" buttons write
   `location` (`list.declare:53`, `hall.declare:316-318, 357-359`). `link = { "#" + :id }` gives a real anchor,
   ⌘-click and copy-link; the extra work goes in an `onClick` beside it.
8. **The checkout's heights are arithmetic** (`checkout.declare:504, 545, 549`: the body is `app.hostHeight - 64`,
   repeating the header's 64). The hall screen in the same program does it right with `flexes`.
9. **The hall's geometry is written five times** — the polar transform appears in `SeatView`, twice in `SeatRowArc`,
   in `SectionBlock.caption`, in `HouseOverview.draw` and in `House.halfWidth` (`hall.declare:28-32, 69-74, 94-95,
   175-187`; `venue.declare:278-285`). One derived plan of seat positions, as run 1's `SeatMap.plan`, would feed the
   scene and the miniature.
10. **Keeping a field clear of the pay bar is rebuilt by hand** (`checkout.declare:524-529`, with a magic 140). The
    platform's pinned-bar clearance should have been tried first; finding 6 is what the docs left unsaid.
11. **Minor:** the tickets swipe moves only when the finger lifts (no spring following the finger, as weather's
    `swipeX`); the miniature tracks a drag through `app.pointerDown` rather than down/move/up; two shadows carry literal
    colours outside the theme (`tickets.declare:33`, `checkout.declare:674`); and a field's identity is a string
    threaded through four places (`checkout.declare:67-103, 508-515`).

### Workarounds the platform forced

- **Casts to read a refusal** (`venue.declare:61-73`) — finding 8.
- **A table of paths to focus a field by key** (`checkout.declare:508-515`) — finding 9.
- **`scrollBy(target - scrollX, target - scrollY)` for an absolute two-axis scroll** (`hall.declare:200, 308`) —
  `scrollTo` and `scrollToX` are separate requests; one call for both axes would be cleaner (finding 13 is why the agent
  thought there was no `scrollToX` at all).
- **Error timing hand-built** (`touched`, `attempted`; `checkout.declare:16-17, 57-59, 104-107`) — finding 11.
- **An extra `View` round a flexing `Text`** — finding 4.
- **A `desk: State` in place of a conditional height** — finding 2.
- **`afterSettle` before each focus move between steps** (six places). This is the documented use, but it says a
  destination has no way to declare "focus lands here on arrival". Mild.
- **An indeterminate progress bar built by hand** (`checkout.declare:389-397`); `ProgressBar` is determinate only.
  Mild.

## What changes next

In the order I'd take them:

1. **Fix the four bugs**: the branch-blind `sizeFromParent` (and a report when content sizing skips a child), the
   flexing `Text` after boot, the `scrollIntoView` signature, and a static check for `flexes` size conflicts.
2. **Reference fixes**: `transformTo`'s frame; `scrollToX` in `scrollTo`'s entry and guide 07; `onBlur`/`onFocus` in a
   guide chapter and `declare-help blur`; `menu =` in the select/dropdown answers; button icons as your own subclass;
   `Editor.validate`; which focus moves clear a pinned bar.
3. **Guidance**: the SKILL should say to check a flow with `declare-verify --assert` and not build a browser harness,
   and stop presenting `library/` as a place to look things up; the README should not offer Puppeteer as a user tool.
4. **Gaps**: an `expect` on requests sent; error semantics for assistive technology; a schema for `errorBody`; finding a
   view by key; `Editor` judging a field once left.
5. **Reach**: the documented features this run missed (`Intl`, `onBlur`, `failed`, `RadioGroup`, `link`, computed
   defaults) are all form-building. A short "Building a form" section near the front of the SKILL's table, pointing at
   each, would have caught most of this run's missteps.

## The agent's account, verbatim

Asked after the build by resuming the finished session with read-only tools (Read, Glob, Grep), with the standard
questions in `impressions.txt`. 1.4 minutes; 7.4k output tokens, counted separately from the build.

### Building Venue in Declare: notes for the Declare team

Some context first. I'm an LLM agent with no prior exposure to Declare. Over a single long session I built a complete box-office app: a list of performances, a seat map of about 650 seats with live updates, checkout with sign-in and saved cards, and tickets. I verified it with Declare's own tools and with scripted headless Chrome. Where I say "I think", I'm genuinely unsure.

#### (a) Getting up to speed

**What I read, in order:** `README.md`, then `skill/SKILL.md`, then all 902 lines of `docs/declare.md`. After that, guide chapters 01, 04 and 05, then all of `apps/calendar/calendar.declare` alongside `28-calendar.md`. That's exactly the order SKILL.md prescribes, and I think it's the right one.

When I reached a part of the build that needed it, I also read:
- chapters 08 (controls), 14 (data), 06 (layout), 19 (accessibility), 18 (overlays), 10 (touch) and 07 (scrolling);
- parts of 11 (themes), 12 (text) and 20 (URLs);
- many `declare-help` entries.

**What taught me the most:**
- **`docs/declare.md`.** Some sections reorganized how I think rather than just informing me: "Seven differences", the set-versus-declare table in §5, and "Count the data, not the tree". After reading it I could predict most compiler errors before I hit them.
- **The `declare-help View.accessibilityRole` entry.** It spells out the ARIA mapping: `toggle` becomes a `button` with `aria-pressed`, and "a test that finds views by role and name finds them by these." That one paragraph settled how seats should present themselves to a role-based test. Nothing else I read was as directly useful per line.
- **`14-data.md` § Talking to a server.** In particular, the "fetch() settles first" fact. It let me write the order request as "assign `body`, then `fetch()`" in one handler without worrying about stale data.
- **The calendar.** It's where I learned that constraints over shared scalars are the house idiom for geometry. My hall geometry (row radius, angle along the arc, values provided down from section to row to seat) is the calendar's way of thinking applied to a different surface.
- **The drift check in SKILL.md.** It stopped me before I committed to a few habits from other frameworks: a ladder of hand-set `y` values, and per-control pass-through methods.

**What was missing or misleading.** In rough order of the time it cost me:

1. **`app.height` on a scrolling App is the page's height, not the window's.** I sized my hall and checkout screens with `app.height`, which pinned the page to 844px and quietly stopped it from scrolling. The only place I'd seen this was a parenthetical in the `Sheet` source ("not the App's, which on a page that scrolls is as tall as the page"). The guide's "responsive code reads `app.width`" led me to assume height behaves the same way. It doesn't, and nothing warned me. This was the single largest bug in the build. `__declare.explain` is what found it.
2. **A reference entry the compiler disagrees with.** `declare-help View.method.scrollIntoView` lists `scrollIntoView(align?, smooth?, inset?)`. The compiler rejected the third argument: "this call passes 3 arguments but the method declares 2 parameters" (DECLARE6001). declare.md says the compiler wins, and it did, but stale reference text costs trust.
3. **`transformTo`'s frame isn't stated.** I needed to know whether a text field sat under my pinned pay bar. I assumed `v.transformTo(app).y` was in page coordinates, but logging showed it was relative to the window. That cost one round trip. The entry says only "read as `rootTransform()` is".
4. **A flexing `Text` with `wrap = true` didn't wrap.** It ran under its neighbouring button. The `Text.wrap` entry mentions a "width-bounded run", but doesn't say a width assigned by `flexes` doesn't count as bounded. I worked around it by wrapping the text in a flexing `View` and giving the inner `Text` `width = 100%`. I can't tell whether this is a bug or intended.
5. **Smaller gaps:**
   - `scrollTo` only takes y. The x axis needs `scrollBy(dx, dy)`, which I found by reading the method list.
   - There's no select or popup control; I used `Segmented` for the country.
   - `Button`'s `iconLeft = "ChevronIcon"` takes a class name as a string, so there's no way to point the chevron left. Every back button rendered with a downward chevron, and I wrote a small `BackButton` control.
   - There's no `accessibilityInvalid` or `accessibilityRequired`, so field errors only reach a screen reader through `accessibilityHint`.

#### (b) Expressing what I wanted

**Where it fit my intent well.** Most of the build fit.

- **The hall.** The hall was the hardest thing in the brief, and it came out right on the first render. A section declares `startRadius` and `sectionName`, a row declares `radius` and `count`, and each seat computes its `x`, `y` and `rotation` from `provided("radius")`, `provided("count")` and its own `rowIndex`. Nested replication (sections, then rows, then seats) and provided values were exactly the right tools. The program's layout mirrors the hall's structure. I had expected to fight it.
- **Live data.** The service's stream of other people's purchases is an `EventStream` with `url` and `active` written as constraints over which screen is showing. Connecting, disconnecting and switching performances needed no code. A seat sold elsewhere becomes a `markSold` write to the seat map, and each seat's appearance, the free count, the overview and the running total all follow without update code.
- **Derived state.** `chosenSeats` is a derived dataset, and the summary text and pay amount are constraints over it. The amounts can't disagree because there is only one source.
- **Overlays.** Sign-in is a `Sheet` driven by `shown = { app.signingIn }` and `input(open)`. When it's open, the content behind it is marked `inert`, which I confirmed in the DOM. That's the correct accessibility behaviour, and I wrote none of it.
- **Forms.** `TextInput.purpose` (`cardNumber`, `cardExpiry`, `postalCode`, `username`, `password`) plus `concealed` covered autofill, password managers and phone keyboard hints in one attribute per field. I couldn't test real autofill.
- **Layouts that differ by device.** A `State` overriding an attribute that is otherwise unset (`desk: State [ applied = { !app.phone }, height = { app.hostHeight } ]`) turned out to be exactly how to say "fixed height at a desk, sized to content on a phone". I got there only after a failed attempt (below).
- **Small motion.** An `Animator` pops a seat when chosen and bumps the total when it changes. A `Spring` slides the tickets. Each was a couple of lines.

**Where I had to work around it:**

- **Collapsing `contentHeight` constraints.** I first wrote `height = { app.phone ? this.contentHeight : app.hostHeight }` on the checkout screen. On a phone it resolved to 64px, the header alone, with no diagnostic. I don't understand why it collapsed; my guess is a circular sizing problem the analysis can't see. The State form above fixed it, but I only found the failure because `explain` showed `value: 64`.
- **Detecting when a field is left.** I used `trackChanges = ["focused"]` with `onChange`. It turned out `onChange` also ran for fields that had never had focus, I think when they became visible. That marked a prefilled postcode as wrong while the person was still typing in it for the first time, which the brief specifically forbids. I fixed it by checking `previousValue == true` on the change record. I'd have liked a blur event.
- **Service refusals.** `DataSource` has no `onError`. I watched `trackChanges = ["loading"]` for the true-to-false transition. Watching `failed` instead might miss two failures in a row, since it may not change between them; I didn't confirm that. `errorBody` is untyped, so reading `message`, `field` and `conflicts` from it needed small script helpers with casts. A schema for the error body would have been cleaner.
- **Formatted fields.** The card number groups itself as it's typed (value pattern: `text` shows the grouped digits, `onInput` stores raw digits). Deleting a space then deletes nothing, so I wrote an `editDigits` helper to treat that as deleting the digit before it. I didn't test the caret position when editing mid-string. I expect it jumps to the end.
- **Focusing a field from code.** `fieldView(k)` is a ternary chain of paths like `f.billing.place.code.postal.input`. The compiler checks these paths, which helped when the layout fix renamed them, but it's brittle. I kept it rather than build a script-side map of views.
- **Diagnostics that arrived at different stages:**
  - A child that declares a `y` its layout owns: caught at the first rung (structure), with a clear message.
  - A `Spacer` given a height: caught only at R4, when the program boots.
  - An `Entry` with `width = 100%` placed in a row with `flexes = true`: surfaced only as a page error inside a `declare-look` run.

  All three are the same rule, applied at different stages.
- **Good diagnostics I triggered:**
  - DECLARE5000, naming my schema `Card` (a library class) and suggesting `VenueCard`.
  - DECLARE4005, using bare `bold` inside braces, which tells you to write `"bold"`.
  - The `Animator.motion` error listing the valid curve names.
  - The DECLARE1002 hint about redundant parentheses.

  Each one named the fix, and applying exactly that fix worked every time.

#### (c) Verifying it

- **`declare-verify` (rungs R1–R4)** took about two seconds per run and reported all errors in a phase together. It was my inner loop. As its own note warns, its synthetic layout couldn't catch the real bugs: wrapping, `app.height`, `contentHeight`. Every one of those showed up only in a real browser.
- **`declare-look`** was excellent. `--call 'app.pickPerformance("p06")'` followed by `--shot` gave me desk and phone screenshots of any state in seconds. Most of the visual corrections came from those screenshots: the downward chevrons, the list overflowing on a phone, the chosen-seat text running into its price, the ticket next door showing too strongly.
- **`__declare.explain`** found my two worst bugs in two calls: the App's height of 844, and the checkout screen's height of 64 along with the expression and dependencies behind it. I wish I'd reached for it sooner instead of probing the DOM.
- **What I didn't use:** the R5/R6 scripted-assertion rungs. I wanted what the eventual grader will do — find elements by ARIA role and name, and watch requests go to the service — so I wrote puppeteer scripts instead. That was a judgement call, not a gap in the tools. I also never ran `--semantics`, which I now think would have been a cheaper check of the accessibility tree.
- **Where my time actually went:** most of the debugging hours were in my own test harness, not in Declare.
  - Puppeteer clicks an element's centre without checking whether something covers it, so it clicked my pinned pay bar through a field.
  - Its `aria/` selector ignores `inert`, so it found the checkout's Email field behind the open sign-in sheet.
  - A triple-click raced with my scroll-into-view.

  In each case Declare was right and my driver was wrong. I'd note it for anyone evaluating Declare with naive drivers: the app can look broken when it isn't.

#### Surprises

- How much was correct on the first try: the curved, rotated hall; nested replication; keyed reconciliation when the stream changed seat states; inert backgrounds; focus restoration when the sheet closed.
- The `focusScope = stop` behaviour on the seat map: one Tab stop for 648 seats, arrows within it, disabled seats skipped, all for free.
- That a `scrolls = both` pane plus a drawn overview was enough to solve picking a seat with a thumb on a phone. I'd planned a pinch-and-zoom camera and didn't need it.

#### The good and the bad

**Good:** one source of truth with no update code; diagnostics that name their fix; first-class accessibility semantics; `purpose` on text fields; overlays done properly; `explain`; `declare-look`; a language small enough to read in full.

**Bad:**
- layout failures that are silent (`contentHeight`, wrapping text that doesn't wrap);
- the `app.height` trap;
- reference text that disagrees with the compiler;
- a few missing primitives: a select, a blur event, an error event on `DataSource`, invalid/required accessibility facts, an x argument for `scrollTo`, a direction on a button's icon.

#### Differences from what I'm used to

- No CSS, no flexbox; layout is an attribute and stacking is declaration order.
- Constraints instead of re-rendering; handlers are synchronous; no `fetch` or `async` in handlers.
- Events don't bubble.
- Children come from data, never from loops.

The adjustment that mattered most was "derived state is never assigned, change its inputs". Once that was habit, whole categories of bug stopped occurring.

#### What it reminded me of

- **QML**, most strongly: property bindings, states, declarative trees with script.
- **OpenLaszlo and Flex/MXML**: the lineage is visible.
- **SwiftUI's** state-driven views.
- **Cocoa Bindings/KVO** and spreadsheets, for "what depends on what".
- **Svelte**, for compiler-extracted dependencies.

#### Where I'd most want improvement

1. **Turn silent layout failures into diagnostics.** At minimum, flag height constraints over `contentHeight` that can't resolve, and a flexed `Text` that never gets a width to wrap at.
2. **Generate the reference from the same source as the compiler's types**, so they can't drift apart (`scrollIntoView`).
3. **Document frames and the `app.height` versus `app.hostHeight` distinction prominently**, including what frame `transformTo` returns.
4. **Fill out forms:** a select control, a blur event, typed error bodies or an `onError`, and invalid/required accessibility facts.
5. **Let the R1 structure check catch layout-ownership conflicts** (sized `Spacer`, `width` plus `flexes`) instead of R4 or runtime.

#### What I'd use it for

- **Yes, gladly:** interfaces whose geometry comes from data — seat maps, schedules, dashboards, boards, anything with continuous transitions. It was clearly better here than what I'd write in React, and checkout-style forms were fine.
- **Less sure:**
  - **Work that leans on third-party widgets**, like hosted payment fields. `DOMIsland` exists, but I didn't try it.
  - **Large teams who need a mature ecosystem.**
  - **Performance on low-end phones.** 648 controls felt instant in headless Chrome, but I didn't measure on a real device.
- **Untested:** I never used a real screen reader. My accessibility claims rest on the DOM, the ARIA output and role-based queries, not on VoiceOver or NVDA.
