# DOM against render=gpu — what a frame costs (2026-10-15)

`node gpu/versus.mjs` runs each scenario of gpu/census-scenarios.json (and Atlas's and
Murmur's) in the DOM renderer and in `?render=gpu`, alternating, two rounds, medians, in
headless Chrome 155 on an Apple M2 Max at 1280×800, 2×.

## The gate again (2026-10-19)

After steps 2–5, the memory fix and the browser's own page scroll; `versus.mjs`, three rounds,
ms a frame (renderer and GPU processes):

| Scenario | DOM | render=gpu | GPU process: DOM / gpu |
|---|---|---|---|
| Sampler DataGrid scroll | 21.2 | 7.7 | 1.7 / 1.8 |
| Marketmap chip: covid | 19.4 | 14.7 | 2.3 / 2.6 |
| Marketmap scrub | 21.6 | 19.8 | 2.2 / 2.9 |
| Calendar week → year | 13.5 | 13.7 | 1.8 / 3.5 |
| Tracker scroll | 4.4 | 7.3 | 0.8 / 2.9 |
| Weather idle (sky) | 1.3 | 7.5 | 0.6 / 3.8 |
| Docs scroll | 1.7 | 5.9 | 0.6 / 2.6 |
| Swatchbook Combined scroll | 4.5 | 14.0 | 2.9 / 8.4 |

Heavy frames: render=gpu wins where the app's own work is heavy (DataGrid 2.8×, Market Map's
chips 1.3×), ties elsewhere. Light frames: 1.3–4× the DOM (2–8× on 2026-10-15). What the rows
mean:
- **The floor is Chrome's.** A light frame now makes one submit and two passes (homepage
  idle; `&gpucalls`), the shape of the bare WebGPU page above, whose GPU process costs 2 ms.
  Our light frames' 2–3 ms of GPU process are that floor.
- **Not outliers, on a closer look:** homepage idle draws 53 frames because its calendar shot
  is a video at 25 a second (the DOM hands video to Chrome's compositor, no page frame);
  tempest's 9 ms of "GPU" is 5.5 ms of the GPU waiting for the worker's first submit and 2 ms of
  work; weather's pick city draws its change in 3 frames, about 120 ms in all against the
  DOM's 104 (the DOM's 65 frames are other work); "late" frames on docs, homepage and
  architecture scrolls are the harness's wheel, one event every 50 ms, each answered by a frame.
- **Docs' Reference tab** (25.5 / 35.4, heavy, runtime-bound): the measuring engine took 45 of
  the worker's 246 ms a frame, most of it reading glyph outlines for ink bounds no one asked
  for (7.4 ms) and looking up colour tables per run (4.4).

Changed after it (2026-10-20):
- **Kept groups and filter layers laid moved** by whole device pixels (a scroll): swatchbook
  Combined scroll's groups made 2.3 → 0.7 a frame, filters kept 2.5 → 8.3, quads passes 13 →
  5.7, GPU 6.0 → 3.8 ms (census, single runs). Pixels within one level of `&nokeep`.
- **GPU timing opt-in** (`&timing`; the census turns it on): its readback was a submit and a
  `mapAsync` every frame. Alternating, docs scroll 12.0 / 13.2 ms without it against 14.9 /
  15.1 with; DataGrid's GPU process 1.9 → 1.5 ms.
- **A line's ink measured only when asked** (engine `ink`; the runtime asks for "H" and "x"),
  and a face's colour tables looked up once: docs' Reference tab, the measuring engine's
  share of the worker about 182 → 88 ms over the scenario (sampled, single runs).

A second full gate run (2026-10-20, overnight) took four hours where the first took one, with
the DOM's own numbers up (docs scroll 1.7 → 3.2 ms) and a system daemon (`duetexpertd`)
holding a core: not comparable with the first, and not recorded. Docs scroll read 12–16 ms on
render=gpu there and after; switching off keeping (`&nokeep`) or turning timing back on does
not bring it down, so it is not one of the changes above. Whether it is load or a change
since the first run is open: to settle with an A/B against a build of the first run's tree.

## The host in Rust, in a compositor worker (2026-10-18)

The host (the tree the ops build, the paint walk, damage, scrolling, scroll layers) moved from
host.ts into the engine (engine/src/host/), and the canvas, the engine and the host moved into a
worker of their own (compositor.ts) beside the runtime's (README § How it is put together).
`node gpu/census.mjs --stages`, every scenario, against the TypeScript host in one worker the
day before; encode medians (walk, plan, submit), ms a frame. ⚠ Not back to back: the machine's
load varies, and that build no longer exists to alternate with, so the table below is only a
rough sign. The frame counts and the busy-runtime scroll are not comparisons and hold.

| scenario | before | now | | scenario | before | now |
|---|---|---|---|---|---|---|
| calendar month→week | 1.8 | 1.5 | | swatchbook Effects | 2.6 | 1.5 |
| calendar week→year | 2.4 | 1.9 | | swatchbook Combined | 3.9 | 1.9 |
| calendar next month | 1.9 | 1.3 | | swatchbook Combined scroll | 4.6 | 2.8 |
| tracker type search | 0.9 | 0.3 | | marketmap scrub | 2.5 | 1.8 |
| weather idle (sky) | 4.1 | 2.4 | | marketmap hover tiles | 2.5 | 1.8 |
| weather pick city | 4.2 | 2.1 | | desktop drag window | 1.3 | 1.1 |
| weather scroll main | 1.9 | 2.0 | | weather scroll cities | 0.7 | 1.2 |

- Lower in 40 of 51 scenarios, the same in 1. Higher in 10: weather's scrolls (0.7→1.2,
  1.9→2.0), architecture scroll (0.8→1.1), homepage idle (1.4→1.8), lzx-calendar →week
  (1→1.9), docs Reference tab (0.8→1.3), calendar hover cells (1→1.5), tracker hover rows
  (1.8→2.0), docs scroll and sampler Table tab (0.1 each). Most are scrolls through frosted or
  filtered content, which step 4 (keeping group and filter textures) addresses.
- The engine is built for speed now (opt-level 3, wasm-opt -O3): A/B over five apps, twice,
  encode 10–25 % lower than built for size (marketmap 2.3→1.9, calendar week→year 2.5→1.8,
  swatchbook Combined 3.4→2.6). The wasm is 893 KB brotli (740 for size; 826 with only the
  engine's own crate for speed, which gained about half).
- The census's runtime column (busy less encode) now holds both workers' time outside painting:
  the crossing (sending a flush, replaying its drawing calls, applying the commit, laying out
  its Texts) adds 0.3–0.8 ms a frame on light scenarios (tracker scroll 1.2→2.0, weather scroll
  cities 0.4→0.8, docs scroll 0.4→1.2) — on the compositor's thread, beside the runtime's.
- Frames a second are as before; a tick's frame waits up to 8 ms for the runtime's commit
  while the runtime sends them (without the wait, a frame drawn for a drawing to sharpen came
  beside each commit's: asteroids 120 frames a second for 60 commits).
- Large drawings kept (`node gpu/ab.mjs`, back to back, alternating, 4 rounds): a drawing past
  1100 pixels has a texture of its own, rastered once (it was Vello's every frame). Desktop drag
  window: GPU 8.13 → 1.84 ms a frame (the wallpaper; the GPU's waits between submissions 3.3 →
  0.5), encode 1.2 → 1.0; open calendar 3.80 → 2.16; menu File 2.56 → 1.90. Weather pick city
  23.1 → 15.1 (2 rounds). Marketmap and the games, which have no such drawing, the same within
  the rounds' spread.
- Plan buffers and bindings kept between frames (each plan's buffers rewritten in place; a
  texture's binding made once), A/B against a build that makes them every frame, 3 rounds:
  marketmap encode 2.0 → 1.5 ms, GPU 5.3 → 3.5 in all four scenarios; calendar GPU 3.4 → 2.6
  (month→week), 3.7 → 2.4 (year→month); swatchbook Effects 5.8 → 4.7; weather pick city
  16.0 → 8.1. Weather's city scroll read worse (encode 0.4 → 1.0, GPU 1.1 → 2.4), unexplained.
- Unchanged subtrees' walks and plans kept (host walk.rs KeptWalk, paint.rs Kept; `&nokeep`
  for the A/B, `&nokeepplans` for the plans alone), on my-apps/desktop-dense (the tracker and the
  market map open, a frosted band over them, gpu/census-dense.json): dragging the note over the
  tracker, kept walks cover 964 of the 1037 views a frame and 33 plans are replayed. Compositor
  CPU, sampled (worker-profile `--compositor`), off/on alternating, three rounds: 2.82/2.15,
  2.71/2.14, 2.61/2.12 ms a frame — a fifth less. The census's busy-time column is too coarse to
  show it (`node gpu/ab.mjs … --a "&nokeep"`: within its spread everywhere but the tracker
  scrolled under the frost, CPU 3.28 → 2.72, GPU 4.00 → 2.95). What a kept plan saves is small
  until it is laid as one block (one item over its union): laid item by item, the batching
  costs what planning does.
- Opacity groups and filter layers kept (paint.rs KeptGroup, the walk's `filter_made`; both off
  with `&nokeep`), A/B against the build before, alternating, 4 rounds, ms a frame:

  | scenario | GPU before | after | compositor before | after |
  |---|---|---|---|---|
  | swatchbook Effects tab | 5.24 | 1.44 | 1.53 | 1.41 |
  | swatchbook Combined tab | 3.93 | 2.62 | 2.98 | 2.30 |
  | swatchbook Combined scroll | 6.62 | 4.85 | 4.99 | 3.26 |
  | weather idle (sky) | 4.59 | 3.08 | 2.76 | 2.26 |
  | weather pick city | 11.21 | 7.73 | 4.77 | 4.95 |
  | docs expand Building | 7.93 | 4.59 | 3.40 | 3.00 |
  | marketmap zoom tile | 3.60 | 3.01 | 1.76 | 1.71 |

  Swatchbook Effects reuses 19.5 filter layers a frame, weather 9 groups. The rest within the
  rounds' spread (calendar and asteroids, which read worse, run again for 6 rounds: the same).
  Calendar and marketmap make groups whose content changes each frame and so gain nothing.
- No whole frame for a 3D view or a mask on screen: a change under a projected 3D view still
  makes the frame whole (its rects are in the view's plane), one in a mask's stencil damages the
  views it masks, and anything else is a region as usual. A/B, 6 rounds, swatchbook: Combined tab
  encode 1.2 → 0.2, GPU 1.97 → 0.59 ms; Transforms tab GPU 0.98 → 0.52; Effects tab 0.85 →
  0.52; Combined scroll the same; homepage (neither) the same. Region and whole frames compared
  after hovering and scrolling both tabs (`&nodamage` for the whole): the same but for one
  card's text edges, a projected texture placed from another corner.
- Moved subtrees laid again moved (step 5, without textures): a move that is not a resize no
  longer lapses the moved view's kept walk (only its ancestors'); a kept walk that culled nothing
  is laid again with every transform translated, and its subtree's painted rects moved. The
  census counts rigid moves in most moving scenarios (marketmap ~100 a frame of one view each,
  calendar week→year 21 carrying 914 views, stargate 36, desktop's window 1 of 43 views); the
  walks laid moved a scenario: calendar month→week 393, desktop drag 103, desktop-dense note
  drag 119, sampler 42–44. A/B, 4 rounds, compositor ms a frame: calendar month→week 1.61 →
  1.36, desktop drag window 1.00 → 0.92, desktop-dense drag 2.22 → 2.09 and 2.40 → 2.23; the
  rest within the spread (swatchbook, which read worse, 6 rounds: the same). Pictures after
  each moving scenario against `&nokeep`: the same.
- Moving layers (step 5): a subtree of 8 views or more whose kept walk is laid moved a second
  frame in a row is drawn into a texture over its reach (command 19 carries it) and laid at each
  new place without being planned; the frame after it rests it is drawn exactly again. A/B
  against moved walks alone, 5 rounds: desktop drag window compositor 1.19 → 0.90 ms, GPU 1.51
  → 1.11; swatchbook Combined scroll compositor 3.29 → 2.58, GPU 5.31 → 4.52, 20 → 25 frames a
  second; desktop-dense's note mixed (1.95 → 1.82 one way, GPU 1.84 → 2.36 back). Used where
  something large moves for frames on end: a dragged window or note, a scrolled card; most moved
  subtrees in the census are smaller (tracker rows, calendar events, marketmap tiles). Not for
  scaling motion (the dock's swell, a window opening, a zoom): the kept walk is laid moved only
  for a translation. gpu/census-motion.json adds weather's phone page (open, page, swipe,
  close), tracker's row open and close, desktop's dock, minimize and open, birds' card.
  Found: desktop's windows are under a shape clip, so all their content is a Vello item.
- Damage as several rectangles, tried and not kept. Each rectangle a walk of its own onto the
  same frame (a frost made whole in the last rectangle that holds it): on desktop-dense's drag
  (the note's rectangle and the frost band, 37 % of the screen) GPU 2.0 → 4.0 and compositor
  1.7 → 2.6 ms against the whole frame. With kept walks and plans a whole frame costs little on
  the CPU, and on the GPU a frame's cost is passes rather than pixels: each rectangle added
  Vello renders (5.2 a frame against 3.0) and quad passes. Without keeping, the rectangles won
  (GPU 3.3 → 2.7). Asteroids' four rocks in four rectangles cost more than its whole frame.
  What stays from it: a kept walk or plan serves any clip inside the one it was made under (a
  region frame no longer misses them), a kept walk whose reach misses the clip is skipped, and
  a drawing that paints nothing, or that was made in the flush that creates its view, has a
  reach (desktop-dense's drag frames had all been whole: two such 8×8 drawings counted as
  reaching everywhere). A/B against step 3's build, 3–5 rounds: within the spread but sampler
  menu open (runtime+compositor 15.6 → 10.1) and docs Reference tab (GPU 1.9 → 0.7).
- Scrolling while the runtime is busy (scratchpad busyscroll.mjs): tracker, the runtime's
  worker held busy 800 ms during a wheel scroll — 15 wheels, 15 frames drawn meanwhile, the
  list moving. With one worker the frames waited for the runtime.

## GPU time by stage (2026-10-17)

`node gpu/census.mjs --stages` splits each frame's GPU span (`gpuExec`) into its stages
(README § The quads, `&gpustages`). The span runs from the frame's start to its end on the
GPU's clock, so it includes the GPU waiting for the worker. The waiting splits in two: before
the frame's first submission (the host's walk and plan) and between submissions (a Vello
render encoded on the worker). Medians over the census, ms a frame, scenarios with 10 timed
frames or more:

| Scenario | Span | Wait, first | Wait, between | GPU work | of it quads | present copy |
|---|---|---|---|---|---|---|
| calendar month→week | 5.04 | 1.33 | 1.58 | 2.13 | 1.38 | 0.15 |
| calendar year→month | 5.10 | 1.05 | 1.95 | 2.10 | 1.73 | 0.19 |
| tracker scroll list | 1.63 | 0.61 | 0.16 | 0.86 | 0.07 | 0.26 |
| weather idle (sky) | 9.00 | 6.43 | 0.01 | 2.56 | 2.02 | 0.04 |
| weather scroll main | 6.66 | 3.37 | 0.14 | 3.15 | 1.78 | 0.08 |
| desktop drag window | 8.09 | 0.62 | 5.73 | 1.74 | 0.50 | 0.83 |
| desktop open calendar | 6.08 | 0.73 | 1.75 | 3.60 | 2.12 | 0.32 |
| marketmap scrub | 6.54 | 2.07 | 2.06 | 2.41 | 2.19 | 0.11 |
| marketmap zoom tile | 7.58 | 4.64 | 0.02 | 2.92 | 2.88 | 0.04 |
| tempest play | 7.29 | 5.10 | 0.28 | 1.91 | 1.21 | 0.11 |
| vortex play | 5.12 | 0.19 | 0.25 | 4.68 | 4.37 | 0.06 |
| swatchbook Effects | 10.26 | 4.75 | 0.25 | 5.26 | 2.01 | 0.23 |
| swatchbook Combined scroll | 9.70 | 1.19 | 2.49 | 6.02 | 3.79 | 0.22 |
| homepage idle | 1.99 | 0.63 | 0.31 | 1.05 | 0.04 | 0.77 |
| asteroids attract | 1.99 | 0.92 | 0.10 | 0.97 | 0.12 | 0.86 |

Over all 44 such scenarios: span median 3.1 ms, GPU work median 1.5 ms. The stamps cost GPU
time of their own (calendar month→week's span: 5.0 ms with them, 4.0 without), counted here
in the stages they close, so the work figures are if anything high.

- **The GPU's own work is small.** The "whole frame costs 4–7 ms of GPU" figures above
  (§ After the cleanup, PATTERNS.md § What the renderer should make cheap) were spans: about
  half of each was the GPU waiting for the worker. A whole frame's work is 1.4–2.9 ms
  (calendar, marketmap, weather, tempest), within PATTERNS.md's target of about 3 ms at 2×.
  Past it: swatchbook's Effects and Combined (20 filtered layers remade a frame), vortex play
  (4.4 ms of quads from 41 instances a plan: fill, not count, unexplained), desktop opening
  a window (3.6) and weather's main scroll (3.2).
- **The quads are most of the work**, and they come as many passes: an opacity group is a
  texture and a pass of its own (calendar 14–22 a frame, marketmap 31–42). Folding a group's
  alpha into its instances is exact only when nothing inside it overlaps, and the usual group
  (a card: its background and its text) overlaps, so that is not pursued.
- **The present copy** (the kept frame into the canvas's texture) is the largest work on a
  light frame: 0.6–0.9 ms on homepage idle, asteroids and the tracker's search, at 2560×1600.
- **The waiting is the worker.** Before the first submission it is the walk and plan
  (weather idle 6.4 ms, tempest 5.1, marketmap zoom 4.6). Between submissions it is Vello
  encoding on the worker, a render at a time (desktop's drag: 5.7 ms over 6 submissions). On
  the Mac host, that encoding runs natively and off the main thread.

So the remaining cost of a render=gpu frame is the worker's CPU (walk, plan, Vello encoding)
and Chrome's GPU process (BENCHMARKS § What WebGPU itself costs here), not the GPU.

Readbacks removed the same day: decoded images are copied on the GPU from their bitmaps (the
birds' 50 plates cost 128 ms of the worker's CPU to read back, 2.6 ms an image, and 123 MB to
upload); text shadows are blurred layers of the lines' own glyphs; stroked text in a drawing
is drawn by the engine. Left: a drawing with an SVG `url()` filter.

## Cost by layer, all four (2026-10-16)

`node gpu/costs.mjs` runs each scenario in the DOM renderer, the canvas renderer, render=gpu and
the Mac host ("Declare Mac GPU", built from this tree), and splits its CPU time into the layers
they share (the tool's header says how each is measured). These are 52 scenarios: the census
and the stress set. Below are seconds summed over all of them; per scenario, ms over the whole
scenario, follow after that.

| layer | DOM | canvas | gpu | Mac |
|---|---|---|---|---|
| app (compiled program) | 1.1 | 2.5 | 1.4 | JS, unsplit: 13.3 |
| runtime core | 5.0 | 6.0 | 5.0 | ↑ |
| drawing (recording draw()) | 0.9 | 0.6 | 0.1 | ↑ |
| text measure | 0.5 | 0.6 | 0.4 | 0.2 |
| GC on the runtime thread | 0.3 | 0.9 | 0.5 | ↑ |
| adapter (renderer-specific runtime) | 1.8 | 5.1 | 0.3 | ↑ |
| renderer (gpu: host + engine; Mac: main thread) | — | — | 6.5 | 16.9 |
| native on the runtime thread (DOM: style, layout, paint) | 6.5 | 2.3 | 0.4 | — |
| crossing (gpu: page thread + worker glue; Mac: decoding) | — | — | 3.5 | 1.2 |
| compositor thread | 1.4 | 0.9 | 0.2 | — |
| JS engine background (GC, JIT) | 3.9 | 7.3 | 6.7 | 7.3 (other threads) |
| GPU process (Mac: WindowServer above idle) | 23.3 | 16.7 | 18.2 | 0.8 |
| **total** | **45.0** | **43.2** | **43.7** | **39.7** |
| settle meter (the same counter in all four) | 12.4 | 10.8 | 9.5 | 12.2 |
| cheapest scenarios | 28 | 14 | 1 | 9 |

- **The runtime's work is the same in every renderer.** Runtime core is 5.0 s in the DOM and
  in render=gpu, and app code 1.1 against 1.4. Canvas is higher (6.0, 2.5), partly because it draws hidden
  views (stargate, below). This work, about 7.5 s of the 45, is fixed: no renderer
  changes it.
- **The renderers differ in how they draw, and in presentation.** Each renderer's drawing sits
  in different rows, so compare their sums. On the thread that makes the frame (drawing +
  adapter + native + renderer): DOM 9.4 s (style, layout and paint 6.6, DOM calls 1.9),
  canvas 8.2 (`canvas-backend.ts` 4.8, with the Canvas 2D calls it makes; native 2.4),
  render=gpu 7.3 (engine 4.9, host 1.2, drawing.ts 0.5), plus 3.6 of crossing. Rastering is not
  on that thread in any Chrome renderer: it is in the GPU process (Skia for the DOM and
  canvas; our WebGPU work for render=gpu), 23.4 / 16.8 / 18.3 s. The Mac host's main thread (16.9 s) is the most expensive:
  text layers and drawings are rastered on the CPU there (swatchbook's tabs: 390–535 ms on the
  Mac against 35–60 in the DOM; homepage scroll 739 against 107).
- **The GPU process dominates every Chrome renderer**, and most of the DOM's is marketcharts
  (14.4 s of its 23.3). Without it the DOM is cheapest. render=gpu's GPU process costs 2–3× the
  DOM's on light scenarios (sampler switch: 70 against 30 ms; homepage scroll: 690 against
  110): that is the per-frame present floor.
- **render=gpu's fixed overhead** is the crossing: about 25 ms per scenario at rest (the page
  thread relaying, the worker's glue). Its worker also pays more background GC and JIT than the
  DOM's main thread (6.7 against 3.9 s). One outlier: sampler's DataGrid scroll spends 1654 ms
  on the page thread, so something there runs per frame on the page (to be found).
- **Drawing-heavy apps:** marketcharts costs 9.8–10.3 s in the DOM, 2.7–2.8 in canvas,
  2.6–2.9 in render=gpu and 3.3–4.9 on the Mac. The canvas renderer matches render=gpu there,
  and wins on tempest (1.3 against 2.7–2.9 s). render=gpu is cheapest in only one scenario.
- **Hidden views:** only the DOM backend defers views that start hidden (`defersHidden`).
  render=gpu does through its worker's subclass (2026-10-16). The canvas renderer and the Mac
  host draw them every frame: stargate attract settles for 260 ms in the DOM, 909 in canvas,
  1862 on the Mac. That is a runtime fix for main.
- **JavaScriptCore against V8:** the Mac's JS (13.3 s) is 1.7× render=gpu's (7.7 s: app, core,
  drawing, GC and the same MacBackend adapter). Part of that is the hidden views above
  (stargate alone: 3.6 s of the Mac's JS against 0.7).

Caveats. The Mac's `frames` is its runtime's commits: a scroll the host does on its own
commits nothing, so read Mac rows as totals, not per frame. The Mac rig cannot press and hold a
key (the games' play steps) or type into a native field (tracker's search), so those Mac rows
measure less input than the others. WindowServer serves the whole machine: its row is its
CPU above its idle rate, at ps's 10 ms grain. The trace that does the sampling costs the worker
more than the page. Each scenario ran once.

```
ms over the scenario: js = runtime JS, rend = renderer, x = crossing, bg = background threads, pres = GPU process / WindowServer
                                            dom       fr    js  rend     x    bg  pres total |canvas    fr    js  rend     x    bg  pres total |gpu       fr    js  rend     x    bg  pres total |mac       fr    js  rend     x    bg  pres total
calendar · month→week                                 59    43    94     ·    75   100   313 |          57   223    28     ·   409   330   990 |          57    47   110    28   101   250   536 |         111   121   120    38    82    52   413
calendar · week→year                                  46   213   141     ·   280   120   754 |          45   356   144     ·   192   210   902 |          48   153   193    29   311   230   916 |          86   261   316    67   276    73   993
calendar · year→month                                  1   2.5   1.4     ·   1.2    10    15 |           2   4.0   1.8     ·   5.2    10    21 |           1   2.6   1.2    26   8.2    10    48 |           1   4.2    14     ·   7.9     ·    26
calendar · next month                                  2    23    15     ·    21    20    80 |           2    20   4.1     ·    18    10    52 |           2    21   9.1    26    30    30   116 |           1    21    22   2.7    28     ·    74
calendar · hover cells                                 1    11    12     ·   9.7    10    43 |          41    50    20     ·    28    50   148 |           1    13   3.6    34    13     ·    63 |          40    79   123   1.8    64     ·   267
tracker · scroll list                                106   119   140     ·    91    80   430 |         123   301    87     ·   235   150   773 |          61    60    71    55   114   200   500 |          45   254   181   7.2   143     ·   585
tracker · hover rows                                  15    40    34     ·    22    20   116 |          15    54    15     ·    43    30   142 |          13    50    18    35    50    40   194 |          13   208   111   0.7   114     ·   434
tracker · type search                                 60   104    87     ·    85    60   336 |          59   115    55     ·    90    60   320 |          57    81    49    32   124   130   415 |           0   6.3    18     ·   6.6     ·    31
tracker · 10K→100K                                    70   347    88     ·   262    60   757 |          67   373    20     ·   258    50   701 |          67   369    79    27   243   180   897 |         112   373   171   8.4   296     ·   849
weather · idle (sky)                                  18   4.8    22     ·    17    60   104 |          18    99    18     ·   199   270   587 |          19   5.0    34   2.2    13    80   134 |          19    38   323   1.5    70     ·   432
weather · scroll main                                121    11    71     ·    70   320   472 |         116   578    71     ·   658  2110  3418 |          86    19   180    51   102   440   792 |          25    45   679   1.7   114     ·   841
weather · scroll cities                               95    17    78     ·    58   200   353 |         132   551    91     ·   612  1740  2994 |          89    18   103    75    59   330   585 |          27    45   806   1.1   115     ·   967
weather · pick city                                    1    25    14     ·    23    40   102 |          17   113    16     ·   239   270   637 |           1    15    17    43    40    40   156 |          16    47   254   2.4    49     ·   352
desktop · drag window                                 51    29    81     ·    57   100   267 |          52    57    32     ·    43    90   222 |          52    25    75    41    51   230   422 |          49   125   129   2.0   105     ·   361
desktop · open calendar                               64   102    89     ·   163   130   484 |          70   165   100     ·   128   130   522 |          72    78   117    48   148   350   741 |         139    95    65   5.8   254     ·   420
desktop · menu File                                    2   8.2    17     ·   5.9    20    52 |           2    12   2.7     ·    18    10    43 |           2   7.8   4.7    26    12    30    80 |           1    16    22   0.5    47     ·    85
birds · scroll grid                                  123    18    77     ·   197   140   432 |         162   146   176     ·    92   340   755 |         117    24   109    55    83   350   621 |         123    85   120   5.5    75     ·   286
birds · hover cards                                  116    58    81     ·    67   150   357 |         112    83    35     ·    58   210   386 |         107    57    70    39    63   280   508 |         288   363   242    20   207     ·   831
birds · open card                                     26    17    16     ·    31    50   114 |          40    30    32     ·    35    80   177 |          32    14    35    33    42   120   243 |          61    32    40   3.2    44     ·   120
docs · scroll page                                    62   5.5    54     ·    29    50   139 |          75    67    75     ·    65    90   297 |         109    12    50    77   100   220   458 |           0    24   270     ·    51     ·   344
docs · expand Building                                 2   4.9    26     ·   3.2    10    44 |           2   6.7   3.1     ·   5.8    10    26 |           2   4.0   3.9    25    12    20    65 |           1   5.0   7.3   0.1   5.7     ·    18
docs · Reference tab                                  31   521   109     ·   337    50  1016 |          31   637    48     ·   410    50  1146 |          11   585   295    34   555    90  1559 |           1   482   749    42   339     ·  1612
sampler · switch+check                                27    12    28     ·    14    30    85 |          27    18   8.2     ·    18    30    74 |          27    16    18    26    40    70   170 |          50    46    46   1.7    27     ·   119
sampler · drag slider                                 42    26    51     ·    30    50   158 |          44    59    25     ·    37    60   181 |          40    26    26    36    50   100   238 |          41    96   124   2.4    73     ·   295
sampler · accordion                                   26    18    30     ·    18    40   107 |          27    27   9.1     ·    17    30    83 |          27    15    28    25    33   100   202 |          50    32    32   1.6    41     ·   105
sampler · menu open                                    2    11    16     ·   6.4    10    43 |           2    12   2.3     ·    11    20    46 |           2    11   3.3    23    22    30    89 |           1    13    11   0.8    15    17    57
sampler · Table tab                                   34   7.4    33     ·    15    40    95 |          34    11    27     ·    15    30    83 |          34   8.0    22    27    24    90   172 |          64    17    38   1.6    13     ·    70
sampler · DataGrid scroll                            142   532  1430     ·   407   220  2589 |         122   622   212     ·   379   180  1393 |         143   273   191  1654   453   380  2951 |          60   261  1163    18   246     ·  1688
swatchbook · Effects tab                              40   6.9    35     ·    23    50   115 |          39    37    26     ·    15    70   148 |          40    20   116    28    82   220   467 |          77    16   387   1.3    17   3.6   424
swatchbook · Transforms tab                           41    10    42     ·    25    40   118 |          41    23    27     ·    14    50   115 |          41   9.3    54    29    32   140   264 |          79    17   402   1.5    22   1.5   444
swatchbook · Drawing tab                              43    11    45     ·    21    50   127 |          42    20    24     ·    15    40    99 |          43   8.5    41    30    22   110   211 |          82    17   414   1.3    16     ·   448
swatchbook · Combined tab                             43    15    58     ·    31    60   164 |          43    49    26     ·    56    70   201 |          44    20   196    28    79   460   783 |          81    17   535   1.4    72     ·   625
swatchbook · Combined scroll                         104   5.6    46     ·    29    50   131 |          99   255    71     ·   655   250  1231 |          38    12    42    53    78   150   334 |           0    17   161     ·    21     ·   200
marketmap · scrub timeline                            79  1140   543     ·   334   220  2238 |         122  1941    78     ·   357   760  3137 |          87  1096   346    45   323   430  2241 |          88  1320  1834   270   505   118  4047
marketmap · chip: covid                               70  1013   481     ·   298   450  2243 |          88  1442    49     ·   301   840  2633 |          79  1084   333    30   302   550  2299 |          55   898  1251   191   475     ·  2815
marketmap · hover tiles                               13    17    42     ·    20    30   109 |          13    57    14     ·    36    60   167 |          11    23    40    34    56    60   213 |          11    71    79   0.8   105     ·   256
marketmap · zoom tile                                 14    52    47     ·    43    90   233 |          14   112   5.9     ·    48   130   296 |          15    39    82    27    72   160   380 |          25    76    59   7.6    89     ·   231
homepage · idle                                       50   0.1   0.7     ·    11    40    52 |         118    38    20     ·    40   200   298 |          49   3.3    40    43    39   260   385 |           0   2.1    16     ·    39     ·    57
homepage · scroll                                    133    14   107     ·    64   110   295 |         177   113   111     ·    92   310   625 |         143    29   159   108   172   690  1159 |         126    40   739   2.5    50     ·   831
architecture · scroll                                 61   7.3    60     ·    36    50   153 |         121   133    97     ·   118   110   458 |          60   7.5    47    53    49   180   337 |           0    25   168     ·    29     ·   221
lzx-calendar · →week                                   2   5.9    14     ·   3.6    10    34 |           2   5.8   1.5     ·    11     ·    18 |           3   5.7   3.1    26    22    20    76 |           1   5.3    10   0.1   9.5     ·    25
lzx-calendar · →month                                  1   3.2   1.7     ·   1.6    10    16 |           1   3.3   1.4     ·   3.0     ·   7.8 |           1   2.6   0.8    26   8.5     ·    38 |           0   3.9    11     ·   8.3     ·    23
lzx-dashboard · guest                                  2   3.4    17     ·    12    30    62 |           2   7.7    12     ·   6.4    20    46 |           2   3.7    18    27    48    20   117 |           1   4.7    37     ·    14     ·    55
games/tempest · attract                               92   280    88     ·   148  1500  2016 |          83   317    36     ·   185   800  1338 |         123   243   406    14   478  1590  2731 |          83   457   171   8.3   367     ·  1003
games/tempest · play                                  90   336    78     ·   148  1760  2322 |          83   312    31     ·   168   740  1251 |         125   273   450    43   411  1750  2926 |          83   385   138   8.6   174     ·   706
games/vortex · attract                                87    39    26     ·    42   150   257 |          87    46    19     ·    48   120   233 |          88    31   103   5.3    81   490   711 |         258   250   181    13    80     ·   523
games/vortex · play                                  180   342   119     ·   260   550  1272 |         180   597    56     ·   293  2150  3096 |         179   240   621    33   387  2500  3780 |           8    66    60   0.5    33     ·   160
games/stargate · attract                             102   227    48     ·   119   250   643 |         178   842    38     ·   179   270  1330 |         177   225   329    10   215   570  1349 |         181  1795    98   4.8   440     ·  2338
games/stargate · play                                182   562   178     ·   250   940  1930 |         183  1566    85     ·   449   940  3040 |         179   477   407   117   334   820  2155 |         181  1791   416   7.5   484     ·  2699
games/asteroids · attract                            180    70    65     ·    71    90   296 |         179    93    37     ·    68   360   558 |         179    68   108   6.9    86   430   699 |         181   187    99   9.3    92     ·   388
games/asteroids · play                               167   105    74     ·    69   270   518 |          57    72    30     ·    63   370   534 |         166    91   153    34   117   590   985 |         181   200   104   9.9    63     ·   377
marketcharts · scrub timeline                         67  2247  1008     ·   766  5790  9811 |          82  1605    85     ·   458   590  2739 |          62   967   525    49   466   610  2616 |          75  1626  2060   249   693   251  4878
marketcharts · chip: covid                            29  1012   397     ·   318  8570 10297 |          70  1430    51     ·   418   900  2799 |          54   919   476    34   442  1070  2941 |          46  1035  1307   169   511   240  3262
```

## Corrected (2026-10-16)

Read this section first: it replaces the findings below it where they differ.

**The measures were wrong in render=gpu's favor in two ways, now fixed:**
- The worker's busy time missed the runtime's settle, which runs as a microtask after each
  callback. It reported about a sixth of the real time (stargate: 0.7 ms a frame against 5.5
  traced). It now ends after that microtask, once for nested callbacks (env.ts `timed`), and
  agrees with a trace of the worker within tracing's own cost.
- The worker painted up to twice per display tick: once when a change landed (an image, a
  commit) and again after the tick's flush. Only one of them can reach the screen, and the
  cheap second paint lowered the average per frame. Now it paints once per tick (host.ts
  `frame` asks for a tick, `paintNow` paints).

**What was fixed in the renderer:**
- **Hidden views:** MacBackend made a surface for every view and recorded the drawings of
  views no one could see. The DOM backend defers a view that attaches hidden; the worker's
  backend now does too (`&eagerhidden` for the A/B). Stargate's attract went from 9.7 to
  5.8 ms a frame, and from 30 late frames to none.
- **Batching:** an item joins the earliest segment of its kind it can reach without passing
  one it overlaps, so a map of tiles is three segments, not three per tile (paint.rs
  `earliest`). Marketcharts went from 157 Vello renders a frame to 8.
- **Shadows in drawings** run on the GPU, as filter layers, gathered so that all of a frame's
  layers share one Vello render. There is no readback for them any more. Tempest went from
  21 ms a frame (CPU raster) to 17.9.
- **Moving sprites** were sampled without premultiplying alpha, which drew soft edges too
  bright.

**Where the worker's thread goes:** in apps limited by the runtime, both renderers run the
same script. Marketmap's DOM main thread spends 19.5 ms a frame, of which 13.2 is script and
about 5 is Chrome's style, layout and paint (`gpu/threads.mjs --dom`). The worker runs the
same 12–15 ms. A renderer can win at most Chrome's share.

**Where render=gpu wins clearly: many drawings that change every frame.** Marketcharts
(marketmap with a chart in every tile, gpu/census-stress.json):

| Scenario | DOM ms a frame (frames) | GPU ms a frame (frames) |
|---|---|---|
| scrub timeline | 112 (71, 68 late) | 40.9 (70, 13 late) |
| covid flight | 107 (35, 33 late) | 32.9 (76, 2 late) |

The DOM spends 66–69 ms a frame in the GPU process rastering the tiles' canvases.

**Atlas is about level, not ahead:** with one paint per tick its flights draw the same number
of frames in both, at 10.3–13.8 ms against 12.6–15.1 (Paris → Tokyo: 13.4 against 13.1).

**Ordinary apps cost 1.2–3× the DOM's CPU a frame**, with the browser's floor (a full-canvas
present, 3–4 ms in the GPU process) a large part of a light frame. The scroll rows' frame counts
and late frames do not compare like for like. The scenarios' wheel events (40 px, about every
33 ms) are a trackpad's to Chrome, which moves the page once per event without animating.
Both renderers show one new position per event. The DOM's second frame per event is the
runtime's, with no new position, so it halves the DOM's cost per frame and its gaps. Per wheel
event, render=gpu costs about 1.7× the DOM (tracker: 18.7 ms against 11).

**Outliers still unexplained:** weather idle (16 ms of GPU execution a frame for a drifting
sky), vortex play (9.3 ms of GPU execution), and the first frame after idle (100–180 ms).

### The table (2026-10-16, after the fixes above but before gathered layers)

Tempest after gathered layers: attract 17.9 (DOM 9.8), play 18.4 (DOM 11.8).

| Scenario | DOM frames | DOM ms (thread, gpu proc) | GPU frames | GPU ms (thread, gpu proc) | GPU exec | late DOM / GPU |
|---|---|---|---|---|---|---|
| calendar · month→week | 57 | 7.5 (3.3, 2.3) | 56 | 9.5 (2.7, 4.4) | 7.67 | 0 / 0 |
| calendar · week→year | 55 | 11.5 (4.8, 2) | 47 | 13.6 (4.9, 3.2) | 4.78 | 3 / 1 |
| calendar · year→month | 47 | 9.4 (4, 1.9) | 47 | 8.5 (3.2, 3.6) | 6.55 | 0 / 0 |
| calendar · next month | 1 | 110 (32.9, 10) | 1 | 70 (15.4, 0) | 1.57 | 0 / 0 |
| calendar · hover cells | 37 | 3.3 (1.8, 0.5) | 1 | 180 (46.3, 40) | 21.1 | 6 / 0 |
| tracker · scroll list | 118 | 5.7 (3.4, 1.1) | 62 | 18.1 (5.7, 6.5) | 2.69 | 14 / 61 |
| tracker · hover rows | 40 | 7.9 (4, 1) | 12 | 28.3 (10.7, 5) | 4.46 | 6 / 11 |
| tracker · type search | 65 | 7.7 (3.4, 1.7) | 57 | 11.3 (3.4, 4.4) | 1.97 | 2 / 4 |
| tracker · 10K→100K | 85 | 11.3 (5.9, 1.7) | 70 | 13.3 (6.3, 3.9) | 1.57 | 3 / 6 |
| weather · idle (sky) | 122 | 3 (0.9, 1.4) | 20 | 22 (7.6, 10.5) | 16.06 | 6 / 19 |
| weather · scroll main | 164 | 6.8 (1, 4.4) | 90 | 14.1 (3.8, 6.9) | 9.7 | 12 / 43 |
| weather · scroll cities | 158 | 5.4 (1.2, 3) | 88 | 15.6 (3.9, 8) | 4.13 | 12 / 64 |
| weather · pick city | 91 | 2.1 (0.8, 0.7) | 3 | 53.3 (14.6, 20) | 5.77 | 24 / 1 |
| desktop · drag window | 104 | 4.7 (2.6, 1.4) | 57 | 11.4 (2.9, 5.9) | 10.49 | 4 / 0 |
| desktop · open calendar | 77 | 8.3 (2.3, 1.9) | 74 | 11.2 (2.8, 5.1) | 3.67 | 3 / 3 |
| desktop · menu File | 19 | 5.3 (1.5, 2.9) | 15 | 10.7 (2, 4.7) | 2.75 | 2 / 1 |
| birds · scroll grid | 163 | 5.2 (1.1, 1.6) | 122 | 11.6 (2.2, 5.9) | 3.34 | 7 / 47 |
| birds · hover cards | 119 | 5.6 (2.1, 2.3) | 43 | 9.8 (2.7, 3.7) | 2.1 | 0 / 0 |
| birds · open card | 40 | 4.2 (1.1, 1.5) | 31 | 10 (2.1, 5.3) | 4 | 3 / 0 |
| docs · scroll page | 121 | 3.5 (1.2, 1.2) | 60 | 19 (2.6, 8.8) | 3.41 | 8 / 59 |
| docs · expand Building | 1 | 30 (5.8, 10) | 1 | 30 (5.1, 20) | 5.9 | 0 / 0 |
| docs · Reference tab | 30 | 28.7 (16.9, 2) | 25 | 54.4 (28.6, 3.6) | 1.7 | 2 / 1 |
| sampler · switch+check | 27 | 5.6 (2.5, 1.9) | 26 | 8.8 (1.4, 5) | 1.64 | 3 / 1 |
| sampler · drag slider | 80 | 4.3 (2, 1.1) | 40 | 11.2 (2.1, 4.7) | 1.44 | 3 / 7 |
| sampler · accordion | 26 | 4.6 (1.7, 1.9) | 26 | 8.1 (1.4, 3.8) | 1.77 | 0 / 0 |
| sampler · menu open | 2 | 15 (5.2, 5) | 1 | 30 (8.1, 10) | 5.24 | 1 / 0 |
| sampler · Table tab | 35 | 4.9 (1.3, 2.3) | 1 | 20 (3.4, 10) | 3.21 | 2 / 0 |
| sampler · DataGrid scroll | 108 | 20.5 (15.4, 1.5) | 122 | 21.1 (3.7, 2.5) | 3.34 | 47 / 53 |
| swatchbook · Effects tab | 40 | 5.5 (1.8, 2.5) | 39 | 11 (2.9, 5.4) | 9.18 | 0 / 0 |
| swatchbook · Transforms tab | 33 | 5.2 (1.5, 2.4) | 33 | 8.2 (2.2, 4.5) | 4.06 | 0 / 0 |
| swatchbook · Drawing tab | 38 | 5 (1.5, 2.1) | 36 | 7.8 (2.1, 4.4) | 3.15 | 1 / 0 |
| swatchbook · Combined tab | 37 | 6.2 (2, 2.4) | 36 | 19.7 (3.9, 9.7) | 6.09 | 1 / 0 |
| swatchbook · Combined scroll | 122 | 7.5 (1.3, 4.2) | 73 | 26.4 (6.4, 13.8) | 9.83 | 9 / 52 |
| marketmap · scrub timeline | 139 | 20.5 (15.2, 2.2) | 99 | 20.1 (12, 3.9) | 6.75 | 1 / 2 |
| marketmap · chip: covid | 94 | 18 (13.8, 2.2) | 94 | 15.8 (10, 3.4) | 6.82 | 0 / 17 |
| marketmap · hover tiles | 92 | 11.8 (8.9, 2.1) | 115 | 16.2 (10.5, 4) | 7.08 | 8 / 0 |
| marketmap · zoom tile | 18 | 10.7 (3.8, 4.7) | 63 | 27.7 (15.5, 7.9) | 10.42 | 1 / 1 |
| homepage · idle | 1 | 210 (8.8, 130) | 54 | 19.1 (2.9, 11.3) | 2.88 | 0 / 53 |
| homepage · scroll | 132 | 6.2 (2.3, 2.2) | 147 | 16 (2.7, 8.9) | 3.41 | 3 / 69 |
| architecture · scroll | 121 | 3.8 (1.3, 1.3) | 60 | 17 (2.6, 9) | 3.41 | 2 / 59 |
| lzx-calendar · →week | 1 | 60 (18.1, 20) | 2 | 30 (4.2, 10) | 3.74 | 0 / 0 |
| lzx-calendar · →month | 37 | 8.1 (1.6, 4.9) | 31 | 8.1 (2.1, 4.2) | 2.95 | 1 / 0 |
| lzx-dashboard · guest | 17 | 5.9 (1.9, 2.9) | 14 | 10.7 (2.1, 3.8) | 1.25 | 4 / 0 |
| games/tempest · attract | 162 | 9.9 (2.1, 6.6) | 124 | 37.5 (9, 23.1) | 1.11 | 28 / 83 |
| games/tempest · play | 146 | 10.5 (2.1, 7.5) | 126 | 39.6 (9.5, 25) | 1.51 | 39 / 82 |
| games/vortex · attract | 74 | 6.6 (1.6, 3.4) | 75 | 12.4 (2.7, 6.2) | 2.36 | 1 / 1 |
| games/vortex · play | 190 | 6.9 (2.9, 2.3) | 183 | 14.5 (3.3, 8.7) | 8.98 | 1 / 1 |
| games/stargate · attract | 184 | 5.5 (2.8, 1.4) | 188 | 8.8 (3.7, 3) | 2.95 | 6 / 2 |
| games/stargate · play | 188 | 9.9 (4.3, 3.5) | 187 | 11.8 (5.6, 2.8) | 5.83 | 0 / 0 |
| games/asteroids · attract | 189 | 3.8 (1.7, 1) | 189 | 9.2 (2.3, 5.1) | 2.56 | 0 / 0 |
| games/asteroids · play | 182 | 3.2 (1.4, 0.9) | 152 | 11.8 (3, 5.9) | 2.36 | 4 / 0 |


## How a frame's cost is measured

The two renderers work in different places, so the measure is what both have: CPU time per
frame drawn.
- **Frames drawn:** for the DOM, the frames Chrome ran a rendering update in (its trace's
  Layerize); for render=gpu, the frames the worker drew.
- **ms/frame:** CPU time of the renderer and GPU processes (from `ps`), divided by frames.
  The browser process is left out: its time here is the test harness's.
- **In brackets:** the thread that makes the frame (the DOM page's main thread, or our
  worker), then the GPU process.
- **GPU exec:** render=gpu's own GPU execution per frame. The DOM has nothing to compare.
- **Late:** frames over 25 ms after the one before.

A scenario of a single frame (a click with no animation) puts a whole interaction's cost on
one frame: compare those rows across, not down.

## What it shows (2026-10-15; corrected above)

- **The thread that makes the frame is far cheaper in render=gpu** (wrong: the worker's busy
  time missed the runtime's settle; see Corrected):
  - the worker spends 1–3 ms a frame where the DOM's main thread spends 1–17;
  - marketmap's scrub: 3.2 against 17.5;
  - the sampler's data grid: 1.4 against 16.7;
  - docs' Reference tab: 7.1 against 16.2.

  The runtime and the walk are not the problem.
- **The GPU process costs 2–5 times what Chrome's own drawing costs there:** 4–18 ms a frame
  against 1–5. That is overhead, not drawing: our measured GPU execution is 1.5–9 ms. A
  calendar transition makes about 660 WebGPU calls a frame:
  - 22 submits and 20 render passes;
  - 70 new buffers (each mapped and unmapped);
  - 63 new bind groups and 9 new textures.

  A scroll frame that only lays kept tiles makes 130, with 10 submits (`&gpucalls`).
- **So, overall:** render=gpu costs more CPU a frame than the DOM in most scenarios, about
  the same in marketmap and the data grid, and less in Atlas's flights (7–11 ms against
  13–15), where the DOM redraws the tiles' canvases (wrong: render=gpu drew extra frames;
  see Corrected).
- **Scrolling draws fewer frames in render=gpu.** It draws one frame per wheel event, while
  Chrome animates its scroll at the display's rate (tracker: 77 frames against 118). It shows
  as late frames.
- **A frame after idle:** costs 100–260 ms of CPU in render=gpu (calendar hover, weather pick,
  Murmur's answer arriving). The DOM pays nothing like it.
- **Stargate,** as DT saw: 10.5–12.9 ms a frame against 5.4–9.9, and more late frames. In
  headless Chrome its pictures match the DOM's in attract and play; the bugs DT saw aren't
  reproduced here yet.

## What WebGPU itself costs here

A bare WebGPU page with no engine: a 2560×1600 canvas presented every frame, the content a
dot, organized four ways. CPU per frame, the same measure as above:

| Each frame | Renderer process | GPU process |
|---|---|---|
| One submit, one pass, present | 0.9–1.0 ms | 2.0 ms |
| 20 submits | 1.4 | 4.1 |
| 20 passes in one submit | 0.6 | 1.3 |
| 70 new buffers and bind groups, one pass | 1.1 | 2.5 |

- **A floor:** presenting a WebGPU canvas costs about 3 ms of CPU a frame before anything is
  drawn. Chrome's own compositing of a DOM frame is in the same range or below.
- **Submits cost:** about 0.1 ms each in the GPU process. Our frames make 10–28.
- **Passes and allocations are cheap by comparison.**

So of render=gpu's 4–18 ms in the GPU process, about 2 ms is the floor and the rest is ours.

## After the cleanup (the gate)

The gate: after the WebGPU cleanup, render=gpu should beat the DOM by about 1.5× on heavy
frames and come within about 20% on light ones, or it doesn't justify itself in the browser.

What changed:
- **One encoder a frame:** the frame's commands go into one encoder, submitted at present, or
  before a Vello render (which submits its own). Submits went from 10–28 a frame to 3–4.
- **Text fields moved only when their box changes:** they used to be restyled on the page
  every frame.
- **Not done, deliberately:** keeping buffers and bind groups in place. The bare WebGPU test
  above puts 70 of each at about 0.4 ms a frame.

The measure was also corrected: pages warmed for 6 s (V8 finishing the wasm), three rounds,
and render=gpu's side untraced (tracing its worker inflated it).

| Scenario | DOM ms/frame | render=gpu ms/frame | GPU process: DOM / gpu |
|---|---|---|---|
| Calendar month → week | 5.4 | 9.6 | 1.4 / 4.4 |
| Calendar week → year | 11.7 | 13.7 | 1.7 / 3.3 |
| Tracker scroll | 5.3 | 12.2 | 0.8 / 4.3 |
| Weather idle (sky) | 2.0 | 16.0 | 0.9 / 8.0 |
| Weather scroll | 6.1 | 11.6 | 4.1 / 6.3 |
| Docs scroll | 3.4 | 12–19 | 1.2 / 5.8–8.7 |
| Marketmap scrub | 22.4 | 21.8 | 2.3 / 4.2 |
| Stargate play | 9.9 | 13.6 | 3.5 / 2.6 |

**The gate is not met.** Heavy frames tie at best; light frames cost 2–8× the DOM's.

What's left is mostly structural:
- **The WebGPU floor:** about 3 ms of CPU a frame, before anything is drawn.
- **A full-screen copy into the canvas each frame:** the kept frame is blitted to the canvas.
- **The worker's own time:** about 3 ms a frame when traced. Its self-reported busy time
  undercounts by about half.
- **The GPU process:** our main-thread share there is near the bare floor (2.7 ms against 2.0
  in a traced tracker scroll). The rest of its time is in threads the trace doesn't show
  (Metal, the driver).

Where render=gpu does win in the browser is the thread that runs the app: 1–3 ms a frame
where the DOM's main thread spends up to 17 (marketmap), leaving the page's main thread free
for input. That is responsiveness, not total cost.

Single runs still vary: docs' scroll measured 12 and 19 ms in two runs of this method.

## The table

| App · scenario | DOM frames | DOM ms/frame (main, GPU proc) | GPU frames | GPU ms/frame (worker, GPU proc) | GPU exec | late DOM / GPU |
|---|---|---|---|---|---|---|
| calendar · month→week | 57 | 7.5 (3.1, 2.3) | 57 | 11.4 (1.7, 6) | 5.9 | 0 / 0 |
| calendar · week→year | 57 | 12.8 (5.6, 2.1) | 48 | 16.9 (2.5, 5.2) | 4.52 | 4 / 0 |
| calendar · year→month | 47 | 8.9 (4.4, 2.1) | 48 | 12.8 (2.1, 6.8) | 5.37 | 0 / 0 |
| calendar · next month | 1 | 50 (19.9, 10) | 1 | 40 (4.5, 10) | 1.31 | 0 / 0 |
| calendar · hover cells | 39 | 3.8 (1.9, 0.8) | 1 | 260 (26.4, 50) | 26.41 | 10 / 0 |
| tracker · scroll list | 118 | 6.1 (3.5, 1.2) | 77 | 15.2 (1.8, 6.6) | 2.16 | 15 / 61 |
| tracker · hover rows | 38 | 5.3 (3.2, 0.8) | 13 | 28.5 (5, 6.9) | 2.75 | 9 / 12 |
| tracker · type search | 67 | 7.6 (3.7, 1.8) | 64 | 9.7 (2.2, 3.8) | 1.44 | 3 / 7 |
| tracker · 10K→100K | 82 | 11.8 (6.2, 1.7) | 75 | 15.5 (4, 4) | 1.51 | 3 / 6 |
| weather · idle (sky) | 121 | 2.3 (0.6, 1.1) | 21 | 26.5 (6.1, 15.5) | 9.44 | 6 / 20 |
| weather · scroll main | 161 | 6.7 (1, 4.5) | 103 | 17.7 (3.3, 10.3) | 6.29 | 15 / 49 |
| weather · scroll cities | 151 | 5.2 (1.1, 3) | 100 | 17.2 (2.9, 9.9) | 3.54 | 15 / 69 |
| weather · pick city | 98 | 1.8 (0.8, 0.5) | 2 | 115 (13.1, 25) | 16.58 | 4 / 0 |
| desktop · drag window | 101 | 5.4 (2.5, 1.7) | 62 | 10 (1.8, 5.3) | 4.19 | 5 / 24 |
| desktop · open calendar | 77 | 8.2 (2.3, 2.1) | 141 | 8.5 (1.3, 4) | 2.29 | 4 / 5 |
| desktop · menu File | 19 | 6.7 (2.5, 2.7) | 29 | 7.2 (1.2, 3.8) | 2.42 | 2 / 2 |
| birds · scroll grid | 158 | 5.7 (1.4, 1.8) | 142 | 11 (1.7, 6.1) | 2.23 | 11 / 47 |
| birds · hover cards | 119 | 4.5 (1.9, 1.7) | 43 | 10.5 (1.4, 4.4) | 1.9 | 0 / 0 |
| birds · open card | 39 | 4.1 (1.2, 1.3) | 43 | 10.2 (1.4, 5.8) | 2.42 | 5 / 1 |
| docs · scroll page | 113 | 3.5 (1.2, 1.2) | 60 | 15.2 (1.9, 7.3) | 1.51 | 16 / 59 |
| docs · expand Building | 1 | 20 (5.9, 10) | 1 | 20 (3.4, 10) | 4.92 | 0 / 0 |
| docs · Reference tab | 31 | 27.4 (16.2, 1.3) | 31 | 49 (7.1, 3.2) | 2.1 | 1 / 1 |
| sampler · switch+check | 27 | 5.2 (2.6, 1.9) | 26 | 9.2 (1.2, 5) | 1.57 | 3 / 1 |
| sampler · drag slider | 81 | 3.8 (1.8, 1.1) | 41 | 9.5 (1.3, 3.7) | 1.18 | 5 / 5 |
| sampler · accordion | 26 | 3.8 (1.2, 1.5) | 26 | 8.1 (1.3, 4.6) | 2.23 | 0 / 0 |
| sampler · menu open | 2 | 15 (5.3, 5) | 1 | 20 (2.9, 0) | 4.98 | 1 / 0 |
| sampler · Table tab | 34 | 3.5 (1.1, 1.5) | 1 | 40 (1.7, 10) | 3.28 | 2 / 0 |
| sampler · DataGrid scroll | 106 | 23.1 (16.7, 1.9) | 123 | 21.6 (1.4, 2.4) | 2.95 | 48 / 61 |
| swatchbook · Effects tab | 40 | 5 (1.9, 2.3) | 39 | 19.7 (3.8, 12.6) | 6.49 | 0 / 0 |
| swatchbook · Transforms tab | 33 | 4.8 (1.5, 2.1) | 33 | 8.8 (1.4, 4.5) | 3.21 | 0 / 0 |
| swatchbook · Drawing tab | 38 | 4.2 (1.5, 1.6) | 36 | 7.8 (1.1, 4.2) | 2.16 | 1 / 0 |
| swatchbook · Combined tab | 37 | 4.3 (1.5, 1.6) | 36 | 24.2 (4.4, 12.8) | 8.39 | 1 / 0 |
| swatchbook · Combined scroll | 117 | 5.6 (0.9, 3.6) | 73 | 32.7 (6.4, 18.2) | 9.37 | 11 / 53 |
| marketmap · scrub timeline | 105 | 23.1 (17.5, 2.4) | 94 | 26.2 (3.2, 7.5) | 5.9 | 2 / 2 |
| marketmap · chip: covid | 93 | 20.3 (16.2, 2.4) | 112 | 19.4 (2.8, 6.4) | 5.37 | 0 / 1 |
| marketmap · hover tiles | 91 | 14.7 (10.6, 2.3) | 159 | 17.5 (2.6, 6.5) | 6.03 | 2 / 0 |
| marketmap · zoom tile | 18 | 15 (4.8, 5.3) | 29 | 31.9 (3.7, 14.4) | 7.34 | 1 / 1 |
| homepage · idle | 1 | 170 (6.2, 110) | 57 | 14.5 (2.1, 7.7) | 1.64 | 0 / 39 |
| homepage · scroll | 130 | 4.3 (1.6, 1.6) | 242 | 9.3 (1.2, 4.5) | 1.7 | 4 / 65 |
| architecture · scroll | 104 | 3 (1.1, 1) | 60 | 12.7 (1.7, 6.3) | 1.77 | 14 / 59 |
| lzx-calendar · →week | 1 | 40 (23.8, 20) | 2 | 40 (3.5, 10) | 6.49 | 0 / 0 |
| lzx-calendar · →month | 37 | 9.2 (2.2, 5.4) | 58 | 6.4 (0.8, 3.1) | 1.97 | 1 / 0 |
| lzx-dashboard · guest | 16 | 6.4 (2.1, 2.9) | 16 | 12.1 (2, 5) | 1.25 | 5 / 0 |
| games/tempest · attract | 174 | 10.1 (2.3, 6.6) | 124 | 21 (1.5, 3.4) | 5.51 | 22 / 90 |
| games/tempest · play | 154 | 12.8 (2.7, 8.9) | 133 | 21.1 (1.3, 3.5) | 5.24 | 31 / 92 |
| games/vortex · attract | 73 | 4.9 (1.5, 2.3) | 83 | 8.7 (1, 3.7) | 2.75 | 1 / 0 |
| games/vortex · play | 187 | 7.1 (3, 2.3) | 249 | 19.8 (2.5, 10) | 7.14 | 2 / 0 |
| games/stargate · attract | 180 | 5.4 (2.5, 1.5) | 202 | 10.5 (0.7, 2.3) | 3.01 | 13 / 46 |
| games/stargate · play | 187 | 9.9 (4.2, 3.7) | 243 | 12.9 (1, 2.7) | 4.52 | 0 / 18 |
| games/asteroids · attract | 187 | 3.6 (1.7, 1) | 408 | 3.5 (0.5, 1.9) | 1.38 | 0 / 0 |
| games/asteroids · play | 178 | 2.8 (1.3, 0.7) | 331 | 4.5 (0.6, 2.2) | 1.77 | 14 / 0 |
| atlas · idle (world) | 0 | 30 (0, 20) | 0 | 20 (1, 10) | 0 | 0 / 0 |
| atlas · pan world | 117 | 7.4 (3.4, 1.9) | 78 | 14.1 (2, 4.9) | 3.74 | 13 / 7 |
| atlas · wheel zoom in (Europe) | 202 | 10.1 (3.2, 2.2) | 212 | 12.1 (1.8, 4.8) | 3.28 | 6 / 6 |
| atlas · fly to Paris (z13) | 236 | 13.1 (3.7, 2) | 394 | 10.2 (1.4, 3.7) | 2.69 | 18 / 21 |
| atlas · pan Paris z13 | 104 | 6.6 (2.4, 1) | 120 | 8.2 (1.1, 4.1) | 3.01 | 22 / 9 |
| atlas · wheel zoom in Paris → z16 | 185 | 10 (4, 2.6) | 221 | 8 (1.1, 4.6) | 3.6 | 5 / 2 |
| atlas · fly Paris → Tokyo | 263 | 14.9 (5.7, 2.2) | 405 | 10.8 (1.2, 4.1) | 3.08 | 21 / 19 |
| atlas · pan Tokyo z14 | 114 | 10.9 (3.7, 1.2) | 91 | 10.8 (1.3, 5.5) | 3.8 | 21 / 9 |
| atlas · fly Tokyo → World | 241 | 13.2 (5.1, 2.4) | 464 | 7.3 (1.2, 3.2) | 3.15 | 7 / 7 |
| murmur · open long thread | 4 | 47.5 (26.3, 10) | 4 | 110 (6.2, 33.3) | 3.6 | 0 / 1 |
| murmur · scroll history up | 120 | 6.3 (3.4, 1.3) | 80 | 16.5 (1.6, 7.9) | 2.16 | 32 / 61 |
| murmur · scroll history down | 118 | 5.6 (2.8, 1.3) | 76 | 15.5 (1.3, 7.4) | 2.23 | 24 / 60 |
| murmur · live feed 8s | 0 | 20 (0, 10) | 1 | 30 (2.5, 10) | 1.38 | 0 / 0 |
| murmur · type + send | 54 | 9.3 (3.9, 1.9) | 53 | 13.7 (2.6, 4.8) | 1.25 | 25 / 26 |
| murmur · answer arrives | 24 | 20.4 (8, 2.9) | 3 | 193.3 (2.4, 40) | 16.97 | 13 / 0 |
| murmur · switch thread | 4 | 27.5 (10.4, 7.5) | 4 | 66.7 (3.4, 20) | 4.13 | 1 / 1 |
| murmur · 100x (service --scale=100): open long thread | 4 | 52.5 (27, 10) | 4 | 87.5 (5.2, 25) | 3.34 | 0 / 1 |
| murmur · 100x: scroll history up | 184 | 8.9 (4.8, 1.6) | 173 | 14.4 (1.2, 6.2) | 1.84 | 70 / 90 |
| murmur · 100x: scroll history down | 182 | 6.7 (3.7, 1.5) | 141 | 13.8 (1.2, 6.7) | 2.29 | 40 / 90 |
