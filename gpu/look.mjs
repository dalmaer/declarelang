// gpu/look.mjs — open an app under ?render=gpu in headless Chrome, report the console, and shoot it.
//
//   node gpu/look.mjs <app path> [--out shot.png] [--dom dom.png] [--size 1280x800] [--dark] [--wait ms] [--clip x,y,w,h]
//
// <app path> is served by the dev server on :8200 (`npm start`; e.g. apps/calendar/).
// --dom also shoots the same page on the DOM renderer, for comparison. --click x,y (repeatable), --drag x1,y1,x2,y2,
// --probe text (or #id) reports the GPU host's matching nodes. --wheel x,y,dy[,steps], --type text and --key Key act on the page, in order, before the shot.

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const app = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "apps/calendar/";
const [w, h] = opt("--size", "1280x800").split("x").map(Number);
const out = opt("--out", "/tmp/gpu-look.png");
const dom = opt("--dom", null);
const wait = Number(opt("--wait", "1500"));
const dark = args.includes("--dark");
const clipArg = opt("--clip", null);
const clip = clipArg === null ? undefined : (([x, y, width, height]) => ({ x, y, width, height }))(clipArg.split(",").map(Number));
const base = `http://127.0.0.1:8200/${app}`;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"],
  defaultViewport: { width: w, height: h, deviceScaleFactor: 2 },
});
const shoot = async (url, file, gpu) => {
  const page = await browser.newPage();
  if (dark) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const log = [];
  page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
  // the worker's console reaches the page's target
  page.on("workercreated", (wk) => { log.push(`[worker] ${wk.url()}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  if (gpu) {
    await page.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 }).catch(() => log.push("[look] never ready"));
  } else {
    await page.waitForFunction(() => window.__declarePerf?.completed === true, { timeout: 30000 }).catch(() => {});
  }
  const ready = Date.now() - t0;
  await new Promise((r) => setTimeout(r, wait));
  // the person's part: --click x,y (repeatable, in order), --type text, --key Key
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--click") { const [x, y] = args[i + 1].split(",").map(Number); await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, wait)); }
    else if (args[i] === "--drag") {
      const [x1, y1, x2, y2] = args[i + 1].split(",").map(Number);
      await page.mouse.move(x1, y1); await page.mouse.down();
      for (let k = 1; k <= 12; k++) { await page.mouse.move(x1 + (x2 - x1) * k / 12, y1 + (y2 - y1) * k / 12); await new Promise((r) => setTimeout(r, 16)); }
      await page.mouse.up(); await new Promise((r) => setTimeout(r, wait));
    }
    else if (args[i] === "--type") { await page.keyboard.type(args[i + 1], { delay: 20 }); await new Promise((r) => setTimeout(r, wait)); }
    else if (args[i] === "--wheel") {
      // --wheel x,y,dy[,steps]: a mouse wheel at a point, dy pixels per step. Under the 2x
      // device emulation Chrome hands script half the delta its own scrolling uses, so ?render=gpu
      // (which hears the script's event) scrolls half as far as the DOM renderer here.
      const [x, y, dy, steps = 10] = args[i + 1].split(",").map(Number);
      await page.mouse.move(x, y);
      for (let k = 0; k < steps; k++) { await page.mouse.wheel({ deltaY: dy }); await new Promise((r) => setTimeout(r, 16)); }
      await new Promise((r) => setTimeout(r, wait));
    }
    else if (args[i] === "--probe") {
      // --probe text: the GPU host's nodes whose text holds it, with their ancestors (diagnostic)
      const shell = await page.evaluate((t) => { window.__declareGpuProbe = undefined; return t; }, args[i + 1]);
      await page.evaluate((t) => window.__declareGpu?.worker?.postMessage({ t: "probe", text: t }), shell);
      await new Promise((r) => setTimeout(r, 300));
      console.log(JSON.stringify(await page.evaluate(() => window.__declareGpuProbe), null, 1));
    }
    else if (args[i] === "--key") { await page.keyboard.press(args[i + 1]); await new Promise((r) => setTimeout(r, wait)); }
  }
  // captureBeyondViewport would re-emulate the viewport for a clip, and the GPU canvas's
  // images do not survive that capture (a real resize keeps them)
  await page.screenshot({ path: file, clip, captureBeyondViewport: false });
  const ms = gpu ? await page.evaluate(() => window.__declareGpu?.ms) : null;
  console.log(`${gpu ? "gpu" : "dom"}: ready in ${ready} ms ${ms ? JSON.stringify(ms) : ""} → ${file}`);
  for (const l of log) console.log("   " + l.slice(0, 400));
  await page.close();
};
await shoot(base + (base.includes("?") ? "&" : "?") + "render=gpu", out, true);
if (dom) await shoot(base, dom, false);
await browser.close();
