// gpu/worker-profile.mjs — what the render=gpu worker spends its time on during one scenario
// (gpu/census-scenarios.json's shape): V8's sampling profiler on the worker, self time summed
// by function and by source file, in ms per frame the worker drew.
//   node gpu/worker-profile.mjs <scenarios.json> <app filter> <scenario name> [--base URL]
//        [--top N] [--switches "&a&b"] [--compositor]
// render=gpu runs in two workers: the runtime's (the default) and, with --compositor, the one
// that draws (the host and the engine).
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : d; };
const BASE = opt("--base", "http://127.0.0.1:8200");
const TOP = Number(opt("--top", 25));
const SW = opt("--switches", "");
const DOM = args.includes("--dom") ? (args.splice(args.indexOf("--dom"), 1), true) : false;
const COMPOSITOR = args.includes("--compositor") ? (args.splice(args.indexOf("--compositor"), 1), true) : false;
const [file, only, scName] = args;
const spec = JSON.parse(fs.readFileSync(file, "utf8"));
const app = spec.find((a) => a.app.includes(only));
const sc = app.scenarios.find((s) => s.name === scName) ?? app.scenarios[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });

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

{ const p = await b.newPage(); await p.goto(`${BASE}/apps/tracker/`, { waitUntil: "load" }); await sleep(1500); await p.close(); }
const p = await b.newPage();
await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
// the runtime's worker, or (--compositor) the one that draws
let worker = null;
p.on("workercreated", (w) => { if ((COMPOSITOR ? /compositor\.js/ : /\/worker\.js/).test(w.url())) worker ??= w; });
await p.goto(`${BASE}/${app.app}${DOM ? "" : (app.app.includes("?") ? "&" : "?") + "render=gpu" + SW}`, { waitUntil: "load" });
if (DOM) await p.waitForFunction(() => typeof window.__declare === "object", { timeout: 30000 });
else await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 });
await sleep(app.settle ?? 1500);
for (const a of sc.before ?? []) await act(p, a);
const stats = (clear) => p.evaluate((clear) => new Promise((res) => { const w = window.__declareGpu.worker; const on = (e) => { if (e.data?.t === "stats") { w.removeEventListener("message", on); res(e.data); } }; w.addEventListener("message", on); w.postMessage({ t: "stats", clear }); }), clear);
const c = DOM ? await p.createCDPSession() : worker.client;
await c.send("Profiler.enable");
await c.send("Debugger.enable");
await c.send("Profiler.setSamplingInterval", { interval: 100 });
if (!DOM) await stats(true);
await c.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
await c.send("Profiler.start");
for (const a of sc.steps) await act(p, a);
const { profile } = await c.send("Profiler.stop");
const cov = await c.send("Profiler.takePreciseCoverage");
const s = DOM ? { busy: 0, frames: 1 } : await stats(false);

const frames = Math.max(1, s.frames_raw?.length ?? s.frames);
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = new Map();
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000);
const fn = new Map(), files = new Map();
let total = 0, idle = 0;
for (const [id, ms] of dt) {
  const f = byId.get(id).callFrame;
  if (f.functionName === "(idle)") { idle += ms; continue; }
  total += ms;
  const file = (f.url || f.functionName).replace(/^.*\//, "");
  const k = `${f.functionName || "(anon)"}  ${file}:${f.lineNumber + 1}`;
  fn.set(k, (fn.get(k) ?? 0) + ms);
  files.set(file, (files.get(file) ?? 0) + ms);
}
const pf = (v) => (v / frames).toFixed(2).padStart(6);
console.log(`${app.app} · ${sc.name} · ${DOM ? "DOM main thread" : "GPU worker"}: total ${total.toFixed(0)} ms; ${frames} frames; worker busy (self-reported) ${(s.busy / frames).toFixed(2)} ms/frame; sampled ${pf(total)} ms/frame (idle ${pf(idle)})`);
console.log("by file:");
for (const [k, v] of [...files].sort((a, c) => c[1] - a[1]).slice(0, 12)) console.log(`  ${pf(v)}  ${k}`);
console.log("by function (self):");
for (const [k, v] of [...fn].sort((a, c) => c[1] - a[1]).slice(0, TOP)) console.log(`  ${pf(v)}  ${k}`);
// inclusive: each sample counted once for every distinct function on its stack
const parent = new Map();
for (const n of profile.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
const incl = new Map();
for (const [id, ms] of dt) {
  if (byId.get(id).callFrame.functionName === "(idle)") continue;
  const seen = new Set();
  for (let x = id; x !== undefined; x = parent.get(x)) {
    const f = byId.get(x).callFrame;
    const k = `${f.functionName || "(anon)"}  ${(f.url || "").replace(/^.*\//, "")}:${f.lineNumber + 1}`;
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + ms);
  }
}
console.log("by function (inclusive):");
for (const [k, v] of [...incl].sort((a, c) => c[1] - a[1]).slice(0, TOP)) console.log(`  ${pf(v)}  ${k}`);
// calls: per function of the app's own code (scripts without a URL, or named by sourceURL), how often it ran
const calls = [];
const src = new Map();
for (const sc of cov.result) {
  if (/worker\.js|declare-boot|puppeteer|^chrome|^https?:.*node_modules/.test(sc.url) && !process.env.ALLCALLS) continue;
  for (const f of sc.functions) if (f.ranges[0].count > 0) calls.push([`${f.functionName || "(anon)"}  ${sc.url.replace(/^.*\//, "") || "(app)"}`, f.ranges[0].count, sc.scriptId, f.ranges[0].startOffset]);
}
console.log("calls:");
for (const [k, n, id, at] of calls.sort((a, c) => c[1] - a[1]).slice(0, TOP)) {
  if (!src.has(id)) src.set(id, (await c.send("Debugger.getScriptSource", { scriptId: id }).catch(() => ({ scriptSource: "" }))).scriptSource);
  console.log(`  ${String(n).padStart(9)}  ${k}  ${src.get(id).slice(at, at + 90).replace(/\s+/g, " ")}`);
}
await b.close();
// entries: what the event loop called into, each with its time and the first frames under it
if (process.env.ROOTS) {
  const root = profile.nodes.find((n) => n.callFrame.functionName === "(root)");
  const inc = new Map();
  const sum = (id) => { if (inc.has(id)) return inc.get(id); const n = byId.get(id); let v = n.callFrame.functionName === "(idle)" ? 0 : (dt.get(id) ?? 0); for (const ch of n.children ?? []) v += sum(ch); inc.set(id, v); return v; };
  const show = (id, depth) => {
    const n = byId.get(id), f = n.callFrame;
    if (sum(id) / frames < 0.05) return;
    console.log(`${"  ".repeat(depth)}${pf(sum(id))}  ${f.functionName || "(anon)"} ${(f.url || "").replace(/^.*\//, "")}:${f.lineNumber + 1}`);
    if (depth < Number(process.env.ROOTS)) for (const ch of [...(n.children ?? [])].sort((a, c) => sum(c) - sum(a))) show(ch, depth + 1);
  };
  show(root.id, 0);
}
