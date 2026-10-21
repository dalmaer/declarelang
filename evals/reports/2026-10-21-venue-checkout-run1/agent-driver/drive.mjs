// usage: node drive.mjs <script.mjs> [WxH] [touch]
import puppeteer from "/Users/temkin/Code/eval-venue-checkout-1/work/declarelang/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const [,, scriptPath, size = "1440x900", touch] = process.argv;
const [w, h] = size.split("x").map(Number);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: touch ? 3 : 1, isMobile: !!touch, hasTouch: !!touch });
const reqs = [];
page.on("request", (r) => { if (r.url().includes(":8350/api/") && r.method() != "OPTIONS" && r.method() != "GET") reqs.push(r.method() + " " + r.url().replace("http://127.0.0.1:8350", "") + " " + (r.postData() ?? "")); });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() == "error" || m.type() == "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 300)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const role = (r, name) => page.locator(`::-p-aria([name="${name}"][role="${r}"])`);
const byName = (name) => page.$(`::-p-aria(${JSON.stringify(name).slice(1, -1)})`);
const shot = (f) => page.screenshot({ path: "/tmp/shots/" + f });
const text = () => page.evaluate(() => document.body.innerText);
await page.goto("http://127.0.0.1:8201/my-apps/venue/venue.declare", { waitUntil: "networkidle2" });
await sleep(800);
const mod = await import(scriptPath);
try { await mod.default({ page, role, byName, sleep, shot, text, reqs, touch: !!touch }); }
catch (e) { console.log("FAILED:", e.message); await shot("fail.png"); }
console.log("REQUESTS:\n  " + reqs.join("\n  "));
await browser.close();
