// gpu/baseline.mjs — the render=gpu renderer against its own earlier pictures: a tripwire for
// work that should change how frames are made but not what they show (the layer compositor).
//
//   node gpu/baseline.mjs --save        shoot every case twice into gpu/test/baseline/ — the
//                                       second shot is the case's own noise (clocks, motion)
//   node gpu/baseline.mjs --learn       compare, and raise each case's noise to what it saw (a
//                                       clock a minute on, a game a few frames on): run it with
//                                       nothing changed, after --save
//   GPU_SWITCHES="&nokeep" node gpu/baseline.mjs …   the same with switches on every page
//   node gpu/baseline.mjs [name…]       shoot again and compare: per case the mean and largest
//                                       channel difference against the saved shot, beside the
//                                       noise; a case past its noise is reported as CHANGED
//
// Headless Chrome, 1280×800 at 2x. DOM stays the reference for what is right; this only says
// whether ?render=gpu still draws what it drew. Pictures are compared in the browser (no PNG library).

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import fs from "node:fs";
import path from "node:path";

const ROOT = "http://127.0.0.1:8200/";
const DIR = new URL("./test/baseline/", import.meta.url).pathname;
const save = process.argv.includes("--save");
const learn = process.argv.includes("--learn");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// swatchbook's tabs (css px): the top row at y 26, a tab's own row at y 156
const SW = { Type: 290, Lines: 367, Rich: 445, Paint: 523, Effects: 600, Transforms: 678, Images: 756, Drawing: 833, Measure: 911, Combined: 989 };
const SUB = [73, 169, 264, 359, 454, 550, 647, 742, 838, 933];
const sw = (top, sub = -1) => [["click", SW[top], 26], ...(sub >= 0 ? [["click", SUB[sub], 156]] : [])];

const CASES = [
  ...["architecture", "birds", "calendar", "desktop", "docs", "homepage", "lzx-calendar", "lzx-dashboard",
    "lzx-weather", "marketmap", "sampler", "tracker", "weather"].map((a) => ({ name: a, url: `apps/${a}/` })),
  ...["asteroids", "stargate"].map((a) => ({ name: a, url: `apps/games/${a}/` })),
  { name: "two-way", url: "apps/two-way/index.html" },
  { name: "calendar-week", url: "apps/calendar/", steps: [["click", 1100, 30]] },
  { name: "calendar-busy", url: "gpu/test/calendar-busy/" },
  { name: "tracker-scrolled", url: "apps/tracker/", steps: [["wheel", 600, 500, 600]] },
  { name: "weather-scrolled", url: "apps/weather/", steps: [["wheel", 900, 500, 500]] },
  { name: "weather-sidebar", url: "apps/weather/", steps: [["wheel", 160, 500, 400]] },
  { name: "birds-plate", url: "apps/birds/", steps: [["click", 210, 215]] },
  { name: "desktop-calendar", url: "apps/desktop/", steps: [["click", 531, 752]] },
  ...["Faces", "Italic", "Size", "Figures", "Decoration", "Fill"].map((s, i) => ({ name: `sw-type-${s.toLowerCase()}`, url: "apps/swatchbook/", steps: sw("Type", i) })),
  { name: "sw-lines", url: "apps/swatchbook/", steps: sw("Lines") },
  { name: "sw-rich", url: "apps/swatchbook/", steps: sw("Rich") },
  { name: "sw-paint", url: "apps/swatchbook/", steps: sw("Paint") },
  ...["Filters", "Chains", "Blend", "Masks", "Opacity", "Backdrop"].map((s, i) => ({ name: `sw-effects-${s.toLowerCase()}`, url: "apps/swatchbook/", steps: sw("Effects", i) })),
  ...["Scale", "Rotate", "Skew", "Pivot", "Combined", "3D"].map((s, i) => ({ name: `sw-transforms-${s.toLowerCase()}`, url: "apps/swatchbook/", steps: sw("Transforms", i) })),
  { name: "sw-images", url: "apps/swatchbook/", steps: sw("Images") },
  ...["Shapes", "Paths", "Curves", "Clip", "Compose", "Gradients", "Text", "Images", "Transforms", "Shadows"].map((s, i) => ({ name: `sw-drawing-${s.toLowerCase()}`, url: "apps/swatchbook/", steps: sw("Drawing", i) })),
  { name: "sw-measure", url: "apps/swatchbook/", steps: sw("Measure") },
  { name: "sw-combined", url: "apps/swatchbook/", steps: sw("Combined") },
].filter((c) => only.length === 0 || only.some((o) => c.name.includes(o)));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox", "--mute-audio"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
});

async function shoot(c, file) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    // the pictures are light: the system's own appearance does not reach them
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    const sep = c.url.includes("?") ? "&" : "?";
    await page.goto(ROOT + c.url + sep + "render=gpu" + (process.env.GPU_SWITCHES ?? ""), { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 60000 });
    await wait(2500);
    for (const s of c.steps ?? []) {
      if (s[0] === "click") await page.mouse.click(s[1], s[2]);
      if (s[0] === "wheel") { await page.mouse.move(s[1], s[2]); for (let i = 0; i < 5; i++) { await page.mouse.wheel({ deltaY: s[3] / 5 }); await wait(40); } }
      await wait(1500);
    }
    await page.screenshot({ path: file });
  } finally { await page.close(); }
  return errors;
}

// mean and largest channel difference of two PNGs on the dev server, decoded by the browser
const cmp = await browser.newPage();
await cmp.goto(ROOT + "gpu/test/provides/index.html");
async function diff(a, b) {
  const rel = (f) => ROOT + path.relative(path.resolve(DIR, "../../.."), f).split(path.sep).join("/") + "?t=" + Date.now();
  return cmp.evaluate(async (ua, ub) => {
    const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
    const [A, B] = await Promise.all([load(ua), load(ub)]);
    if (A.width !== B.width || A.height !== B.height) return { mean: 255, max: 255, over: 1 };
    const px = (img) => { const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const p = px(A), q = px(B);
    let sum = 0, max = 0, over = 0;
    for (let i = 0; i < p.length; i += 4) {
      const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
      sum += d; if (d > max) max = d; if (d > 24) over++;
    }
    const n = p.length / 4;
    return { mean: +(sum / n).toFixed(3), max, over: +(over / n).toFixed(5) };
  }, rel(a), rel(b));
}

fs.mkdirSync(path.join(DIR, "now"), { recursive: true });
let changed = 0;
for (const c of CASES) {
  const base = path.join(DIR, c.name + ".png"), noise = path.join(DIR, c.name + ".b.png");
  if (save) {
    const e = [...await shoot(c, base), ...await shoot(c, noise)];
    const n = await diff(base, noise);
    fs.writeFileSync(path.join(DIR, c.name + ".json"), JSON.stringify(n));
    console.log(`saved ${c.name.padEnd(24)} noise mean ${n.mean} over ${n.over}${e.length ? "  errors: " + e.join("; ") : ""}`);
    continue;
  }
  if (!fs.existsSync(base)) { console.log(`${c.name}: no baseline (--save)`); continue; }
  const now = path.join(DIR, "now", c.name + ".png");
  const e = await shoot(c, now);
  const d = await diff(base, now);
  const n = JSON.parse(fs.readFileSync(path.join(DIR, c.name + ".json"), "utf8"));
  if (learn) {
    n.mean = Math.max(n.mean, d.mean); n.over = Math.max(n.over, d.over);
    fs.writeFileSync(path.join(DIR, c.name + ".json"), JSON.stringify(n));
    console.log(`learned ${c.name.padEnd(24)} noise mean ${n.mean} over ${n.over}`);
    continue;
  }
  // past its own noise: more pixels off by a visible amount than two shots of it differ by
  const bad = d.over > n.over * 1.5 + 0.0005 || d.mean > n.mean * 1.5 + 0.05;
  if (bad) changed++;
  console.log(`${bad ? "CHANGED" : "same   "} ${c.name.padEnd(24)} mean ${d.mean} (noise ${n.mean})  over ${d.over} (noise ${n.over})${e.length ? "  errors: " + e.join("; ") : ""}`);
}
await browser.close();
if (!save && !learn) console.log(changed === 0 ? "all as before" : `${changed} changed — the shots are in gpu/test/baseline/now/`);
process.exit(!save && !learn && changed > 0 ? 1 : 0);
