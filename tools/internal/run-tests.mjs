// run-tests.mjs — run ALL the test files and report every failure at the end.
// This replaced a package.json `&&` chain, which stopped at the first failing
// file: a formatting failure in the middle of the list silently skipped the
// seventeen suites after it, and "the suite passed" could mean "the suite ran
// until it didn't". A test run's job is to deliver the WHOLE verdict, once.
//
//   node tools/internal/run-tests.mjs             # the full suite (list below)
//   node tools/internal/run-tests.mjs test/a.test.mjs test/b.test.mjs
//   node tools/internal/run-tests.mjs -j 3        # at most 3 files at once
//   node tools/internal/run-tests.mjs --serial    # one at a time, output live
//
// SEVERAL FILES AT ONCE. Each file is its own process; every server binds
// port 0 and every browser is its own Chrome, so files share nothing but the
// machine. Up to half the cores' worth run together (at most 6; TEST_JOBS or
// -j sets it), the longest first — the last run's times are kept in
// node_modules/.cache — so the run ends when its longest file does. A file's
// output is printed whole when it finishes, never interleaved.

import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SUITE = [
  "test/unit.test.mjs",
  "test/seam.test.mjs",
  "test/perceptual.test.mjs",
  "test/scaffold.test.mjs",
  "test/declarec.test.mjs",
  "test/lower-literals.test.mjs",  // a compiled program carries values, not literal text
  "test/diagnostics-hints.test.mjs",
  "test/error-codes.test.mjs",
  "test/release.test.mjs",         // a release is a projection of the tree: the check, the scaffold, the projection
  "test/databinding.test.mjs",
  "test/dataset-merge.test.mjs",
  "test/change-event.test.mjs",
  "test/cursor-reach.test.mjs",
  "test/path-write.test.mjs",
  "test/after-delay.test.mjs",
  "test/provided-text-style.test.mjs",
  "test/hit-3d.test.mjs",
  "test/scene-walk.test.mjs",      // the retained-scene walks canvas and the Mac share: press, cursor, wheel, scroll range
  "test/super.test.mjs",
  "test/subclass-roots.test.mjs",  // a class extends ANY built-in: Spring, DataSource, AnimatorGroup, Keys, State, …
  "test/override-runtime.test.mjs", // a method replaces a built-in's RUNTIME method; super reaches the runtime's; the method table is pinned
  "test/materialization.test.mjs",
  "test/deferred-dom.test.mjs",    // a view not shown gets no DOM until first shown — and nothing the program can observe changes
  "test/dataschema.test.mjs",
  "test/datasource-failure.test.mjs",
  "test/table.test.mjs",
  "test/library.test.mjs",
  "test/overlays.test.mjs",        // overlays by kind, windows, hosted programs (planes.md §3, §8, §11, §12)
  "test/shortcuts.test.mjs",       // shortcuts as declared data, across islands (planes.md §9)
  "test/focus-ring.test.mjs",      // reveal clear of pinned chrome, the ring under it, turned rings, flight (planes.md §14)
  "test/layout-padding.test.mjs", // padding on the Layout base, per-side stroke on both backends, Card + Divider
  "test/layout-claims.test.mjs",  // a claim meeting an author value: the literal is reported, a refused size drops the child, every message is positioned and names the strategy
  "test/responsive-share.test.mjs", // what a ResponsiveLayout share divides (naturals first), "auto", and the two refusals
  "test/tracker.test.mjs",
  "test/streams.test.mjs",
  "test/runtime-errors.test.mjs",
  "test/dep-extract.test.mjs",
  "test/dep-projection.test.mjs",
  "test/script-block.test.mjs",
  "test/script-module.test.mjs",
  "test/static-constraint.test.mjs",
  "test/highlight.test.mjs",
  "test/briefs.test.mjs",          // the task briefs: snippets compile, every name and pointer resolves
  "test/inspect.test.mjs",
  "test/format.test.mjs",
  "test/md.test.mjs",
  "test/themes.test.mjs",
  "test/html.test.mjs",
  "test/richtext.test.mjs",
  "test/swatchbook.test.mjs",      // every combination of what a view can look like, DOM vs canvas: layout exactly, pixels per swatch against a baseline
  "test/inline-views.test.mjs",    // a program class as a tag in rich text: one real view, placed in the line (DOM + canvas)
  "test/text.test.mjs",            // the silent text regressions only: headless, one stub measurer, ~1s
  "test/md-conformance.test.mjs",  // Declare's Markdown reader vs markdown-it (VS Code's) over the CommonMark+GFM surface
  "test/slim.test.mjs",
  "test/crawl.test.mjs",
  "test/serve-parity.test.mjs",
  "test/serve.test.mjs",
  "test/toolchain-realm.test.mjs",
  "test/hydrate.test.mjs",
  "test/prod-parity.test.mjs",
  "test/serve-browser.test.mjs",
  "test/static-host.test.mjs",
  "test/streams-browser.test.mjs",
  "test/network-browser.test.mjs",
  "test/desktop-input.test.mjs",
  "test/transform-layout.test.mjs",
  "test/safearea.test.mjs",
  "test/gesture.test.mjs",
  "test/scroll-loop.test.mjs",     // the runtime scroll provider on canvas: wheel batching, glides, touch physics, arbitration
  "test/history.test.mjs",
  "test/embed.test.mjs",
  "test/dep-typed.test.mjs",
  "test/vis-camera.test.mjs",
  "test/reader-flow.test.mjs",
  "test/raster-memo.test.mjs",
  "test/canvas-filter.test.mjs",   // the Safari filter fallback, pinned from Chrome via the forced-fallback lever
  "test/draw-bounds.test.mjs",     // text bounds, per-op extents, replayArea, byte-identical culling
  "test/draw-lengths.test.mjs",
  "test/draw-redraw.test.mjs",
  "test/audio-in-memory.test.mjs",
  "test/island.test.mjs",
  "test/keyboard-focus.test.mjs",
  "test/fetch-family.test.mjs",
  "test/script-host.test.mjs",
  "test/files-browser.test.mjs",
  "test/island-browser.test.mjs",
  "test/two-way.test.mjs",         // the apps/two-way showcase: the whole embedder surface on one page
  "test/verify-apps.test.mjs",
  "test/verify-boot.test.mjs",      // rung 4 as an author runs it: the host it fills, out-of-reach controls, the boot budget
  // THE KERNEL and the precompiled bodies (the native-partition arc): the two
  // kernels against one written contract (C→wasm vs kernel-js.ts), the kernel's
  // own expression / extent / visibility rules, the Mac geometry binary, a boot
  // with no text-to-code under a CSP that forbids eval, and the runtime parity
  // check against a second tree when one is present.
  "test/kernel-conformance.test.mjs",
  "test/kernel-expr.test.mjs",
  "test/kernel-extent.test.mjs",
  "test/kernel-vis.test.mjs",
  "test/kernel-layout.test.mjs",
  "test/mac-geom-binary.test.mjs",
  "test/precompiled.test.mjs",
  "test/runtime-parity.test.mjs",
  "test/eval-references.test.mjs",
];

const argv = process.argv.slice(2);
let jobs = Number(process.env.TEST_JOBS) || Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--serial") jobs = 1;
  else if (argv[i] === "-j") jobs = Math.max(1, Number(argv[++i]) || 1);
  else files.push(argv[i]);
}
if (files.length === 0) files.push(...SUITE);

const TIMES = "node_modules/.cache/declare-test-times.json";
let last = {};
try { last = JSON.parse(readFileSync(TIMES, "utf8")); } catch { /* first run: list order */ }

const failed = [];
const times = [];
const t0 = Date.now();
const note = (f, s, code) => {
  times.push({ f, s });
  if (code !== 0) failed.push({ f, code });
};

if (jobs === 1) {
  for (const f of files) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
    note(f, (Date.now() - t) / 1000, r.status ?? `signal ${r.signal}`);
  }
} else {
  const queue = [...files].sort((a, b) => (last[b] ?? 0) - (last[a] ?? 0));
  const run = (f) => new Promise((done) => {
    const t = Date.now();
    const p = spawn(process.execPath, [f], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code, signal) => {
      const s = (Date.now() - t) / 1000;
      process.stdout.write(`\n── ${f} (${s.toFixed(1)} s)${code === 0 ? "" : "  FAILED"}\n${out}`);
      note(f, s, code ?? `signal ${signal}`);
      done();
    });
  });
  const worker = async () => { while (queue.length) await run(queue.shift()); };
  console.log(`run-tests: ${files.length} file(s), ${jobs} at a time`);
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
}

// this run's times order the next run
try {
  for (const { f, s } of times) last[f] = s;
  mkdirSync(dirname(TIMES), { recursive: true });
  writeFileSync(TIMES, JSON.stringify(last, null, 1));
} catch { /* ordering is a convenience */ }

const mins = ((Date.now() - t0) / 60000).toFixed(1);
// where the time went: the slowest files, so the run's cost has names
if (files.length > 1) {
  console.log("\nrun-tests: slowest files");
  for (const { f, s } of [...times].sort((a, b) => b.s - a.s).slice(0, 12)) console.log(`   ${s.toFixed(1).padStart(6)} s  ${f}`);
}
if (failed.length === 0) {
  console.log(`\nrun-tests: all ${files.length} file(s) passed (${mins} min)`);
} else {
  console.error(`\nrun-tests: ${failed.length} of ${files.length} file(s) FAILED (${mins} min):`);
  for (const { f, code } of failed) console.error(`   ${f}  (exit ${code})`);
  process.exit(1);
}
