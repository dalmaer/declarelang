# Venue (checkout) run 1: Declare 9444a776, Opus 5.5

**Run:** 2026-10-21 01:48 UTC, launched with
`evals/craft/launch.sh venue-checkout ~/Code/eval-venue-checkout-1 claude-opus-5-5 9444a776` against GitHub main
`9444a776`, the head at launch. It is the first run of the new Venue brief, and the first since the accessibility work
merged (`9b8c4927`):

- `accessibilityRole` and its contract;
- `TextInput.purpose` and `concealed`;
- live regions and `Accessibility.announce`;
- the new library controls.

It used Opus 5.5 (`claude-opus-5-5`) with web tools available, and the brief included the idiom sentence. One round.
The standard strip removed `evals/`, `docs/system-design/` and `test/`. The service ran from outside the sandbox (this
app has `fixtures/`), so the agent had `brief.md` and `api/API.md` and nothing else of the task.

**Try it:** http://127.0.0.1:8201/my-apps/venue/venue.declare. This is the agent's own dev server; it took 8201 because
8200 was taken. The service is on :8350. Open the page at `127.0.0.1`, not `localhost`, or the session cookie won't
stick. The one account is `ada@example.com`, password `correct horse battery`.

**The intervention.** At 29.6 minutes, opening night was sold out. The fault was in the service I wrote, not the app: each
open event stream sold its own seat every 4 seconds, with no limit. With the user's go-ahead, I fixed the service. I
paused the agent (`SIGSTOP`) at 02:19:37 UTC, restarted the service, and resumed the agent one second later.

- **The fix:** one shared clock, one seat every 12 s per watched performance, never below 60% of the seats free at
  launch.
- **What the restart reset:** the service state, so the seats were back and any session was cleared. The agent was
  between page loads and never noticed.
- **Also brought in by the restart:** a test-only `silent` option on `_take`, which the agent can't see.
- **Where it's logged:** `logs/started.txt` and `logs/fixture.log`.

## The comparison

The build figures come from the build's own final record. The account was asked for afterwards, in a separate resume,
and is counted separately. This is the first run of this brief. Earlier Venue runs (August) had a different brief and an
old Declare, so they aren't comparable. Cadence 14 and Murmur 9, the latest runs of the other briefs, are here for
scale only. There's no React baseline yet.

| | Cadence 14 | Murmur 9 | **Venue 1** |
|---|---|---|---|
| Declare commit | `611b696f` | `611b696f` | **`9444a776`** |
| time | 19.2 min | 23.4 min | **44.2 min** |
| turns · tool calls | 94 · 93 | 124 · 123 | **184 · 179** |
| code, raw lines | 1,242 (3 files) | 1,368 (5 files) | **1,885 (5 Declare + 1 TS)** |
| code, excluding comments and blanks | 921 | 955 | **1,499** (Declare 1,338 · script 161) |
| **Tokens** | | | |
| output (incl. thinking) | 87k (38k) | 102k (44k) | **162k (68k)** |
| fresh input (cache writes) | 252k | — | **399k** |
| cached input re-read | 15.5M | 23.8M | **46.6M** |
| read before first app write | 328 KB | — | **391 KB** |
| context at first write → end | 156k → 257k | — | **185k → 405k** |
| first app write at | 6.0 min | — | **6–10 min** ¹ |
| **Download (gzip)** | | | |
| app + runtime | 163.5 KB | 148.5 KB | **152.9 KB** ² (program 33.7 · runtime 106.4 · kernel 12.5) |

¹ The stream carries no timestamps. The first write falls between the 6-minute check, which had none, and the first
file's creation time.
² `declarec --sizes` from the main tree at `9444a776`. No web font: the serif is the system's Iowan Old Style.

The account took 1.3 min, in a separate resume; its tokens are not counted in the build's.

Where the time went (`measure.mjs`):

| activity | time | share |
|---|---|---|
| model | 29.0 min | 65% |
| rendering (screenshots, its own browser scripts) | 7.8 min (33 calls) | 18% |
| editing | 4.3 min (46 calls) | 10% |
| reading | 2.0 min (67 calls) | 5% |
| everything else | 1.2 min | 2% |

It made 48 `declare-help` calls about 44 topics. 13 corrections were found by looking at a render, and 15 checks
reported failure. One warning met 18 times was never resolved: `onClick writes app.location on a view with no 'link'`
(finding 7).

### Onboarding

- **The SKILL's required reading, in order:** README, SKILL, `declare.md`, chapters 01, 04 and 05, and the calendar
  whole.
- **Then on demand:** ch06, 08, 14, 19 (Accessibility), 18, 10, 07, 09, part of 12, and `operational/intake.md`.
- **The source, where the docs stopped:** `library/sheet.declare`, `library/button.declare`, `runtime/src/purpose.ts`,
  `semantics-dom.ts`, `dom-backend.ts`.
- **First thing it looked up about the payment form** was whether Declare puts fields in a `<form>`, grepping for
  `autocomplete` and `<form`.
- **Before writing anything** it probed the service directly: credentialed CORS, and the event stream.

## What it built

Four steps, with the address and back and forward carried by `location` (`p05`, `p05/checkout`):

- **The list:** twenty performances under month headings. Each row has the weekday and date set large, the time, "from
  $35.00", and a fullness meter that turns dark when a house is nearly gone ("Nearly sold out · 79 left").
- **The hall:**
  - A stage everything faces, and four sections as curved bands stepping back, with row letters at both ends.
  - Seats are rings, dots and discs: free is an open ring toned darker for pricier sections, sold is a small dot, yours
    is a crimson disc with a tick. The three differ in shape, so they read with the legend covered or in any colour
    vision.
  - A chosen seat swells once, unless the person has asked for reduced motion.
  - **At a desk** the whole house fits, beside a panel with the date, doors time, seats free, legend, prices with fees,
    the chosen seats, the summary and "Continue to payment".
  - **On a phone** the hall never drops below a 34-point seat. It becomes a native pan pane, with a 76-point minimap in
    the top bar that you can drag to move the view. The summary and the button sit in a bar at the bottom.
- **Checkout:**
  - **At a desk** the form scrolls on the left, while the seats with each price and fee, the total and "Pay $245.00"
    stay put on the right.
  - **On a phone** the seats come first, and Pay is a bar pinned to the bottom.
  - Sign-in is a library `Sheet`, available from the header or the form. Signed in, the saved cards appear as radios.
    The expired Mastercard is dimmed, reads "Expired 08/26" and can't be chosen.
  - The card number is grouped as typed (4-6-5 for Amex), and its kind is named beside the label. Expiry is
    reformatted to "MM / YY".
  - Country is a three-way `Segmented` control. The default follows the postal code until the person picks.
- **Tickets:** one at a time on a spring-driven strip, as you can see in the screenshots:
  - a dark header with the title and "Ticket 1 of 3";
  - "Fri 13 Nov · 7:30pm" in the serif, and "Doors open 6:45pm — please arrive by then";
  - Section, Row and Seat large;
  - a perforation, and a real Code 128 barcode it encodes itself.
  - Arrow keys, a swipe, or Previous and Next move between tickets.

Screenshots: `shots/desk-*.png` and `shots/phone-*.png`, the five steps at 1280×860 and 390×844.

### Scored

`evals/apps/venue-checkout/drive.mjs` is the hidden acceptance. It drives the app only by role and accessible name, from
Chrome's accessibility tree, and judges by the service's request log and the sentences the brief fixes. Each scenario
starts from a reset service, with sales off, in a fresh browser context. **11 of 11 pass** (`drive/results.json`):

| scenario | what is checked |
|---|---|
| guest_pays | 2 seats, new card, `Sent to …`; exactly one POST, carrying the number typed |
| phone_guest_pays | the same at 390×844, touch |
| double_press_sends_one | double click, a third click, Enter twice → one POST |
| declined_then_retry | the bank's sentence shown; email kept, security code cleared; a second card pays |
| security_code_wrong | the service's 422 sentence shown, and focus moved to the security code |
| seat_taken_before_paying | a silent sale, then Pay → 409 sentence naming the seat; back in the hall with "1 seat · $80.00" |
| seat_taken_while_choosing | a live sale of a chosen seat → the summary drops to 1 seat and the seat is named |
| signed_in_saved_card | the password field is concealed; the expired card is shown and refused; Visa 4242 pays as `card_1`; a reload keeps the session |
| wrong_password | "That email and password don't match." |
| bad_postcode_stays_home | a 4-digit ZIP never reaches the service, and the field says why |
| sign_in_midway_keeps_choice | signing in on the checkout page keeps the seats and the total |

**The limits of 11 of 11:**
- **The phone scenario clicks rather than taps.** It doesn't judge whether a thumb hits the seat it means.
- **Some checks accept either of two forms.** For instance, the expired card must be either disabled or named
  "expired". This app does both.
- **The driver was debugged against this app.** Two fixes were mine, not loosened checks: the country is a radio group,
  and an accessibility-tree node can resolve to a text node.

A real reference build would show whether the driver is fair to a different but valid design. Until then, treat it as
calibrated on one app.

### Used as a person would

- **Desk, keyboard alone:**
  - The hall is one Tab stop (`focusScope = stop`), entering on a chosen seat or else the free seat nearest the middle
    of the front.
  - The arrow keys move along a row and to the nearest open seat in the row in front or behind, skipping sold seats.
  - Space chooses a seat; Return in a field moves on to the next.
- **Phone, Fri 13 Nov:**
  - The room opens framed on the middle of the Orchestra, at a seat size a thumb can hit.
  - Panning is native. The minimap shows where you are and how full the house is.
  - "3 seats · $225.00" and "Continue to payment" stay in reach.
- **Payment reached the service only as typed:**
  - the number as digits;
  - expiry as month and four-digit year;
  - `line2: null` when empty;
  - the saved card's email from the account.

## Findings for the platform

1. **A text field's accessible name doesn't update after it's created.** The agent reported this and I haven't
   reproduced it yet. A `TextInput` whose `accessibilityLabel` is a constraint showed the right value to
   `declare-look --read`, but its `<input>` had no `aria-label`. Literal labels were fine. The agent gave up a
   country-dependent label ("ZIP code" / "Postcode") because of it.
2. **There's no number, currency or date formatting.** Thirty lines of `helpers.ts` are a thousands separator,
   twelve-hour time, and weekday and month names, written by hand. Every app that shows money or a date will write these
   again. A small set of formatting functions, using the platform's own facilities with a zone given, would remove all of
   it.
3. **A drawing that uses `arc()` is bounded as if it covered the whole circle.** The first floor drawing came back blank
   with an 11 MB raster. The diagnostic was excellent: it named the view and the size. The cause was not named. The agent
   drew every arc as a 48-segment polyline instead (`hall.declare:155-166`).
4. **There's no failure event on `DataSource`.** Refusals are handled by watching `loading` go false and then reading
   `failed` (`venue.declare:175-176`). It's correct, but every app with a write that can be refused needs `onFail` or
   `onSettled`.
5. **There's no way to find a replicated view from its key.** To move focus between seats and to the field a refusal
   names, the agent kept two registries of `Map<string, View>` filled in `onInit` and never cleared
   (`hall.declare:29,119`, `checkout.declare:52,208`). The platform has the key; it should answer `viewFor(key)`.
6. **A first scroll request on a pane was lost.** `scrollToX` then `scrollTo` from the seat map's `onLoad` landed X and
   not Y. The docs say a pane that can't take a scroll yet holds the request. The agent's workaround was a tracked
   height and a one-shot guard (`hall.declare:247-254`). I haven't reproduced it.
7. **A Button can't also be a link.** The warning "onClick writes app.location on a view with no 'link'" fired 18 times
   and was left unresolved, because the agent couldn't see how to keep a `Button` a button and make it a link. The
   "All performances" and "Back to seats" buttons are exactly that case. Either `Button` takes `link`, or the warning
   should say what to do.
8. **The docs contradict themselves twice:**
   - `declare.md` §4 allows `export` in a script file; the compiler refused `export type` (DECLARE4000) and accepted
     `export function`.
   - The SKILL's drift check (`SKILL.md:194`) calls "a list's records copied into a second list to interleave headings"
     a sign of drift. The tracker, the model program the SKILL recommends for lists, does exactly that
     (`tracker.declare:851`). So did this app (`venue.declare:120-128`), and correctly.
9. **Names that look ordinary but are reserved:** `key` (replication metadata, 23 sites) and `form` (a `Sheet`
   attribute). The diagnostics were clear, but there's no list to check against beforehand.
10. **`exists` inside a `Sheet`.** A child with `exists = { app.signingIn }` made the sheet open 48 px tall. Building
    the child unconditionally fixed it. I haven't determined whether this is a bug or an undocumented rule.
11. **Tools:**
    - `declare-look --click` couldn't reach a field inside an inner `scrolls` pane, which drove the agent to Puppeteer.
    - `declare-help toLocaleString` crashes (`declare-help.mjs:276`), apparently finding the name on an object's
      prototype.
12. **What worked, and is worth keeping as it is:**
    - **`TextInput.purpose`:** the agent called its reference entry "a model of what a reference entry should be". It
      produced correct `autocomplete`, `inputmode` and `name` attributes on every field.
    - **Modals:** `Sheet` made the content behind it inert with no work from the agent.
    - **Seats:** `accessibilityRole = toggle` with `accessibilityPressed` gave them exactly the names and states the
      brief fixed.
    - **Computed defaults:** they let signing in prefill the form without overwriting anything typed. The agent called
      this "the best moment of the build".

### Corrections and causes, found after the run (2026-10-21)

Two findings above were wrong, and four now have causes:

- **Finding 2 was wrong.** Formatting is there: the host's `Intl` works in script and inside `{ }`
  (`Intl.NumberFormat` gave "$1,234.56", `Intl.DateTimeFormat` gave "Fri 13 Nov" in this build). The gap was that the
  docs never mention it, and `declare-help toLocaleString` crashed when the agent asked.
- **Finding 4 was wrong.** `DataSource` already answers a failure: a constraint on `failed` to show it, and
  `trackChanges = ["failed"]` to act once on it (`14-data.md`). The agent's code was nearly that idiom. The gap was that
  the `DataSource` reference led with `onLoad` and said nothing of acting on a refusal.
- **Finding 1's cause:** a field whose label *starts empty* never received an accessibility rule, so a name that
  arrived later never reached the page. A label that changed between two values updated correctly.
- **Finding 3's cause:** two faults. An arc was bounded by its whole circle, and the blank check sampled the centre of
  each mark's box, where a shallow arc has no ink, so the drawing was reported blank, and redrawn at half resolution,
  when it had painted. The message then blamed size.
- **Finding 6's cause:** the request was clamped to content that had not got its size yet. The docs promised that a pane
  "not yet laid out" holds a request, which reads as covering this case; the runtime holds only for a pane that is
  hidden or itself unlaid.
- **Finding 10's cause:** `exists` is lowered to a `State`, and the Sheet's default placement moved only views into its
  body, so the child was built into the Sheet itself. The same lowering hid a child named `form` from the check that
  refuses a child taking an attribute's name. The guide's own Sheet example (`14-data.md`) did both; Cadence run 15
  copied it and hit the same 48 px sheet.

## Is it idiomatic Declare?

Mostly yes: more so than its size suggests, and in the places that matter most. Where it isn't, the cause is mostly the
platform's gaps rather than habits carried in from elsewhere.

### What it gets right

- **The work divides the way the calendar teaches** (`venue.declare:7-18`):
  - **Records:** the service's records live in `DataSource` classes.
  - **Where the person is:** `location`, the chosen seats and the result live on the App.
  - **Classes with no view:** a payment form, a sign-in form, the seats' shared machinery and the ticket pager
    (`PaymentForm`, `SignInForm`, `Seating`, `TicketPager`, each `extends Node`).
  - **Views:** they derive from all of the above.
- **The step is derived, never set** (`venue.declare:186-190`): tickets when there's a result, the list when no
  performance is picked, checkout when the address says so and there's a choice, otherwise the hall. Back and forward
  work because the address is the state.
- **The hall is a scene, placed by hand where a scene should be.** `SeatMap.plan` is a `Dataset` derived from the seat
  records (`data.declare:63-115`): seat positions, row labels and floor bands in plan units. One scale, `k`, is provided
  to every view in the room (`hall.declare:100, 146, 201`). Each placed seat carries its own record (`seat: SeatRec`), so
  the one write the stream makes, `markSold` (`data.declare:148-157`), reaches the seat that shows it. No refresh code.
- **Things people press are controls:** `PerfRow`, `Seat` and `CardOption` each `extends Control` with `press()`.
  Keyboard, focus, hover and pressed states come with them.
- **Accessibility as part of the model, not added later:**
  - seats as toggles with pressed state and a hint of price, fee and status (`hall.declare:93-97`);
  - the cards as a `radioGroup` of radios with a one-stop focus scope (`checkout.declare:352`);
  - the hall as one Tab stop with an entry seat and arrow-key movement (`hall.declare:50-86, 281-283`);
  - live regions on the summary, the notices and the payment status;
  - `Accessibility.announce` for a refusal;
  - reduced motion respected (`hall.declare:37`).
- **The form is a derivation.** `shown(f)` (`checkout.declare:78-81`) speaks a field's problem only once it's been left
  or Pay has been pressed, and otherwise shows the service's sentence. The field outline, the message under it, the
  focus after a refusal and the announcement all read that one method.
- **One guard stops a second payment** (`checkout.declare:106`), and the button stays focusable.
- **The live stream recovers properly** (`venue.declare:139-150`): `EventStream` with `retry`, and a re-fetch of the hall
  when the status goes from retrying to open, so nothing sold during the gap shows as free.
- **Library pieces where they fit:** `Sheet`, `Segmented`, `Checkbox`, `Button`, `ChevronIcon`, `CheckIcon`, `Divider`,
  `Spring`, `Animator`, `Time`. A theme extends `SanFrancisco` and holds every colour (`venue.declare:33-46`).

### The script

`helpers.ts` is 202 lines (161 without comments). The SKILL counts a long script block as a sign of drift. Read
closely, this one mostly isn't drift in the SKILL's sense. Here is what's in it:

| lines | what | verdict |
|---|---|---|
| 1-49 | money, dates, times, "3 seats" | **forced** — Declare has no formatting (finding 2) |
| 51-141 | card kind, grouping, length, Luhn check, expiry, security code, email | **legitimate** pure functions, **with the copy in the wrong place** |
| 143-174 | postal-code patterns per country, the hint beside the field, guessing the country from a code | the same |
| 176-202 | Code 128 bars for the ticket's barcode | **legitimate** — a pure algorithm, exactly what script is for |

None of it holds state, places a view, times motion or carries a colour, which are the SKILL's actual tells. It is a
library of functions of their arguments, and its header says so (`helpers.ts:1-2`).

**My view:** the script isn't the problem its length suggests, but it isn't clean either. Two things are wrong with it,
one the agent's and one the platform's:

- **The agent put user-facing copy in script.** About twenty sentences a person reads live in TypeScript (`helpers.ts:93-162`): "That card number isn't right — check the digits.",
  "A ZIP code is 5 digits, like 94103.", and so on. So the form's words are in two languages and two files.
  `PaymentForm.problem` (`checkout.declare:61-74`) writes some of them itself ("Enter the street address.") and takes
  the rest from script. This should have been written the other way round. The script answers which rule failed (`"short"`,
  `"luhn"`, `"format"`), and `PaymentForm` words it, so a designer or translator finds every sentence of the form
  in one place, in Declare.
- **A third of it shouldn't exist.** Money and dates are the platform's job. The agent did the right thing within what
  it had: it parsed the hall's local time as written rather than through a time zone, which avoids a real trap. But
  writing a thousands separator by hand is exactly the work a UI platform should do, and every Declare app that shows
  money or a date will write it again.

What remains, the card and postal rules and the barcode, is roughly 120 lines. That's a reasonable amount of pure logic
for a checkout, and it's in the right place.

### Missteps, and how they should have been written

1. **The service address appears seven times** as a literal: `data.declare:33` and `venue.declare:131, 140, 157, 161,
   165, 173`. It should be one `api: string` on the App, with each `url` built from it.
2. **A seat's name has two sources.** `Placed.label` is built in the layout (`data.declare:86`). `SeatMap.label` rebuilds
   it by splitting the id on `-` (`data.declare:135-138`), and so do `sectionOf`, `price` and `fee` (`:119-131`).
   Everything those need is already on the placed seat. One lookup by id into the plan should answer all of them, and
   no code should parse an id.
3. **Page heights are arithmetic.** The header's 64 is repeated (`venue.declare:324, 327`). `HallPage` places its pane,
   bar and side panel by subtraction (`hall.declare:400-447`). The agent hit a refusal when one `SimpleLayout` had to be
   a row at a desk and a column on a phone, and fell back to arithmetic. `ResponsiveLayout`, which the SKILL's table
   names for exactly this, wasn't tried. It's the SKILL's own drift tell ("a container whose height is arithmetic over
   its children"), arrived at through a refusal rather than by habit.
4. **A flag stands in for an event** (`venue.declare:220-225, 283`). `seatFocusWanted` is set when focus is wanted
   before the seats exist, and consumed when they arrive. It works. The cleaner form is for `seatsArrived` to focus the
   entry seat whenever the hall step is current and no seat holds focus, with no flag.
5. **The "back" controls write `location` from `onClick`** (`hall.declare:410, 453`; `venue.declare:301`). These are
   links in all but name, and the crawler warning said so 18 times. Where the platform allows it, they should be links
   (finding 7).
6. **It wrote no tests for maintainers.** Its own Puppeteer driver (thirteen scripts, `agent-driver/`, 301 lines) found
   real bugs:
   - duplicate "Security code" fields while one was only hidden;
   - the empty postal-field name;
   - the minimap swallowing the first tap.

   But the driver lives in `/tmp`, outside the program. The agent says it never used R5 assert scripts, R6 baselines or
   `--semantics`, so the program ships with no tests. The agent's account says it would have caught the postal name
   sooner with `--semantics`.

### Workarounds the platform forced

- **Formatting by hand** (`helpers.ts:1-49`). The fix is formatting functions in the platform (finding 2).
- **View registries** (`hall.declare:29, 119`, `checkout.declare:52, 208`). The fix is a key-to-view lookup (finding 5).
- **Refusals detected through `trackChanges = ["loading"]`** (`venue.declare:175-176`). The fix is `onFail` or
  `onSettled` (finding 4).
- **Arcs drawn as polylines, and the floor drawn row by row** (`hall.declare:143-171`). The fix is drawing bounds that
  follow what a path actually covers (finding 3).
- **A fixed postal label** in place of one that follows the country. The fix is refreshing a field's accessible name
  (finding 1).
- **The first frame of the room driven by `trackChanges` and a guard** (`hall.declare:247-254`). The fix is a held
  scroll request (finding 6).
- **`chosenData`, a `Dataset` that wraps the chosen ids as records** (`venue.declare:198`), so the seat list beside the
  room and the order lines can replicate over them. As far as I can tell, a replicated view can't take its datapath
  from a plain array of strings on the App. If that's right, it's a small, common need.

## The React comparison run

**Run:** 2026-10-21 03:00 UTC, `launch.sh --stack React venue-checkout ~/Code/eval-venue-checkout-react-1 claude-opus-5-5 "" 8351`.
It used the same brief, API, model, tools and web access, with the two-sentence React prompt and no download. Its own
fresh service ran on 8351, with the corrected sales clock from the start, and its copies of the brief and API were
rewritten to say 8351. It needed no intervention. The source, screenshots and its QA scripts are filed in
`../2026-10-21-venue-checkout-react-1/`, and its app is at http://127.0.0.1:5173/.

| | **Declare** | **React** |
|---|---|---|
| time | 44.2 min | 31.4 min |
| turns · tool calls | 184 · 179 | 101 · 97 |
| output (incl. thinking) | 162k (68k) | 147k (51k) |
| fresh input (cache writes) | 399k | 199k |
| cached input re-read | 46.6M | 9.3M |
| read before first app write | 391 KB | 23 KB |
| context at first write → end | 185k → 405k | 42k → 205k |
| first app write at | 6–10 min | 5.1 min |
| first look in a browser at | about 12 min | about 18 min |
| code, excluding comments and blanks | 1,499 (Declare 1,338 + TS 161) | 4,861 (TSX 2,339 + TS 578 + CSS 1,944) |
| files | 6 | 36 |
| libraries | none | react-router, TanStack Query, react-hook-form, card-validator, qrcode.react, Fontsource (Inter, Fraunces) |
| download (gzip) | 152.9 KB, system fonts | 158.5 KB (JS 150.0 + CSS 8.6), plus about 85 KB of Latin web fonts |
| hidden acceptance (`drive.mjs`) | 11 of 11 | 11 of 11 |

**What the comparison says:**

- **Both apps pass every scenario.** The driver passed the React app with no change, so it now has two independent
  designs behind it, and the "calibrated on one app" caveat above is weaker.
- **React was faster and used fewer tokens:** 30% less time, 55% of the turns, and a fifth of the cached input. The gap is almost entirely
  learning. The React agent read 23 KB before writing, against Declare's 391 KB, and carried far less context
  (205k at the end against 405k). Declare's figure includes learning a language from nothing in the same session, and it shows.
- **Declare took a third of the code:** 1,499 lines against 4,861, about 3.2 times less. That's with four libraries
  doing card validation, forms, routing and fetching on the React side, and about 160 lines of hand-written card,
  formatting and barcode code on the Declare side. CSS alone, at 1,944 lines, is larger than the whole Declare program.
- **The download is a wash** (153 KB against 158 KB), but React also loads about 85 KB of web fonts.
- **The phone hall is where they differ most:**
  - **Declare** never lets a seat drop below a 34-point target. The room is a pan pane with a minimap, so every tap is
    a thumb-sized target.
  - **React** shows the whole house at overview scale, about 10-point seats, with a "Zoom in" button that switches to
    thumb-sized seats.
  - The brief's hard case ("the exact seat they mean, first time, with a thumb") is met directly by Declare and in two
    steps by React. Neither is wrong. Declare's is the stronger answer to the sentence as written.
- **The look:**
  - **React:** a dark auditorium on a card, seats as little chair shapes, web fonts throughout, a QR code on the
    ticket.
  - **Declare:** warm paper and a single crimson, seats as rings and discs, a hand-encoded Code 128 barcode.
  - Both are well past "a database with a form attached". I'd call it even, by taste.
- **React used `<form>` for sign-in and checkout**, the question we tested by hand before the runs. Declare has no
  `<form>`, and its fields filled and saved through autofill in our hand tests regardless.
- **Verification:** React looked in a browser later and less often (4 renders against 33). It relied on writing whole
  files and type-checking, then a handful of Playwright flows. Declare looked earlier and much more often. That's
  partly the SKILL telling it to, and partly because it had no prior knowledge to write from.

**For Declare:** the time and token gap is the onboarding. 391 KB read before the first line, and 405k tokens of
context by the end. Each finding above that removes a workaround (formatting, `onFail`, a key-to-view lookup, arcs)
also removes reading and turns. The code-size advantage is real, and it held on a form-heavy brief, not just on
motion-heavy ones.

## The agent's account, verbatim

# Building Venue in Declare: an account for the people who make it

Venue came to about 1,680 lines of Declare across five files (`venue`, `data`, `hall`, `checkout`, `tickets`) plus 200 lines of TypeScript helpers. Every flow in the brief ran end to end against the live service. What follows is my honest experience, including the places where I'm not sure whether I hit a bug or misused the platform.

---

## (a) Getting up to speed

**What I read, in order.** I started with `README.md`, which sent me to `skill/SKILL.md`. That routed me to `docs/declare.md`, guide chapters 01, 04 and 05, and the whole of `apps/calendar/calendar.declare`. After that I read chapters as I needed them: 06 (layout), 08 (controls), 14 (data), 19 (accessibility), 18 (overlays), 10 (touch), 07 (scrolling), 09 (pointer and keyboard), part of 12 (text) and `operational/intake.md`. I made a lot of `npx declare-help` calls: `TextInput.purpose`, `DataSource.credentials`, `EventStream`, `Spring --all`, `Animator.start`, `View.focusScope`, `Focus`, `ValueChange` and others. Several times I went to the source itself: `library/sheet.declare`, `library/button.declare`, `runtime/src/purpose.ts`, `semantics-dom.ts` and the `scrollIntoView` in `dom-backend.ts`.

**What taught me the most:**
- **`docs/declare.md`.** Its "Seven differences" section and the set-versus-declare table in §5 ("owned by its constraint?") set my mental model in one pass. I made almost no reactivity mistakes after reading it.
- **The "What Declare handles for you" table in `SKILL.md`.** It is the most useful page in the distribution. It mapped needs I already had (sign-in sheet, password field, autofill, live seat stream) straight to class names.
- **`declare-help`.** It was nearly always right and specific. The `TextInput.purpose` entry, with its autofill and keyboard table, is a model of what a reference entry should be.
- **The calendar program.** It taught me to compute geometry as constraints on a few numbers, which I used for the hall's scale `k`. I'm less sure it was the right first read for an app that is mostly forms and lists. The tracker might have been a better model for checkout, but I never read it.
- **The `Spring` reference prose.** Two lines in it changed my design: "It starts where it is going" and the warning against a spring per replicated row. Instead of springs on 650 seats, the "a choice registers" pulse became one shared `Animator` on a `Seating` node.

**What was missing or misleading:**
- **Script files and `export`.** `declare.md` §4 says a script *file* "is written module-style (`export` allowed, and optional)". But `export type Brand` in `helpers.ts` was refused with "'export' has no meaning in a script { } block" (DECLARE4000). Exported functions in the same file were fine. Either the rule or the docs is wrong.
- **Reserved member names.** `key` and `form` look like ordinary names and both collided. `key` gave "'key' is replication metadata" across 23 sites. `form` gave "Sheet.form is an attribute — a child may not take an attribute's name". The diagnostics were clear, but a short list of reserved and commonly inherited names would have saved two rounds.
- **`exists` inside a `Sheet`.** I put the sign-in form in the sheet with `exists = { app.signingIn }` and the sheet opened 48px tall. `app.sheet.body.contentHeight` read 28, and `body.0` read null. Building the child unconditionally fixed it. Nothing in the docs warned me, and I can't tell whether this is a bug or a rule I missed.

## (b) Expressing what I wanted to express

**Where the language fit:**
- **Computed defaults were the best moment of the build.** The brief says signing in mid-checkout must not lose anything typed, yet the account should prefill. `email: string = { app.account?.email ?? "" }` does exactly that: the formula follows the account until the person types, and then their value is theirs. The country field followed the postal code the same way, until the person picked one. I wrote no merge logic at all.
- **The data sources.** `DataSource` with `credentials = include`, plus an `EventStream` with `listenTo`, `retry` and a tracked `status`, gave me sign-in, the session, ordering and the live seat stream with almost no plumbing. For example, `this.status == "open" && previousValue == "retrying"` triggers a refetch of the hall.
- **Double-submit protection.** A one-line guard, `if (app.order.loading) return`, held up against click, click and Enter: exactly one POST.
- **Free accessibility.** `TextInput.purpose` produced correct `autocomplete`, `inputmode` and `name` attributes. A `Sheet` made the content behind it `inert`. `accessibilityRole = toggle` with `accessibilityPressed` gave seats the exact names and states the brief asked for.
- **Keyboard focus.** `focusScope = stop` with `focusEntry()` made the room one Tab stop. `Focus.next()` on Enter gave the brief's "next field is one step away".
- **Errors as derivations.** Each field's message comes from a `shown(field)` method over a few facts: whether the person has left the field, whether they've tried to pay, and the server's verdict. That stayed small and correct.

**Where I worked around it:**
- **Big drawings.** I first drew the hall's floor as one `draw()`. The runtime reported "the drawing on …room came back blank from the browser: a 1695×1695 raster (11 MB)". I split it into one drawing per row and still got blank rasters, because each `arc()` seems to be bounded as its whole circle. I replaced every arc with a polyline. The diagnostic was excellent — it named the view and the size — but it didn't name the cause, and I'm inferring the full-circle bounding from the numbers.
- **A text field's screen-reader name doesn't update.** The postal field's label was computed from the country. `declare-look --read` showed `accessibilityLabel = "ZIP code"`, but the DOM `<input>` had no `aria-label`. Every literal-labelled field was fine. I made the label static ("Postal code") and moved the format to a side note. This looks like a refresh bug in `semantics-dom.ts`'s text-field path, but I didn't confirm the mechanism.
- **Initial scroll position.** I called `scrollToX` then `scrollTo` from `afterSettle` in the seat map's `onLoad`. X landed and Y stayed 0, though calling the same method later worked. The docs say a pane that "cannot take it yet holds the request", but in my case the Y request seemed clamped or dropped instead. I ended up reacting to the room's measured height with `trackChanges` and a one-shot guard.
- **Finding a view from its data.** For arrow-key movement I needed "the seat view for this id". I registered views into a `Map<string, Seat>` in `onInit`. It works, but it feels like going around the replication system. I'd like a sanctioned way to look up a view by its key.
- **A layout whose axis switches.** The hall page needed a row at a desk and a column on a phone. `flexes = true` combined with a size on the switching axis was refused at R4 ("HallPage's SimpleLayout sizes its children…"). I fell back to explicit x/y/width/height arithmetic, which is exactly what the drift check calls a smell. `ResponsiveLayout` might have been the right answer; I didn't try it, so I can't say.
- **No failure event on `DataSource`.** I handled refusals with `trackChanges = ["loading"]` and checked `failed` when loading turned false. It works, and I think it's correct even across two declines in a row. An `onFail` event, or an `onSettled` that runs on either outcome, would read more plainly.
- **A warning I left unresolved.** "onClick writes app.location on a view with no 'link'" stayed in the output. I couldn't see how to make a `Button` a link while keeping it a button, which my role-based tests relied on.

## (c) Verifying it

- **`declare-verify` R1–R4** was fast and its messages named fixes I could apply directly. Examples: DECLARE4005 on a bare `semibold` inside braces, DECLARE5001 when a class name clashed with a schema name, and the layout-ownership errors.
- **"Fed a sample of their schema"** at R4 is a clever idea: it boots a program whose data is all remote.
- **`declare-look --read`** was my main debugging tool. Reading `app.hallView.scrollY`, `app.sheet.body.contentHeight` or `…slot.0.accessibilityLabel` answered questions in seconds.
- **`declare-look --click` and inner scrollers.** It failed with "'app."City"' is outside the window … and scrolling did not bring it in", and `--call '…scrollIntoView("nearest")'` didn't move the pane either. Yet Puppeteer's native scroll-into-view worked on the same page. I can't explain the difference.
- **My own driver.** Because of that, and because the brief says grading works by role and accessible name, I wrote a Puppeteer script using `::-p-aria(...)` selectors that logs every non-GET request to the service. That driver found the real problems: duplicate "Security code" fields while the hidden one was only `visible = false`, the empty postal name, and the minimap overlay swallowing the first seat tapped on a phone.
- **What I skipped.** I never used R5/R6 (`--assert`, visual baselines) or `--semantics`. In hindsight `--semantics` would probably have caught the missing postal name sooner.
- **The dev server** handled a port collision well: "port 8200 is already taken… start this one on another port: PORT=8201".

## Surprises

- How little reactive bookkeeping there was. I never debugged a stale value.
- The `exists`-inside-`Sheet` sizing, the arc bounding and the text-field name refresh, as described above.
- Background content was made `inert` under a modal with no work from me. Pleasant.
- `scrolls = { zoomed ? "both" : "none" }` worked as a constraint. I half expected that to be refused.

## Good and bad

**Good:**
- The two-delimiter model.
- Diagnostics written for whoever reads them next, which often meant me.
- `purpose`, and the Sheet's built-in focus and inert handling.
- `DataSource` and `EventStream` with credentials.
- Computed defaults.
- A small enough surface that `declare-help` could answer nearly every question.

**Bad:**
- A few runtime gaps, all in the last stretch to production: accessibility refresh, canvas bounds, scroll timing.
- Test tooling that loses track inside inner scrollers.
- Reserved names discovered by collision.
- Some layout cases that push you toward hand arithmetic.

## Differences from what I'm used to

- No CSS or DOM to program, and no async in handlers.
- Events don't bubble. Seats call `app.toggle`; nothing propagates.
- `fetch` is refused inside expressions in favour of a `DataSource`.
- The "settle" replaces render cycles.
- Constraints are compiled and checked, not discovered at runtime.

Compared with React there are no effects or dependency arrays. The closest thing to a pitfall was an attribute's owner refusing a write, and the compiler explains that.

## What it reminded me of

Mostly QML: property bindings, states, springs, a tree as scope. OpenLaszlo, its stated ancestor, is clearly there too. The data side felt like MobX or Svelte stores with a type checker attached. Drawing reminded me of Flutter's `CustomPainter`.

## Where I'd most want improvement

1. Re-announce a text field's accessible name when it changes.
2. Bound a drawing by what it actually covers rather than whole circles.
3. Make `declare-look` and verify scrolling work inside inner `scrolls` panes. Close the gap with native behaviour.
4. Give `DataSource` an explicit failure or settled event.
5. Provide a lookup from a key to its replicated view.
6. Document reserved and inherited member names, and fix the `export` contradiction for script files.
7. Clarify how `exists` children size inside overlays.

## What I'd use it for

Interactive, stateful surfaces, where its strengths compound: seat maps, schedules, dashboards, anything with live data and meaningful motion. The hall, with its live sales, focus handling and phone panning, came together faster than I'd expect in React. For a form-heavy product where screen-reader correctness is critical, I'd use it only after the text-field labelling gap is fixed. And I'd want the testing tools more mature before handing it to a team that relies on automated end-to-end checks.

I'm less sure about long-term maintainability at scale. My largest file was about 530 lines, so I haven't tested how it holds up beyond that.