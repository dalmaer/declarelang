# Overlay build — changes to the base language, for review

Every change the overlay build (planes.md §16) makes to the language or the runtime's
semantics, kept here for review after the fact. The rule: minimize them, and when a
library-level answer exists, use it instead. Library classes and docs are not listed.

## From the design (planes.md, ruled before the build)

| Change | Where | Step |
|---|---|---|
| `focusScope = none \| stop \| capture \| region \| modal`; `focusTrap` and `escapeFocus` removed | schema.ts, view.ts, focus.ts | 1 |
| `Focus.focusIn(v)`, `Focus.nextRegion(dir)`; F6 / Shift-F6; Enter enters a region; Esc closes an entered member | focus.ts, scaffold.ts | 1 |
| Keys an open overlay uses (Esc, Enter, arrows) reach only `Keys` members inside it | keys.ts | 1 |
| `paintsIn = { view }` — paint parent apart from the logical one; `travelWith` now writes it (retire in step 6) | view.ts, interaction.ts, layout.ts | 2 |
| `outsidePress`, `scrollBelow`, `onOutsidePress` | schema.ts, outside.ts, input.ts | 3 |

## Made during the build — not in the design text

1. **`defaultplacement` places views only.** A subclass's or use site's non-view members
   (Spring, Animator, State, Keys, Dataset, Node) stay on the instance instead of going into
   the placement target. Before, `class DeskWindow extends Window [ tiltSpring: Spring
   [ attribute = tiltA ] ]` drove the *content pane's* `tiltA` — silently nothing — once
   `Window` named `content` its placement; every Dialog/Sheet/Popover subclass with a
   member of its own had the same trap. The checker already resolved such members against
   the instance, so this brings the runtime in line with it. `runtime/src/instantiate.ts`
   (`into`). **Ruled 2026-10-16: kept.**
2. **Blocking is per context.** `outsidePress = block` and `scrollBelow = block` hold back
   input only inside the overlay's context — the nearest `focusScope = region` above where
   it paints, else the program (a window-modal sheet). `dismiss` stays global.
   `runtime/src/outside.ts`.
3. **An overlay's keyboard claim holds only while focus is not in another context**, and
   `Keys.claimant()` (new static) names the overlay the keys go to now; the library's Esc
   and Enter use it. `runtime/src/keys.ts`, `services.ts`, `scaffold.ts`, `effects.ts`.
4. **`Focus.holds(v)`** (new static): is focus on `v` or inside it, crossing from a
   hosted program's root to its island. The library `Window.holdsFocus()` walked
   `parent` only, so with focus on a control of a program hosted in the window it
   said no, and a press in the window called `Focus.focusIn` on it. Declare has no
   other way across an island (`$hostIsland` is internal). `runtime/src/focus.ts`,
   `scaffold.ts`, `capabilities.ts`. Alternative: expose the island crossing some
   other way, or leave a hosted program's focus invisible to the host.
5. *(documentation only)* `View.rootTransform().rotation` is in radians; the reference did
   not say. No behavior change.

6. **`overlays` — a provided name that makes a context** (library convention, step 3–4):
   a view that declares `overlays: View? = { … }` makes every `Floating` below it open in
   that view — the library `Window` provides its `layer`. Works by name, as `provided`
   does; undocumented for programs until step 8.
7. **`View.transformTo(other)`** (new method, step 5): the similarity from this view's
   frame to another's, crossing islands (a hosted program's root frame is its island's
   frame; an oversized tenant's panning inside its box is not counted). How a hosted
   program's overlay is placed against its host's layer. `runtime/src/interaction.ts`
   (`outerAffine`, `transformBetween`), `view.ts`, `scaffold.ts`, prose `View.md`.
8. **An `AppIsland` passes the overlay layer down by default** (step 5, DT discussion
   2026-10-15): its program's overlays open in the nearest `overlays` up the whole chain —
   the island's own ancestors, then its host's host — and take the program's scale and turn
   relative to that layer (`Floating.baseScale`/`baseRotation`; `Sheet` and full-window
   presentations keep the window's). No context above: they stay in the program, as before.
   `AppIsland.containOverlays = true` keeps them in the box. The runtime adds `overlays` to
   the island's provides when the island declares `containOverlays` (= an `AppIsland`) and
   it is false; `islandProvision` falls through to the island's own program's host value for
   that one name. Not a security boundary (a hosted program runs in the host's realm and
   could already draw anywhere); a design choice the island can reverse.
9. **A hosted program's presence in its host ends when its island unlinks**: its views
   painting in host layers come home, its open overlays and keyboard claims go
   (`withdrawPaintGuests`, `withdrawOpen`, `Keys.releaseProgram`, run first in
   `linkIslandTenant`'s undo). A torn-down claimant or open overlay is also dropped where
   they are read.

10. **`View.travelWith()` removed** (step 6, as ruled in §16 step 2): `paintsIn` replaces it.
    Its two callers were library-only (`api: false`): `FocusRing` writes `paintsIn` to the
    scroller it rides, and `DataGrid`'s header declares `paintsIn = { classroot.parent }`
    (its `escaped` member and the deferred retry are gone). The backend seam's surface
    `travelWith` stays — `paintsIn` is built on it.
11. **Focus reveal is the focus service's own** (step 6, §14): Tab scrolls each scroller
    that carries the focused view, innermost first, by the least that shows it with ring
    room — passing over scrollers it ignores the scroll of, ending at a modal scope, and
    waiting out a user's scroll. Replaces native `scrollIntoView` for focus (which walked
    to the document). The DOM backend focuses a native field with `preventScroll`.
12. **The App's overlay layer ignores scroll** (`OverlayStrata.ignoreScroll`): overlays stay
    in the viewport of an App that scrolls as a document.
13. **The ring rides only a scroller that overflows**, and draws inset where the scroller it
    rides would cut it off (§14 room at the clip); it shows for focus inside the overlay that
    holds the keys (a dialog's own controls), standing down only for what lies behind.

14. **Shortcuts as declared data** (step 7, §9). New library class `Shortcuts` (a `Node`:
    `items` of `{ id, key, label, enabled }`, `on`, `title`, `picked(id)`), registering with
    the new `Keys.declareShortcuts`. A key press first looks for a declared shortcut, from the
    focused view outward through islands into hosts, nearest first; one found takes the key —
    it is **not also delivered to `Keys` members**, and the browser's default for the chord is
    stopped. Not while an overlay holds the keyboard; a key with no command modifier not while
    a text field has focus (a typed symbol's Shift is implied: `"?"` matches ⇧/). `MenuBar`
    declares its items' `key:` for its whole program. New `Keys.shortcutsInForce()` (the
    resolved set, for a panel) and `Keys` member event `onCommandHeld(on)` (the command key
    held alone ~0.7 s — every program hears it). `runtime/src/keys.ts` (`comboOf`,
    `normalizeCombo`), `services.ts` (`focusChain`, `typing`), `schema.ts`, `sources.ts`,
    `scaffold.ts`, `capabilities.ts`; prose `Keys.md`; `library/shortcuts.declare`,
    `menubar.declare`. The desktop's own `keyRegistry` and ⌘ dispatch are gone; it gains the
    hold-⌘ panel.

15. **Reveal lands clear of pinned chrome** (focus stress page, §14). A scroller's children
    that ignore its scroll, are visible, take the pointer and stand against an edge — a
    header bar, a footer, a side rail, under half the frame — cover that edge: Tab reveals a
    control past them, not under them (CSS's `scroll-padding`, read from the tree rather
    than written). An overlay stratum (full-frame, `pointerEvents = "none"`) is not chrome.
    `focus.ts` `pinnedEdges`. Only focus reveal: `View.scrollIntoView()` is unchanged (its
    DOM path is native).
16. **`FocusGeometry.homeRot`** (new field on the shared interface): the focused view's turn
    in its home scroller's content space, in degrees. When it is not 0, `homeX`/`homeY` are
    the turned box's origin corner and `homeW`/`homeH` its own scaled size (they were the
    upright bounds); unturned, nothing changes. The ring uses it to ring a tilted window
    turned. `focus.ts`, `scaffold.ts`.
17. **The ring stacks beneath the page's pinned chrome** over a control in the scrolled
    content (above it for a control in the chrome or an overlay): a control scrolled under a
    toolbar takes its ring under too. `FocusRing.restack()`; riding a pane, the pane's
    pinned chrome paints over the ring on every backend (the DOM pane's sticky frame now
    lifts above a paint guest, `zIndex` 2).
18. **`FocusGeometry.scroller` skips a scroller across its pinned chrome**: a control in a
    pane's `ignoreScroll` header is not carried by that pane's scroll, so its geometry names
    the next scroller out (the page), and `homeX`/`homeY` are given there. Before, the ring
    rode the pane's scrolled content at the header's frame position: once the pane had
    scrolled, it sat out of view and under the header (stress page §6, Outer 7 → Header
    button: focus there, no ring). `focus.ts` (the follower's scroller walk). With it, in
    the library only, the ring's outline holds to the visible frame of the scroller it
    rides, so the arrival overshoot flattens at a pane's edge instead of being clipped
    (`FocusRing.draw`; no surface change).
19. **`Focus.focus()` from a key's handler is keyboard focus.** It used to clear keyboard
    modality always (the pointer/programmatic path). Now, called while a key is being
    dispatched (`Keys.inKeyDispatch()`, internal), it sets keyboard modality instead — the
    web's `:focus-visible` rule for script focus during keyboard use. Every group control
    that roves with `Focus.focus` from its arrow handler (`Segmented`, `RadioGroup`,
    `MenuBar` titles) used to snap the ring to the next member and fade it out, as if
    clicked (sampler page switch, Cupertino). `keys.ts` (dispatch depth around
    `keyDown`/`keyUp`), `focus.ts` (`focus()`, `deliverKeys` hands the focus service its
    key service). A pointer press or code run outside a key handler is unchanged.
20. **Every library look value is a theme token** (library vocabulary, no language
    surface). An audit found no per-theme logic in any class, but found look values that
    were literals or borrowed another part's token. Each now reads an optional token whose
    default is the old literal, so a theme that does not set it looks as before:
    - roles that collided (one token, two parts): `trackFill` (segmented, slider and
      progress tracks, switch off, gauge rail; default `control`), `segmentedSelectedFill`
      (the pill; default `surface`), `switchThumbFill` and `sliderThumbFill` (default `surface`),
      `accordionHeaderFill` (default `control`), `segmentDividerColor` (new: dividers
      between unselected segments; none by default);
    - overlay chrome: `dialogCornerRadius`, `dialogShadow` (were borrowed from the menu's),
      `popoverCornerRadius`, `popoverShadow`, `sheetCornerRadius`, `sheetShadow`,
      `toastCornerRadius`, `toastShadow`, `toastFontSize`, `tooltipCornerRadius`,
      `dragShadow` (DataGrid's column ghost); Popover's scrim now reads `scrimOpacity` like
      Sheet and Dialog; Toast wears `tooltipStrokeColor` and Tooltip's fallbacks;
    - metrics: `segmentedHeight`, `segmentedCornerRadius`, `segmentedFontSize`,
      `menuFontSize`, `menuKeyFontSize`, `menuHighlightCornerRadius`, `menuBarHeight`,
      `menuBarFontSize`, `menuBarTitleCornerRadius`, `accordionHeaderHeight`,
      `accordionFontSize`, `comboboxHeight`, `gridRowHeight`, `gridHeaderHeight`,
      `gridFontSize`, `gridHeaderFontSize`, `gridCellCornerRadius`, `radioSize`,
      `progressBarHeight`, `sliderTrackHeight`.
    Two changes of look: `Gauge` drops its fixed colours for `accent` / `trackFill` /
    `textMuted` and the theme's corner radius, and DataGrid's select cell hovers with
    `controlHovered`/`controlPressed` (it borrowed `control`). Presets: Cupertino sets the
    Mac's grey well, white pill, dividers, and light switch and slider knobs in dark; every dark record
    sets `segmentedSelectedFill` lighter than its track (the pill was darker than the track
    in all four). Library-only; `docs/declare-model.json`'s theme-token table is measured
    from the sources. Still literals by intent: structural geometry (2px insets, the
    slider's thumb arithmetic, row margins, the sheet grabber), and the platform apps'
    (inspector) own palettes, which are programs, not library classes.
21. *(withdrawn)* An `App.regionKey` attribute was added and removed the same day (DT
    2026-10-16): the region key stays **F6, fixed**, accepting that some browsers take it.
    Making it configurable waits for the conventions record, a provided record parallel to
    `theme` (`docs/system-design/conventions-record.md`). No surface change remains.

### After the design assessment (2026-10-16)

An independent assessment (`~/Desktop/declare-overlay-design-assessment.md`) and an audit of
the last evals' findings (`my-apps/evalaudit/STATUS.md`) led to these.

22. **Focus inside the overlay that holds the keys keeps them.** Design step 1 withheld an open
    overlay's keys (Enter, Space, the arrows, Home/End, Page keys) from the focused view
    always — right for a menu, which roves while focus stays on its opener, but every control
    *inside* a popover, sheet or dialog went deaf (the guide's own popover slider). Now the keys
    are withheld only when focus is outside the claimant. `focus.ts` (`deliverKeys`,
    `focusInClaimant`). With it, in the library: a dialog's Return picks the default only when
    the focused view does not take Return itself (a control presses itself; a multi-line field
    types the break) — `Dialog.returnTaken()`.
23. **A modal overlay's dismissal keeps to its context** (revises #2). A press in another
    window used to close a sheet open on its window — and be swallowed. A `focusScope = modal`
    overlay with `outsidePress`/`scrollBelow = dismiss` now lets a press or scroll outside its
    context go on, and stays. A menu still closes on a press anywhere. `outside.ts`.
24. **A text field keeps its editing chords** (revises #14): while a field has focus, ⌘A,
    ⌘C/X/V, ⌘Z, ⇧⌘Z, ⌘Y and the caret's ⌘/⌥ arrow moves stay the field's, whatever a program
    declares (the Mac's first-responder order). Other ⌘ shortcuts still fire from a field.
    `keys.ts` (`FIELD_CHORDS`).
25. **Esc then Tab leaves a region** — Shift-Tab back — beside F6 (the way out every browser
    leaves to the page; CodeMirror's rule). An Esc with nothing open to close arms it; any other
    key but a lone modifier disarms it. Esc alone still never leaves a region. `focus.ts`.
26. **`focused` is every view's fact, and `Focus.getFocus()` is a tracked read.** A read-only,
    reactive `View.focused` (a cell per view that is read); `Control` and `Editor` lose their own
    `focused` (Control's was library-written in `onFocus`/`onBlur`). A constraint over
    `Focus.getFocus()` follows focus. `view.ts` (`noteFocused`), `focus.ts`, `schema.ts`,
    `text-input.ts`, `control.declare`; prose View, Focus, Editor, Control.
27. **`TextInput`: the selection's read half, Return-to-send, and growth.**
    `selectionStart`/`selectionEnd` (read-only; reported by every backend — `edit-selection.ts`
    for DOM and canvas, a selection observer in the Mac host); `enterSubmits` (a multi-line
    field whose Return fires `enter`, Shift-Return the break; DOM, canvas, Mac); and a field's
    `contentHeight` is its text's, so the ordinary cap `height = { Math.min(contentHeight, 120) }`
    is a field that grows, then scrolls. The IME composing range is not exposed.
28. **A provided theme is laid over the library's defaults.** `library/themes/defaults.declare`
    (`theme ThemeDefaults`, not a preset) holds every optional token's default; the runtime
    fills a provided theme from it (`themes.ts withThemeDefaults`, at `provideWrite`), so a
    library read carries no fallback — the 80 `typeof provided("theme").x == "number" ? … : n`
    reads are gone; a token whose default is another token reads `a ?? b`. Presets are served
    filled; a preset lowered into a program stays as authored. Look changes: Popover's scrim
    0.30 → 0.32 (the others' value); `AppearanceSwitch` reads its own `appearanceSwitchSize`
    (32) where it borrowed `buttonHeight`. Token table, `declare-help`, gen-themes updated.
29. **An overlay's `shown` can be state.** `Floating` delivers its opening and closing through
    `input(open)` (the value pattern), and does the open and close work when `shown` changes,
    whoever changed it — so `shown = { app.editing }, input(open: boolean) { app.editing = open }`
    opens and closes with the state, and Esc or a press past it writes the state back. With it,
    in the checker: **a use site that constrains an attribute its class's own `input(v)` writes
    (`shown`, a control's `value`) without an `input` override is a compile error naming the
    fix** — before, the first Esc, drag or pick failed at run time. `floating.declare`,
    `check.ts` (`checkControlledInput`).
30. **The library's records are typed.** `schema MenuItem`, `MenuBarMenu`, `DialogButton`,
    `Shortcut`; `Menu.items`, `MenuBar.menus`, `Dialog.buttons`, `Shortcuts.items` take them, so a
    misspelled field (`lable`) is a compile error. A schema cannot name itself, so `submenu` is
    `any`.
31. **A press on content that takes no focus clears focus** (2026-10-17, DT: "go with web
    rule"; keyboard-follows-focus.md §9). When nothing on the pressed view's chain can take
    focus, focus is cleared — the keyboard returns to the program pressed in — and the next
    Tab or Shift-Tab starts from the pressed spot, inside the cycle that holds it (a dialog's
    plain content keeps Tab in the dialog). A press on a control, or inside a focusable view,
    is unchanged. `focus.ts` (`pressAt`, `precedes`, the start point in `move`),
    `services.ts` (the router's press hook), `outside.ts` (`leafAcross` exported).
32. **A hold or a context menu goes to the nearest view that declares it** (2026-10-17;
    Murmur 7's "hold anywhere on the bubble"; DT: current behaviour was inconsistent with
    pinch). The pressed view used to take every gesture, so a child that took a tap blocked
    its ancestor's `onHold`. Now each of hold and the context gesture resolves up the hit
    chain to the nearest declarer, as pinch already did (`HitTarget.hold`, `.context`;
    `scene-walk.ts` for canvas and the Mac, `dom-backend.ts`), and a hold that went to an
    ancestor suppresses the release's click on the child. Nothing bubbles: each gesture is
    answered once, by one view. `input.ts`; guide 10, View prose.
33. **Focus fixes from the tab-order review** (2026-10-17):
    - the reveal frames the page App by the window (`hostWidth`/`hostHeight`), not its own
      content-tall size — Tab now scrolls a long page to the focused control (`frameExtent`);
    - focus moved by code shows the ring when the person's last input was the keyboard (the
      web's rule) — so an overlay giving focus back a turn after Esc keeps the ring (revises
      #19's "only while a key is being handled"); `Focus.lastInputKeyboard`;
    - focus does not stay on what can no longer be reached: the focused view hidden, made
      unfocusable or disabled, or dropped by an ancestor's `tabOrder()` clears focus after
      the settle, the next Tab starting from where it was (`Focus.reachable` watch);
    - Tab with an overlay holding the keys while focus is outside it (a menu) closes it, as
      Esc would, then moves;
    - an overlay that takes focus and holds nothing focusable focuses itself
      (`Floating.holdFocusItself`), so Tab cannot reach what is behind it;
    - `Combobox` is one Tab stop (its entry).
34. **In a `stop`, the arrows move among the members by default** (2026-10-17, DT: "yes";
    no `grid` — moving by position stays each program's own code, known right for its case).
    The base `onKeyDown` every view has: Right/Down to the next member, Left/Up to the
    previous, wrapping, Home/End to the ends; never with a modifier, never in a text field.
    A member takes the keys it wants and hands the rest to `super.onKeyDown(e)` — inheritance,
    not propagation: no ancestor's handler sees the key (declare.md rule 6 stands).
    `super.onKeyDown` now resolves on any view (`View` lists it among its runtime methods; the
    checker's scaffold makes it a required member). The default lives in the focus module
    (`setKeyDefaultHook`), so a program with no focus carries none of it. `Control` hands on
    what it does not take. `Segmented.roveFrom`, `RadioGroup.step` and `MenuBar.stepTitle`
    are gone (a radio still checks where the arrow lands; a segment that is a place is still
    followed). Programs: the desktop dock's own stepping removed; new stops for the tracker's
    status chips, weather's city lists, the birds quiz's choices and the marketmap's eras.
    The desktop's Files columns keep their own Up/Down (they select and do not wrap, as
    Finder's do).

Library behaviour settled alongside (no language surface): `Segmented`'s arrows wrap at
the ends, as `RadioGroup`'s do, and still move focus without selecting (a radio group
selects on the arrow — the web's, Windows' and ARIA's rule; a segmented control is the
Mac's, Space picks). `Accordion`'s pane drew its own focus edge besides the ring; the ring,
shaped to the header (`focusShape`), is now its only indicator. `Menu` has typeahead (2026-10-17):
letters typed while it has the keys move the highlight to the first row whose label starts
with them (the prefix grows while typing continues, the same letter again cycles, Return still
picks); `typeahead = false` turns it off, as `Combobox` does for its list, whose letters are its
field's. Only menus: a group control's few members gain little from it.

## Programs changed (for review with the merge)

- **`apps/desktop`**: `DeskWindow extends Window` (step 4); the dock is one Tab stop; a Files
  row context menu in the window's layer; minimized windows `paintsIn` the dock's parked
  layer (step 2); **the tracker replaces the Write placeholder in the dock** (DT 2026-10-15,
  "for now"; `WriteApp` kept, out of the roster); the ⌘ registry and dispatch replaced by the
  menu bar's declared shortcuts, and a **hold-⌘ panel** (`ShortcutRow/Line/Head`); the Help
  menu's search is a `TextInput` that is the capsule.
- **`apps/tracker`**: its data resolves through `hostProvided("base")` (so it runs hosted);
  ⌘K and `/` are a `Shortcuts` set (the `typing` fact went with the hand-made guard); uses
  the library `Toast` (step 3).
- **`apps/docs`**: the search pill is the `TextInput` itself (§14 ring shape).
- **`skill/SKILL.md`** (and `.claude/skills/declare`): overlay row names every kind and the
  window; keyboard row names `Shortcuts`; drift check names the hand-built overlay and
  shortcuts as key-test chains. Guide 09 § Keyboard shortcuts, 18 § Overlays that belong to a
  window, 24 (the boundary is transparent) — neutral examples, nothing shaped like an eval.

## Runtime bug fixes found on the way (no semantic change intended)

- `input.ts`: a press with a mouse's secondary button (a right-click) fired `onClick` on the
  view under it as well as the context gesture. It fires no click now, as on the web; the
  raw `onPointerDown` still hears every button. Found probing #32.

- `compile.ts`: a `script` block whose last line ended in a `//` comment lost every name it
  declared — the bindings tail went on that line (the open-list must-fix, also in main).
  Transpiled script now drops comments. Regression test in script-block.test.

- `replicate.ts`: the reconcile attached earlier instances to the parent's stale stand-in
  surface when a later instance (one holding a `TextInput`) brought a deferred parent in
  mid-loop — the first DataGrid column never drew. Regression test in deferred-dom.test.
- `view.ts`: discarding a `paintsIn` guest wrote its constraint-bound `paintsIn`.
- `focus.ts`: the geometry follower was never kept (`this.follower = k` missing), so
  no focus change disposed the last one, and every view that had held focus went on
  pushing its geometry to the ring. **Main has the same bug** (254fad3f); there it
  makes the ring answer stale views. In the overlay, `paintsIn` re-arranging the
  ring's parent on each host change turned it into a settle that never closed
  (Tab through the tracker's header: "afterSettle re-armed"). `view.ts` now also
  re-arranges the parent only when the paint host really moved. Regression test in
  unit.test ("the view that lost focus pushes no more geometry").
- `browser/host-islands.js`: a DOM or canvas island discarded with its window never
  disposed the program it hosted, nor undid the link — **in main too** — so every closed
  desktop window left its program running (clocks, fetches), and, with step 5, its open
  menu holding the keyboard. Now `onDiscard(island)` undoes the link and disposes the app,
  as the Mac host already did on its island surface going (`mac-boot.js`). `onDiscard`
  is exported from `host-api.ts` for it.
- `canvas-backend.ts`: a surface coming home from a host it rode (`travelWith(null)`) was
  inserted at home but never removed from the host — painted twice. The focus ring left a
  ghost in a pane focus moved out of. **In main too.**
- `focusring.declare`: the ring snapped to a control whenever its geometry was delivered
  again for the same control — meant for a target that moves under a resting ring (a
  dragged thumb) — and the follower re-delivers as a focus change settles, so every Tab
  landed the ring instead of flying it. It snaps now only when the target really moved.
  Main has the same rule (`prev == g.view`). Regression test in focus-ring.test.
- `canvas-backend.ts`: the native field of a focused `TextInput` scrolled under a pinned bar
  painted over the bar (its overlay clip knew the scroller's box, not its frame chrome); it
  is now cut where the scroller's pinned chrome covers it, as paint is. **In main too.**
- `dom-backend.ts`: moving an element blurs a focused field inside it, and the blur cleared
  Declare's focus — Tab in a dialog jumped to the page once a sibling re-ordered (the ring
  re-hosting). Moves now keep focus (`keepingFocus`), and a blur a move causes is not
  passed on.
