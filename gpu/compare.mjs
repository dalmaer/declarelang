// gpu/compare.mjs — the GPU renderer against the DOM renderer in Chrome: startup, per-frame
// cost and interaction, measured the same way for both from Chrome's own trace.
//
//   node gpu/compare.mjs [app path] [--runs 3] [--size 1440x900]
//
// Every thread of every process is traced, so work that moves off the page's thread (to the
// worker, to the GPU process) is still counted. For each part it reports:
//   frames   frames the display compositor showed (Display::FrameDisplayed)
//   busy     each group of threads' busy time (top-level tasks, overlaps merged), in total
//            and per frame shown
//   slot     the critical thread's busy time per 16.7 ms frame slot while things move — its
//            median, p95 and worst: what is left of the frame is the headroom
// Groups: page = the page's main thread; worker = the program's worker (GPU renderer);
// renderer = the page process's other threads (compositor, raster, IO); gpu = the GPU
// process (Viz, the GPU main thread — where both renderers' drawing ends up); browser.
// Input is Chrome's real input (CDP Input), the same for both renderers.

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const app = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--")) ?? "apps/calendar/";
const runs = Number(opt("--runs", "3"));
// --throttle N: slow the page's CPU N× (CDP Emulation.setCPUThrottlingRate) for the interaction
// parts — what the headroom buys when the machine is short of time
const throttle = Number(opt("--throttle", "1"));
// --parts a,b: only these interaction parts; --no-startup skips the startup section
const only = opt("--parts", null)?.split(",") ?? null;
const [W, H] = opt("--size", "1440x900").split("x").map(Number);
const base = `http://127.0.0.1:8200/${app}`;
const SLOT = 1000 / 60;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const traceFile = path.join(os.tmpdir(), `declare-compare-${process.pid}.json`);

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"], defaultViewport: { width: W, height: H, deviceScaleFactor: 2 },
});

// ── the trace ─────────────────────────────────────────────────────────────────

const CATS = ["toplevel", "viz", "disabled-by-default-display.framedisplayed"];

function analyze(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const ev = raw.traceEvents ?? raw;
  const tn = new Map(), pn = new Map();
  for (const e of ev) if (e.ph === "M") {
    if (e.name === "thread_name") tn.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === "process_name") pn.set(e.pid, e.args.name);
  }
  // which renderer is the page's: the one with a DedicatedWorker or the most main-thread work
  const group = (pid, tid) => {
    const p = pn.get(pid) ?? "", t = tn.get(`${pid}:${tid}`) ?? "";
    if (p === "Renderer") return t === "CrRendererMain" ? "page" : t.startsWith("DedicatedWorker") ? "worker" : "renderer";
    if (p === "GPU Process") return "gpu";
    if (p === "Browser") return "browser";
    return "other";
  };
  const spans = new Map();     // thread → [[start, end]] (µs)
  let t0 = Infinity, t1 = -Infinity;
  const shown = [];
  for (const e of ev) {
    if (e.ts !== undefined) { t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts + (e.dur ?? 0)); }
    if (e.name === "Display::FrameDisplayed") shown.push(e.ts);
    if (e.ph !== "X" || !e.cat?.includes("toplevel") || !(e.dur > 0)) continue;
    const k = `${e.pid}:${e.tid}`;
    let a = spans.get(k); if (a === undefined) { a = []; spans.set(k, a); }
    a.push([e.ts, e.ts + e.dur]);
  }
  // merge each thread's spans (nested and overlapping top-level events count once)
  const busy = { page: 0, worker: 0, renderer: 0, gpu: 0, browser: 0, other: 0 };
  const merged = new Map();
  for (const [k, a] of spans) {
    a.sort((x, y) => x[0] - y[0]);
    const m = [];
    for (const s of a) { const last = m[m.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else m.push([...s]); }
    merged.set(k, m);
    const [pid, tid] = k.split(":").map(Number);
    busy[group(pid, tid)] += m.reduce((x, s) => x + s[1] - s[0], 0) / 1000;
  }
  // per-slot busy of a group's threads (µs → ms), over the stretch where frames were shown
  shown.sort((a, b) => a - b);
  const slots = (g) => {
    if (shown.length < 2) return null;
    const from = shown[0], to = shown[shown.length - 1];
    const n = Math.max(1, Math.ceil((to - from) / (SLOT * 1000)));
    const bins = new Array(n).fill(0);
    for (const [k, m] of merged) {
      const [pid, tid] = k.split(":").map(Number);
      if (group(pid, tid) !== g) continue;
      for (const [s, e] of m) {
        for (let x = Math.max(s, from); x < Math.min(e, to);) {
          let i = Math.floor((x - from) / (SLOT * 1000));
          let binEnd = from + (i + 1) * SLOT * 1000;
          if (binEnd <= x) { i++; binEnd += SLOT * 1000; }          // x on a boundary: the next slot
          const end = Math.min(e, binEnd, to);
          if (i < bins.length) bins[i] += (end - x) / 1000;
          if (end <= x) break;
          x = end;
        }
      }
    }
    const s = [...bins].sort((a, b) => a - b);
    return { median: +s[Math.floor(s.length / 2)].toFixed(2), p95: +s[Math.floor(0.95 * (s.length - 1))].toFixed(2), max: +s[s.length - 1].toFixed(2) };
  };
  return { wall: (t1 - t0) / 1000, frames: shown.length, busy, slots };
}

const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(1) : v]));

// ── startup ───────────────────────────────────────────────────────────────────

async function startup(gpu, cold) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  if (cold) await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.tracing.start({ path: traceFile, categories: CATS });
  await page.goto(base + (gpu ? "?render=gpu" : ""), { waitUntil: "load" });
  // the first frame the app appears in, from navigation start
  const firstFrame = gpu
    ? await page.evaluate(async () => {
      while (!(window.__declareGpu?.ready)) await new Promise((r) => setTimeout(r, 5));
      const w = window.__declareGpu.worker;
      for (;;) {
        const st = await new Promise((res) => { const on = (e) => { if (e.data?.t === "stats") { w.removeEventListener("message", on); res(e.data); } }; w.addEventListener("message", on); w.postMessage({ t: "stats", clear: false }); });
        const f = st.frames_raw[0];
        if (f !== undefined && f[2] >= 0) return f[0] + f[1] + f[2] - performance.timeOrigin;   // the GPU finished it
        await new Promise((r) => setTimeout(r, 10));
      }
    })
    : await page.evaluate(async () => { await window.__declarePerf.done; return performance.now(); });
  await pause(300);
  await page.tracing.stop();
  const a = analyze(traceFile);
  await page.close();
  return { firstFrame, busy: a.busy };
}

// ── interaction ───────────────────────────────────────────────────────────────
// Each renderer in a browser of its own, so both pages stay foreground; every part runs
// on the DOM page and then at once on the GPU page — back to back, so whatever else the
// machine is doing weighs on both alike.

const seg = (k) => [W - [279, 205, 132, 59][k], 30];   // day, week, month, year (right-aligned header)
const PARTS = {
  async hover(page) {
    for (let i = 0; i <= 120; i++) { await page.mouse.move(40 + (i / 120) * (W - 80), H * 0.55 + Math.sin(i / 8) * 120); await pause(16); }
  },
  async switches(page) {
    for (const k of [1, 0, 3, 2, 1, 2, 0, 2]) { const [x, y] = seg(k); await page.mouse.click(x, y); await pause(1100); }
  },
  async drag(page) {
    // from Monday's 3:30a in week view (the setup puts it there), down and across, slowly
    const ev = [Math.round(W * 0.255), 211];
    await page.mouse.move(ev[0], ev[1]); await page.mouse.down();
    for (let i = 1; i <= 90; i++) { await page.mouse.move(ev[0] + i * 3, ev[1] + i * 2); await pause(16); }
    await page.mouse.up(); await pause(400);
  },
};
const SETUP = {
  hover: async () => {},
  switches: async () => {},
  drag: async (page) => { const [x, y] = seg(1); await page.mouse.click(x, y); await pause(1100); },
};

async function openApp(b, gpu) {
  const page = await b.newPage();
  if (throttle > 1) await (await page.createCDPSession()).send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.goto(base + (gpu ? "?render=gpu" : ""), { waitUntil: "load" });
  await page.waitForFunction(gpu ? () => window.__declareGpu?.ready === true : () => window.__declarePerf?.completed === true, { timeout: 30000 });
  await pause(800);
  return page;
}

async function tracedPart(page, part) {
  await SETUP[part](page);
  await page.tracing.start({ path: traceFile, categories: CATS });
  await PARTS[part](page);
  await page.tracing.stop();
  const a = analyze(traceFile);
  const critical = page.url().includes("?render=gpu") ? "worker" : "page";
  return { frames: a.frames, busy: a.busy, crit: a.slots(critical), pageSlot: a.slots("page"), gpuSlot: a.slots("gpu") };
}

// ── run ───────────────────────────────────────────────────────────────────────

const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const medianOf = (objs, key) => { const ks = Object.keys(objs.find((o) => o?.[key])?.[key] ?? {}); return Object.fromEntries(ks.map((k) => [k, median(objs.map((o) => o?.[key]?.[k]))])); };
const pad = (s, n) => String(s).padEnd(n);
console.log(`${app} at ${W}×${H} @2x, Chrome ${(await browser.version())}; ${runs} interleaved A/B rounds\n`);

if (!args.includes("--no-startup")) {
console.log("STARTUP — navigation to the app's first frame, and each process group's busy time getting there (medians)");
const st = { "cold dom": [], "cold gpu": [], "warm dom": [], "warm gpu": [] };
for (let i = 0; i < runs; i++) {
  st["cold dom"].push(await startup(false, true));
  st["cold gpu"].push(await startup(true, true));
  st["warm dom"].push(await startup(false, false));
  st["warm gpu"].push(await startup(true, false));
}
for (const [k, r] of Object.entries(st)) {
  console.log(`  ${pad(k, 9)} first frame ${pad(median(r.map((x) => x.firstFrame)).toFixed(0) + " ms", 8)} busy ms ${JSON.stringify(round(medianOf(r, "busy")))}`);
}
}

console.log(`\nINTERACTION${throttle > 1 ? ` (CPU slowed ${throttle}×)` : ""} — frames shown; busy per frame shown; the critical thread's busy per 16.7 ms slot (medians across rounds)`);
const browsers = { dom: browser, gpu: await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"], defaultViewport: { width: W, height: H, deviceScaleFactor: 2 } }) };
const res = {};
for (let i = 0; i < runs; i++) {
  for (const part of Object.keys(PARTS).filter((p) => only === null || only.includes(p))) {
    for (const r of ["dom", "gpu"]) {
      const page = await openApp(browsers[r], r === "gpu");
      ((res[part] ??= {})[r] ??= []).push(await tracedPart(page, part));
      await page.close();
    }
  }
}
for (const part of Object.keys(PARTS).filter((p) => only === null || only.includes(p))) {
  console.log(`  ${part}`);
  for (const r of ["dom", "gpu"]) {
    const rs = res[part][r];
    const frames = median(rs.map((x) => x.frames));
    const busy = medianOf(rs, "busy");
    const perFrame = {}; for (const [k, v] of Object.entries(busy)) if (v > 0.5) perFrame[k] = +(v / Math.max(1, frames)).toFixed(2);
    console.log(`    ${pad(r, 4)} frames ${pad(frames, 4)} busy ms ${JSON.stringify(round(busy))}`);
    console.log(`         per frame shown ${JSON.stringify(perFrame)}`);
    console.log(`         ${r === "gpu" ? "worker" : "page  "} per slot ${JSON.stringify(medianOf(rs, "crit"))}   gpu process per slot ${JSON.stringify(medianOf(rs, "gpuSlot"))}`);
  }
}
await browsers.gpu.close();
await browser.close();
rmSync(traceFile, { force: true });
