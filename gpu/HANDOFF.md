# Handoff — the render=gpu renderer

Read this first, then `gpu/README.md` (architecture, the compositor, what each tool does).

## Where this is

render=gpu lives in `gpu/` and is otherwise isolated: what it needs from the rest of the tree
is the boot's `?render=gpu` hook (browser/boot-uniform.js, outside every production build),
the runtime's exports, and `feedPointer` (canvas-backend.ts, the pointer for a composed
tenant, shared with the canvas renderer and the Mac host). Its build output and test output
are per machine and ignored (.gitignore § render=gpu); its test programs live in `my-apps/`
and its early prototype in `workshop/gpu-probe`, both local.

Rules (DT):
- Changes made for render=gpu must not regress the DOM, canvas or Mac renderers, and must not
  grow a bundle that does not need them by more than a trivial amount: check production
  builds (`declarec`, DOM and canvas) against HEAD, and measure back to back.
- Code for measuring only (counters, timers) ships only in builds with the development
  switches, or behind an environment flag on the Mac (DECLARE_METER).
- Don't change app code (`apps/`) to make the renderer look good.
- Test programs, probes and fixtures go in directories already ignored (`my-apps/`,
  `workshop/`, the ignored paths under `gpu/`); no new top-level directories.
- Kill processes by PID only. Tests run headless and muted (`--mute-audio`); nothing takes
  focus. Use headless Chrome; **skip Safari for now** (when it is allowed: own tabs via
  `safaridriver --mcp`, ask first).
- American spelling. Comments and docs say what is, not its history.

## Running

- Dev server: `npm start` (:8200; open e.g. `http://127.0.0.1:8200/apps/tracker/?render=gpu`).
  The tools here take `--base` where a scenario needs another server.
- Build: `node gpu/build.mjs` (engine + JS; it checks for rustup, wasm-bindgen-cli and
  binaryen's wasm-opt and names what is missing), or `node gpu/build.mjs --no-engine` for
  TypeScript only. Scripts can flake right after a build (the page never reports ready):
  run again.
- Type-check the host: `npx tsc --noEmit --strict --target es2022 --module esnext
  --moduleResolution bundler --lib es2022,webworker,dom --skipLibCheck gpu/src/host.ts`
- Tripwire: `node gpu/baseline.mjs` — 57 cases against saved ?render=gpu pictures; must print
  "all as before" after any compositor change.
- Scroll timing: `node gpu/scroll-chrome.mjs <app path> <x,y> --rounds 2` — layers beside
  `&nolayers`, after an unmeasured warm-up page (the first page in a browser runs cold).
- Diagnostic switches: `&nolayers`, `&nofrost`, `&trace`, `&census` (per-frame change
  classes, for `node gpu/census.mjs`), `&gpumem` (WebGPU memory made, destroyed, collected),
  `&timing` (frame GPU time; off by default, the census turns it on). `NAMES=1 node
  gpu/build.mjs` keeps the engine's function names for a profile.
- The gate, 2026-10-19/20 (BENCHMARKS.md § The gate again): light frames sit on Chrome's
  WebGPU floor; fixed since: kept groups and filters laid moved on a scroll, timing opt-in,
  ink measured only when asked. Docs scroll reads 11–16 ms a frame; the gate's 5.9 came from a
  run in which the DOM, too, drew 72 frames where every other run drew 112–121, so the page
  likely stood differently there: compare docs scroll back to back, not with that row.
- Scrolling (DT, 2026-10-19): the platform's own scrolling where there is one, imitation as
  the fallback; the same method in render=gpu and render=canvas. A whole-page app scrolls the
  window: the canvas fixed, a strut as tall as the app, the browser's scroll, scrollbar,
  momentum and bounce; the offset goes to whoever draws; fields and islands fixed and moved
  with each drawn frame. Inner panes are imitation (render=gpu scroll.rs, canvas-backend.ts:
  two copies to one spec, held together by step 6's rig, not shared code). render=gpu's page
  decides at once whether a wheel or a finger is the browser's, from the compositor's page map
  (host `place_page`: inner panes, wheel claimants, views that take a finger — worker.ts
  `followTouchClaims`), a frame old. `&nopagescroll`: the compositor scrolls the page, for an
  A/B. The fallback bar (both renderers): the Mac's under a mouse, iOS's indicator under a
  finger (README § Scrollbars). The Mac's own scrolling (an NSScrollView per scroller) is the Mac host's to adopt; today
  it imitates (Scrollbars.swift). Canvas fixes (runtime): a wheel's axes go each to the pane
  that scrolls on it (the Files columns scroll across), fields fixed on a page that scrolls
  the window.
- Hosted apps' pointer (2026-10-19, a regression since 8627490a): a tenant mounted by surface
  composition (boot.ts mountEmbeddedApp: canvas, render=gpu) has no element and no router of
  its own, and nothing fed its pointer facts, so drags reading `app.pointerX` (the Slider) and
  its hover and pressed looks were dead in a desktop window. `feedPointer`
  (canvas-backend.ts) feeds them: the tenant's own window listeners, capture phase, after its
  host's, so its coordinates in its island's frame (`rootToLocal`) land before the event is
  routed. Each composing host calls it and stops it with the tenant: host-islands.js (canvas),
  gpu/src/worker.ts, the Mac's mac-boot.js `mountCompiled`. The DOM mounts tenants as
  elements, so a DOM build carries none of it. The Mac had no hosted app at all in a desktop
  window: its URL shim (mac-env.js `normalizePath`) resolved `new URL(".", ".../desktop/")`
  without the trailing slash, so each tenant's source was fetched from the wrong directory.
- Text fields (DT, 2026-10-19): a field is a DOM element only while it has focus; otherwise
  the canvas draws its value or placeholder (#757575, the browser's). render=gpu: shell.ts
  makes the element on a press in the field's box, host draws the text (mod.rs `field_text`).
  The canvas renderer got the same (runtime/src/canvas-backend.ts, a press found by
  scene-walk.ts `fieldWalk`).
- GPU memory: wgpu in the browser does not destroy a texture or buffer it drops; it waits for
  the collector. The engine destroys what it lets go of once the frame is submitted
  (layers.rs `Pool::reap`); the desktop otherwise held 1–3.5 GB awaiting the collector (DT's
  out-of-memory in Safari), now about 480 MB steady (2026-10-19).
- Cost by layer, all four renderers: `node gpu/costs.mjs <scenarios.json> [app] [scenario]`
  (README, after worker-profile).

## State at handoff

Done this session: compatibility with `?render=canvas` (all apps run), then the
compositor: Vello passes + scroll-layer tiles + frame snapshots for frost; fast frames for
a scroll that touches one layer; tile patches (a change inside a layer redraws only its
rectangle); tiles at the scroller's sub-pixel phase; a scroller is a layer only while it
moves (+1 s); nested scrollers drawn into the parent's tiles. Vello is vendored with one
atlas fix and an encoder hook (`engine/vendor/vello`). Numbers are in README § The compositor.

Then (2026-10-14): `?render=dom|canvas|gpu` (boot-uniform.js; every gpu/ tool
uses `?render=gpu`), and the quads — ordinary UI drawn as instanced quads with a glyph
atlas, opacity groups, drawing sprites, Vello only for paths and changing drawings; frame GPU
time from timestamp queries (`gpuExec`). See README § The quads. `&noquads` is the A/B.
gpu/baseline.mjs pins the light appearance (the system's dark mode turned every case) and
its pictures were saved anew from the quads.

Then (2026-10-15): the change census and gpu/PATTERNS.md — what Declare apps change frame
to frame (49 scenarios, 20 apps), set against today's apps and against what those apps would do
if written in Declare, with a ranked list of what the renderer should make cheap.
`apps/games/` (tempest, vortex, stargate, asteroids) is copied from main for it; all four run
under ?render=gpu.

Then (2026-10-15, DT's ask): two test programs in my-apps — Murmur (the eval's chat app,
with its seeded service; behaves like the tracker) and Atlas (a map zoomed without end over
Natural Earth, tiles drawn with `draw()`, its own tile service), with census scenarios for
each (gpu/census-murmur.json, gpu/census-atlas.json). Atlas found that tile drawings missed
the sprite path (over 512 pixels, and keyed by exact scale and phase), so the engine now lays
a moving drawing from its last raster, sampled, and rasters it exactly once still
(README § The quads, PATTERNS.md § An infinite canvas) — an experiment, on by default,
`&oldsprites` for the A/B. Services the test programs need (README, after the census tool):
atlas tiles on 8340, Murmur's service on 8330, a proxying dev server on 8221.

Then (2026-10-16): the measures corrected and render=gpu's weak spots found
(BENCHMARKS.md § Corrected). The worker's busy time had missed the runtime's settle (a sixth
of the real time), and the worker painted up to twice per tick. Fixed: hidden views deferred as
under the DOM (stargate's slowness), one paint per tick, batches gathered across tiles,
shadows in drawings on the GPU (no readback; layers of a frame made in one Vello render),
moving sprites premultiplied. New: my-apps/marketcharts (a chart in every tile:
render=gpu 2.7–3.3× cheaper than the DOM), gpu/threads.mjs and gpu/worker-profile.mjs
(where a thread's time goes), NOMINIFY=1 for the build.

Then (2026-10-17, the browser's stopping point): GPU time by stage (`&gpustages`,
`census.mjs --stages`, BENCHMARKS.md § GPU time by stage). A whole frame's GPU work is
1.4–2.9 ms; the 4–7 ms quoted before was a span, half of it the GPU waiting for the worker.
The readbacks are gone but for SVG `url()` filters in drawings. Vendored Vello has an
encoder hook for the timing (README).

Loose ends:
- Readbacks left in render=gpu: only a drawing with a filter the passes cannot run (an SVG
  `url()`), rastered whole on the worker's 2D canvas. Images, text shadows and stroked text
  in drawings are on the GPU (2026-10-17).
- gpu/baseline.mjs: the calendar cases (calendar, calendar-week, calendar-busy, lzx-calendar,
  desktop-calendar) show today, so they read CHANGED on any later day; look, then `--save`.
- Scrolling: a mouse wheel's notches glide (README § Scrolling). The scenarios' wheels are a
  trackpad's, which neither renderer animates, so scroll rows compare per wheel event
  (render=gpu about 1.7× the DOM), not per frame. Scroll runs in the compositor worker, beside
  the runtime's, since 2026-10-18.
- `npx tsc` on host.ts reports five errors in drawing.ts, env.ts and worker.ts's
  `FontFaceSet.add`, none in host.ts and none in code changed here.
- A hosted app's relative URLs resolve against its host's page, not its own program: the
  tracker in a desktop window fetches my-apps/desktop-dense/issues.json (the market map reads
  the `base` the desktop provides). The test bed carries a copy of the issues; reported to DT,
  runtime not changed.
- Weather's main area gains nothing from layers: the app pins its sky with
  `y = { app.scrollY }` (weather.declare:1260), so every scroll frame moves it, and the sky
  drifts 10×/s on its own. Reported to DT; app not changed.

## The plan (DT's go, 2026-10-18)

One renderer shared by the browser and the Mac: a Rust crate that takes the runtime's
commits (the MacHost protocol) and owns everything below them — the tree, scroll state,
damage, what is kept, planning. The planner knows no GPU API: it hands instance arrays and
passes to a backend (wgpu in the browser, Metal on the Mac), and text goes through an
interface (parley and skrifa in the browser, Core Text on the Mac, to be measured against
ours: speed, appearance, edge cases). Scrolling runs off the runtime's thread on both, as the
Mac host does now; the runtime hears the offsets afterward. The runtime, the compiler and
the hosts are fixed where the work needs it (DT, 2026-10-19). Springs run by the renderer:
dropped (few cases).

Browser steps, in order, each through the baseline:
1. host.ts into the Rust crate, behind text and GPU interfaces.
2. A compositor worker: the engine and the tree in a worker of their own; scrolling, glides
   and scrollbars there; the runtime's `measure` answered by a measuring engine in the runtime
   worker.
3. The planned quads of unchanged subtrees kept.
4. Group and filter textures kept; no whole frame forced by a layer on screen.
5. Views made layers from motion seen in the commits.
6. Gestures as close to the browser's own as measurement allows (DT, 2026-10-18: in the
   browser render=gpu provides its own gestures, as the canvas renderer does; no native
   scroll overlays). A rig replays the same wheel, touch and pinch input on a DOM page and on
   render=gpu and compares the offsets over time; then trackpad overscroll (the stream's
   phases inferred from its timing), the mouse wheel's curve, pinch with its rubber band and
   settle (Mesa client's shell-input.ts, shell-zoom-animation.ts), keyboard scrolling. The
   touch physics is already Mesa's (runtime scroll-physics.ts). This lives in the compositor
   worker (TypeScript): the crate takes offsets.

Step 1 done (2026-10-18): engine/src/host/ (mod.rs the tree and ops, walk.rs the paint walk,
scroll.rs scrolling and scroll layers, frame.rs the frame); host.ts is the platform side
(text lines, touch physics, timers, the page's work). The engine is built for speed now
(opt-level 3, wasm-opt -O3; 893 KB brotli against 740).
Step 2 done (2026-10-18): compositor.ts owns the canvas, the engine and the host;
worker.ts runs the runtime, whose MacHost is remote-host.ts (measuring with an engine of its
own, drawings recorded through a stand-in engine and replayed in the compositor, a flush one
message). The runtime held busy 800 ms during a wheel scroll: 15 frames drawn meanwhile.
Baseline as before (the date cases aside), web builds unchanged; numbers in BENCHMARKS.md
§ The host in Rust. Tools: worker-profile.mjs `--compositor`; costs.mjs counts both workers.
Not done in step 2: the drawing replay stays in TypeScript (the Mac plan moves it to the
crate); a virtualized list's rows not yet built show blank while the runtime is busy.
Step 3 done (2026-10-18): plan buffers and bindings kept between frames; commits read in place
(an op's objects parsed only where one is carried); text styles numbered; large drawings (past
1100 pixels) a texture of their own; unchanged subtrees' walks and plans kept (`&nokeep`).
Measured back to back (gpu/ab.mjs, BENCHMARKS.md § The host in Rust). A test bed for whole
frames over still content: my-apps/desktop-dense, gpu/census-dense.json. Found there: those
frames need not be whole — the damage is one rectangle, and a frost it touches stretches it
across the screen (damage as several rectangles, next with step 4).
Step 4 done (2026-10-18): opacity groups and filter layers kept while their content stands
(swatchbook Effects GPU 5.2 → 1.4 ms, Combined scroll 6.6 → 4.9, weather idle 4.6 → 3.1); a 3D
view or mask on screen no longer makes every frame whole, only a change under a 3D view does
(swatchbook Combined tab GPU 2.0 → 0.6). Damage as several rectangles was built, measured and
taken out: with kept walks and plans a whole frame is cheap, and each rectangle costs passes
(BENCHMARKS.md § The host in Rust). Kept from it: kept walks and plans serve any clip inside
theirs; drawings that paint nothing no longer make every frame whole.
Step 5 begun (2026-10-18): a moved subtree's kept walk is laid again translated instead of walked
anew (calendar month→week compositor 1.61 → 1.36 ms, desktop drag 1.00 → 0.92). Then moving
layers: a large subtree moved frames on end is a texture laid at each place, drawn exactly once it
rests (desktop drag window compositor 1.19 → 0.90 ms, GPU 1.51 → 1.11; swatchbook Combined scroll
20 → 25 frames a second). Not yet for scaling motion (dock swell, window open, zoom). Loose end: desktop's
dock icons' glyph edges differ kept and not kept (up to 67 levels; since step 3), likely
size-ladder text under the dock's magnification.

The Mac (a plan of its own, after): the crate native, a Metal backend, Core Text, scrolling
driven by AppKit (native momentum, elasticity and scrollbars: an NSScrollView per scroller over
the surface, drawn in step with presentsWithTransaction). Candidates: the drawing replay
(drawing.ts) into the crate, reading the recording MacBackend already sends; swap-buffer
damage by buffer age instead of the present copy.

## Direction and open questions (DT, 2026-10-14)

- **No hybrid model.** Drive toward a maximally optimized pure WebGPU renderer.
- Done (DT's go, 2026-10-14): ordinary UI primitives drawn as instanced quads with a glyph
  atlas, Vello only for real paths and drawings (README § The quads).
- Animated layers (a rigid subtree kept as a texture and only placed) measured as a narrow
  case: PATTERNS.md ranks it sixth. Proposed order: whole-frame GPU cost first — done
  (2026-10-17): the work is within target, what is left of a frame is the worker's CPU and
  Chrome's GPU process (BENCHMARKS.md § GPU time by stage); outliers vortex play (fill),
  swatchbook Effects. Then scroll with changes beside it, frost over moving content, damage
  as several rectangles, large still drawings kept.
- The Mac host (DT, 2026-10-17): the plan is to port or rewrite this renderer there. Proposed:
  the whole window one Metal surface; overlays only for web views; video drawn in the surface
  (AVPlayerItemVideoOutput → CVMetalTexture); text input through NSTextInputClient on our own
  view, drawing the text ourselves (the accessibility element, spelling and the context menu
  then ours to supply).
- A frame after a second of idle costs 20–46 ms of GPU in headless Chrome (3–4 ms back to
  back); to be checked in a headed browser.
- DOM against render=gpu (gpu/BENCHMARKS.md, 2026-10-15): the worker makes a frame for far
  less than the DOM's main thread, but our WebGPU use costs the GPU process 4–18 ms a frame
  (Chrome's own: 1–5) — about 660 calls a calendar frame: 22 submits, 70 new buffers, 63 new
  bind groups. DT's gate (heavy frames 1.5× better, light ones within 20%) was run after
  the cleanup (one encoder a frame, text fields moved only when changed): not met — heavy
  frames tie, light ones cost 2–8× (BENCHMARKS.md § After the cleanup).
- DT (2026-10-16): keep render=gpu only if it clearly wins (1.5×) for some class of app;
  otherwise move to the Mac host (an upgrade of it, not a new variant). A floor of 2–3 ms on a
  light frame is fine. render=gpu should make draw() free of readbacks. DT wants to discuss
  the hybrid model. Found so far: many drawings changing every frame is such a class
  (marketcharts, 2.7–3.3×); apps limited by the runtime cannot gain much (marketmap's script
  is 13 of the DOM main thread's 19.5 ms a frame).
- Scroll off the runtime's thread (DT, 2026-10-16): built 2026-10-18 (the plan's step 2). A
  compositor worker owns the canvas, the engine and the host's tree; the runtime worker sends
  it the MacHost commits; the runtime's synchronous calls (`measure`, `imageSize`) are answered
  by a measuring engine of its own (fonts loaded twice). Content the runtime has not built yet
  (rows a virtualized list has not made) shows blank until it arrives, as Chrome's checkerboard
  does. Heavy frames pipeline: the runtime makes the next while the compositor draws.
- Cost by layer, all four renderers (BENCHMARKS.md § Cost by layer): the runtime's work is the
  same everywhere (core 5.0 s in the DOM and render=gpu over 52 scenarios); the renderers differ
  in drawing and presentation. Findings for main: the canvas backend and MacBackend do not
  defer hidden views (stargate attract settles 909 / 1862 ms against the DOM's 260); the Mac
  host's main thread rasters text and drawings on the CPU (16.9 s, the largest layer of any).
  To find: sampler's DataGrid scroll spends 1654 ms on render=gpu's page thread.
- Moving sprites (above): keep as the default or not is DT's call. Drawings past 1100 pixels
  have a texture of their own (2026-10-18; up to 4096). Still open: least-recently-used eviction
  instead of clearing.
- Declare findings from Atlas (PATTERNS.md § Does Declare stretch): schema fields one array
  deep; no shared per-record fetched resource between views; no guard against a method
  looping without end (the page hangs); a `DataSource`'s `onLoad` fires after its view has
  left the tree, where `app` is the detached subtree's root (runtime, both renderers —
  for main).
- The engine's texture pool kept every size it was ever given (a leak; DT ran out of memory
  in Atlas): now held to 192 MB (layers.rs `Pool`). A two-axis spreadsheet is the next stretch:
  `virtualize` windows rows only.
- URL parameter (DT's pick): one parameter, `?render=dom|canvas|gpu`; `gpu` rather than
  `webgpu` since wgpu can run natively on Metal too. The hook is in `browser/boot-uniform.js`.
