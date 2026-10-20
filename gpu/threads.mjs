// gpu/threads.mjs — where a scenario's time goes, thread by thread, in every process of
// headless Chrome: one scenario (gpu/census-scenarios.json's shape) under a full trace, each
// thread's top-level work summed (CPU time where the trace has it, else wall time) and shown
// in ms per frame drawn.
//   node gpu/threads.mjs <scenarios.json> <app filter> <scenario name> [--dom] [--base URL]
//        [--cats a,b] [--top N]
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : d; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const BASE = opt("--base", "http://127.0.0.1:8200");
const CATS = opt("--cats", "toplevel,devtools.timeline,disabled-by-default-devtools.timeline,v8,gpu,blink,cc,viz,disabled-by-default-v8.cpu_profiler").split(",");
const TOP = Number(opt("--top", 12));
const DOM = flag("--dom");
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
await p.goto(`${BASE}/${app.app}${DOM ? "" : (app.app.includes("?") ? "&" : "?") + "render=gpu"}`, { waitUntil: "load" });
if (DOM) await p.waitForFunction(() => typeof window.__declare === "object", { timeout: 30000 });
else await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 });
await sleep(app.settle ?? 1500);
for (const a of sc.before ?? []) await act(p, a);
await p.tracing.start({ categories: CATS });
for (const a of sc.steps) await act(p, a);
const trace = JSON.parse(Buffer.from(await p.tracing.stop()).toString("utf8")).traceEvents;
await b.close();

const names = new Map(), procs = new Map();
for (const e of trace) {
  if (e.ph !== "M") continue;
  if (e.name === "thread_name") names.set(e.pid + ":" + e.tid, e.args.name);
  if (e.name === "process_name") procs.set(e.pid, e.args.name);
}
// frames: the page's Layerize (DOM) or the worker's frame calls (render=gpu, counted from swaps)
const frames = Math.max(1, trace.filter((e) => e.ph === "X" && (DOM ? e.name === "Layerize" : e.name === "Graphics.Pipeline.DrawAndSwap" || e.name === "Display::DrawAndSwap")).length);
// per thread: nested complete events merged so each moment counts once; CPU from tdur when present
const by = new Map();
const ev = trace.filter((e) => e.ph === "X" && e.dur > 0).sort((a, c) => a.ts - c.ts || c.dur - a.dur);
const open = new Map();
for (const e of ev) {
  const k = e.pid + ":" + e.tid;
  const end = open.get(k) ?? -1;
  if (e.ts < end) continue;
  open.set(k, e.ts + e.dur);
  const r = by.get(k) ?? { wall: 0, cpu: 0, names: new Map() };
  r.wall += e.dur / 1000; r.cpu += (e.tdur ?? e.dur) / 1000;
  r.names.set(e.name, (r.names.get(e.name) ?? 0) + (e.tdur ?? e.dur) / 1000);
  by.set(k, r);
}
console.log(`${app.app} · ${sc.name} · ${DOM ? "DOM" : "GPU"}: ${frames} frames (swaps)`);
const rows = [...by].sort((a, c) => c[1].cpu - a[1].cpu).slice(0, TOP);
for (const [k, r] of rows) {
  const pid = Number(k.split(":")[0]);
  const top = [...r.names].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([n, v]) => `${n} ${(v / frames).toFixed(2)}`).join(", ");
  console.log(`  ${(procs.get(pid) ?? pid) + " / " + (names.get(k) ?? k)}`.padEnd(48) + `${(r.cpu / frames).toFixed(2).padStart(6)} ms/frame cpu  (${(r.wall / frames).toFixed(2)} wall)  ${top}`);
}
// the busiest thread's own time by what it was doing: each trace event's self time (its span less
// its children's), in ms per frame
{
  const [k] = rows[0];
  const mine = trace.filter((e) => e.ph === "X" && e.dur > 0 && e.pid + ":" + e.tid === k).sort((a, c) => a.ts - c.ts || c.dur - a.dur);
  const self = new Map(), stack = [];
  for (const e of mine) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    if (stack.length) self.set(stack[stack.length - 1].name, (self.get(stack[stack.length - 1].name) ?? 0) - e.dur / 1000);
    self.set(e.name, (self.get(e.name) ?? 0) + e.dur / 1000);
    stack.push(e);
  }
  console.log(`  ${names.get(k)} by event (self):`);
  for (const [n, v] of [...self].sort((a, c) => c[1] - a[1]).slice(0, 14)) console.log(`    ${(v / frames).toFixed(2).padStart(6)}  ${n}`);
}
