// gpu/check.mjs — behaviours a screenshot alone does not show, under ?render=gpu:
// the cursor over a button, Escape closing the event panel, and a live window resize.
//
//   node gpu/check.mjs [app path] [--dom]   (written against apps/calendar/ at 1280×800; --dom runs the
//                                            same steps on the DOM renderer, for comparison)

import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const dom = process.argv.includes("--dom");
const app = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "apps/calendar/";
const tag = dom ? "dom" : "gpu";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:8200/${app}${dom ? "" : "?render=gpu"}`, { waitUntil: "load" });
await page.waitForFunction(dom ? () => window.__declarePerf?.completed === true : () => window.__declareGpu?.ready === true);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await pause(800);

// the cursor: over the Week button, then over empty ground
await page.mouse.move(1075, 30); await pause(300);
const cursorAt = (x, y) => page.evaluate((x, y) => { const c = document.querySelector("canvas"); return c ? c.style.cursor : getComputedStyle(document.elementFromPoint(x, y)).cursor; }, x, y);
const overButton = await cursorAt(1075, 30);
await page.mouse.move(640, 500); await pause(300);
const overGround = await cursorAt(640, 500);
console.log(`cursor: over a button "${overButton}", over the grid "${overGround}"`);

// Escape: open an event's panel in Week view, then close it from the keyboard
await page.mouse.click(1075, 30); await pause(900);
await page.mouse.click(326, 211); await pause(900);
await page.screenshot({ path: `/tmp/chk-open-${tag}.png`, clip: { x: 900, y: 60, width: 380, height: 200 } });
await page.keyboard.press("Escape"); await pause(900);
await page.screenshot({ path: `/tmp/chk-closed-${tag}.png`, clip: { x: 900, y: 60, width: 380, height: 200 } });
console.log(`escape: /tmp/chk-open-${tag}.png → /tmp/chk-closed-${tag}.png`);

// a live resize: narrower, then the shot
await page.setViewport({ width: 760, height: 640, deviceScaleFactor: 2 }); await pause(900);
await page.screenshot({ path: `/tmp/chk-resized-${tag}.png` });
console.log(`resize: /tmp/chk-resized-${tag}.png`);
console.log(errors.length === 0 ? "no errors" : "errors:\n  " + errors.join("\n  "));
await browser.close();
