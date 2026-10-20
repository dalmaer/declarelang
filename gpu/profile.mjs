// gpu/profile.mjs — where each frame's time goes, DOM / canvas / GPU renderers, in Chrome.
//
//   node gpu/profile.mjs [--runs 3] [--size 1440x900] [--headed] [--only switches,rapid,hover,light,startup]
//
// Each workload is traced (Chrome's trace, every thread of every process, µs clock) on the
// three renderers back to back, in rounds; medians across rounds. Reported per frame shown:
//   page      the page's main thread, by what it was doing (self time of the trace's own
//             events): script · style · layout · paint (pre-paint, paint, layerize) · commit ·
//             gc · other. On the canvas renderer the drawing itself is script.
//   worker    the GPU renderer's worker: runtime (its busy time less the flush) · flush
//             (MacBackend's flush itself) · apply (the host applying ops) · encode (the scene
//             into Vello) · submit (Vello's GPU passes prepared, recorded and submitted)
//   compositor, raster (the page process's tile workers), renderer-other, gpu-process, browser
// and HEADROOM: the critical thread's busy time per 16.7 ms frame slot (median / p95 / worst)
// — the page's main thread for DOM and canvas, the worker for GPU — with the page's main
// thread alongside for GPU. For the GPU renderer, WebGPU's own time per frame (submit → done).
// --headed runs Chrome on screen (the display's real frame clock); default is headless.

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runs = Number(opt("--runs", "3"));
const [W, H] = opt("--size", "1440x900").split("x").map(Number);
const headed = args.includes("--headed");
const only = opt("--only", null)?.split(",") ?? null;
const SLOT = 1000 / 60;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const traceFile = path.join(os.tmpdir(), `declare-profile-${process.pid}.json`);
const HOST = "http://127.0.0.1:8200/";
const BUSY = "gpu/test/calendar-busy/", LIGHT = "apps/calendar/";
const RENDERERS = { dom: "", canvas: "?render=canvas", gpu: "?render=gpu&trace" };

// not "v8": it records every compile and call, and inflates the very script being timed
const CATS = ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "blink.console",
  "viz", "disabled-by-default-display.framedisplayed"];

// ── reading a trace ───────────────────────────────────────────────────────────

const PAGE_CATS = [
  ["style", /^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|ParseAuthorStyleSheet)$/],
  ["layout", /^(Layout|UpdateLayout|LayoutShift)$/],
  ["paint", /^(PrePaint|Paint|PaintImage|Layerize|UpdateLayer|UpdateLayerTree|PaintSetup|Decode Image|RasterTask)$/],
  ["commit", /^(Commit|CommitData|ProxyMain::BeginMainFrame::commit)$/],
  ["gc", /GC|Collect|Sweep|Mark/],
  ["script", /^(FunctionCall|FireAnimationFrame|TimerFire|EventDispatch|EvaluateScript|RunMicrotasks|HandlePostMessage|v8\.|V8\.|ParseHTML|ScriptStreaming|BlinkScheduler_PerformMicrotaskCheckpoint)/],
];
const catOf = (name) => { for (const [c, re] of PAGE_CATS) if (re.test(name)) return c; return "other"; };

function analyze(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const ev = raw.traceEvents ?? raw;
  const tn = new Map(), pn = new Map();
  for (const e of ev) if (e.ph === "M") {
    if (e.name === "thread_name") tn.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === "process_name") pn.set(e.pid, e.args.name);
  }
  const groupOf = (k) => {
    const pid = Number(k.split(":")[0]), p = pn.get(pid) ?? "", t = tn.get(k) ?? "";
    if (p === "Renderer") return t === "CrRendererMain" ? "page" : t.startsWith("DedicatedWorker") ? "worker"
      : t === "Compositor" ? "compositor" : t.startsWith("CompositorTileWorker") ? "raster" : "renderer-other";
    if (p === "GPU Process") return "gpu-process";
    if (p === "Browser") return "browser";
    return "other";
  };
  const shown = ev.filter((e) => e.name === "Display::FrameDisplayed").map((e) => e.ts).sort((a, b) => a - b);
  const byThread = new Map();
  for (const e of ev) if (e.ph === "X" && e.dur > 0) { const k = `${e.pid}:${e.tid}`; (byThread.get(k) ?? byThread.set(k, []).get(k)).push(e); }
  const busy = {}, split = { page: {}, worker: {} };
  const spans = new Map();                       // group → merged busy spans, for the slot analysis
  for (const [k, a] of byThread) {
    const g = groupOf(k);
    a.sort((x, y) => x.ts - y.ts || y.dur - x.dur);
    // busy: the union of top-level work
    const top = a.filter((e) => e.cat.includes("toplevel"));
    const merged = [];
    for (const e of top) { const l = merged[merged.length - 1]; if (l && e.ts <= l[1]) l[1] = Math.max(l[1], e.ts + e.dur); else merged.push([e.ts, e.ts + e.dur]); }
    busy[g] = (busy[g] ?? 0) + merged.reduce((s, x) => s + x[1] - x[0], 0) / 1000;
    const into = spans.get(g) ?? spans.set(g, []).get(g);
    for (const m of merged) into.push(m);
    // self time by category (page and worker): a stack of the thread's events
    if (g !== "page" && g !== "worker") continue;
    const st = [], self = new Map();
    for (const e of a) {
      while (st.length && st[st.length - 1].ts + st[st.length - 1].dur <= e.ts) st.pop();
      if (st.length) self.set(st[st.length - 1], (self.get(st[st.length - 1]) ?? st[st.length - 1].dur) - e.dur);
      if (!self.has(e)) self.set(e, e.dur);
      st.push(e);
    }
    for (const [e, s] of self) { const c = catOf(e.name); split[g][c] = (split[g][c] ?? 0) + Math.max(0, s) / 1000; }
  }
  // the worker's marked phases (console.time spans: async begin/end on the worker thread)
  const open = new Map(), phases = {};
  for (const e of ev) {
    if (!e.cat?.includes("blink.console") || !String(e.name).startsWith("gpu:")) continue;
    const key = `${e.pid}:${e.tid}:${e.name}:${e.id ?? e.id2?.local ?? ""}`;
    if (e.ph === "b" || e.ph === "S") open.set(key, e.ts);
    else if ((e.ph === "e" || e.ph === "F") && open.has(key)) { phases[e.name.slice(4)] = (phases[e.name.slice(4)] ?? 0) + (e.ts - open.get(key)) / 1000; open.delete(key); }
  }
  // per 16.7 ms slot, over the stretch frames were shown
  const slots = (g) => {
    if (shown.length < 2 || !spans.has(g)) return null;
    const from = shown[0], to = shown[shown.length - 1], us = SLOT * 1000;
    const bins = new Array(Math.max(1, Math.ceil((to - from) / us))).fill(0);
    for (const [s, e] of spans.get(g)) {
      for (let x = Math.max(s, from); x < Math.min(e, to);) {
        let i = Math.floor((x - from) / us), end = from + (i + 1) * us;
        if (end <= x) { i++; end += us; }
        const stop = Math.min(e, end, to);
        if (i < bins.length) bins[i] += (stop - x) / 1000;
        if (stop <= x) break;
        x = stop;
      }
    }
    const s = [...bins].sort((a, b) => a - b);
    return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(0.95 * (s.length - 1))], max: s[s.length - 1] };
  };
  return { frames: shown.length, busy, split, phases, slots: { page: slots("page"), worker: slots("worker"), gpu: slots("gpu-process") } };
}

// ── the workloads ─────────────────────────────────────────────────────────────

const seg = (k) => [W - [279, 205, 132, 59][k], 30];      // day, week, month, year (right-aligned header)
const WORK = {
  switches: { app: BUSY, run: async (p) => { for (const k of [1, 0, 3, 2, 1, 2, 0, 2]) { await p.mouse.click(...seg(k)); await pause(1100); } } },
  rapid: { app: BUSY, run: async (p) => { for (let i = 0; i < 16; i++) { await p.mouse.click(...seg([1, 2, 3, 0][i % 4])); await pause(350); } await pause(900); } },
  hover: { app: BUSY, run: async (p) => { for (let i = 0; i <= 120; i++) { await p.mouse.move(40 + (i / 120) * (W - 80), H * 0.55 + Math.sin(i / 8) * 120); await pause(16); } } },
  light: { app: LIGHT, run: async (p) => { for (const k of [1, 0, 3, 2, 1, 2, 0, 2]) { await p.mouse.click(...seg(k)); await pause(1100); } } },
};

async function launch() {
  return puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: !headed, args: headed ? ["--window-position=40,40", `--window-size=${W},${H + 90}`] : [],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 2 } });
}
const ready = (r) => r === "gpu" ? () => window.__declareGpu?.ready === true : () => window.__declarePerf?.completed === true;

async function workload(browser, r, name) {
  const w = WORK[name];
  const page = await browser.newPage();
  await page.goto(HOST + w.app + RENDERERS[r], { waitUntil: "load" });
  await page.waitForFunction(ready(r), { timeout: 30000 });
  await pause(900);
  const stats = r === "gpu" ? () => page.evaluate(() => new Promise((res) => { const wk = window.__declareGpu.worker; const on = (e) => { if (e.data?.t === "stats") { wk.removeEventListener("message", on); res(e.data.gpu); } }; wk.addEventListener("message", on); wk.postMessage({ t: "stats", clear: true }); })) : null;
  if (stats) await stats();
  await page.tracing.start({ path: traceFile, categories: CATS });
  await w.run(page);
  await page.tracing.stop();
  const a = analyze(traceFile);
  if (stats) a.webgpu = await stats();
  await page.close();
  return a;
}

async function startup(browser, r) {
  const page = await browser.newPage();
  await page.tracing.start({ path: traceFile, categories: CATS });
  await page.goto(HOST + BUSY + RENDERERS[r], { waitUntil: "load" });
  await page.waitForFunction(ready(r), { timeout: 30000 });
  const first = r === "gpu"
    ? await page.evaluate(async () => { const wk = window.__declareGpu.worker; for (;;) { const st = await new Promise((res) => { const on = (e) => { if (e.data?.t === "stats") { wk.removeEventListener("message", on); res(e.data); } }; wk.addEventListener("message", on); wk.postMessage({ t: "stats", clear: false }); }); const f = st.frames_raw[0]; if (f && f[2] >= 0) return f[0] + f[1] + f[2] - performance.timeOrigin; await new Promise((x) => setTimeout(x, 10)); } })
    : await page.evaluate(async () => { await window.__declarePerf.done; return performance.now(); });
  await pause(300);
  await page.tracing.stop();
  const a = analyze(traceFile);
  await page.close();
  return { first, ...a };
}

// ── run and report ────────────────────────────────────────────────────────────

const med = (a) => { const s = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const f2 = (v) => (v == null ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1));
const col = (s, n = 9) => String(s).padStart(n);

const browser = await launch();
console.log(`Chrome ${await browser.version()}, ${headed ? "on screen" : "headless"}, ${W}×${H} @2x, ${runs} rounds, renderers interleaved; medians.\n`);

const names = Object.keys(WORK).filter((n) => !only || only.includes(n));
const R = ["dom", "canvas", "gpu"];
for (const name of names) {
  const res = { dom: [], canvas: [], gpu: [] };
  for (let i = 0; i < runs; i++) for (const r of R) res[r].push(await workload(browser, r, name));
  const frames = Object.fromEntries(R.map((r) => [r, med(res[r].map((x) => x.frames))]));
  const per = (r, get) => med(res[r].map((x) => { const v = get(x); return v == null ? null : v / Math.max(1, x.frames); }));
  console.log(`${name.toUpperCase()} (${WORK[name].app})        ${R.map((r) => col(r)).join("")}`);
  console.log(`  frames shown               ${R.map((r) => col(frames[r])).join("")}`);
  console.log(`  per frame shown, ms:`);
  for (const c of ["script", "style", "layout", "paint", "commit", "gc", "other"]) {
    const vals = R.map((r) => per(r, (x) => x.split.page[c] ?? 0));
    if (vals.some((v) => v > 0.005)) console.log(`    page ${c.padEnd(22)}${vals.map((v) => col(f2(v))).join("")}`);
  }
  console.log(`    page total                 ${R.map((r) => col(f2(per(r, (x) => x.busy.page ?? 0)))).join("")}`);
  // the worker: everything happens inside its busy time; the flush span holds apply, encode
  // and submit (a commit runs inside the flush), so the runtime is the busy time less the flush
  const wk = (x, k) => {
    const ph = x.phases ?? {}, busyW = x.busy.worker ?? 0, flush = ph.flush ?? 0;
    const inner = (ph.apply ?? 0) + (ph.encode ?? 0) + (ph.submit ?? 0);
    return { runtime: Math.max(0, busyW - Math.max(flush, inner)), flush: Math.max(0, flush - inner),
      apply: ph.apply ?? 0, encode: ph.encode ?? 0, submit: ph.submit ?? 0 }[k];
  };
  for (const k of ["runtime", "flush", "apply", "encode", "submit"]) {
    const v = per("gpu", (x) => wk(x, k));
    console.log(`    worker ${k.padEnd(20)}${col("")}${col("")}${col(f2(v))}`);
  }
  console.log(`    worker total               ${col("")}${col("")}${col(f2(per("gpu", (x) => x.busy.worker ?? 0)))}`);
  for (const g of ["compositor", "raster", "renderer-other", "gpu-process", "browser"]) {
    console.log(`    ${g.padEnd(27)}${R.map((r) => col(f2(per(r, (x) => x.busy[g] ?? 0)))).join("")}`);
  }
  console.log(`    all processes              ${R.map((r) => col(f2(per(r, (x) => Object.values(x.busy).reduce((a, b) => a + b, 0))))).join("")}`);
  console.log(`  headroom — critical thread busy per 16.7 ms slot (median / p95 / worst):`);
  for (const r of R) {
    const g = r === "gpu" ? "worker" : "page";
    const s = (k, which) => f2(med(res[r].map((x) => x.slots[which]?.[k])));
    console.log(`    ${r.padEnd(7)} ${g.padEnd(7)} ${s("median", g)} / ${s("p95", g)} / ${s("max", g)}` +
      (r === "gpu" ? `    page ${s("median", "page")} / ${s("p95", "page")} / ${s("max", "page")}` : "") +
      `    gpu process ${s("median", "gpu")} / ${s("p95", "gpu")} / ${s("max", "gpu")}`);
  }
  const wg = res.gpu.map((x) => x.webgpu).filter(Boolean);
  if (wg.length) console.log(`  WebGPU per frame (submit → done): median ${f2(med(wg.map((x) => x?.median)))} ms, p95 ${f2(med(wg.map((x) => x?.p95)))} ms`);
  console.log("");
}

if (!only || only.includes("startup")) {
  const res = { dom: [], canvas: [], gpu: [] };
  for (let i = 0; i < runs + 1; i++) for (const r of R) { const s = await startup(browser, r); if (i > 0) res[r].push(s); }   // round 0 warms the cache
  console.log(`STARTUP (${BUSY}, warm)       ${R.map((r) => col(r)).join("")}`);
  console.log(`  first frame, ms from nav.  ${R.map((r) => col(f2(med(res[r].map((x) => x.first))))).join("")}`);
  for (const g of ["page", "worker", "compositor", "raster", "renderer-other", "gpu-process", "browser"]) {
    console.log(`  busy ${g.padEnd(22)}${R.map((r) => col(f2(med(res[r].map((x) => x.busy[g] ?? 0))))).join("")}`);
  }
}
await browser.close();
rmSync(traceFile, { force: true });
