// gpu/apples.mjs — the same program on three renderers, its work in the same rows.
//
//   node gpu/apples.mjs [--runs 3] [--size 1440x900] [--headed] [--only switches,rapid,light,drag,hover]
//
// One table per workload: a row per KIND of work, a column per renderer (DOM, canvas, GPU),
// in ms per frame shown — whichever thread or process did it:
//
//   program            the Declare runtime's own work: the reactive core, constraints, springs,
//                      layout, events, the program's compiled code — identical on all three
//   renderer: script   the backend turning the view tree into renderer work (dom-backend; the
//                      canvas backend's paint walk and drawing replay; MacBackend, the GPU
//                      host, its drawing replay)
//   renderer: engine   the native work done for the renderer: the DOM's style, layout, paint,
//                      commit; Canvas2D's native calls; Vello (wasm) and WebGPU's calls
//   gc                 garbage collection, on the thread and in V8's background pool
//   overhead           task scheduling, the page↔worker relay, the event loop's own costs
//   compositing        the compositor and raster threads, the GPU process (CPU)
//   elsewhere          the page process's IO thread, the browser process (input, IPC)
//   (measurement)      writing the trace, the sampling profiler — shown, never in the total
//   total
//
// HOW: Chrome's trace (every thread, µs) with V8's sampling profiler in it (~150 µs). Each
// thread's script time (from the trace) is split by its samples: a sample belongs to the
// original source file of its innermost frame (through the bundles' source maps); wasm and
// native-API frames take the nearest caller with a source file — a renderer file makes them
// engine work, a runtime file program work (the reactive kernel is wasm). The DOM's
// lifecycle (style, layout, paint, commit) comes from the trace's own events.
// GPU EXECUTION: Metal System Trace (xctrace) attached to Chrome's GPU process — where every
// renderer's GPU work runs: the DOM's raster and compositing, Canvas2D, WebGPU through Dawn —
// the union of its GPU intervals over the workload. The same instrument for all three.
// HEADROOM: the busiest thread's (critical thread's) work per display frame — the page's main
// thread for DOM and canvas, the worker for GPU.
// Needs bundles/declare-boot.js built with its source map (BOOT_SOURCEMAP=1 node tools/internal/build-boot.mjs).

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import { readFileSync, rmSync, existsSync, readdirSync, statfsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { SourceMap } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runs = Number(opt("--runs", "3"));
const [W, H] = opt("--size", "1440x900").split("x").map(Number);
const headed = args.includes("--headed");
const only = opt("--only", null)?.split(",") ?? null;
const WITH_GPU = !args.includes("--no-gpu-trace");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const traceFile = path.join(os.tmpdir(), `declare-apples-${process.pid}.json`);
const HOST = "http://127.0.0.1:8200/";
const BUSY = "gpu/test/calendar-busy/", LIGHT = "apps/calendar/";
const RENDERERS = { dom: "", canvas: "?render=canvas", gpu: "?render=gpu" };
const R = ["dom", "canvas", "gpu"];

// ── source maps: a bundle position → the original file ──────────────────────────

const maps = new Map();
function mapFor(url) {
  if (maps.has(url)) return maps.get(url);
  let m = null;
  try {
    const rel = new URL(url).pathname.replace(/^\//, "");
    const file = path.join(ROOT, rel) + ".map";
    if (existsSync(file)) m = new SourceMap(JSON.parse(readFileSync(file, "utf8")));
  } catch { /* not ours */ }
  maps.set(url, m);
  return m;
}
const fileMemo = new Map();
function originalFile(frame) {
  const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
  if (fileMemo.has(key)) return fileMemo.get(key);
  let f = frame.url;
  const m = mapFor(frame.url);
  if (m) { const e = m.findEntry(frame.lineNumber ?? 0, frame.columnNumber ?? 0); if (e?.originalSource) f = e.originalSource; }
  fileMemo.set(key, f);
  return f;
}

/** What a source file's code is: the renderer's backend, the renderer's engine glue, relay
 *  and event plumbing (overhead), or the program (the runtime and everything else). */
function kindOfFile(f) {
  if (/(^|\/)engine\.js$|engine_bg/.test(f)) return "engine";
  if (/runtime\/src\/(dom-backend|dom-effects|dom-rich|canvas-backend|canvas-filter|canvas-[a-z-]+|mac-backend|boxpaint|raster-client|scene-walk)\.ts/.test(f)) return "script";
  // the GPU renderer's own sources (gpu/src, named from gpu/dist as ../src/…), not the runtime's
  if (/(^|\/)(?<!runtime\/)src\/(host|drawing|fonts)\.ts$/.test(f)) return "script";
  if (/(^|\/)(?<!runtime\/)src\/(shell|env|worker|bench)\.ts$/.test(f)) return "overhead";
  return "program";
}

// ── reading a trace ───────────────────────────────────────────────────────────

const NATIVE = [
  ["style", /^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|ParseAuthorStyleSheet)$/],
  ["layout", /^(Layout|UpdateLayout|LayoutShift)$/],
  ["paint", /^(PrePaint|Paint|PaintImage|Layerize|UpdateLayer|UpdateLayerTree|PaintSetup|Decode Image)$/],
  ["commit", /^(Commit|CommitData|ProxyMain::BeginMainFrame::commit)$/],
  ["gc", /GC|Collect|Sweep|Mark/],
  ["script", /^(FunctionCall|FireAnimationFrame|TimerFire|EventDispatch|EvaluateScript|RunMicrotasks|HandlePostMessage|v8\.|V8\.|ParseHTML|ScriptStreaming|BlinkScheduler_PerformMicrotaskCheckpoint)/],
];
const nativeCat = (name) => { for (const [c, re] of NATIVE) if (re.test(name)) return c; return "other"; };

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
    // the measurement itself — writing the trace, the profiler, DevTools — is not the program's
    if (t.startsWith("v8:") || t === "PerfettoTrace" || t.includes("DevTools") || (p === "Browser" && t.startsWith("ThreadPoolBackground"))) return "measurement";
    if (p === "Renderer") return t === "CrRendererMain" ? "page" : t.startsWith("DedicatedWorker") ? "worker"
      : t === "Compositor" || t.startsWith("CompositorTileWorker") ? "compositing"
      : t.startsWith("ThreadPool") ? "gc-background" : "elsewhere";      // the page process's pool: V8's concurrent GC (measured)
    if (p === "GPU Process") return "compositing";
    return "elsewhere";
  };
  const shown = ev.filter((e) => e.name === "Display::FrameDisplayed").map((e) => e.ts).sort((a, b) => a - b);
  // busy (top-level union) and native self time, per thread
  const byThread = new Map();
  for (const e of ev) if (e.ph === "X" && e.dur > 0) { const k = `${e.pid}:${e.tid}`; (byThread.get(k) ?? byThread.set(k, []).get(k)).push(e); }
  const busy = {}, self = { page: {}, worker: {} }, spans = { page: [], worker: [] }, threadsBusy = {};
  for (const [k, a] of byThread) {
    const g = groupOf(k);
    a.sort((x, y) => x.ts - y.ts || y.dur - x.dur);
    const merged = [];
    for (const e of a) if (e.cat.includes("toplevel")) { const l = merged[merged.length - 1]; if (l && e.ts <= l[1]) l[1] = Math.max(l[1], e.ts + e.dur); else merged.push([e.ts, e.ts + e.dur]); }
    busy[g] = (busy[g] ?? 0) + merged.reduce((s, x) => s + x[1] - x[0], 0) / 1000;
    if (g === "elsewhere" || g === "measurement") {
      const name = `${pn.get(Number(k.split(":")[0])) ?? "?"} / ${tn.get(k) ?? k}`;
      threadsBusy[name] = (threadsBusy[name] ?? 0) + merged.reduce((s, x) => s + x[1] - x[0], 0) / 1000;
    }
    if (g !== "page" && g !== "worker") continue;
    for (const m of merged) spans[g].push(m);
    const st = [], own = new Map();
    for (const e of a) {
      while (st.length && st[st.length - 1].ts + st[st.length - 1].dur <= e.ts) st.pop();
      if (st.length) own.set(st[st.length - 1], (own.get(st[st.length - 1]) ?? st[st.length - 1].dur) - e.dur);
      if (!own.has(e)) own.set(e, e.dur);
      st.push(e);
    }
    for (const [e, s] of own) { const c = nativeCat(e.name); self[g][c] = (self[g][c] ?? 0) + Math.max(0, s) / 1000; }
  }
  // the sampling profiler: each profile's thread, its nodes, its samples
  const profThread = new Map();
  for (const e of ev) if (e.name === "Profile") profThread.set(e.id, groupOf(`${e.pid}:${e.tid}`));
  const nodes = new Map(), samples = new Map();   // profile id → Map(nodeId → node) / [nodeId]
  for (const e of ev) {
    if (e.name !== "ProfileChunk") continue;
    const cp = e.args?.data?.cpuProfile;
    if (!cp) continue;
    const nm = nodes.get(e.id) ?? nodes.set(e.id, new Map()).get(e.id);
    for (const n of cp.nodes ?? []) nm.set(n.id, n);
    const sm = samples.get(e.id) ?? samples.set(e.id, []).get(e.id);
    for (const s of cp.samples ?? []) sm.push(s);
  }
  const share = { page: {}, worker: {} };
  for (const [id, sm] of samples) {
    const g = profThread.get(id);
    if (g !== "page" && g !== "worker") continue;
    const nm = nodes.get(id);
    const kindOf = new Map();
    const classify = (nodeId) => {
      if (kindOf.has(nodeId)) return kindOf.get(nodeId);
      const n = nm.get(nodeId);
      let k = null;
      if (!n) k = null;
      else {
        const cf = n.callFrame, name = cf.functionName;
        if (name === "(garbage collector)") k = "gc";
        else if (name === "(program)" || name === "(idle)" || name === "(root)") k = null;
        else if (cf.url && !cf.url.startsWith("wasm")) k = kindOfFile(originalFile(cf));
        else if (!cf.url && cf.scriptId && cf.scriptId !== 0 && cf.scriptId !== "0") k = "program";      // the program's evaluated code
        else {
          // wasm or a native API: the nearest caller with a source file decides
          let p = n.parent, by = null;
          while (p !== undefined && by === null) {
            const pf = nm.get(p)?.callFrame;
            if (pf?.url && !pf.url.startsWith("wasm")) by = kindOfFile(originalFile(pf));
            p = nm.get(p)?.parent;
          }
          k = by === "script" || by === "engine" ? "engine" : by ?? "program";
        }
      }
      kindOf.set(nodeId, k);
      return k;
    };
    // parents: the profile gives children; build parent links once
    for (const n of nm.values()) for (const c of n.children ?? []) { const ch = nm.get(c); if (ch) ch.parent = n.id; }
    for (const s of sm) { const k = classify(s); if (k !== null) share[g][k] = (share[g][k] ?? 0) + 1; }
  }
  // per display frame of the critical threads
  const perFrame = (g) => {
    if (shown.length < 2) return null;
    const out = [];
    let j = 0;
    const sp = spans[g].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < shown.length; i++) {
      const a = shown[i - 1], b = shown[i];
      let t = 0;
      while (j < sp.length && sp[j][1] <= a) j++;
      for (let k = j; k < sp.length && sp[k][0] < b; k++) t += Math.min(b, sp[k][1]) - Math.max(a, sp[k][0]);
      out.push({ busy: t / 1000, span: (b - a) / 1000 });
    }
    return out;
  };
  return { frames: shown.length, busy, self, share, threadsBusy, perFrame: { page: perFrame("page"), worker: perFrame("worker") } };
}

/** The rows, in ms, from one analysis. */
function rows(a) {
  const r = { program: 0, "renderer: script": 0, "renderer: engine": 0, gc: 0, overhead: 0, compositing: 0, elsewhere: 0 };
  for (const g of ["page", "worker"]) {
    const s = a.self[g] ?? {}, sh = a.share[g] ?? {};
    const js = s.script ?? 0;
    const n = (sh.program ?? 0) + (sh.script ?? 0) + (sh.engine ?? 0) + (sh.overhead ?? 0);
    if (n > 0) {
      r.program += js * (sh.program ?? 0) / n;
      r["renderer: script"] += js * (sh.script ?? 0) / n;
      r["renderer: engine"] += js * (sh.engine ?? 0) / n;
      r.overhead += js * (sh.overhead ?? 0) / n;
    } else r.overhead += js;
    r["renderer: engine"] += (s.style ?? 0) + (s.layout ?? 0) + (s.paint ?? 0) + (s.commit ?? 0);
    r.gc += s.gc ?? 0;
    // the rest of the thread's busy time: scheduling and the event loop's own work
    const named = (s.script ?? 0) + (s.style ?? 0) + (s.layout ?? 0) + (s.paint ?? 0) + (s.commit ?? 0) + (s.gc ?? 0);
    r.overhead += Math.max(0, (a.busy[g] ?? 0) - named);
  }
  r.gc += a.busy["gc-background"] ?? 0;
  r.compositing = a.busy.compositing ?? 0;
  r.elsewhere = a.busy.elsewhere ?? 0;
  r.total = Object.values(r).reduce((x, y) => x + y, 0);
  r.measurement = a.busy.measurement ?? 0;            // shown, never in the total
  return r;
}

// ── workloads ─────────────────────────────────────────────────────────────────

const seg = (k) => [W - [279, 205, 132, 59][k], 30];      // day, week, month, year
const WORK = {
  switches: { app: BUSY, run: async (p) => { for (const k of [1, 0, 3, 2, 1, 2, 0, 2]) { await p.mouse.click(...seg(k)); await pause(1100); } } },
  rapid: { app: BUSY, run: async (p) => { for (let i = 0; i < 16; i++) { await p.mouse.click(...seg([1, 2, 3, 0][i % 4])); await pause(350); } await pause(900); } },
  light: { app: LIGHT, run: async (p) => { for (const k of [1, 0, 3, 2, 1, 2, 0, 2]) { await p.mouse.click(...seg(k)); await pause(1100); } } },
  drag: { app: LIGHT, setup: async (p) => { await p.mouse.click(...seg(1)); await pause(1100); },
    run: async (p) => { const ev = [Math.round(W * 0.255), 211]; await p.mouse.move(ev[0], ev[1]); await p.mouse.down();
      for (let i = 1; i <= 90; i++) { await p.mouse.move(ev[0] + i * 3, ev[1] + i * 2); await pause(16); } await p.mouse.up(); await pause(400); } },
  hover: { app: BUSY, run: async (p) => { for (let i = 0; i <= 120; i++) { await p.mouse.move(40 + (i / 120) * (W - 80), H * 0.55 + Math.sin(i / 8) * 120); await pause(16); } } },
};
const CATS = ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-v8.cpu_profiler",
  "viz", "disabled-by-default-display.framedisplayed"].filter((c) => !(args.includes("--no-sampling") && c.includes("cpu_profiler")));

// ── GPU execution, through Metal System Trace ────────────────────────────────────

const gpuPidOf = (browser) => {
  const root = String(browser.process().pid);
  const line = execFileSync("ps", ["-o", "pid=,ppid=,command=", "-A"]).toString().split("\n")
    .find((l) => { const f = l.trim().split(/\s+/); return f[1] === root && l.includes("--type=gpu-process"); });
  return line ? line.trim().split(/\s+/)[0] : null;
};
const mstFile = path.join(os.tmpdir(), `declare-apples-${process.pid}.trace`);

// xctrace leaves its raw kernel trace (instruments*.ktrace, 1–3 GB each) in the temp folder
// after every recording: each recording removes the ones it made, and an interrupted run
// removes them on the way out. A recording does not start with under 10 GB free.
const tmp = os.tmpdir();
const ktraces = () => new Set(readdirSync(tmp).filter((f) => f.startsWith("instruments")));
let recorder = null, before = null;
function sweep() {
  if (recorder) { try { recorder.kill("SIGKILL"); } catch {} recorder = null; }
  rmSync(mstFile, { recursive: true, force: true });
  if (before) for (const f of ktraces()) if (!before.has(f)) rmSync(path.join(tmp, f), { recursive: true, force: true });
}
process.on("exit", sweep);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { sweep(); process.exit(130); });
process.on("uncaughtException", (e) => { sweep(); console.error(e); process.exit(1); });

async function gpuRecord(browser) {
  const pid = gpuPidOf(browser);
  if (pid === null) return null;
  const st = statfsSync(tmp);
  if (st.bavail * st.bsize < 10e9) throw new Error(`under 10 GB free in ${tmp}: not recording GPU traces`);
  rmSync(mstFile, { recursive: true, force: true });
  before = ktraces();
  const p = spawn("xcrun", ["xctrace", "record", "--template", "Metal System Trace", "--attach", pid, "--output", mstFile, "--no-prompt"],
    { stdio: ["ignore", "pipe", "pipe"] });
  recorder = p;
  await new Promise((resolve) => {
    const on = (d) => { if (String(d).includes("Starting recording")) resolve(); };
    p.stdout.on("data", on); p.stderr.on("data", on);
    setTimeout(resolve, 8000);
  });
  await pause(500);
  return {
    async stop() {
      p.kill("SIGINT");
      await new Promise((r) => p.on("exit", r));
      recorder = null;
      let xml = "";
      try {
        xml = execFileSync("xcrun", ["xctrace", "export", "--input", mstFile, "--xpath",
          '/trace-toc/run/data/table[@schema="metal-gpu-intervals"]'], { maxBuffer: 1 << 30 }).toString();
      } finally {
        sweep();
        before = null;
      }
      // rows: the first two cells are start and duration (ns), each a value or a reference to one
      const ids = new Map();
      for (const m of xml.matchAll(/<(start-time|duration) id="(\d+)"[^>]*>(\d+)</g)) ids.set(m[2], Number(m[3]));
      const spans = [];
      for (const row of xml.matchAll(/<row>(.*?)<\/row>/gs)) {
        const cells = [...row[1].matchAll(/<(start-time|duration)(?: id="(\d+)"[^>]*>(\d+)<\/\1>| ref="(\d+)"\/>)/g)].slice(0, 2);
        if (cells.length < 2) continue;
        const v = (c) => (c[3] !== undefined ? Number(c[3]) : ids.get(c[4]));
        const t0 = v(cells[0]), d = v(cells[1]);
        if (Number.isFinite(t0) && Number.isFinite(d)) spans.push([t0, t0 + d]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let busy = 0, end = -Infinity;
      for (const [a, b] of spans) { if (a > end) { busy += b - a; end = b; } else if (b > end) { busy += b - end; end = b; } }
      return busy / 1e6;           // ms
    },
  };
}

async function workload(browser, r, name) {
  const w = WORK[name];
  const page = await browser.newPage();
  await page.goto(HOST + w.app + RENDERERS[r], { waitUntil: "load" });
  await page.waitForFunction(r === "gpu" ? () => window.__declareGpu?.ready === true : () => window.__declarePerf?.completed === true, { timeout: 30000 });
  await pause(900);
  if (w.setup) await w.setup(page);
  const gpu = WITH_GPU ? await gpuRecord(browser) : null;
  await page.tracing.start({ path: traceFile, categories: CATS });
  await w.run(page);
  await page.tracing.stop();
  const a = analyze(traceFile);
  a.gpuExec = gpu ? await gpu.stop() : null;
  await page.close();
  return a;
}

const med = (a) => { const s = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const f2 = (v) => (v == null ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1));
const col = (s, n = 10) => String(s).padStart(n);

if (!existsSync(path.join(ROOT, "bundles/declare-boot.js.map"))) {
  console.error("bundles/declare-boot.js.map is missing: BOOT_SOURCEMAP=1 node tools/internal/build-boot.mjs");
  process.exit(1);
}
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: !headed, args: headed ? ["--window-position=40,40", `--window-size=${W},${H + 90}`] : [],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2 } });
console.log(`Chrome ${await browser.version()}, ${headed ? "on screen" : "headless"}, ${W}×${H} @2x, ${runs} rounds (renderers interleaved), medians.\n`);

for (const name of Object.keys(WORK).filter((n) => !only || only.includes(n))) {
  const res = { dom: [], canvas: [], gpu: [] };
  for (let i = 0; i < runs; i++) for (const r of R) res[r].push(await workload(browser, r, name));
  const frames = Object.fromEntries(R.map((r) => [r, med(res[r].map((x) => x.frames))]));
  const perShown = name !== "hover";
  console.log(`${name.toUpperCase()} — ${WORK[name].app}   ${perShown ? "ms per frame shown" : "ms in all (little or nothing is drawn)"}`);
  console.log(`  ${"".padEnd(20)}${R.map((r) => col(r)).join("")}`);
  console.log(`  ${"frames shown".padEnd(20)}${R.map((r) => col(frames[r])).join("")}`);
  const keys = ["program", "renderer: script", "renderer: engine", "gc", "overhead", "compositing", "elsewhere", "total"];
  for (const k of keys) {
    const vals = R.map((r) => med(res[r].map((x) => { const v = rows(x)[k]; return perShown ? v / Math.max(1, x.frames) : v; })));
    console.log(`  ${(k === "total" ? "TOTAL CPU" : k).padEnd(20)}${vals.map((v) => col(f2(v))).join("")}`);
  }
  { const mv = R.map((r) => med(res[r].map((x) => { const v = rows(x).measurement; return perShown ? v / Math.max(1, x.frames) : v; })));
    console.log(`  ${"(measurement)".padEnd(20)}${mv.map((v) => col(f2(v))).join("")}   not in the total: writing the trace, the profiler`); }
  const gx = R.map((r) => med(res[r].map((x) => (x.gpuExec == null ? null : perShown ? x.gpuExec / Math.max(1, x.frames) : x.gpuExec))));
  console.log(`  ${"GPU execution".padEnd(20)}${gx.map((v) => col(f2(v))).join("")}`);
  if (args.includes("--threads")) for (const r of R) {
    const t = res[r][0].threadsBusy;
    console.log(`    ${r} elsewhere: ` + Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(" · "));
  }
  if (perShown) {
    const head = (r) => {
      const g = r === "gpu" ? "worker" : "page";
      const pf = res[r].flatMap((x) => x.perFrame[g] ?? []);
      if (pf.length === 0) return "—";
      const util = pf.map((x) => x.busy / Math.max(1e-6, x.span));
      return `${(100 * q(util, 0.5)).toFixed(0)}% / ${(100 * q(util, 0.95)).toFixed(0)}%`;
    };
    console.log(`  ${"critical thread busy".padEnd(20)}${R.map((r) => col(head(r), 13)).join("")}   (share of each display frame, median / p95; DOM, canvas: page thread; GPU: worker)`);
  }
  console.log("");
}
await browser.close();
rmSync(traceFile, { force: true });
