// gpu/startup.mjs — where a page's startup goes, GPU renderer against DOM, interleaved A/B (warm).
//   node gpu/startup.mjs [app path] [--runs 5]
// GPU: the boot handing over to the shell, then the worker's milestones (ms from navigation).
// DOM: the boot's own stages (performance measures `declare:*`) and the first painted frame.
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--") && !/^\d/.test(a)) ?? "apps/calendar/";
const runs = Number(args.includes("--runs") ? args[args.indexOf("--runs") + 1] : "5");
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 } });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const gpu = [], dom = [];
for (let i = 0; i < runs + 1; i++) {          // the first round warms the cache and is dropped
  for (const g of [false, true]) {
    const p = await b.newPage();
    await p.goto(`http://127.0.0.1:8200/${app}${g ? "?render=gpu" : ""}`, { waitUntil: "load" });
    const r = g
      ? await p.evaluate(async () => { while (!window.__declareGpu?.ready) await new Promise((r) => setTimeout(r, 5)); return window.__declareGpu.marks; })
      : await p.evaluate(async () => { const d = await window.__declarePerf.done; const o = { firstPaint: +performance.now().toFixed(1) };
          for (const s of d.stages) o[s.stage] = +(s.start + s.dur).toFixed(1); return o; });
    if (i > 0) (g ? gpu : dom).push(r);
    await p.close();
  }
}
const show = (rows) => { const ks = Object.keys(rows[0]); return ks.map((k) => [k, median(rows.map((r) => r[k] ?? NaN))]).sort((x, y) => x[1] - y[1]).map(([k, v]) => `${k} ${v}`).join(" · "); };
console.log("DOM (ms from navigation, each stage's end): " + show(dom));
console.log("GPU (ms from navigation):                    " + show(gpu));
await b.close();
