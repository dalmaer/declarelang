// gpu/costs.mjs — what a scenario costs, layer by layer, in each renderer and host: the DOM
// renderer, the canvas renderer, render=gpu, and the Mac host. The same scripted scenario
// (gpu/census-scenarios.json's shape) runs in each, and its CPU time is split into the layers
// every one of them has:
//
//   app            the program's own compiled code: constraint bodies, methods, draw() bodies
//   runtime core   the kernel, settling, layout, events, data — the same code in every mode
//   drawing        recording draw() calls (runtime draw*.ts)
//   text measure   measuring text (the DOM and canvas through the browser, render=gpu through
//                  the engine, the Mac through CoreText)
//   GC             the JS engine's collector, on the runtime's thread
//   adapter        the runtime's renderer-specific code: dom-*.ts, canvas-*.ts, mac-backend.ts
//   renderer       render=gpu's host (host.ts, drawing.ts) and its engine (wasm, WebGPU calls)
//   native         the runtime thread outside JS: the DOM's style, layout and paint, a
//                  worker's messaging
//   crossing       render=gpu: the page relaying input and messages to the worker, and the
//                  worker's own glue (worker.ts, env.ts); the Mac: decoding commits
//   compositor     the renderer process's compositor thread
//   raster         the renderer process's raster threads
//   engine         V8's background threads: concurrent GC marking and sweeping, compiling
//   background     (the renderer's thread pool); on the Mac, the process's threads other
//                  than the runtime's and the main thread (JavaScriptCore's GC and JIT,
//                  Core Animation's)
//   GPU process    Chrome's GPU process (ps), all of it
//
// In Chrome the runtime thread (the page's main thread, or render=gpu's worker) is split by
// V8's sampling profiler, recorded in the trace: each sample goes to the layer of the
// innermost frame whose source says (bundles mapped back to their source files through their
// source maps); a builtin or wasm frame takes its caller's layer. The other threads come from
// the same trace, the GPU process from ps.
//
// On the Mac (JavaScriptCore has no such profiler) the app's own counters split it: the
// runtime thread's CPU, of which text measure and decoding commits are timed in Swift (the app is
// launched with DECLARE_METER, which turns those timers on); the
// main thread's (applying commits, Core Animation, the scroll process); the rest of the
// process; and WindowServer's CPU over the run less its rate over 2 s with the app idle
// just before (it composites the whole machine: a rough figure, at ps's 10 ms grain). Its JS is one row: app + core + drawing + adapter. The Mac host is
// the Mac app (`DECLARE_MAC_APP` names another tree's variant, mac-host/app.mjs); it never
// takes the foreground.
//
// Every mode also reports the runtime's own settle meter (`__declareMeter`: settles and their
// time), the same counter in every renderer, in a build with the development switches
// (mac-host/profile/build-runtime.mjs; 0 elsewhere), and the frames it presented. Times are ms over
// the whole scenario: the same input in every mode, so the shared rows should match; where a
// mode presents more frames, its animation runs more ticks.
//
//   node gpu/costs.mjs <scenarios.json> [app filter] [scenario filter] [--modes dom,canvas,gpu,mac]
//        [--base URL] [--json out.json] [--files]   (--files: the runtime thread's time by source file)
// Build first: `BOOT_SOURCEMAP=1 node tools/internal/build-boot.mjs` (the DOM bundle's map),
// `node gpu/build.mjs`, and for the Mac `npm run build:mac`.
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : d; };
const BASE = opt("--base", "http://127.0.0.1:8200");
const MODES = opt("--modes", "dom,canvas,gpu,mac").split(",");
const OUT = opt("--json", null);
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const SUMMARY = flag("--summary"), TOTALS = flag("--totals"), FILES = flag("--files");
const [file, onlyApp, onlyScenario] = args;
if (SUMMARY) { summarize(args.map((f) => JSON.parse(fs.readFileSync(f, "utf8"))).flat()); process.exit(0); }
const spec = JSON.parse(fs.readFileSync(file, "utf8"));

/** `--summary a.json [b.json …]`: one line per scenario, each mode's time in five groups, ms
 *  per frame presented (`--totals`: ms over the whole scenario) — runtime JS (app, core, drawing, text measure, GC, adapter: the Mac's
 *  JS is one figure), renderer (render=gpu's host and engine, the DOM's style, layout and paint,
 *  the Mac's main thread), crossing (render=gpu's page thread, the Mac's decoding), background
 *  (the JS engine's threads, the compositor, raster, others), and presentation (the GPU
 *  process; on the Mac, WindowServer above its idle rate). */
function summarize(rows) {
  const group = (l) => ({
    js: l.app + l["runtime core"] + l.drawing + l["text measure"] + l.GC + l.adapter + l["JS, unsplit"] + l.unclassified,
    rend: l.renderer + l.native,
    cross: l["page thread"],
    bg: l["engine background"] + l.compositor + l.raster + l["other threads"],
    pres: l["GPU process"],
  });
  const modes = ["dom", "canvas", "gpu", "mac"].filter((m) => rows.some((r) => r.modes[m]));
  const f = (v) => (v < 0.05 ? "·" : v < 10 ? v.toFixed(1) : v.toFixed(0)).padStart(5);
  console.log((TOTALS ? "ms over the scenario" : "ms per frame presented") + ": js = runtime JS, rend = renderer, x = crossing, bg = background threads, pres = GPU process / WindowServer");
  console.log("".padEnd(44) + modes.map((m) => `${m.padEnd(8)}  fr    js  rend     x    bg  pres total`.padStart(46)).join(" |"));
  for (const r of rows) {
    const cells = modes.map((m) => {
      const x = r.modes[m];
      if (!x) return "".padStart(46);
      const g = group(x.layers), n = TOTALS ? 1 : Math.max(1, x.frames);
      const total = g.js + g.rend + g.cross + g.bg + g.pres;
      return `${String(x.frames).padStart(12)} ${f(g.js / n)} ${f(g.rend / n)} ${f(g.cross / n)} ${f(g.bg / n)} ${f(g.pres / n)} ${f(total / n)}`;
    });
    console.log(`${r.app.replace(/^(apps|my-apps)\//, "").replace(/\/$/, "")} · ${r.scenario}`.slice(0, 43).padEnd(44) + cells.join(" |"));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CATS = ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "gpu", "blink", "cc", "viz",
  "disabled-by-default-v8.cpu_profiler"];

// ── layers ───────────────────────────────────────────────────────────────────

const ROWS = ["app", "runtime core", "drawing", "text measure", "GC", "adapter", "JS, unsplit", "renderer", "native",
  "unclassified", "page thread", "compositor", "raster", "engine background", "other threads", "GPU process"];
/** A source file's layer, or null for one that says nothing (its caller decides). */
function layerOfSource(src) {
  if (/runtime\/src\/(dom-[\w-]+|canvas-backend|canvas-filter|mac-backend|boxpaint|raster-client|raster-worker)\.ts$/.test(src)) return "adapter";
  if (/runtime\/src\/(draw|draw-text|draw-image)\.ts$/.test(src)) return "drawing";
  if (/runtime\/src\/(measure|text-measure|font[\w-]*|face-[\w-]+)\.ts$/.test(src)) return "text measure";
  if (/gpu\/src\/(host|drawing|fonts|media)\.ts$/.test(src)) return "renderer";
  if (/gpu\/src\/(worker|env|address|shell[\w-]*)\.ts$/.test(src)) return "page thread";   // the worker's own glue: crossing
  if (/gpu\/engine\//.test(src) || /engine\.js$/.test(src)) return "renderer";
  if (/runtime\/|kernel|node_modules|browser\//.test(src)) return "runtime core";
  return null;
}

// source maps: a generated (line, column) → its source file
const maps = new Map();
async function mapFor(url) {
  if (maps.has(url)) return maps.get(url);
  let m = null;
  try {
    const r = await fetch(url + ".map");
    if (r.ok) {
      const j = await r.json();
      const lines = [];
      let src = 0, col = 0;
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (const line of j.mappings.split(";")) {
        col = 0;
        const segs = [];
        for (const seg of line.split(",")) {
          if (seg === "") continue;
          const v = [];
          let shift = 0, val = 0;
          for (const ch of seg) {
            const d = B64.indexOf(ch);
            val += (d & 31) << shift;
            if (d & 32) shift += 5;
            else { v.push(val & 1 ? -(val >> 1) : val >> 1); val = 0; shift = 0; }
          }
          col += v[0];
          if (v.length > 1) { src += v[1]; segs.push([col, src]); }
        }
        lines.push(segs);
      }
      // sources resolved against the map's own address: a bundle names them relative to itself
      m = { lines, sources: j.sources.map((x) => new URL(x, url).pathname) };
    }
  } catch { m = null; }
  maps.set(url, m);
  return m;
}
function sourceAt(m, line, col) {
  const segs = m.lines[line];
  if (!segs || segs.length === 0) return null;
  let best = segs[0];
  for (const s of segs) { if (s[0] <= col) best = s; else break; }
  return m.sources[best[1]];
}

/** The layer of one profile node (a frame), or null: builtins, wasm and the profiler's
 *  pseudo-frames say nothing on their own. */
let frameSource = "";                                  // the source file that decided, for the per-file detail
async function layerOfFrame(frame, appUrl) {
  // a trace's frames leave out empty fields
  const cf = { url: "", scriptId: 0, lineNumber: 0, columnNumber: 0, ...frame };
  frameSource = cf.url.replace(/^.*\//, "") || "(compiled program)";
  if (cf.url.startsWith("wasm://")) return null;
  if (cf.scriptId === 0 || cf.scriptId === "0") return null;
  if (cf.url === "" || cf.url === appUrl || cf.url.startsWith(appUrl.replace(/\?.*$/, ""))) {
    // a compiled program has no url (new Function) or the page's own
    return cf.url === "" || !/\.js(\?|$)/.test(cf.url) ? "app" : null;
  }
  if (cf.url.startsWith("pptr:")) return "unclassified";
  const m = await mapFor(cf.url.replace(/\?.*$/, ""));
  if (m === null) return /\/bundles\//.test(cf.url) ? "runtime core" : "unclassified";
  const src = sourceAt(m, cf.lineNumber, cf.columnNumber);
  if (src !== null) frameSource = src.replace(/^\//, "");
  return src === null ? "unclassified" : layerOfSource(src) ?? "runtime core";
}

// ── Chrome ───────────────────────────────────────────────────────────────────

async function act(p, a) {
  const [k, ...v] = a;
  if (k === "wait") await sleep(v[0]);
  else if (k === "click") await p.mouse.click(v[0], v[1]);
  else if (k === "move") await p.mouse.move(v[0], v[1], { steps: v[2] ?? 1 });
  else if (k === "drag") {
    await p.mouse.move(v[0], v[1]); await p.mouse.down();
    for (let i = 1; i <= v[4]; i++) { await p.mouse.move(v[0] + (v[2] - v[0]) * i / v[4], v[1] + (v[3] - v[1]) * i / v[4]); await sleep(16); }
    await p.mouse.up();
  }
  else if (k === "wheel") { await p.mouse.move(v[0], v[1]); for (let i = 0; i < v[3]; i++) { await p.mouse.wheel({ deltaY: v[2] }); await sleep(16); } }
  else if (k === "key") await p.keyboard.press(v[0]);
  else if (k === "keydown") await p.keyboard.down(v[0]);
  else if (k === "keyup") await p.keyboard.up(v[0]);
  else if (k === "type") await p.keyboard.type(v[0], { delay: 30 });
  else if (k === "hover") { for (const [x, y] of v[0]) { await p.mouse.move(x, y, { steps: 8 }); await sleep(250); } }
}

let browser = null, root = 0;
function psCpu() {
  const rows = execSync("ps -A -o pid=,ppid=,time=,command=").toString().split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length > 3);
  const kids = new Set([String(root)]);
  for (let k = 0; k < 4; k++) for (const r of rows) if (kids.has(r[1])) kids.add(r[0]);
  const secs = (t) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  let gpu = 0, renderer = 0;
  for (const r of rows) {
    if (!kids.has(r[0])) continue;
    const cmd = r.slice(3).join(" ");
    if (cmd.includes("gpu-process")) gpu += secs(r[2]);
    if (cmd.includes("--type=renderer")) renderer += secs(r[2]);
  }
  return { gpu: gpu * 1000, renderer: renderer * 1000 };
}

async function runChrome(app, sc, mode) {
  if (browser === null) {
    browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
      args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
    root = browser.process().pid;
    const w = await browser.newPage(); await w.goto(`${BASE}/apps/tracker/`, { waitUntil: "load" }); await sleep(1500); await w.close();
  }
  const p = await browser.newPage();
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const sep = app.app.includes("?") ? "&" : "?";
  const url = `${BASE}/${app.app}${mode === "dom" ? "" : sep + "render=" + mode}`;
  await p.goto(url, { waitUntil: "load" });
  if (mode === "gpu") await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 });
  else await p.waitForFunction(() => typeof window.__declare === "object", { timeout: 30000 });
  await sleep(app.settle ?? 1500);
  for (const a of sc.before ?? []) await act(p, a);
  // the runtime's own meter, where the runtime runs
  const where = mode === "gpu" ? p.workers().find((w) => /worker\.js/.test(w.url())) : p;
  const meter = async () => where ? where.evaluate(() => ({ ...(globalThis.__declareMeter ?? { settles: 0, settleMs: 0 }) })) : { settles: 0, settleMs: 0 };
  await sleep(300);
  const m0 = await meter(), c0 = psCpu();
  await p.tracing.start({ categories: CATS });
  for (const a of sc.steps) await act(p, a);
  const trace = JSON.parse(Buffer.from(await p.tracing.stop()).toString("utf8")).traceEvents;
  const m1 = await meter(), c1 = psCpu();
  await p.close();
  return analyze(trace, mode, url, { settles: m1.settles - m0.settles, settleMs: m1.settleMs - m0.settleMs }, { gpu: c1.gpu - c0.gpu, renderer: c1.renderer - c0.renderer });
}

async function analyze(trace, mode, url, meter, ps) {
  const names = new Map();
  for (const e of trace) if (e.ph === "M" && e.name === "thread_name") names.set(e.pid + ":" + e.tid, e.args.name);
  // each thread's CPU: its top-level events, nested ones merged so each moment counts once
  const cpu = new Map();
  {
    const ev = trace.filter((e) => e.ph === "X" && e.dur > 0).sort((a, c) => a.ts - c.ts || c.dur - a.dur);
    const open = new Map();
    for (const e of ev) {
      const k = e.pid + ":" + e.tid;
      if (e.ts < (open.get(k) ?? -1)) continue;
      open.set(k, e.ts + e.dur);
      cpu.set(k, (cpu.get(k) ?? 0) + (e.tdur ?? e.dur) / 1000);
    }
  }
  // the sampled threads: the Profile event names the thread, its chunks carry nodes and samples
  const profiles = new Map();
  for (const e of trace) {
    if (e.name === "Profile") profiles.set(e.pid + ":" + e.id, { thread: e.pid + ":" + e.tid, nodes: new Map(), samples: [], deltas: [] });
  }
  for (const e of trace) {
    if (e.name !== "ProfileChunk") continue;
    const pr = profiles.get(e.pid + ":" + e.id);
    if (pr === undefined) continue;
    const d = e.args.data;
    for (const n of d.cpuProfile?.nodes ?? []) pr.nodes.set(n.id, n);
    for (const s of d.cpuProfile?.samples ?? []) pr.samples.push(s);
    for (const t of d.timeDeltas ?? []) pr.deltas.push(t);
  }
  // the runtime thread: the page's main thread, or render=gpu's worker — whichever such
  // thread has the most non-idle samples
  const runtimeName = mode === "gpu" ? /DedicatedWorker/ : /CrRendererMain/;
  let rt = null, best = -1;
  for (const pr of profiles.values()) {
    if (!runtimeName.test(names.get(pr.thread) ?? "")) continue;
    const busy = pr.samples.filter((s) => !/^\((idle|root)\)$/.test(pr.nodes.get(s)?.callFrame.functionName ?? "")).length;
    if (busy > best) { best = busy; rt = pr; }
  }
  // render=gpu's other worker (the compositor: the host, the engine) is counted by layer beside it
  const others = mode === "gpu" ? [...profiles.values()].filter((pr) => pr !== rt && runtimeName.test(names.get(pr.thread) ?? "")) : [];
  const out = Object.fromEntries(ROWS.map((r) => [r, 0]));
  const detail = {};
  if (rt !== null) {
    let pr = rt, memo = new Map();
    const layerOfNode = async (id) => {
      if (memo.has(id)) return memo.get(id);
      const n = pr.nodes.get(id);
      let r, file = "";
      const fn = n.callFrame.functionName;
      if (fn === "(garbage collector)") r = "GC";
      else if (fn === "(program)" || fn === "(root)") r = "native";
      else if (fn === "(idle)") r = "idle";
      else {
        r = await layerOfFrame(n.callFrame, url);
        if (r !== null) file = frameSource;
        else if (n.parent !== undefined) [r, file] = await layerOfNode(n.parent);
        else r = "unclassified";
      }
      if (r === "native" && fn !== "(program)" && fn !== "(root)") r = "unclassified";
      memo.set(id, [r, file || fn]);
      return [r, file || fn];
    };
    const files = {};
    // a node's parent: chunks give it as `parent`
    for (const one of [rt, ...others]) {
      pr = one; memo = new Map();
      for (let i = 0; i < pr.samples.length; i++) {
        const dt = Math.min(10, (pr.deltas[i + 1] ?? pr.deltas[i] ?? 0) / 1000);
        const [l, f] = await layerOfNode(pr.samples[i]);
        if (l === "idle") continue;
        out[l] += dt;
        files[l + " · " + f] = (files[l + " · " + f] ?? 0) + dt;
      }
    }
    detail.files = Object.fromEntries(Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    // the DOM's own rendering on that thread, from the trace (a detail of `native`)
    const thread = rt.thread;
    const self = new Map(), stack = [];
    for (const e of trace.filter((e) => e.ph === "X" && e.dur > 0 && e.pid + ":" + e.tid === thread).sort((a, c) => a.ts - c.ts || c.dur - a.dur)) {
      while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
      if (stack.length) self.set(stack[stack.length - 1].name, (self.get(stack[stack.length - 1].name) ?? 0) - e.dur / 1000);
      self.set(e.name, (self.get(e.name) ?? 0) + e.dur / 1000);
      stack.push(e);
    }
    const sum = (re) => [...self].filter(([n]) => re.test(n)).reduce((a, [, v]) => a + v, 0);
    detail["style & layout"] = sum(/^(UpdateLayoutTree|Layout|RecalcStyle|LocalFrameView::|Document::updateStyleAndLayout)/);
    detail["paint & commit"] = sum(/^(PrePaint|Paint|Layerize|Commit|UpdateLayer|PaintArtifactCompositor)/);
    // the other threads of the runtime's process
    const pid = thread.split(":")[0];
    for (const [k, v] of cpu) {
      if (!k.startsWith(pid + ":") || k === thread || others.some((o) => o.thread === k)) continue;
      const n = names.get(k) ?? "";
      if (/CrRendererMain/.test(n)) out["page thread"] += v;
      else if (/Compositor$/.test(n)) out.compositor += v;
      else if (/CompositorTileWorker|Raster/.test(n)) out.raster += v;
      else if (/ThreadPoolForegroundWorker/.test(n)) out["engine background"] += v;
      else out["other threads"] += v;
    }
  }
  out["GPU process"] = ps.gpu;
  out["JS, unsplit"] = 0;
  const frames = trace.filter((e) => e.ph === "X" && (e.name === "Graphics.Pipeline.DrawAndSwap" || e.name === "Display::DrawAndSwap")).length;
  return { layers: out, detail, meter, frames, rendererPs: ps.renderer };
}

// ── the Mac host ─────────────────────────────────────────────────────────────

let mac = null;
async function macModules() {
  if (mac !== null) return mac;
  const app = await import("../mac-host/app.mjs");
  const { channel } = await import("../mac-host/channel.mjs");
  const { hostWindow } = await import("../mac-host/win.mjs");
  mac = { ...app, channel, hostWindow };
  return mac;
}
function windowServerMs() {
  try {
    const t = execSync("ps -A -o time=,comm= | grep WindowServer").toString().trim().split(/\s+/)[0];
    return t.split(":").reduce((a, x) => a * 60 + Number(x), 0) * 1000;
  } catch { return 0; }
}

async function runMac(app, sc) {
  const M = await macModules();
  const bin = M.hostBinary();
  if (bin === null) throw new Error(M.NO_HOST);
  M.stopStrayHosts();                                  // only this variant's own pipe
  const sep = app.app.includes("?") ? "&" : "?";
  const url = `${BASE}/${app.app}${sep}render=mac`;
  const host = spawn(bin, [], { detached: true, stdio: "ignore",
    env: { ...process.env, DECLARE_CONTROL: "1", DECLARE_METER: "1", DECLARE_APPEARANCE: "light", DECLARE_URL: url } });
  host.unref();
  const ctl = M.channel();
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(500); try { M.hostWindow(); up = true; } catch { /* not yet */ } }
    if (!up) throw new Error("no host window");
    await ctl.send("occlusion ignore");
    const loaded = await ctl.send("waitload 40", 45000);
    if (!/^ok/.test(loaded)) throw new Error("load: " + loaded);
    await ctl.send("resize 1280 800");
    await sleep(app.settle ?? 1500);
    let at = [640, 400];
    const step = async (a) => {
      const [k, ...v] = a;
      if (k === "wait") await sleep(v[0]);
      else if (k === "click") { await ctl.send(`click ${v[0]} ${v[1]}`); at = [v[0], v[1]]; }
      else if (k === "move") {
        const n = v[2] ?? 1;
        for (let i = 1; i <= n; i++) await ctl.send(`move ${at[0] + (v[0] - at[0]) * i / n} ${at[1] + (v[1] - at[1]) * i / n}`);
        at = [v[0], v[1]];
      } else if (k === "drag") {
        await ctl.send(`move ${v[0]} ${v[1]}`); await ctl.send(`down ${v[0]} ${v[1]}`);
        for (let i = 1; i <= v[4]; i++) await ctl.send(`move ${v[0] + (v[2] - v[0]) * i / v[4]} ${v[1] + (v[3] - v[1]) * i / v[4]}`);
        await ctl.send(`up ${v[2]} ${v[3]}`); at = [v[2], v[3]];
      } else if (k === "wheel") {
        await ctl.send(`move ${v[0]} ${v[1]}`);
        await ctl.send(`wheelsweep ${v[3]} 30 ${v[2]} ${v[0]} ${v[1]}`);
        await sleep(v[3] * 1000 / 30 + 50);
      } else if (k === "key") await ctl.send(`key ${v[0]}`);
      else if (k === "type") { for (const ch of v[0]) { await ctl.send(`key ${ch === " " ? "Space" : ch}`); await sleep(30); } }
      else if (k === "hover") {
        for (const [x, y] of v[0]) {
          for (let i = 1; i <= 8; i++) await ctl.send(`move ${at[0] + (x - at[0]) * i / 8} ${at[1] + (y - at[1]) * i / 8}`);
          at = [x, y]; await sleep(250);
        }
      } else console.error(`  mac: step ${k} not driven`);
    };
    for (const a of sc.before ?? []) await step(a);
    await sleep(300);
    const meter = async () => JSON.parse(await ctl.send(`eval JSON.stringify(globalThis.__declareMeter ?? {settles:0,settleMs:0})`));
    // WindowServer composites the whole machine: its rate with this app idle, over 2 s, is
    // taken off what it spends during the steps
    const wsIdle0 = windowServerMs(); await sleep(2000); const wsRate = (windowServerMs() - wsIdle0) / 2000;
    const m0 = await meter();
    const ws0 = windowServerMs(), t0 = Date.now();
    await ctl.send("statsreset");
    for (const a of sc.steps) await step(a);
    const stats = await ctl.send("stats");
    const ws1 = windowServerMs(), wall = Date.now() - t0;
    const m1 = await meter();
    const L = /LAYERS cpu ms runtime=([\d.]+) main=([\d.]+) process=([\d.]+)\s+measure=([\d.]+) \(n=\d+\) decode=([\d.]+) apply=([\d.]+) caCommitCpu=([\d.]+)/.exec(stats);
    if (L === null) throw new Error("no LAYERS line in stats (an app built before the LAYERS counters?)");
    const [runtime, mainT, proc, measure, decode, apply, caCpu] = L.slice(1).map(Number);
    const commits = Number(/commits=(\d+)/.exec(stats)?.[1] ?? 0);
    const out = Object.fromEntries(ROWS.map((r) => [r, 0]));
    out["text measure"] = measure;
    out["page thread"] = decode;
    out["JS, unsplit"] = Math.max(0, runtime - measure - decode);
    out.renderer = mainT;
    out["engine background"] = Math.max(0, proc - runtime - mainT);
    out["GPU process"] = Math.max(0, ws1 - ws0 - wsRate * wall);
    return { layers: out, detail: { "main: apply": apply, "main: CA commit cpu": caCpu }, meter: { settles: m1.settles - m0.settles, settleMs: m1.settleMs - m0.settleMs }, frames: commits };
  } finally {
    try { process.kill(host.pid); } catch { /* gone */ }
    await sleep(800);
  }
}

// ── the table ────────────────────────────────────────────────────────────────

const LABEL = { "engine background": "JS engine background (GC, JIT)", "JS, unsplit": "JS, unsplit (Mac)", renderer: "renderer (GPU host, Mac main thread)", "page thread": "crossing (page thread, worker glue)",
  "GPU process": "GPU process (Mac: WindowServer)" };
const results = [];
for (const app of spec) {
  if (onlyApp && !app.app.includes(onlyApp)) continue;
  for (const sc of app.scenarios) {
    if (onlyScenario && !sc.name.includes(onlyScenario)) continue;
    const row = { app: app.app, scenario: sc.name, modes: {} };
    for (const mode of MODES) {
      try { row.modes[mode] = mode === "mac" ? await runMac(app, sc) : await runChrome(app, sc, mode); }
      catch (e) { console.error(`${app.app} · ${sc.name} · ${mode}: ${e.message}`); }
    }
    results.push(row);
    const ms = MODES.filter((m) => row.modes[m]);
    const f = (v) => (v === undefined ? "" : v < 0.05 ? "·" : v.toFixed(1)).padStart(9);
    console.log(`\n${app.app} · ${sc.name}   (ms over the scenario)`);
    console.log("".padEnd(40) + ms.map((m) => m.padStart(9)).join(""));
    const line = (label, get) => console.log(label.padEnd(40) + ms.map((m) => f(get(row.modes[m]))).join(""));
    line("frames presented", (r) => r.frames);
    line("settles (runtime meter)", (r) => r.meter.settles);
    line("settle ms (runtime meter)", (r) => r.meter.settleMs);
    for (const k of ROWS) {
      if (ms.every((m) => (row.modes[m].layers[k] ?? 0) < 0.05)) continue;
      line("  " + (LABEL[k] ?? k), (r) => r.layers[k]);
    }
    for (const d of new Set(ms.flatMap((m) => Object.keys(row.modes[m].detail)))) if (d !== "files") line("    of which " + d, (r) => r.detail[d]);
    line("total", (r) => Object.values(r.layers).reduce((a, b) => a + b, 0));
    line("total per frame", (r) => Object.values(r.layers).reduce((a, b) => a + b, 0) / Math.max(1, r.frames));
    if (FILES) for (const m of ms) if (row.modes[m].detail.files) {
      console.log(`  ${m}, the runtime thread by layer and source file:`);
      for (const [k, v] of Object.entries(row.modes[m].detail.files).slice(0, 18)) console.log(`    ${v.toFixed(1).padStart(8)}  ${k}`);
    }
  }
}
if (browser !== null) await browser.close();
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
