// gpu/scroll-safari.mjs — scroll a ?render=gpu page in Safari (a tab of its own, through
// `safaridriver --mcp`) by posting wheel messages to its worker, a frame apart, and print
// the worker's frame timing. Run outside the sandbox.
//   node gpu/scroll-safari.mjs [app path] [x,y]
import { connect } from "./tools/safari-client.mjs";
const app = process.argv[2] ?? "apps/weather/";
const [x, y] = (process.argv[3] ?? "160,500").split(",").map(Number);
const c = await connect();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expression) => {
  const r = await c.tool("evaluate_javascript", { expression });
  const text = r.content?.map((t) => t.text).join("") ?? JSON.stringify(r);
  try { const v = JSON.parse(text); return typeof v === "string" ? v : text; } catch { return text; }
};
const tab = await c.tool("create_tab", { url: `http://127.0.0.1:8200/${app}?render=gpu${process.argv[4] ?? ""}` });
const handle = (JSON.stringify(tab).match(/(page-[0-9A-Fa-f-]+)/) || [])[1];
try {
  for (let i = 0; i < 40; i++) { if ((await js(`return String(window.__declareGpu?.ready === true)`)).includes("true")) break; await wait(500); }
  await wait(2500);
  const run = async (label) => {
    await js(`window.__declareGpu.worker.postMessage({ t: "stats", clear: true }); return "ok"`);
    await wait(300);
    await js(`window.__done = false; let i = 0; const f = () => { window.__declareGpu.worker.postMessage({ t: "wheel", x: ${x}, y: ${y}, dx: 0, dy: 40, pinch: false, ts: performance.timeOrigin + performance.now() }); if (++i < 40) requestAnimationFrame(f); else setTimeout(() => window.__done = true, 600); }; requestAnimationFrame(f); return "ok"`);
    for (let i = 0; i < 20 && !(await js(`return String(window.__done)`)).includes("true"); i++) await wait(300);
    await js(`window.__declareGpuStats = undefined; window.__declareGpu.worker.postMessage({ t: "stats", clear: true }); return "ok"`);
    await wait(400);
    console.log(label, await js(`const s = window.__declareGpuStats; return JSON.stringify({ frames: s.encode?.n, encode: s.encode && [s.encode.median, s.encode.p95].map((v) => +v.toFixed(1)), gpu: s.gpu && [s.gpu.median, s.gpu.p95].map((v) => +v.toFixed(1)), interval: s.frameInterval && [s.frameInterval.median, s.frameInterval.p95].map((v) => +v.toFixed(1)), damage: s.damage, counts: s.counts })`));
  };
  await run("scroll");
} finally {
  if (handle) await c.tool("close_tab", { handle });
  c.close();
}
