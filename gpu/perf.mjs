// gpu/perf.mjs — the same interaction on the GPU and DOM renderers, timed.
//
//   node gpu/perf.mjs [app path] [--size 1440x900]
//
// Clicks through the calendar's views (Week, Day, Year, Month — each a spring-carried
// change of the whole surface) and reports, per renderer: the page's main-thread time
// (Chrome's TaskDuration) over the sequence; for the GPU, the worker's frames and their
// encode-and-submit times.

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--")) ?? "apps/calendar/";
const [w, h] = (args.includes("--size") ? args[args.indexOf("--size") + 1] : "1440x900").split("x").map(Number);
const base = `http://127.0.0.1:8200/${app}`;
// the segmented control's four buttons at 1440 wide: Day, Week, Month, Year (CSS px)
const seg = { day: [w - 340, 30], week: [w - 250, 30], month: [w - 160, 30], year: [w - 72, 30] };
const steps = ["week", "day", "year", "month", "week", "month"];

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"], defaultViewport: { width: w, height: h, deviceScaleFactor: 2 },
});
const pct = (a, p) => { if (a.length === 0) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const gpu of [true, false]) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");
  await page.goto(base + (gpu ? "?render=gpu" : ""), { waitUntil: "load" });
  await page.waitForFunction(gpu ? () => window.__declareGpu?.ready === true : () => window.__declarePerf?.completed === true, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));
  if (gpu) await page.evaluate(() => window.__declareGpu.worker.postMessage({ t: "stats", clear: true }));
  const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const t0 = Date.now();
  for (const s of steps) { await page.mouse.click(seg[s][0], seg[s][1]); await new Promise((r) => setTimeout(r, 900)); }
  const wall = Date.now() - t0;
  const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const main = (m1.TaskDuration - m0.TaskDuration) * 1000;
  let line = `${gpu ? "gpu" : "dom"}: main thread ${main.toFixed(0)} ms over ${wall} ms (${steps.length} view changes)`;
  if (gpu) {
    await page.evaluate(() => { window.__declareGpuStats = null; window.__declareGpu.worker.postMessage({ t: "stats" }); });
    await page.waitForFunction(() => window.__declareGpuStats != null);
    const st = await page.evaluate(() => window.__declareGpuStats);
    const log = st.log;
    const sum = log.reduce((a, b) => a + b, 0);
    line += `; worker busy ${st.busy.toFixed(0)} ms, ${log.length} frames, encode+submit ${sum.toFixed(0)} ms total, median ${pct(log, 0.5).toFixed(2)} ms, p95 ${pct(log, 0.95).toFixed(2)} ms, max ${Math.max(0, ...log).toFixed(2)} ms`;
  }
  console.log(line);
  await page.close();
}
await browser.close();
