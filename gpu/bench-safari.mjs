// gpu/bench-safari.mjs — run gpu/dist/bench.js in Safari (a tab of its own, through
// `safaridriver --mcp`) against a ?render=gpu page; print its timing. Run outside the sandbox.
//   node gpu/bench-safari.mjs [app path]
import { connect } from "./tools/safari-client.mjs";
const app = process.argv[2] ?? "apps/calendar/";
const c = await connect();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the tool answers a value as JSON text: decode it, so a returned string is that string
const js = async (expression) => {
  const r = await c.tool("evaluate_javascript", { expression });
  const text = r.content?.map((x) => x.text).join("") ?? JSON.stringify(r);
  try { const v = JSON.parse(text); return typeof v === "string" ? v : text; } catch { return text; }
};
const tab = await c.tool("create_tab", { url: `http://127.0.0.1:8200/${app}?render=gpu` });
const handle = (JSON.stringify(tab).match(/(page-[0-9A-Fa-f-]+)/) || [])[1];
try {
  for (let i = 0; i < 40; i++) { if ((await js(`return String(window.__declareGpu?.ready === true)`)).includes("true")) break; await wait(500); }
  console.log("ready:", await js(`return JSON.stringify({ ms: window.__declareGpu?.ms, size: innerWidth + "x" + innerHeight + "@" + devicePixelRatio, visible: document.visibilityState })`));
  // the tab's own frame rate first: a throttled (occluded) window would skew everything
  console.log("raf:", await js(`window.__raf = null; let n = 0, t0 = 0; const f = (t) => { if (!t0) t0 = t; if (++n < 61) requestAnimationFrame(f); else window.__raf = ((t - t0) / 60).toFixed(2); }; requestAnimationFrame(f); return "started"`));
  await wait(1500);
  console.log("raf interval ms:", await js(`return String(window.__raf)`));
  await js(`window.__bench = null; import("/gpu/dist/bench.js").then((m) => m.run()).then((r) => { window.__bench = JSON.stringify(r, (k, v) => ["log", "frames_raw", "inputs_raw", "busy_raw", "raf_raw", "raf_callbacks", "t"].includes(k) ? undefined : v); }, (e) => { window.__bench = "error: " + e; }); return "started"`);
  let out = "null";
  let last = "";
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    out = await js(`return String(window.__bench)`);
    if (out !== "null") break;
    const st = await js(`return String(window.__benchStage)`);
    if (st !== last) { console.log("  stage:", st); last = st; }
  }
  if (out === "null") console.log("errors:", await js(`return JSON.stringify(window.__declareGpuErrors ?? [])`));
  try {
    const r = JSON.parse(out);
    for (const [k, v] of Object.entries(r)) {
      if (k === "switches") { console.log("switches:"); for (const e of v.each) console.log("  " + JSON.stringify(e)); continue; }
      console.log(k + ": " + JSON.stringify(v));
    }
  } catch { console.log(out); }
} finally {
  if (handle) await c.tool("close_tab", { handle });
  c.close();
}
