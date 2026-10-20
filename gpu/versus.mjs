// gpu/versus.mjs — what a frame costs in the DOM renderer and in ?render=gpu, on the same
// scripted scenarios (gpu/census-scenarios.json's shape), alternating over rounds, in headless
// Chrome at 1280×800, 2×. Each renderer works in different places — the DOM on the page's
// main thread, Chrome's compositor and its GPU process; render=gpu in a worker and the GPU
// process — so it measures, per frame drawn:
//   frames     frames drawn in the scenario: the DOM's rendering updates (the trace's
//              Layerize, one per frame in which something changed), the worker's frames
//   all        CPU time of the renderer and GPU processes (ps), ms per frame — not the
//              browser process, whose time here is the harness's (input, tracing)
//   thread     the thread that makes the frame, ms per frame: the DOM page's main thread (its
//              tasks, from the trace), or the worker (its busy time)
//   gpu proc   the GPU process's CPU time (ps), ms per frame: Chrome's compositing and raster
//              for the DOM, WebGPU's command handling for render=gpu
//   exec       render=gpu's own GPU execution per frame (timestamp queries, with
//              GPU_SWITCHES="&timing", which costs the GPU process a little; the DOM has none
//              to compare)
//   late       frames over 25 ms after the one before, when they followed within half a second
// The DOM side runs under a light trace, which is how its frames are counted; render=gpu's
// side counts its own, and runs without one (tracing its worker costs more than the DOM's).
//   node gpu/versus.mjs [scenarios.json] [app filter] [--rounds N] [--base URL] [--json out]
//   GPU_SWITCHES="&notiming" node gpu/versus.mjs …   the same with switches on render=gpu's pages
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import fs from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : d; };
const ROUNDS = Number(opt("--rounds", 2));
const BASE = opt("--base", "http://127.0.0.1:8200");
const OUT = opt("--json", null);
const spec = JSON.parse(fs.readFileSync(args[0] || new URL("census-scenarios.json", import.meta.url), "utf8"));
const only = args[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (v) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
const root = b.process().pid;

/** CPU seconds of the renderer and GPU processes under the browser, of its GPU process, and
 *  of every process by type. */
function cpu() {
  const rows = execSync("ps -A -o pid=,ppid=,time=,command=").toString().split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length > 3);
  const kids = new Set([String(root)]);
  for (let k = 0; k < 4; k++) for (const r of rows) if (kids.has(r[1])) kids.add(r[0]);
  const secs = (t) => t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
  let all = 0, gpu = 0;
  const by = {};
  for (const r of rows) {
    if (!kids.has(r[0])) continue;
    const s = secs(r[2]), cmd = r.slice(3).join(" ");
    if (cmd.includes("--type=renderer") || cmd.includes("gpu-process")) all += s;
    if (cmd.includes("gpu-process")) gpu += s;
    const t = /--type=([\w-]+)/.exec(cmd)?.[1] ?? "browser";
    const k = t === "utility" ? "utility:" + (/--utility-sub-type=([\w.]+)/.exec(cmd)?.[1] ?? "?") : t;
    by[k] = (by[k] ?? 0) + s;
  }
  return { all, gpu, by };
}

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

/** From a trace: the page renderer's frames (Layerize, once per rendering update) and its
 *  main thread's task time. */
function domFrames(trace) {
  const ev = JSON.parse(trace).traceEvents;
  const names = new Map();
  for (const e of ev) if (e.ph === "M" && e.name === "thread_name") names.set(e.pid + ":" + e.tid, e.args.name);
  const pre = ev.filter((e) => e.name === "Layerize" && e.ph === "X");
  if (!pre.length) return { times: [], mainMs: 0 };
  const pid = pre[0].pid;
  const main = [...names].find(([k, n]) => k.startsWith(pid + ":") && n === "CrRendererMain")?.[0];
  const times = pre.filter((e) => e.pid === pid).map((e) => e.ts / 1000).sort((a, c) => a - c);
  const mainMs = ev.filter((e) => e.ph === "X" && e.name === "ThreadControllerImpl::RunTask" && main && e.pid + ":" + e.tid === main).reduce((a, e) => a + (e.dur ?? 0), 0) / 1000;
  return { times, mainMs };
}

/** One app in one renderer: each scenario's frames and what they cost. */
async function run(app, gpu) {
  const p = await b.newPage();
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const url = `${BASE}/${app.app}${gpu ? (app.app.includes("?") ? "&" : "?") + "render=gpu" + (process.env.GPU_SWITCHES ?? "") : ""}`;
  await p.goto(url, { waitUntil: "load" });
  if (gpu) await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 });
  else await p.waitForFunction(() => typeof window.__declare === "object", { timeout: 30000 });
  await sleep(app.settle ?? 1500);
  const stats = (clear) => p.evaluate((clear) => new Promise((res) => { const w = window.__declareGpu.worker; const on = (e) => { if (e.data?.t === "stats") { w.removeEventListener("message", on); res(e.data); } }; w.addEventListener("message", on); w.postMessage({ t: "stats", clear }); }), clear);
  const out = [];
  for (const sc of app.scenarios) {
    for (const a of sc.before ?? []) await act(p, a);
    if (gpu) await stats(true);
    if (!gpu) await p.tracing.start({ categories: ["devtools.timeline", "toplevel"] });
    const c0 = cpu();
    for (const a of sc.steps) await act(p, a);
    const c1 = cpu();
    const trace = gpu ? "" : Buffer.from(await p.tracing.stop()).toString("utf8");
    let times, threadMs, exec = 0;
    if (gpu) {
      const s = await stats(false);
      times = s.frames_raw.map((f) => f[0]);
      threadMs = s.busy;
      exec = s.gpuExec?.median ?? 0;
    } else {
      const d = domFrames(trace);
      times = d.times; threadMs = d.mainMs;
    }
    for (const a of sc.after ?? []) await act(p, a);
    const n = Math.max(1, times.length);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    if (process.env.BY) console.log(gpu ? "gpu" : "dom", sc.name, JSON.stringify(Object.fromEntries(Object.entries(c1.by).map(([k, v]) => [k, Math.round((v - (c0.by[k] ?? 0)) * 1000)]).filter(([, v]) => v > 0))));
    out.push({ sc: sc.name, frames: times.length,
      all: +((c1.all - c0.all) * 1000 / n).toFixed(1), thread: +(threadMs / n).toFixed(1),
      gpuProc: +((c1.gpu - c0.gpu) * 1000 / n).toFixed(1), exec,
      late: gaps.filter((g) => g > 25 && g < 500).length });
  }
  await p.close();
  return out;
}

// a page first, unmeasured (the first page in a browser runs cold)
{ const p = await b.newPage(); await p.goto(`${BASE}/apps/tracker/`, { waitUntil: "load" }); await sleep(1500); await p.close(); }

const rows = [];
for (const app of spec) {
  if (only && !app.app.includes(only)) continue;
  const got = { dom: [], gpu: [] };
  for (let r = 0; r < ROUNDS; r++) for (const gpu of r % 2 ? [true, false] : [false, true]) {
    try { got[gpu ? "gpu" : "dom"].push(await run(app, gpu)); }
    catch (e) { console.log(app.app, gpu ? "gpu" : "dom", "failed:", e.message.slice(0, 120)); }
  }
  app.scenarios.forEach((sc, i) => {
    const pick = (side, k) => med(got[side].map((o) => o[i]?.[k]).filter((x) => x !== undefined));
    const row = { app: app.app.replace(/^(apps|my-apps)\//, "").replace(/\/$/, ""), sc: sc.name };
    for (const side of ["dom", "gpu"]) row[side] = Object.fromEntries(["frames", "all", "thread", "gpuProc", "exec", "late"].map((k) => [k, pick(side, k)]));
    rows.push(row);
    const f = (s, gpu) => `${String(s.frames).padStart(3)} fr  ${String(s.all).padStart(5)} ms (thread ${String(s.thread).padStart(4)}, gpu proc ${String(s.gpuProc).padStart(4)}${gpu ? `, exec ${String(s.exec).padStart(4)}` : ""}) late ${s.late}`;
    console.log(`${(row.app + " · " + row.sc).padEnd(36)} DOM ${f(row.dom, false)}  |  GPU ${f(row.gpu, true)}`);
  });
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
await b.close();
