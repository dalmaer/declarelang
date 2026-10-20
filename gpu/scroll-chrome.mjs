// gpu/scroll-chrome.mjs — scroll a ?render=gpu page in headless Chrome (real wheel input, a frame
// apart) and print the worker's frame timing: encode (CPU) and GPU per frame, and how many
// tiles were drawn. Compares `&nolayers` beside it.
//   node gpu/scroll-chrome.mjs <app path> <x,y> [steps] [--rounds N]
// Each round runs both, in alternating order, after a page that is not measured (the first
// page in a browser runs cold).
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const app = process.argv[2] ?? "apps/tracker/";
const [x, y] = (process.argv[3] ?? "600,500").split(",").map(Number);
const steps = Number(process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : 40);
const ri = process.argv.indexOf("--rounds");
const rounds = ri > 0 ? Number(process.argv[ri + 1]) : 1;
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox", "--mute-audio"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const order = ["warm"];
for (let r = 0; r < rounds; r++) order.push(...(r % 2 === 0 ? ["", "&nolayers"] : ["&nolayers", ""]));
for (const q of order) {
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror", e.message));
  p.on("console", (m) => { if (m.type() === "error") console.log("console", m.text()); });
  p.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
  await p.goto(`http://127.0.0.1:8200/${app}${app.includes("?") ? "&" : "?"}render=gpu${q === "warm" ? "" : q}`, { waitUntil: "load" });
  await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 60000 });
  await wait(2500);
  const stats = async () => { await p.evaluate(() => { window.__declareGpuStats = undefined; window.__declareGpu.worker.postMessage({ t: "stats", clear: true }); }); await wait(300); return p.evaluate(() => window.__declareGpuStats); };
  await stats();
  await p.mouse.move(x, y);
  for (let i = 0; i < steps; i++) { await p.mouse.wheel({ deltaY: 60 }); await wait(16); }
  await wait(600);
  const s = await stats();
  if (q === "warm") { await p.close(); continue; }             // the first page runs cold
  const f = (v) => v == null ? "-" : `${v.median.toFixed(1)} (p95 ${v.p95.toFixed(1)})`;
  console.log(`${(q || "layers").padEnd(10)} frames ${s.encode?.n ?? 0}  encode ${f(s.encode)}  gpu ${f(s.gpu)}  tiles drawn ${s.counts?.tiles ?? 0}  counts ${JSON.stringify(s.counts)}  damage ${JSON.stringify(s.damage)}`);
  await p.close();
}
await b.close();
