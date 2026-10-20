# Patterns — what changes from frame to frame, and what the renderer must make cheap (2026-10-15)

The question: which kinds of change the render=gpu renderer should be built around. That
depends on two things: what Declare apps do frame to frame, measured on the apps there are,
and what apps in general do, both as they are built today and as they would be if they were
written in Declare from the start, with springs and constraint-driven layout as the default
way to move anything.

## How it was measured

`node gpu/census.mjs` runs the scenarios in `gpu/census-scenarios.json` (49 of them, 20 apps
including `apps/games/{tempest,vortex,stargate,asteroids}` copied from main) on
`?render=gpu&census` pages in headless Chrome 155 on an Apple M2 Max, at 1280×800 and 2×. With
`&census` the host classifies, for every frame, each changed view's change:

- **Placement:** move (x/y), transform (scale, rotation, affine, 3D) and opacity. The view's
  pixels are the same and are only put somewhere else.
- **Shape and content:** size (w/h), paint (fill, gradient, stroke, shadow, filter, frost,
  clip and the like), text, drawing, image, and tree (created, removed, shown or hidden).

A **rigid** view is a placement-only view with nothing changed beneath it. Its whole subtree
could be kept as a texture and only placed. *Affected* views are the changed ones plus
everything under a placement change: the views whose pixels move.

Times are per frame:
- **Runtime:** the worker's busy time outside painting, i.e. springs, constraints and handlers.
- **Encode:** the host's walk, the engine's plan and the submit, on the CPU.
- **GPU:** the frame's span from timestamp queries.

Medians, with p95 where it matters.

Caveats:
- One machine; headless Chrome; scripted input.
- `two-way` is an HTML page that embeds apps, so it doesn't apply.
- A video's frames reach the host as image updates, so the census doesn't count them.
- Runs vary, at times two to one. Docs' scroll measured about 1 or about 2 ms of GPU from
  run to run, whatever was changed. A comparison here alternates its two sides over
  several rounds.

## What the apps do

Eight patterns cover the 49 scenarios:

| Pattern | Scenarios | Changed views a frame | Placement share | How drawn | Runtime / encode / GPU (ms) |
|---|---|---|---|---|---|
| **A. Scroll** | tracker, docs, birds, architecture, weather's city list | 0–2 | — | fast frames (tiles) | 0.1–0.5 / 0.6–1.0 / 1.2–1.6 |
| **B. Scroll beside frost or filters** | weather main, swatchbook Combined | 0–1 | 1.0 | whole | 0.2 / 3.0–6.9 / 7.1–9.6 |
| **C. Layout morph** | calendar view switches, marketmap scrub, chip and zoom, lzx-calendar | 100–700 | 0.08–0.24 | whole | 0.3–1.0 / 1.9–2.4 / 4.3–7.0 |
| **D. Local controls** | sampler switch, slider and accordion; hover springs (birds, tracker) | 1–5 | 0.0–0.9 | region or fast | 0.2–0.5 / 0.4–1.1 / 0.9–2.4 |
| **E. Rigid moves** | desktop drag and menu, asteroids, vortex and stargate play | 1–70 | 0.5–1.0 | region or whole | 0.2–0.4 / 0.6–1.2 / 2.2–8.2 |
| **F. Drawings re-recorded every frame** | tempest, stargate attract, desktop wallpaper under a drag | 5–27 | ~0.1 | whole | 0.2–0.4 / 0.4–1.5 / 2.9–7.5 |
| **G. Video** | homepage's reel, 25/s | — | — | region | 1.0 / 1.8 / 1.6 |
| **H. Discrete change** (one frame) | calendar next month, docs expand, sampler menu and tabs | 10–300 | ~0 | whole | — / 1.5–4.6 / 3–5 when frames run back to back; **20–46 after a second of idle** |

The full rows (kinds of change, rigid views, instances, Vello items) come from rerunning the
tool. Notes on the rows:

- **Calendar month → week:** about 104 views change a frame (88 resized, 39 moved, 17 faded).
  Only 7 of them are rigid, holding 55 views. Week → year: 147 change, and 22 rigid subtrees
  hold 934 views (the year's small months sliding as wholes).
- **Marketmap:** about 700 of ~900 views change every frame of a scrub or a chip's
  transition (580 moved, 430 resized). That's 2,200 quads; encode 2.4 ms, GPU 5.6–6.6 ms.
- **Weather:**
  - With nothing touched, one view moves (the sky, 10×/s), and each such frame is drawn
    whole: encode 3.5 ms, GPU 9.6 ms.
  - Scrolling the main area: the same, at 7.1 ms of GPU.
  - Frost takes in the frosted cards' whole rectangles, and the sky moves under all of them.
- **Desktop window drag:** 1 rigid view (46 under it). It redraws 30% of the screen a frame
  at 8.2 ms of GPU: the wallpaper under the window's old and new places, a 1920×1200 drawing
  with five radial gradients, a `lighten` blend and a `blur()`. It's too big to be kept as a
  sprite (512-pixel limit), so it's drawn again every frame.
- **Asteroids:** draws whole frames for 3–5 moving drawings. Damage is a single rectangle,
  the union of every change, and it becomes the whole frame past half the screen or when a
  drawing's reach is unknown.
- **Tempest:** about 23 of its drawings are re-recorded every frame (it draws its world with
  `draw()`).
- **Swatchbook Effects and Combined:** every frame is whole while one view moves, and a scroll
  of Combined is whole too. The likely reason, not yet checked frame by frame: the moving
  view's damage touches filtered views, which are taken in whole, and a scroller holding
  filters can't be a layer.
- **Lone frames:** a frame after a second or more of idle costs 20–46 ms of GPU, against
  3–4 ms for the same frame when frames follow each other. Wall-clock submit-to-done agrees,
  and a second page keeping the GPU busy didn't change it. Not yet checked in a headed
  browser.

## What the numbers say

1. **The runtime is cheap.** Running springs and constraints every frame costs 0.1–1 ms,
   1 ms for marketmap's 700 changing views. Core Animation's approach (hand an animation to a
   render server so the app doesn't run) would save almost nothing. It would also rule out
   what Declare's frames are: real layouts, with text rewrapping as it moves.
2. **Placement-only change is the minority** wherever there's UI rather than sprites. It
   accounts for 8–24% of changed views in the morphs, and rigid subtrees are small. The large
   rigid sets (calendar's year, 934 views) are quads, which cost nothing extra to move.
   Rigid placement dominates only in games, drags and the weather sky.
3. **The cost is pixels, not views.**
   - Every scenario over 5 ms of GPU draws whole frames. Every scenario under 2 ms draws
     regions or fast frames.
   - A whole frame at 2560×1600 costs 2–3.5 ms with one Vello item and almost no quads
     (asteroids, stargate attract), and 4–7 ms for a quads-heavy screen (calendar,
     marketmap). Where those milliseconds go is not yet known.
   - What forces a whole frame:
     - morphs that touch most of the screen, which is legitimate;
     - frost and filters taking in their whole rectangles;
     - damage kept as one rectangle;
     - drawings with unknown reach.
4. **CPU per frame is not the limit.** Encode stays under 2.5 ms even at 700 changes, so the
   walk-and-plan design holds at this scale. A retained GPU-side tree isn't needed.
5. **At 120 Hz** the budget is 8.3 ms. Morph frames fit if CPU and GPU overlap: about 3.4 ms
   of CPU, 4–7 ms of GPU. Weather's main area doesn't fit (7–12 ms of GPU), and neither do
   lone frames.

## Today's apps

What most apps do, frame to frame, and how platforms make it cheap:

| Kind of app | What moves | How it's made cheap today | Pattern |
|---|---|---|---|
| Feeds, mail, issue lists | Scroll; rows inserted at the top; images arriving; autoplay video | Compositor scrolling of tiled layers; recycled rows; image decode off-thread | A, G |
| Chat and AI assistants | Text streaming in token by token; the last message grows; follow-the-bottom scroll; code blocks highlighting as they arrive | Repaint the growing block; scroll anchoring | D, A, H at a high rate |
| Documents and editors | Typing (one line reflows), caret, selection, scroll; large text | Glyph atlases; incremental layout; tiles | D, A |
| Spreadsheets and data grids | Scroll in two axes; thousands of cells; selection overlays | Tiles; canvas grids with dirty regions | A, D |
| Maps and infinite canvases (Figma, Miro) | Pan and zoom of the whole scene, continuously; vector content | Tiles at several scales; level of detail; GPU vector renderers | E (scaled), F |
| Dashboards and charts | Live data; charts redrawn; crosshair hover | Canvas or SVG redraws of a chart's region | F, D |
| Media and galleries | Video; shared-element transitions (thumbnail to full); blurred album-art backdrops | Video layers; transform animations on the compositor; cached blur | G, E, B |
| OS shells and window managers | Window drags and resizes; overview zoom of every window; dock magnification; frosted menus over live content | A layer tree with a cached bitmap per window; the render server animates transforms | E, B |
| Marketing and landing pages | Scroll-driven animation: parallax, sticky reveals, scroll-linked transforms; hero video | CSS scroll-driven animations on the compositor; transform and opacity only | B, G |
| Settings and forms | Switches, accordions, menus, dialogs over a dimmed or blurred page | Small repaints; backdrop blur | D, B |
| Calendars, boards, kanban | Drag-and-drop with neighbors sliding aside; view changes | Mostly crossfades or jumps; FLIP-style transform tricks | E, C (rarely) |
| Games and visualizations | Everything, every frame | Full redraw each frame; sprites; batching | F, E |

Two design-system trends raise the stakes:
- **Apple's Liquid Glass (2025):** translucent, refracting, frosted controls over scrolling
  content, everywhere, including morphing glass shapes. That makes pattern B, weather's case,
  the default chrome of a platform.
- **Material 3 Expressive:** spring motion and shape morphing as the norm.

120 Hz displays are now standard on phones, iPads and MacBook Pros.

## The same apps, written in Declare

Declare changes **what** these apps do, not only how:

- **Transitions are layout morphs.** Filtering or sorting a list makes its rows glide to their
  new places. Opening an item morphs the card into the detail, with its text rewrapping on
  the way. Switching tabs morphs content instead of cutting. With springs as the default
  motion, pattern C (hundreds of views changing size and place every frame) follows nearly
  every input for 0.3–0.6 s, in nearly every app. Today it's an exception (calendar,
  marketmap). Most of these frames are whole by nature.
- **Scroll stops being pure translation.** Any view can read `app.scrollY` in a constraint,
  so collapsing headers, parallax, pinned skies and progress bars are one line each. Weather
  already does it: the sky pins itself with `y = { app.scrollY }`. The scroll fast path needs
  a frame's only change to be one layer's scroll, so it fails as soon as one view reads the
  scroll. Pattern B, scroll plus a few changes beside it, becomes the common scroll.
- **Interruptible springs overlap.** There's no final state to compute ahead. What can be
  cached is what didn't change since the last frame, which is how the renderer caches today
  (atlas, sprites, tiles).
- **Animated drawings grow.** A chart whose data springs to new values re-records its paths
  every frame of the transition (pattern F, in dashboards).
- **Text changes size and wraps mid-flight.** The atlas sees new sizes and sub-pixel phases
  during a morph. The size ladder exists for this.
- **Frost over moving content** is a natural property (`backdrop`), and per the Liquid Glass
  trend it will be used freely.

What stays the same: scrolling long content is still the most frequent interaction; hovers
and local controls; video.

## Chat: Murmur

Murmur, the eval's conversation app (my-apps/murmur, with its seeded service), behaves like
the tracker:

| Scenario | How drawn | Encode / GPU (ms) |
|---|---|---|
| Scrolling a long conversation (305 messages, and at 100×: 30,500) | fast frames | 0.5–0.7 / 1.0–1.6 |
| Typing and sending | small regions (3% of the screen) | 0.6 / 1.0 |
| Opening a conversation, or switching | 2–4 frames, mostly whole | 2–3 / 3.2–3.7 |
| A reply arriving after a quiet spell | 2–3 whole frames | 4.2 / 37 (a lone frame after idle) |

Its list is virtualized, so 100× history costs what 1× does. Its transitions are few and
short: at 1440 the list is a pane, and opening a conversation replaces the pane's content.
The one cost worth noting is again the lone frame after idle.

## An infinite canvas: Atlas

Atlas (my-apps/atlas) is a map you can zoom without end:
- The world comes from Natural Earth (public domain): land at three levels of detail,
  borders, lakes, rivers, roads and populated places, simplified per zoom to under half a
  pixel by its tile service.
- Past Natural Earth's detail, the service makes up streets and building blocks around each
  city. Positions come from a hash of world-grid cells, so every level holds about as much as
  the one above it: 30–140 streets and 90–215 blocks a tile from zoom 13 to zoom 19.
- Every tile is a view that `draw()`s its features once and is scaled for the zoom between
  levels. Place names are `Text` views held upright.
- A frosted glass panel sits over the moving map, the Liquid Glass case.

### What it does frame to frame

Every frame of a pan, a zoom or a flight is drawn whole, and 84–95% of the changed views are
placement-only: rigid. This is the pattern the "animated layers" idea was about. As built
before this test, it cost 4.3–6.4 ms of GPU a frame.

Nearly every tile was over the 512-pixel sprite limit: 256 points × 2 (device scale) × 0.7–1.4
(the zoom between levels), and twice that for the coarser level beneath. So Vello drew 9–14
tile drawings again every frame, even in a pan where nothing about them changed.

### What changed in the engine (an experiment, on by default; `&oldsprites` turns it off)

- **Sprite texture and limit:** 4096², taking a drawing up to 1100 pixels a side.
- **A drawing moving on the frame:** laid from its last raster, sampled bilinearly (a new
  quad kind), while its scale stays within a quarter of that raster's. Past that it is
  rastered anew at the new scale.
- **Once it holds still:** the host draws its area once more, where it is rastered exactly. A
  drag-and-zoom compared at rest against `&oldsprites` matches to the pixel.
- **Kept textures:** a drawing drawn into a tile or a kept pass is always rastered exactly.
- **Reset fix:** a sprite texture with no room is cleared at the next plan. It used to stay
  stuck full.

### Results

Alternating rounds against `&oldsprites`, GPU medians:

| | new | `&oldsprites` |
|---|---|---|
| Atlas pan / zoom / flights (pan Tokyo about even) | 2.4–3.6 ms | 3.2–5.8 |
| Desktop window drag | 4.5–5.4 | 6.6–7.7 |
| Asteroids | 1.25–1.5 | 2.2–3.5 |
| Tempest | 4.5–5.8 | 5.7–6.5 |

Atlas drawings sent to Vello went from 9–15 a frame to 1–3. The baseline matches apart from
the date.

- **Memory:** the larger sprite texture exposed a leak in the engine's texture pool. It kept
  up to four spare textures of every size it had ever handed out, and sizes vary without
  end (a Vello batch is its own bounds, a sprite raster 4096 wide by however tall). DT ran
  out of memory zooming and panning New York. The pool is now held to 192 MB, letting go of
  the largest spares first. It drops its handle rather than destroying the texture, since a
  layer may still hold it: destroying broke swatchbook's filter chains in the baseline. A
  soak (fly to New York, then eight rounds of zoom and pan) holds the GPU process at about
  210 MB. I haven't reproduced the out-of-memory itself in headless Chrome, so whether it
  was this leak, or the console filling with the `onLoad` errors below, isn't certain. During a pan a moving tile is a little softer (bilinear), the way a browser's
composited layer is; at rest it is exact.

### What the map needed from the app

A real map hides a tile of the coarser level once the four of the finer level over it have
loaded. Atlas does this: each tile marks itself arrived in a dataset, and a coarse tile hides
when its four children have arrived. Without it, every frame draws two levels, and twice the
area stays to be kept. Any renderer pays for that, the DOM included.

At first this never worked. A tile's `onLoad` threw on every load, and covered tiles stayed
drawn: the comparison above is from after the fix.

The made-up streets also ran across water (Rio's bay, in DT's screenshot). They now keep to
the tile's land and out of its lakes.

## Does Declare stretch to an infinite canvas?

Yes. The program is about 300 lines, and the camera is five attributes:
- **The camera:** a world point pinned to a screen point, and a zoom.
- **Gestures:** a drag moves the screen point; the wheel pins the point under the pointer
  and springs the zoom.
- **Flights:** a flight springs the world point and the zoom together. Its arc (zoom out,
  travel, zoom in) is one constraint, the zoom's target capped by the distance left:
  `Math.min(app.zoomTo, app.fitZoom)`.
- **Tiles:** a derived dataset from the camera, keyed, so a tile that stays in view stays the
  same view with its data. `classFor` picks the map or the label kind of tile.
- **Drawing:** `draw()` runs once per tile's data, never per frame.

Where the language pushed back:
- **A schema field is one array deep.** Rings and lines (`number[][]`) can't be declared, so
  the service sends each as a record, `{ "p": [...] }`.
- **No sharing a fetched resource between views.** The labels have to sit over every tile, in
  a second view per tile, and that view can't read the map tile's `DataSource`. It fetches
  the same address and relies on the HTTP cache. A keyed cache of resources, one per record,
  that several views read, would say this directly.
- **Readiness of many children** (is this tile covered?) needed `onLoad` writing to a
  dataset, plus a typed cast to read it back.
- **`onLoad` after a view is gone:** a `DataSource`'s `onLoad` still fires when its fetch lands
  after its view has left the tree, which a flight does to many tiles. There, `app` (compiled
  to `this.root`) is the detached subtree's own root, not the App, so `app.arrived` is
  undefined and the handler throws. The same happens in the DOM renderer, so it's the
  runtime. Atlas guards with `if (app.arrived != null)`. The runtime should not deliver it,
  or `app` should not quietly mean something else.
- **Small spellings:** a bare literal can't be `1e-10`; `Shape` is a reserved type name; a
  color with alpha inside `{ }` isn't `#…` (a theme token is the right answer anyway).
- **A hang with no guard:** a method looping without end hangs the page, the DOM renderer's
  main thread included. Atlas did this at boot, when a zero width gave a −∞ zoom. Nothing in
  the runtime stops it or says where it is.

A spreadsheet is the next stretch, and not the same case. `virtualize` windows rows only (a
scroller and a layout stacked on y). A sheet with hundreds of columns would materialize every
column of every visible row, or window its own cells from the scroll position as Atlas
windows its tiles from the camera. That is what the drift check calls rebuilding what
Declare does, except Declare doesn't do it on two axes.

## Weather under Liquid Glass

Yes, for the same reason. Glass samples what lies beneath it, so a sky that moves under
frosted cards, or cards scrolling over a sky, means sampling and blurring again every frame.
Apple pays that cost too, on the GPU. The ways to make it cheaper are the ones known here:
- **Blur at low resolution.** This engine does it.
- **One capture of what lies beneath, shared by every piece of glass over it.** This engine
  does it too, as the frame snapshot. As far as Apple describes it publicly, grouping glass in
  a `GlassEffectContainer` does the same.
- **Keep glass off the content.** Apple's guidance puts Liquid Glass on the controls and
  navigation that float over content, not on the content's cards. Weather frosts its content
  cards, which makes many large panes of glass over a moving sky.

The iOS Weather app draws translucent cards over an animated sky at 120 Hz, so the platform
pays it within budget. Here it is 7–9 ms at 2560×1600, and needs to come to about 4.

## What the renderer should make cheap, in order

1. **Whole frames.** A Declare app's animated frames are mostly whole (C), so a whole frame's
   GPU cost sets the frame rate. Timed by stage (BENCHMARKS.md § GPU time by stage): a whole
   frame's work is 1.4–2.9 ms at 2×, within the target of about 3 ms, and the 4–7 ms first
   measured was a span, half of it the GPU waiting for the worker. Past it: vortex play
   (fill) and swatchbook's filter galleries.
2. **Scroll with changes beside it (B).** A fast frame should carry the layer's tiles plus
   redraws of the few changed views outside the layer (a header reading `scrollY`, a pinned
   sky), instead of falling back to whole frames.
3. **Frost over moving content (B).** Make a frost's cost depend on what changed beneath it:
   - re-blur only where the source changed;
   - keep a blurred copy of a source that holds still (weather's sky between drifts) and cut
     each frost from it;
   - keep each frost at reduced scale (as now).

   This is the pattern Liquid Glass makes standard.
4. **Damage as a few rectangles, not one union, and drawings' reach for damage.** Several
   small independent changes (sprites, a cursor, a hover beside a moving header) should stay
   small. That covers asteroids, stargate and multi-change frames.
5. **Drawings that move are kept.** The experiment above: drawings up to 1100 pixels in a
   4096² texture, laid from their last raster while they move, exact at rest. Still to do:
   - **Larger drawings:** done (2026-10-18): a drawing past 1100 pixels (desktop's 1920×1200
     wallpaper), up to 4096, is rastered into a texture of its own. Dragging a window: GPU
     8.1 → 1.8 ms a frame (BENCHMARKS.md § The host in Rust).
   - **Eviction:** sprites should be evicted least-recently-used rather than cleared all at
     once.
   - **Settled at rest:** whether the moving policy should be the default is DT's call.
6. **Animated layers (rigid subtrees as textures):** for drawings, item 5 is this, one
   drawing at a time, and it covers the map. For subtrees, it's a narrow case: worth it only
   where a rigid subtree is expensive to draw, such as a scaled subtree of text (an overview
   zoom), or a long fade of a large unchanged subtree. Later, and keyed by "subtree unchanged
   since the last frame".
7. **Lone-frame latency** (20–46 ms after idle): check in a headed browser first. If it holds,
   it's the platform's GPU power state rather than this renderer, and worth knowing for click
   latency.

Not needed: a retained GPU-side view tree or instance buffers patched per view (encode is
under 2.5 ms at 700 changes), and handing animations off to a render server (the runtime
costs ≤1 ms a frame).

## Patterns no app here exercises yet

Murmur now covers chat, and Atlas covers an infinite canvas and a map. None of the apps
exercises these, and each is common today:
- text streaming in token by token (an assistant's transcript; Murmur's messages arrive
  whole);
- a large spreadsheet scrolling in two axes (above: virtualization is rows only);
- drag-to-reorder with neighbors springing aside;
- a list filtered or sorted with rows gliding;
- a Liquid Glass-style toolbar over a scrolling feed.

Small test programs for these would let the census measure them. Whether to write them
(as apps, or under `gpu/`) is DT's call.
