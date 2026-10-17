# Layers, overlays and focus — the presentation and keyboard system

**Status: DESIGN, for review. Not yet built beyond what §15 lists.** This is the one
design for how a program paints things above other things, which of them take input,
and how the keyboard moves among them — from a tooltip to a window system running other
programs in its windows. It takes in the overlay and focus-ring direction drawn up in
discussion, the focus-scope rules adopted earlier, and the keyboard rules already built
(`keyboard-follows-focus.md`, which stays the record of those two rules). Section numbers
§1, §2, §4 and §7 are cited from the runtime's comments and keep their meaning.

---

## 1. The governing model

### 1.1 The cases a general solution has to cover

1. An overlay traps Tab order.
2. Tab reaches the subviews of an overlay — and of any view — with no developer
   contortions.
3. An overlay over an overlay: a dialog that opens a menu; a dialog that opens another
   dialog.
4. An overlay above everything that takes no focus: a toast, a notification.
5. Windows whose stacking order changes at run time (`apps/desktop` does this today with no
   library support).
6. A view that changes stratum at run time: a minimized window paints above the dock's plate
   while parked, and back among the windows when restored.
7. A transformed window (the desktop's tilt and zoom): its own menus turn and scale with it;
   a system dialog it raises does not.
8. Hierarchical windowing: a window that acts as the "system" for windows inside it,
   including across programs (an `AppIsland` tenant).
9. Floating palettes and inspectors: a stratum above the document windows and below modals,
   non-modal, that focus can enter and leave without trapping.
10. Controls with members — a radio group, a segmented control, a menu bar, a list — that
    take one Tab stop and are navigated inside with the arrows.
11. Surfaces with their own Tab cycle — a program in a desktop window, a pane of a multi-pane
    program — that the keyboard can enter, work inside, and leave again.

Ruled: **no numbered z-order.** Stacking stays implicit — declaration order and paint order
— as everywhere else in Declare.

### 1.2 What a program writes

Everything this document designs reaches a program as a handful of things, most of them
already familiar. The rest of the document — contexts, strata, modality — is the model the
implementation is built on, and those words stay out of the reference and the guide.

| A program writes | When |
|---|---|
| `tooltipLabel`; `Menu`, `Popover`, `Dialog`, `Sheet`, `Toast` (§3.3) | Ordinary programs. Each lands where it belongs, takes focus or not, animates in and out, and closes as its kind does. |
| `Window` | A program with windows. A window places its own menus and holds its own Tab cycle. |
| `focusScope = stop`, `capture`, `region` or `modal` | A container that changes what Tab does at its edge (§13). |
| `outsidePress`, `scrollBelow` | Overriding what an overlay does with a press or a scroll aimed past it (§8.1). |
| `paintsIn = { someView }` | The expert case: a view that draws somewhere other than where it is declared — the desktop's parked window, a palette (§3). |
| views declared in order | The expert case's layers are views like any other — the desktop's `windows`, `dock` and `palettes` — stacked in the order they are declared. |

### 1.3 Four concerns, kept apart

Every overlay API we know tangles four things. Kept separate, each case above is a
combination of small mechanisms instead of a special case.

| Concern | Question it answers |
|---|---|
| **Paint** | Where in the stacking order does it draw, and does it escape its ancestors' clips? |
| **Focus** | Where can focus go — the Tab cycle, trapping, restoring, entering and leaving? |
| **Input** | What happens to presses and scrolling aimed at what is underneath? |
| **Ownership** | Who owns it, how long does it live, how does it close? |

A dialog sets all four; a menu sets all four with different values; a toast sets only paint;
desktop windows set paint and ownership and reorder at run time; the parked window is purely
a paint case; a program in a window is purely a focus case.

### 1.4 The model: contexts and strata

This is the implementation's vocabulary, not a program's: the App and a `Window` are contexts,
and the views a program declares in order are their strata.

A **context** is what an operating system calls a screen or a window. It carries:

- its **strata** — the overlay layers it offers its descendants;
- a **focus root** — the scope that traps trap within;
- a **modality boundary** — "inert beneath" applies within it;
- a **coordinate frame** — positions and transforms are measured in it.

**The App is the root context.** A library `Window` is a context. Ordinary programs have only
the App and see no change.

**The recursion property:** a context offers its children exactly the interface the root
offers. A window inside a window is a context inside a context, with nothing special at the
second level, and a program asks for "my context" without knowing whether that is the App, a
window, or a host three islands up. (Precedent: Plan 9's window system, rio, runs inside one
of its own windows because it serves its windows the interface it gets from the screen; also
Smalltalk's Morphic, X11's nested windows — whose menus are the instructive exception, placed
at the root — and Windows MDI.)

**Strata are views; their order is declaration order.** A context's strata are ordinary views
declared in order — on the desktop's App: `content`, `windows`, `dock`, `overlays`, `notice`.
Every App has implicit default strata, empty until something manifests into them and never
declared in ordinary source:

```
content   — the App itself (today's entire world, unchanged)
overlays  — menus, popovers, tooltips, dialogs, sheets, in the order they open
notice    — toasts; above everything; never takes focus
```

Transient and modal overlays share one stratum on purpose: a menu opened from a dialog must
paint above that dialog, and a dialog opened over a popover above the popover — entry order,
which separate floating and modal strata would break.

A layer-shaped program (a desktop) declares additional strata as named members — the expert
tier. Strata are members of the one App (or of a `Window`), never peer declarations: one
`location`, one `width` and `dark`, one fact-space.

**Order is an ordinary slot.** Within a stratum, stacking is tree order for things that are
always there and **entry order** for things that come and go (a menu opened from a dialog lands
above the dialog because it opened later — the browser's top layer works the same way).
Explicit reordering is a verb (`raise()`, which re-links a view among its siblings) or data
order (the desktop's window records, whose order is their paint order) — never a number.

**No isolation.** Strata govern paint order and input — nothing else. One scope space, one
reactive graph: a dialog's attribute may constrain against a content element; the dock may
magnify from the pointer's position over content. Strata are presentation, not ownership.
(Contrast: iframes wall this off; React portals strain context across.)

## 2. Visibility: the authoring tiers

The layer system is deliberately near-invisible. The authoring surface is the same ladder as
everything else in Declare:

1. **An attribute** — `tooltipLabel = "Saves the draft"`. The floor, and the acid test: if a
   tooltip costs more than one attribute, the design failed.
2. **A component** — `Menu [ items = … ]`, `Dialog`. The component manifests into the right
   stratum; the author sees records and verbs.
3. **A service verb** — `app.notify("Saved")` → the notice stratum's queue.
4. **Views declared in order, and `paintsIn`** — the expert move, for layer-shaped programs
   (windows, a desktop). The only tier where layering shows in source, and it shows as
   ordinary views.
5. **The create-API** — imperative instantiation into a stratum (§7).

Developers see the layering in tooling: `inspect()` shows what each window and the App hold
above their content, and what is manifested in each. Visible in the debugger, absent from typical source.

## 3. Paint: `paintsIn`, and `Floating` over it

### 3.1 `paintsIn` — the paint parent separate from the logical parent

```
paintsIn = { app.overlays }
```

A view's **logical parent** (where it is declared: whose state it reads, who owns and discards
it) and its **paint parent** (where it draws and is hit) can differ. The default is the
logical parent, so every existing program is unchanged. The value is a **reference to a
view**, never a number, and it is reactive: changing stratum is an assignment.

The parked window:

```
paintsIn = { this.miniT > 0 ? app.dock.parked : app.wins }
```

where the dock declares `parked: View [ … ]` between its plate and its icons, giving free
windows < plate < parked windows < badges. Nothing else solves this case: a stacking number is
ruled out; `raise()` cannot hold a plate inside a replicated block, which re-links
contiguously on every insert, move or removal; two window blocks rebuild a window, and restart
its program, whenever it crosses between them; cutting holes in the plate couples its drawing
to the parking geometry.

`travelWith`, which already re-hosts a surface on all three backends, is an instance of
`paintsIn` and is retired into it.

**The portal door.** Only a view that says so paints outside its declaration site, and it says
so at the view, in the source: the reader is never misled about where a box sits. The door
opens to this one explicit, slot-valued spelling.

### 3.2 `Floating` — the library base over it

The library base (beside `Control`) for transient overlays. A `Floating` is a presentation
member: declared where it belongs (inside its owner — a button's menu, an App's dialog),
following the `Spring`/`State`/`Dataset` precedent of members whose brackets are not painted
boxes. Closed, it is a small dormant node with no view tree. Its contract, written once:

- **Stratum election** — per class: `Tooltip`, `Menu` and `Popover` → floating; `Dialog` and
  `Sheet` → modal; `Toast` → notice (§3.3). A class-level fact, not a use-site choice: a
  program's own overlay class gets its kind by extending one of these — `class Viewer extends
  Dialog [ … ]` — and fills it with its own children. Which context's stratum is the nearest
  context's (§11).
- **Presence** — a slot (`opener: View? = null`, or `open`), written by verbs
  (`openAt(view, e)`, `close()`), derivable by constraint.
- **Manifestation** — at open, the surface is built into the stratum (from item records, or
  from its children) and torn down after it closes: a thousand rows share one dormant menu node
  and no menu views.
- **Motion** — an overlay animates in and out, and **stays built until its closing motion
  lands**: closing clears its open state at once (it stops taking input, and the stack of
  open overlays moves on), and the teardown waits for the motion's arrival — the `onArrive` of
  the spring that carries it. Each class has a default motion (a sheet slides from its edge, a
  popover scales from its anchor, a dialog fades and scales, a toast slides and fades), drawn
  from theme tokens; a program changes it as it changes any attribute.
- **Anchoring** — to a view's live box, mapped into the stratum's frame (§11), or to a point
  from an event (the context-menu case). Edge flip and clamp written once.
- **Dismissal and input policy** — §8.
- **Focus policy** — §13: a menu is a `stop` scope that takes focus; a dialog is `modal`; a
  tooltip and a toast never take focus.
- **Material** — scrim, shadow, translucency from theme tokens (`scrimFill`, `planeShadow`,
  `planeMaterial`), so each theme's overlay look is data. Canvas approximates blur honestly
  (dim without blur).

### 3.3 The library's overlays

A program is never asked to build an overlay from views: the library carries the objects that
the established platforms converge on, each on the `Floating` contract.

| Class | What it is | Kind | Content |
|---|---|---|---|
| `Tooltip` | a label for a view, on hover or long press | floating | `tooltipLabel` (one attribute) |
| `Menu`, `ContextMenu`, `MenuBar` | commands, anchored to a control, a point, or a bar | floating | item records (§4) |
| `Combobox` | a field with a list of choices | floating | records |
| `Popover` | a bubble anchored to a view; closes on an outside press; follows its anchor; becomes a `Sheet` on a phone | floating | its children |
| `Dialog` | a modal centered over its context; optional title and button records; a full-screen presentation (a viewer, a lightbox) | modal | its children |
| alert verbs on `Dialog` — `ask`, `notice`, `error` | an alert: a title, a message, buttons | modal | records |
| `Sheet` | a modal panel attached to an edge (`bottom`, `end`); floating on a wide screen and a bottom sheet on a narrow one, by default; swiped away on touch; modal to the window it opens from | modal | its children |
| `Toast` | a transient message with an optional action; takes no focus | notice | text and an action record |

How they line up with other systems:

- **Popover** — Apple's `NSPopover` and SwiftUI's `.popover` (which become a sheet on iPhone),
  GTK's `GtkPopover`, WinUI's `Flyout`, the web's `popover` attribute, Radix and MUI's Popover.
- **Dialog** — Apple's sheet or panel with your own view, Material's dialog and full-screen
  dialog, WinUI's `ContentDialog`, libadwaita's `AdwDialog`, the web's `<dialog>`. The alert —
  `NSAlert`, `UIAlertController`, Material's alert dialog, `AdwAlertDialog`, ARIA's alertdialog
  — is its most common use, so it stays a set of verbs on `Dialog` rather than another class.
- **Sheet** — the macOS sheet (attached to its window and modal to it alone), the iOS sheet (a
  card rising from the bottom), Material's modal bottom and side sheets, libadwaita's
  `AdwBottomSheet`, shadcn's Sheet and Vaul's Drawer on the web. libadwaita's `AdwDialog`,
  floating when there is room and a bottom sheet when there is not, is the model for its default.
- **Toast** — Material's snackbar, `AdwToast`, WinUI's app notification, the web's status
  region and toast libraries.

Not classes of their own, because they are presentations of these: an **action sheet** is a
`Menu` presented as a `Sheet` on a phone (as Apple does); a **full-screen cover** is a `Dialog`
presentation; a **coach mark** is a `Popover` that stays until acknowledged; a **command
palette** is a `Dialog` holding a `Combobox`. A **navigation drawer** is a layout question
(`ResponsiveLayout`), not an overlay.

**Why these, and not views.** A program that builds its own overlay from a full-window view
shown by a flag gets none of what the classes carry: Tab stays outside it, presses fall through
it unless it swallows them, its position is a snapshot that does not follow its anchor, Esc is
a chain the program keeps by hand, and its closing motion has to be held open by a visibility
threshold. That way stays legal — the design changes no default — but the skill points every
overlay need at these classes (§16).

## 4. The component shape: records, and the one-line criterion

Ruled: **no component may require datasets or `:path`** — data remains the optional top rung
of the ladder (literal → binding → `:path`), for values and for structure. The shape question
resolves to one rule:

> **If a component arranges it, it takes records (with named classes for custom content). If
> you arrange it yourself, it isn't a component — it's views, SimpleLayout, and replication.**

- Menu, Select and Combobox items, toolbar items, list and table rows: records. Every native
  platform's menu is records (`NSMenuItem`, `UIAction`, `MENUITEMINFO`); UITableView's
  register-a-cell-class-by-name is the record door at OS scale. The component owns arrangement
  and rendition — which is what makes per-theme fidelity airtight.
- Dialog bodies, window interiors, tab panes: children (regions the author arranges).
- Replication remains the data door for author-arranged content — visible template, eager
  instances. Records are the data door for component-arranged collections — no template at
  the use site, lazy build at open.

**The standard menu-item record** is closed: `{ id, label, icon?, key?, enabled?, checked?,
divider?, submenu? }` — real OS menus (icons, disabled items, separators, key equivalents,
cascades) with no custom anything. The customization staircase:

1. Standard records — most menus, cascading submenus included.
2. **Per-item content class** — `{ kind: "SignatureItem", … }`: the component instantiates
   the named class as the row's content, record as its data context. Behavior stays the
   component's: the row owns highlight, pick and keyboard; content classes render, never
   behave (AppKit's `NSMenuItem.view` makes the same split).
3. Custom row class — subclassing the row base, behavior included. Expert.

Literal item arrays are compile-checked (record keys against the item schema; `kind:` names
against known classes); data-fed items fail loudly at run time.

## 5. Worked example 1 — replicated rows and a per-row context menu

One menu declared at App level (one context menu exists, as on every OS); rows carry one
handler line, stamped by replication; the `opener` back-reference binds:

```
rowMenu: Menu [
    items = { opener == null ? [] : [
        { id: "open",   label: "Open " + opener.name },
        opener.locked ? { id: "unlock", label: "Unlock" }
                      : { id: "lock",   label: "Lock" },
        { divider: true },
        { id: "delete", label: "Delete", enabled: !opener.locked },
    ] },
    picked(id) { opener.perform(id) },
    ],

// inside the replicated row template:
onContextMenu(e) { app.rowMenu.openAt(this, e) },
```

Per-row variation with no per-row instances: `items` is a constraint over `opener`, live even
while open. Behavior routes back to the row, which holds its own datapath cursor. `opener` is
declared on the Menu base, written by `openAt`, nulled on dismissal; open is
`opener != null`.

## 6. Worked example 2 — the menu bar

A content-stratum component (it arranges titles → records) whose dropdowns manifest in the
floating stratum. Static and data-driven parts interleave in one constraint:

```
bar: MenuBar [
    menus = { [
        { title: "File", items: [
            { id: "new",  label: "New",   key: "⌘N" },
            { label: "Open Recent",
              submenu: app.recent.map(f => ({ id: "r:" + f.path, label: f.name })) },
            { divider: true },
            { id: "save", label: "Save", key: "⌘S", enabled: app.dirty },
        ] },
    ] },
    picked(id) { app.command(id) },
    ]
```

Bar menus have no external invoker; `opener` stays null. The `menus` constraint re-derives
whole on any tracked read — right at menu scale, wrong for large data feeds, whose answer is
lazy build at open.

## 7. Imperative creation

Real programs create views imperatively. The primitive: create-by-class into a stratum (or a
parent), instance returned, opener wired as an ordinary typed attribute — `createView`, over
the registry's tag→class table and the `use [ … ]` keep-list. Replication is built on it
internally. Lifecycle: a spawner's discard dismisses what it spawned; a dismissed handle is
inert.

## 8. Input, modality and dismissal

Input is resolved in the router, top stratum first — a walk over strata, not bubbling. This
closes the click-outside family at the stratum where it is actually about layers.

- **Modality:** the topmost modal scope makes everything beneath it in paint order inert — to
  the pointer and to focus — **within its context**. A dialog modal to an outer window makes
  that window inert, inner windows included; a sheet modal to an inner window leaves the outer
  one live.
- **Light dismiss** walks the same stack: a press outside the top dismissible overlay applies
  that overlay's `outsidePress`.
- **The notice stratum** is exempt from inertness: it stays interactive above a modal, takes
  the pointer only over its own content, takes no focus, and announces politely to assistive
  technology.

### 8.1 Policy per kind, overridable

There is no single convention to copy: native menus swallow the outside press; Radix and
Material dropdowns block it; the browser's popover API delivers it. macOS distinguishes menus,
which are modal while open (they take all of the program's input, scrolling included, and an
outside press only closes them), from transient popovers, which close on outside interaction
while the program keeps working — inferred from AppKit's settings, and to be confirmed by
testing before it is cited as precedent.

So each class states its default and the instance may override it, as two ordinary
attributes:

- `outsidePress`: `dismiss` (swallowed) · `dismissAndDeliver` · `block` · `ignore`
- `scrollBelow`: `block` · `allow` · `dismiss`

| Kind | outsidePress | scrollBelow |
|---|---|---|
| Menu, context menu | `dismiss` | `block` |
| Popover (share-style, picker, info) | `dismissAndDeliver` | `allow` (follows its anchor, or closes if the anchor leaves) |
| Dialog | `block` (closes by its own buttons or Esc) | `block` |
| Toast | `ignore` (passes through) | `allow` |
| Tooltip | `dismissAndDeliver` | `dismiss` |

## 9. Keys — raw delivery and shortcuts

Two channels, kept separate.

**Raw delivery is program-scoped** (built; `keyboard-follows-focus.md`). The keyboard program
is the program whose tree holds the focused view — through an island into its tenant — or the
top-level program when nothing is focused. Only it receives `Keys` events, `onKeyDown` and
`isDown`; when it changes, the old one sees every held key released. A polled key loses its
browser default while a shown view in the keyboard program polls it. Focus decides; this
document only decides how focus moves (§13).

**An open overlay's keys are its own.** While an overlay is open, the keys it uses — Esc, and
for a menu or list the arrows, Enter and Space — go to it and are not also delivered to the
program's `Keys` members (today `keys.overlayOwns` withholds them only from the focused view).
So one Esc closes the open popover and does nothing else; the program's own Esc, for a
navigation of its own, runs on the next press, when nothing is open. This follows from modality
(§8): an open overlay captures input, the pointer's and the keys it uses alike. Nothing else
withholds keys: a `Keys` member hears keys whatever has focus — a focused text field included —
and a program whose single-key shortcuts should not fire while someone types reads where focus
is (a reactive focused-view fact, from the focus follow-up; not part of this design).

**Shortcuts are declared data with user-facing labels** (the Newton model, revived by iPadOS's
hold-⌘ panel): records — combo, label, action — declarable on any view or the App, resolved by
walking from the focused view up its ancestors, through each tenant link into the host, nearest
declaration wins. Like Tab traversal this is a walk over declared facts, not event
propagation. A menu item's `key:` field is a shortcut declaration, so the menu bar is the
shortcut table; the hold-⌘ panel lists the resolved set, grouped by origin. The walk calls only
the nearest registrant, so it can reach a host's shortcuts without reopening the raw stream to
the host. `apps/desktop` proves the shape at program level today: the registry is one
constraint over its menu-bar records, a `Keys` member dispatches against it, and the hold-⌘
panel derives from the same array. Browsers reserve some chords outright (Safari keeps ⌘N and
⌘W), so a shortcut must be able to stand as displayed truth where the host refuses delivery.

**Built (step 7, 2026-10-15).** `Shortcuts [ items = { [ ({ id, key, label }) ] }, picked(id) { … } ]`
declares a set on the view it sits in (or `on`); `Keys` resolves a press from the focused view
outward, through islands into hosts, and the nearest set declaring the key takes it — no
`Keys` member also hears it. A `MenuBar`'s items are its program's set. Plain keys stand down
in a text field; everything stands down while an overlay holds the keyboard.
`Keys.shortcutsInForce()` is the resolved set and `onCommandHeld(on)` tells every program when
the command key is held alone — the desktop's hold-⌘ panel uses both, and lists a hosted
program's own shortcuts ahead of the desktop's.

## 10. Extraction, crawl, verification

Overlays are ephemeral: absent at first render, excluded from the crawled document by
construction (the `visible = false` rule). A dialog whose content should be crawlable is
mis-modeled — that content is a location. Verify walks every context's strata as it walks the
App; `inspect()` shows them.

## 11. Coordinates, transforms and the real `Window`

- A view's position is in its **paint host's frame** (what `travelWith` already does).
- **An overlay lives in the frame of the stratum it paints in, and its ownership decides which
  stratum that is.** Something that belongs to a window — its menu, a popover, a sheet — paints
  in that window's stratum: it turns and scales with the window and escapes the window's clip.
  Something that belongs to the program or the system — an app-modal dialog, a toast — paints
  in a root stratum, in screen space.
- **Finding the stratum is a provided-value lookup:** the App provides `overlays`; a `Window`
  provides its own; a `Menu` paints into `provided("overlays")` and lands in its window's with
  no code. A system dialog names the root explicitly.
- **An overlay is kept inside the outermost App, not the window it belongs to.** A menu opened
  in a window may hang past the window's edge, and is flipped and clamped only to keep it on the
  screen — the outermost App on the page, or the host a program is embedded in — as a macOS menu
  may leave its window but not the display. In a transformed window the clamp uses the menu's
  box mapped to screen space. (Today `Menu.place` clamps to its own program's App: right for a
  menu declared on the App, but a program in a desktop window clamps to the window's content,
  and a menu declared inside a window paints inside the window's clip.)
- **Which transform an overlay shares** (ruled 2026-10-15). A transform is either *where a
  surface is* — a window tilted, scaled, minimizing; a whole program shown shrunk in a page —
  or *how content is presented on it* — a zoomed canvas, a card mid-flip. An overlay shares
  the first and not the second: it paints in the nearest context's layer (which brings that
  context's transform) and, when that layer is a host's, adds its own program's scale and turn
  relative to it; transforms inside its own program, between its anchor and its `App`, reach
  only its position. A program that wants an inner transform shared declares a context there.
  Precedents: where interactive programs are shown scaled — iPhone apps at 2× on iPad, the
  Simulator, visionOS windows in space — their menus and alerts go with them; where content is
  zoomed inside a program — Figma, Maps, Keynote — menus stay at the program's scale.
- Precedents: Unity's UI canvases (screen space vs world space); macOS sheets, attached to and
  moving with their window, vs app-modal alerts centered on the screen; zoomable canvases
  (selection handles in canvas space, context menus in screen space). The web arrived at
  "overlays ignore transforms" by accident — portalling to `<body>` was the only way to escape
  clipping.

**A real `Window`** does not clip itself; its content pane does, and its overlay stratum is a
sibling after the pane:

```
Window [ content: View [ clip = true, … ], overlays: … ]
```

A menu hanging past the window's edge is then a view in an unclipped part of the window — no
`ignoreClip`. (The desktop's `Window` today clips itself and puts its resize halo outside with
`ignoreClip`.)

## 12. Islands and hierarchical windowing across programs

How tenants mount today:

- **Canvas and Mac:** the tenant's App attaches to the host's backend with the island's surface
  as its parent. The tenant's views are a subtree of the host's display tree; one hit walk;
  each surface carries its own program's input sink.
- **DOM:** each tenant gets its own `DomBackend`, rendering into the island's element
  (`overflow: auto` — the clip, and panning for a tenant that holds a minimum size). Each
  program's router owns the events inside its root element; the outer router stops at an
  embedded root.

**Direction:** the island provides the host's strata; the tenant's nearest-stratum lookup falls
through its own root to them, as `hostProvided` already crosses for values. A tenant view
stays in the tenant's program (state, constraints, owner, lifetime) and paints in the host's
stratum, its coordinates mapped through the island's frame. What it takes:

1. **Coordinates** — map the tenant view's frame into the stratum's through the island's
   transform chain.
2. **Input on the DOM** — routers find an event's owning program from the element itself
   rather than its DOM ancestry; **or the DOM mounts tenants on the host's backend**, as canvas
   and Mac do. The second is the bigger decision and probably the better one ("a tenant is a
   subtree" everywhere). Its two DOM problems to solve: a tenant's `#fragment` links must not
   become false native anchors, and panning an oversized tenant.
3. **Lifetime** — a host discarding its stratum, or the island unmounting, withdraws every
   foreign view painted there.
4. **Modality** — whether a tenant's modal dialog in the host's stratum also makes the host
   inert (modal to the island's window, or to the whole host). Stated by the protocol.
5. **Focus** — the island boundary is transparent to traversal (§13.5).

**Built (step 5, 2026-10-15).** An `AppIsland` passes the overlay layer down by default: a
hosted program's overlays open in the nearest `overlays` up the whole chain, crossing every
island, and take the program's scale and turn relative to it; with no context above, they stay
in the program. `containOverlays = true` keeps them in the island's box. This is not a
security boundary — a hosted program runs in its host's realm and could already draw anywhere —
only a design choice the island can reverse. Coordinates: `View.transformTo(other)` composes
through the islands (1). The DOM mount decision (2): tenants keep their own `DomBackend`; a
tenant view painting in a host layer is re-hosted there and found by the host's hit walk among
the layer's paint guests, so no remount was needed. Lifetime (3): the island's unlink withdraws
the program's paint guests, open overlays and keyboard claims, and a discarded island now
disposes its program in the browser host as it did on the Mac. Modality (4): blocking is per
context, so a hosted program's dialog holds back its own window only.

`DOMIsland` (foreign DOM, not views) stays outside this — not for security (its content also
runs in the page's realm), but because foreign DOM is not views and cannot paint in a layer: a
cross-boundary overlay is a **service** — the tenant asks with data, the host builds and owns the dialog, the choice comes
back (the island bridge's `post` and exposed methods). A web page likewise cannot draw over the
browser's chrome and calls `alert()` or a file picker; a sandboxed Mac app's open panel is drawn
by a separate process.

## 13. Focus navigation

### 13.1 Two dimensions, and what other systems do

Keyboard navigation has two separate questions, and every mature system answers them with two
separate mechanisms:

1. **What Tab does at a container's boundary** — passes through it, treats it as one stop,
   wraps inside it, or stops at its edges. WPF states it per container as
   `KeyboardNavigation.TabNavigation` (`Continue`, `Once`, `Cycle`, `Contained`, `Local`,
   `None`); Swing makes a container a *focus cycle root* (every window is one); Flutter gives
   each traversal group an edge behavior (closed loop, leave to the parent scope); ARIA's
   composite widgets (radio group, toolbar, menu bar, listbox, grid, tree) are one Tab stop
   with arrows inside, and remember the active member. The web flattens nested documents: Tab
   walks into an iframe's content and out of it again, in document order.
2. **How to get between top-level surfaces** — a second, coarser key, because a surface that
   cycles Tab inside it needs a way out that belongs to no program: F6 / Shift-F6 between
   panes on Windows and GTK (and in VS Code), Ctrl-F6 between documents in Windows MDI;
   Cmd-` between a program's windows and Ctrl-F6 to a floating window on macOS, with
   Ctrl-F2 and Ctrl-F3 moving focus to the menu bar and the Dock; Meta-Tab between keyboard
   navigation clusters on Android. Inside a window, Tab never leaves it — on macOS the key
   view loop is per window.

So "entering" and "exiting" a Tab cycle is a solved problem in desktop systems, solved the
same way everywhere: a window (or pane) owns a cycle; Tab stays inside it; a dedicated key and
the pointer move between them. What nobody ships is the uniform rule across all levels —
composite control, pane, window, program in a window — and Declare can, because the view tree
already is the hierarchy.

### 13.2 The scope tree

**Tab order is a walk of the logical tree** — depth-first over focusable views, skipping hidden
and inert ones, each view's `tabOrder()` deciding the order its members are walked (default:
its visible children in source order) — never paint order and never per-container bookkeeping.
A class nested anywhere joins the order without doing anything.

**Focus is a tree of scopes over that walk.** The App is the root scope. A view becomes a scope
with one attribute, **`focusScope`**, whose value says what Tab does at its boundary:

| `focusScope` | Tab arriving | Inside | Tab at its edge | Esc | For |
|---|---|---|---|---|---|
| *(absent)* | walks straight in | its stops are its parent's | walks straight out | — | every ordinary container |
| `stop` | lands on it as **one stop** | arrows move among members; Enter or F2 enters a member's own scope (an editor, a cell's widgets, an opened row) | the next Tab leaves | backs out of a member's scope it entered (ends the edit) | radio groups, segmented controls, menu bars, toolbars, lists, tables, grids |
| `capture` | descends to its first stop | Tab walks its stops; Enter is the scope's | walks straight out (Shift-Tab out of the first stop, backwards) | ends an edit in progress | entry grids, forms |
| `region` | lands on it as **one stop** at its parent's level; Enter enters | Tab **wraps** inside it | never leaves by Tab | — never leaves a region (§13.3) | windows, panes, a program in a window, palettes |
| `modal` | — (opens with focus inside) | Tab wraps inside it | never leaves by Tab | closes it, where its own semantics allow | dialogs, sheets |

`modal` is also the input modality of §8 (inert beneath, within its context); it replaces
`focusTrap`. Modal scopes form a stack in entry order, so dialog → dialog → menu unwinds
correctly, and each one's opening records where focus was and its closing restores it.

**A scope remembers.** Re-entering a `stop` lands on its active member — the selected one for a
selection control, else the last one focused, else the first. Re-entering a `region` restores
the view that last had focus inside it, else its first stop — as a macOS window keeps its first
responder. The pointer enters a scope directly: a press on a focusable view inside a region
focuses it, and the region is entered.

**Tab moves among the stops of the current scope; Enter (or F2) enters the member under focus
when it has a scope of its own; Esc closes what was opened.** The keyboard trap is impossible
by construction: a `modal` scope is left by its own completion or Esc, and a `region` by the
region keys (§13.3) — never a key a program can take for itself.

### 13.3 Esc closes; the region keys move between regions

**Esc closes or cancels the innermost thing that is open** — a menu, a popover, a dialog, an
edit in progress, a member scope entered with Enter — and nothing else. That is the meaning it
has on every platform, so a program's own uses of Esc and the system's never compete for it.
Esc never leaves a region: in a program in a window, Esc closes the program's menu or cancels
its edit, as the program intends, and the program stays where it is. Clearing a selection is not
Esc's either (`selection-model.md` §4).

**Leaving a region is a different act, with its own keys** — the second mechanism of §13.1:

- **next region / previous region** — F6 / Shift-F6 where the host delivers them, moving among
  the regions of the nearest enclosing context (windows, the menu bar, the dock), as Windows
  and GTK move among panes and macOS among windows. No program can take them. In a native host
  (the Mac app) F6 is ours. In a browser F6 belongs to the browser on several platforms (it
  moves focus to the address bar), so the browser host needs a chord the browser leaves to the
  page — measured on each engine before one is chosen (§18). Because it is the only keyboard
  way out of a region, the browser host must have one.
- **the program's own commands** — the desktop's window menu (cycle windows, a window list)
  moves between regions as any command does.
- **the pointer**, always.

### 13.4 The desktop, and a program in a window

`apps/desktop` declares its windows as regions, its menu bar and dock as `stop` composites, and
nothing else. Then:

- **At the desktop level** — with no window entered — Tab moves among the menu bar, the
  windows (front to back) and the dock, each one stop, the window under focus framed by the
  ring. Enter enters a window; arrows inside the menu bar and the dock move among their items.
- **Inside a window** — Tab wraps among the window's own controls and the stops of the program
  running in it, as one cycle. Tab never leaves the window, as on macOS. Esc is the program's.
- **Out of a window** — F6 to the next window, the menu bar or the dock (Shift-F6 back); a
  window command; or a press elsewhere.
- **Bringing a window to the front** — by a press, by F6, or by the desktop's own commands —
  enters its region and restores its focus. This is the same act as `keyboard-follows-focus.md`
  §6's "a window that comes to the front takes the keyboard": entering the region moves focus
  into the window's program, so it becomes the keyboard program.

The tracker in a desktop window, then: a press on the tracker focuses what was pressed; Tab
cycles through the tracker's toolbar, list and editor and the window's own controls; Esc closes
the tracker's menus and cancels its edits, as it does when the tracker runs alone; F6 moves to
the next window (or the menu bar, or the dock), and coming back to the tracker window — by F6, a
press, or a window command — returns to the control that last had focus.

### 13.5 Programs inside programs

**An island is transparent to traversal.** A tenant's stops take its island's place in the
host's walk, as an iframe's content does in a page: Tab walks into the tenant at its first stop
and out after its last. The keyboard program follows focus across the boundary (§9) with no
further rule. Whether the tenant is a cycle of its own is the host's choice, made by the scope
around the island, never the tenant's:

- **In a page** — the homepage's article and live demos, the docs previews, the Viewer —
  nothing is declared: Tab passes through each embedded program and on to the page's next
  control. (Today Tab inside an embedded program cycles within it and never comes out —
  `focus.ts` groups traversal by program — which is a keyboard trap; this design removes it.)
- **In a window** — the window is the region; the program's stops are part of its cycle
  (§13.4).
- **A tenant with no stops of its own** — Asteroids, whose App is focusable — is one stop.

A tenant's own `modal` scope traps within the context it paints in (§11), so a dialog a tenant
raises in its window's stratum keeps Tab inside the dialog, and the host stays live outside
that window unless the island protocol makes it modal to the host (§12.4).

**The top-level App** is a region: Tab wraps within the program, and the browser's own keys
reach the browser's chrome. A program embedded in an ordinary web page takes no keys until it
is given focus (as built) and, once focused, passes Tab out at its edges to the page.

### 13.6 Controls with members

A **container control** is a control whose members a person moves among. Every one in the
library is a `stop` scope — one Tab stop, arrows inside, the active member remembered — instead
of each making its own choice. They differ only in where focus sits while the arrows move, and
the ARIA practice names the two ways:

- **Roving** — focus itself moves to the member (the member is focused; the ring is on it).
  For members that are controls in their own right: radios, segments, menu items, toolbar
  buttons, menu-bar titles.
- **Active member** — the container keeps focus and marks one member active (the ring frames
  the active member's box). For members that are records: rows of a list or table, cells of a
  grid. It is what lets a virtualized collection work — the active row need not exist as a view
  until the container reveals and builds it.

| Control | Way | Tab stop | Arrows | Activation; Enter |
|---|---|---|---|---|
| `RadioGroup` | roving | the checked radio, else the first | move **and check** (ARIA, Windows, GTK, macOS) | — |
| `Segmented` | roving | the selected segment, else the first | move focus; a `Segmented` that switches views (its segments are links to locations) **selects on arrow**, as a tab bar does | Space, Enter |
| `MenuBar` | roving | the last-used title | Left/Right among titles; Down opens | Enter, Space, Down open |
| `Menu` (open) | roving | takes focus on open; restores its opener on close | Up/Down; Right opens a submenu, Left closes it | Enter, Space pick; Esc closes |
| Toolbars | roving | the last-focused item | Left/Right | the item's own |
| `Table` (a list: the tracker's issues) | active member | the table | Up/Down move the active row; Shift extends, ⌘ walks, Space toggles (`selection-model.md`) | Enter opens the active row when the row has a scope of its own (§13.6.1) |
| `DataGrid` | active member | the grid | all four arrows move the active **cell**; Home/End, ⌘ for the row's ends and the grid's | Enter or F2 edits the cell; typing starts an edit (§13.6.2) |
| `Combobox` | — | the field | Up/Down in its open list | Enter picks; Esc closes the list |

Not container controls: an `Accordion` (each pane header is a Tab stop and an open pane's
contents follow it in the walk — the ARIA accordion convention); a `Dialog` (a `modal` scope);
a `Window` (a `region`).

#### 13.6.1 A list whose rows hold controls

The tracker opens an issue in place: the row grows into an editor card with text fields, inside
the list. Under the model the opened row is a member with a scope of its own. The list is one
Tab stop; Up/Down move among rows; Enter opens the active row and enters it, focus on the card's
first field; Tab walks the card's fields; Esc (or the card's own Close) closes the card and
returns focus to the list, on that row. A row's controls are never stops in the walk past the
list — so Tab from the list goes to the next control after it, however many rows are open.

#### 13.6.2 The grid

`DataGrid` follows the ARIA grid pattern, with the spreadsheet's keys where the two agree:

- **Navigating** — the grid has focus and an active cell; arrows move it in two dimensions.
  A checkbox cell toggles with Space without being entered; a select cell opens its menu with
  Enter or Space.
- **Editing** — Enter, F2 or a typed character enters the active cell: focus moves into the
  cell's widget (a typed character becomes its first character). Esc cancels the edit and
  returns to navigating, on the same cell. Enter commits and moves down a row; Tab commits and
  moves right — the spreadsheet's keys.
- **A cell with several controls** (a cell class may hold a field and a button) — Enter enters
  the cell, Tab moves among the cell's own controls, Esc returns to navigating.
- **Tab at the grid's level** — a browsing grid (`focusScope = stop`, the default) is one stop:
  Tab leaves it. An entry grid (`focusScope = capture`, the tax form) takes Tab cell to cell,
  editing each, and leaves after the last cell (Shift-Tab before the first).

**Cells as classes.** Each cell is a class: the grid replicates one `GridCell` per column record
and `classFor` builds it as the class its column's `kind` names — `TextCell`, `EditCell`,
`CheckCell` or `SelectCell` — so a cell builds only its own presentation. The row wires itself
into each cell (`row`), and a cell reads the row's record and writes through it. A cell's
focusable members are the cell's scope. Rows take `classFor` too (a `GridRow` subclass per kind
of record, as the tracker's list does with `GroupRow` and `IssueRow`).

A program's **own** cell class is the open part (§18): `classFor` names classes the checker can
see from where it is written, and the grid's is written in the library, so a `Column` needs a way
to name a program's class that the checker holds to `GridCell` — not a class name in a string.

**Today** `RadioGroup` and `Segmented` make every member its own Tab stop (`Segmented` also
roves with the arrows); `Menu` and `MenuBar` handle arrows in their own `onKeyDown`; `Table`
already keeps focus and moves an active row, but its rows' controls are also stops in the walk;
`DataGrid`'s arrows move rows, and every edit, check and select cell is its own Tab stop. Each
becomes a declaration of its scope kind, and the arrow handling a `stop` scope needs moves into
the scope's protocol rather than each class's handler.

### 13.7 The focus service

`Focus` stays the single owner of where the keyboard is. It gains the **scope path** — the
scopes containing the focused view, root to innermost — and per-scope memory (§13.2). The
sequence for a Tab is computed live over the current tree, as now, but per scope: a `stop` or
`region` is one entry in its parent's sequence; a `capture` scope's stops and an island's
tenant's stops are spliced in; a `region`'s or `modal`'s own sequence wraps. Hidden, inert and
discarded views drop out as they do today, and discard moves focus to a survivor in the same
scope first, then outward.

### 13.8 A floating palette, from the general pieces

The design has no palette construct, and needs none: a floating palette or inspector is written
from what is above. A press on a palette's field gives it the keyboard; Tab then moves among the
palette's stops and wraps, never returning to the document; a press on a palette's button runs it
and focuses it, as a press on any button does, so Tab continues from it; commands such as ⌘S
still act on the program while the palette has the keyboard; a press on the document returns
there.

```
App [ …
    windows: View [ … ],                      // the document windows
    palettes: View [ ],                       // a stratum above them, below the modal strata
    inspector: View [ paintsIn = { app.palettes }, focusScope = region,
        TextInput [ … ], TextInput [ … ],
        Button [ … ]
        ]
    ]
```

- **Above the documents, below modals** — the `palettes` stratum's place in declaration order.
- **Tab inside it** — `focusScope = region`: Tab wraps among its stops; F6 includes it among the
  regions; a press elsewhere leaves it.
- **Commands still reach the program** — shortcuts walk the logical tree (§9), and the inspector
  is declared in the App, whatever stratum it paints in, so the walk from inside it reaches the
  App's shortcuts; the App acts on the document it considers current.
- **Return and Esc** in its fields are the fields' own: commit, and cancel the edit (§13.3).

## 14. The focus ring

The ring work follows the overlay work: four of its six problems rest on what the overlay work
defines.

### 14.1 The problems

1. **Jitter during a host scroll.** The browser and the Mac scroll asynchronously; the ring is
   positioned by the runtime from geometry it hears about afterwards, so it is pulled along and
   snaps back.
2. **Animating inside a scrolling pane.** Two motions — the host's scroll and the ring's spring
   — combined in different frames of reference.
3. **A clip with no room for the ring.** The ring is drawn outside the control; a clipping
   ancestor cuts it off. Sharpest case: a scroller with nothing to scroll still clips (the
   tracker's filter chips: `scrolls = x, clip = true`, `height = 28`, everything fits — the
   ring's top and bottom are cut off).
4. **Tab order** — §13.
5. **Tabbing to something scrolled off** must scroll it into view.
6. **The ring's shape** must follow the focused view's corners (the docs search: the ring is a
   small-radius rectangle inside a capsule).

### 14.2 Root causes and rules

**Ride the scroll, never chase it (1, 2).** Anything that must stay attached to scrolled content
is composited by the host as part of that content. The ring paints inside the focused view's
**nearest scroller**, with its position and spring target in that scroller's **content
coordinates** — so a user scroll moves it in the same frame as the control, and an animation
never fights a scroll. To design: handing the ring between scrollers mid-flight; nested
scrollers (the innermost hosts, outer ones carry it). This is `paintsIn` with scrollers counted
as paint hosts.

**Room at the clip (3).** Layout must not change. Options, combinable:

- **Expand the clip outward**: the clipping element grows outward by the ring's width, its
  content offset back so nothing moves; the margin band lets the pointer through to neighbors.
  Free of side effects on edges across the scroll direction; on edges along it, the shared clip
  would also show scrolled content a few pixels past the pane's edge.
- **Reveal with margin** on edges along the scroll direction: scroll the focused control in by
  the ring's width. At the far end the scroll range can grow by that width without moving
  anything; at the start it cannot, and that one spot draws the ring inside the control.
- **Inset style** where nothing else gives room.
- On canvas and Mac the runtime composites, so it can clip the ring's layer more loosely than
  the content's; only the DOM forces one clip on both.
- **Probe:** CSS scroll-driven animations (`animation-timeline: scroll()`) move an element in
  step with a scroller on the browser's compositor. The ring could then live outside the
  scroller with its own expanded clip and still move in the same frame — removing problems 1
  and 3 on the DOM at once. Safari support and nested-scroller behavior unverified.

**Focus makes itself visible (5).** When focus moves, each scroller from the innermost outward
scrolls the least amount that shows the target with its ring, then the ring moves (in content
coordinates, so the two do not fight). **Contexts bound the chain:** focus in a dialog scrolls
the dialog's panes, not the page behind it. **Pinned chrome is not view:** a scroller's
children that ignore its scroll and stand against an edge (a toolbar, a footer, a pane's
header, under half the frame) cover that edge, so the reveal lands the target clear of them,
and the ring over scrolled content paints beneath them as the content does (built after the
focus stress page, `my-apps/focus-stress`, 2026-10-15).

**The ring frames the focused view, with its shape (6).** It takes the focused view's
`cornerRadius`, four-corner form included, grown by the ring's offset so the curves stay
concentric. When a whole region or composite is the focused stop, the ring frames it. If the
result looks wrong, the structure is wrong: the thing a person sees as the control should be the
thing that takes focus. There is no "frame something else" mechanism. So the docs search and the
desktop's Help search become a `TextInput` that is itself the capsule (per-side padding leaves
room for the magnifier, which becomes a child of the field), not a wrapper around a rectangular
field. A turned view is framed turned — a tilted window's ring turns with it,
not an upright box around it.

## 15. What exists today

- **Paint:** no strata. `Menu`, `Dialog` and `Tooltip` are App-level children that `raise()`
  themselves on open; `Menu` and `Dialog` lay a full-app press catcher for light dismiss. The
  focus ring rides scrollers with `travelWith`. The desktop's windows are a replicated block
  whose record order is their paint order; parked windows paint behind the dock's plate.
- **Focus:** `focus.ts` walks the logical tree in preorder over each view's `tabOrder()`, with
  links as stops. A Tab group is the focused view's nearest `focusTrap` ancestor, else its
  program's root — so Tab cycles within a program and cannot leave it. `focusTrap` is used only
  by `Dialog`. No `focusScope`, no per-scope memory, no region keys. Esc has no general
  meaning; each overlay handles it.
- **Keys:** raw delivery follows focus between programs (`keyboard-follows-focus.md`, built);
  shortcuts are an app-level registry in `apps/desktop`, not a service. An open menu's keys are
  withheld from the focused view, not from `Keys` members.
- **Overlay classes:** `Tooltip`, `Menu`, `ContextMenu`, `MenuBar`, `Combobox`, and a `Dialog`
  that is an alert only — a title, a message and button records, with no content of its own.
  There is no `Popover`, `Sheet` or `Toast`, and an overlay has no closing motion of its own.
- **Composites:** as §13.6's last paragraph.

## 16. Implementation sequence

Each step lands complete and demoable in the sampler or the desktop, with the four themes'
screenshots as the recurring gate. Substrate is built only as a step needs it.

1. **Focus scopes.** `focusScope = stop | capture | region | modal` in the focus service:
   per-scope sequences, the scope path, per-scope memory, Enter/F2 to enter and Esc to close, and
   island transparency (which removes today's trap in embedded programs). `Dialog` moves from
   `focusTrap` to `modal`. Then the container controls (§13.6): `RadioGroup`, `Segmented`,
   `MenuBar`, `Menu`, `Table` on the one pattern; `DataGrid` with two-dimensional navigation,
   the edit mode, and cells as classes. The region keys in the Mac host, and the browser's chord
   once measured.
2. **Contexts and `paintsIn`.** Strata as declared views; `paintsIn` with entry order;
   `travelWith` retired into it; the parked window fixed in `apps/desktop`.
3. **`Floating`, the library's overlays, and the router's strata.** `Tooltip`, `Menu`,
   `ContextMenu`, `MenuBar` and `Combobox` move onto it; `Dialog` gains content of its own and the
   full-screen presentation, keeping the alert verbs; `Popover`, `Sheet` and `Toast` join the
   library (§3.3), each with its closing motion; light dismiss and scroll policy per kind
   (§8.1); modality inert beneath within a context; an open overlay's keys withheld from `Keys`
   members (§9). Their reference docs and examples teach with neutral programs — never shaped
   like an eval's brief.
4. **The real `Window`.** Context, strata, its own overlays; window-local menus that escape the
   clip and turn with the window; regions in the desktop (§13.4).
5. **Islands across programs.** The stratum lookup through the island, coordinates through its
   transform chain, then the DOM mount decision (§12).
6. **The focus ring** (§14), against its acceptance tests.
7. **Shortcuts as declared data** (§9), the service the desktop's registry becomes.
8. **The skill and the guide.** The skill's table points every overlay need — a menu, a popover,
   a dialog, a sheet, a toast — at its class, and its drift check names the hand-built overlay
   ("a full-window view with a scrim, shown by a flag, is a `Dialog` or a `Sheet`"). The guide's
   overlays chapter teaches the set. Neutral examples throughout, as in step 3.
9. **The eval re-run** (§17): the same evals, with the same briefs, against the built tree. It
   needs steps 1, 3 and 8, not 2 and 4–7, so it can run as soon as those land.

## 17. Acceptance tests

In `apps/desktop`, all real:

1. Minimized windows paint above the dock's plate (a change of `paintsIn` at the start of the
   minimize journey, and back on restore).
2. A window-local context menu (in a Files window) escapes the window's clip and turns with it
   under the tilt; opened near the window's edge it extends past the window, and near the
   desktop's edge it flips or clamps to stay on the desktop. The same for a menu of a program
   running in a window (the tracker's sort menu).
3. Dialog → menu, and dialog → second dialog: Tab stays inside the top scope; Esc pops one level;
   focus returns correctly at each step.
4. A toast above everything, taking no focus, still clickable while a modal is up.
5. Tab through a Files window's columns and rows with nothing written for it.
6. A palette with fields and buttons, written in the desktop from the general pieces (§13.8) — no
   palette class: it stays above the document windows as they are raised and below a modal; a
   press on a field gives it the keyboard and Tab wraps among its stops; a press on a button runs
   and focuses it, and Tab continues from it; ⌘S still reaches the program while the palette has
   the keyboard; a press on a document returns there.
7. Later, canvas first: a hosted program raising a system dialog that paints in the desktop's
   root stratum.

Navigation:

8. The tracker in a desktop window: a press enters it; Tab cycles through the tracker and the
   window's controls and never leaves the window; Esc closes the tracker's menu and cancels its
   edit and leaves focus in the tracker; F6 moves to the next window; coming back returns to the
   control that last had focus.
9. At the desktop level, Tab moves among the menu bar, each window and the dock; arrows move
   inside the menu bar and the dock.
10. The docs page with live previews: Tab walks into each preview, through its controls and out
    to the page's next control; Shift-Tab walks back the same way.
11. `RadioGroup` and `Segmented` are one Tab stop each; Tab lands on the selected member; arrows
    move (and, for radios, check); Tab leaves.
12. A tenant's dialog inside a window keeps Tab inside the dialog; Esc returns focus to where it
    was in the tenant.
12a. The tracker's list: one Tab stop; Enter opens the active issue into its card and focuses its
    first field; Tab walks the card; Esc closes it, focus back on the row; Tab from the list
    reaches the next control after it with any number of rows open.
12b. A `DataGrid` in the sampler: one Tab stop; arrows move the active cell in two dimensions;
    typing edits, Enter commits and moves down, Esc cancels; Space toggles a check cell; an entry
    grid (`capture`) takes Tab cell to cell; a custom cell class with two controls is entered with
    Enter and walked with Tab.

For the focus ring:

13. A user scroll never makes the ring jitter (browser and Mac).
14. The ring handed between two panes in mid-flight.
15. Tab revealing a scrolled-off control, including while a scroll is in progress.
16. Focus inside a dialog does not scroll the page behind it.
17. Tab into a virtualized list; arrows reveal and build rows.
18. The tracker's filter chips: the ring is not clipped.
19. The docs search: the ring is a capsule.

The library's overlays, in the sampler, each in the four themes:

20. A `Popover` anchored to a control in a scrolling pane follows it as the pane scrolls, closes
    on an outside press, and becomes a `Sheet` at phone width.
21. A `Sheet` with a form: Tab stays inside it; Esc closes it and returns focus; it slides out
    on close and is torn down when the slide lands; at desk width it floats, at phone width it is
    a bottom sheet that a downward swipe dismisses.
22. A `Dialog` with content of its own, and in its full-screen presentation; the alert verbs
    unchanged.
23. A `Toast` above an open `Dialog`, clickable, taking no focus.
24. With a `Popover` open, one Esc closes it and a program `Keys` member's Esc handler does not
    run; the next Esc reaches the handler.

**The eval re-run** — the same evals, with the same briefs, against the built tree. What the
last runs built by hand, and what the re-run should show instead:

| The last runs | The re-run should show |
|---|---|
| sheets and pickers built as full-window views shown by a flag, with their own press-catchers | `Sheet`, `Popover` and `Dialog` used for them |
| an empty `onClick` to stop presses falling through a sheet | none needed |
| a popup positioned from a snapshot of its anchor, with the flip and clamp re-implemented | `openFor` on the anchor; the popup follows it |
| Esc as a priority chain in a program-wide `Keys` member | library overlays closing themselves; the program's own Esc handles only its own navigation |
| Tab escaping behind a sheet's scrim | Tab held inside the sheet |
| closing motion held open by a visibility threshold | the class's own closing motion |

Measured as in the last runs — the idiom review first, then the agent's account — and compared
with them line by line on these points.

## 18. Open rulings

1. **Declaration site.** Is an overlay declared where it is used (portal-style) or on the App?
   `paintsIn` allows both; which should the library teach?
2. **The DOM mount.** Route by element ownership, or mount tenants on the host's backend?
   (§12)
3. **Tenant modality** across the island (§12.4).
4. **`opener` typing** — narrowing at the declared instance
   (`rowMenu: Menu [ opener: InvRow ]`-style).
5. **`Floating`'s node kind** — does it own a detached view, or does the stratum own the root?
6. **The ring's clip policy** — which combination of §14.2's options is the default.
7. **Confirm the macOS popover behavior** before citing it (§8.1).
8. **The browser's region keys.** Which chord each engine leaves to the page for next and
   previous region (F6 is the browser's on several platforms) — measured on Chrome, Safari and
   Firefox before one is chosen. It is the only keyboard way out of a region (§13.3), so the
   browser host must have one.
9. **The multi-select context-menu convention** (`opener` = the pressed row; actions consult
   `app.selection`) — document as convention.
10. **A program's own cell class** (§13.6.2) — how a `Column` names a class written in the
    program (`cell = SignatureCell`), checked to extend `GridCell` and kept in the build, so the
    four library cells and a program's own share one shape.
11. **`Sheet` detents** — whether a sheet rests at more than one height (iOS's medium and large),
    or only at its content's height, in its first version.
