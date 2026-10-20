// gpu/bench-chrome.mjs — run gpu/dist/bench.js in headless Chrome against a ?render=gpu page; print its timing.
//   node gpu/bench-chrome.mjs [app path] [--size 1440x900] [--headed]
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--") && !/^\d+x\d+$/.test(a)) ?? "apps/calendar/";
const [w, h] = (args.includes("--size") ? args[args.indexOf("--size") + 1] : "1440x900").split("x").map(Number);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: !args.includes("--headed"), args: ["--no-sandbox"], defaultViewport: { width: w, height: h, deviceScaleFactor: 2 } });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:8200/${app}${app.includes("?") ? "&" : "?"}render=gpu`, { waitUntil: "load" });
await page.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1000));
const r = await page.evaluate(async () => (await import("/gpu/dist/bench.js")).run());
const drop = new Set(["log", "frames_raw", "inputs_raw", "busy_raw", "raf_raw", "raf_callbacks", "t"]);
for (const [k, v] of Object.entries(r)) {
  if (k === "switches") { console.log("switches:"); for (const e of v.each) console.log("  " + JSON.stringify(e)); continue; }
  console.log(k + ": " + JSON.stringify(v, (kk, vv) => (drop.has(kk) ? undefined : vv)));
}
await browser.close();
