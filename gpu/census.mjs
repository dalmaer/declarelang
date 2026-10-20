// gpu/census.mjs — what changes from frame to frame, app by app. Runs scripted scenarios
// (gpu/census-scenarios.json: clicks, drags, wheels, keys, waits, at 1280×800, 2×) on
// ?render=gpu&census pages in headless Chrome and prints, per scenario: frames a second; how
// each frame was drawn (whole, a region, a fast frame, skipped); changed views a frame by kind
// of change (move, size, transform, opacity, paint, text, drawing, image, tree, scroll); the
// share whose change is placement alone (move, transform, opacity) and the rigid ones among
// them (nothing under them changed) with the views their subtrees hold; views whose pixels
// change, and views visited and drawn; then the runtime's time a frame (the worker's busy time
// outside painting), the host's encode (walk, plan, submit), the GPU time from timestamps,
// medians and p95, the share of the screen a region frame redraws, Vello items and instances
// per plan, and per plan the drawings rastered as sprites and drawn by Vello.
// With --stages, each scenario also prints its frames' GPU time by stage (timing.rs: Vello
// renders, quads passes, copies, the present, and `gap`, the GPU waiting between submissions),
// ms a frame.
//   node gpu/census.mjs [scenarios.json] [app filter] [--json out.json] [--base http://127.0.0.1:8221] [--stages]
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import fs from "node:fs";
const args = process.argv.slice(2);
const ji = args.indexOf("--json");
const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
const bi = args.indexOf("--base");
const BASE = bi >= 0 ? args.splice(bi, 2)[1] : "http://127.0.0.1:8200";
const si = args.indexOf("--stages");
const STAGES = si >= 0 && args.splice(si, 1).length > 0;
const spec = JSON.parse(fs.readFileSync(args[0] || new URL("census-scenarios.json", import.meta.url), "utf8"));
const only = args[1];
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (v) => { if (!v.length) return 0; const s = [...v].sort((a, c) => a - c); return s[Math.floor(s.length / 2)]; };
const p95 = (v) => { if (!v.length) return 0; const s = [...v].sort((a, c) => a - c); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const KIND = ["move", "size", "xform", "alpha", "paint", "text", "draw", "image", "tree", "scroll"];
const out = [];
// warm-up page (the first page in a browser runs cold)
{ const p = await b.newPage(); await p.goto(`${BASE}/apps/tracker/?render=gpu`, { waitUntil: "load" });
  await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 }).catch(() => {}); await sleep(800); await p.close(); }
for (const app of spec) {
  if (only && !app.app.includes(only)) continue;
  const p = await b.newPage();
  // an app's own viewport [width, height] (a phone's design), touch-less
  if (app.viewport) await p.setViewport({ width: app.viewport[0], height: app.viewport[1], deviceScaleFactor: 2 });
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const stats = (clear) => p.evaluate((clear) => new Promise((res) => { const w = window.__declareGpu.worker; const on = (e) => { if (e.data?.t === "stats") { w.removeEventListener("message", on); res(e.data); } }; w.addEventListener("message", on); w.postMessage({ t: "stats", clear }); }), clear);
  await p.goto(`${BASE}/${app.app}${app.app.includes("?") ? "&" : "?"}render=gpu&census&timing${STAGES ? "&gpustages" : ""}${process.env.GPU_SWITCHES ?? ""}`, { waitUntil: "load" });
  try { await p.waitForFunction(() => window.__declareGpu?.ready === true, { timeout: 30000 }); } catch { console.log(app.app, "never ready"); await p.close(); continue; }
  await sleep(app.settle ?? 1500);
  for (const sc of app.scenarios) {
    for (const a of sc.before ?? []) await act(p, a);
    await stats(true);
    const t0 = Date.now();
    for (const a of sc.steps) await act(p, a);
    const secs = (Date.now() - t0) / 1000;
    const s = await stats(false);
    for (const a of sc.after ?? []) await act(p, a);
    const c = s.census, n = c.length || 1;
    const drawnF = c.filter((r) => r.path === "whole" || r.path === "region");
    const enc = s.frames_raw.reduce((x, f) => x + f[1], 0);
    const row = {
      app: app.app.replace(/^apps\//, "").replace(/\/$/, ""), sc: sc.name, fps: +(c.length / secs).toFixed(0), frames: c.length,
      paths: Object.fromEntries(["whole", "region", "fast", "skip"].map((k) => [k, c.filter((r) => r.path === k).length])),
      changed: med(c.map((r) => r.changed)), changedP95: p95(c.map((r) => r.changed)),
      kinds: Object.fromEntries(KIND.map((k, i) => [k, +(c.reduce((x, r) => x + r.kinds[i], 0) / n).toFixed(1)]).filter(([, v]) => v > 0)),
      placeShare: +(c.reduce((x, r) => x + r.placeOnly, 0) / Math.max(1, c.reduce((x, r) => x + r.changed, 0))).toFixed(2),
      rigid: +(c.reduce((x, r) => x + r.rigid, 0) / n).toFixed(1), rigidViews: +(c.reduce((x, r) => x + r.rigidViews, 0) / n).toFixed(0),
      affected: med(c.map((r) => r.affected)), visited: med(drawnF.map((r) => r.visited)), drawn: med(drawnF.map((r) => r.drawn)),
      runtime: +((s.busy - enc) / n).toFixed(2),
      // the compositor worker's busy time a frame: what it does besides waiting
      compositor: +((s.busyCompositor ?? 0) / n).toFixed(2), encode: s.encode?.median ?? 0, encodeP95: s.encode?.p95 ?? 0,
      gpu: s.gpuExec?.median ?? 0, gpuP95: s.gpuExec?.p95 ?? 0,
      area: +(s.damage.partialArea / Math.max(1, s.damage.partial)).toFixed(2),
      vello: s.paint ? +(s.paint.vello / Math.max(1, s.paint.plans)).toFixed(1) : 0, insts: s.paint ? Math.round(s.paint.insts / Math.max(1, s.paint.plans)) : 0,
      sprites: s.paint ? +(s.paint.sprites / Math.max(1, s.paint.plans)).toFixed(1) : 0, spriteResets: s.paint?.spriteResets ?? 0,
      pictures: s.paint ? +(s.paint.pictures / Math.max(1, s.paint.plans)).toFixed(1) : 0,
      spriteLaid: s.paint ? +(s.paint.spriteLaid / Math.max(1, s.paint.plans)).toFixed(1) : 0,
      spriteMiss: s.paint ? ["missReach", "missRecent", "missTurned", "missLarge", "missRoom"].map((k) => +(s.paint[k] / Math.max(1, s.paint.plans)).toFixed(1)) : [],
      // kept a frame: opacity groups laid from their texture, groups drawn and kept, filter layers
      kept: { groups: +((s.paint?.keptGroups ?? 0) / n).toFixed(1), groupsMade: +((s.paint?.groupsMade ?? 0) / n).toFixed(1), filters: +((s.counts?.filtersKept ?? 0) / n).toFixed(1),
        moved: +((s.counts?.walkMoved ?? 0) / n).toFixed(1), layers: +((s.counts?.motionLayers ?? 0) / n).toFixed(1) },
      stages: s.gpuStages ?? null,
    };
    out.push(row);
    console.log(`${(row.app + " · " + row.sc).padEnd(34)} ${String(row.fps).padStart(3)}/s ${JSON.stringify(row.paths)}  changed ${row.changed} (p95 ${row.changedP95}) ${JSON.stringify(row.kinds)}` +
      `  placement ${row.placeShare} rigid ${row.rigid} (${row.rigidViews} views)  affected ${row.affected} visited ${row.visited} drawn ${row.drawn}` +
      `  | runtime ${row.runtime} encode ${row.encode}/${row.encodeP95} gpu ${row.gpu}/${row.gpuP95} ms  region ${row.area}  vello ${row.vello} insts ${row.insts}  drawings: sprites made ${row.sprites} (resets ${row.spriteResets}), laid moving ${row.spriteLaid}, by Vello ${row.pictures} (not sprites: reach, recent, turned, large, room ${row.spriteMiss.join("/")})  kept: groups ${row.kept.groups} (made ${row.kept.groupsMade}), filters ${row.kept.filters}, walks moved ${row.kept.moved}, moving layers ${row.kept.layers}`);
    if (STAGES && row.stages?.frames) {
      const nf = row.stages.frames[1];
      console.log(`    GPU ms a frame over ${nf} timed: ` + Object.entries(row.stages).map(([k, [ms, n]]) => `${k} ${(ms / nf).toFixed(2)}${k === "frames" ? "" : ` (${(n / nf).toFixed(1)}×)`}`).join("  "));
    }
  }
  await p.close();
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
await b.close();

async function act(p, a) {
  const [k, ...v] = a;
  if (k === "wait") await sleep(v[0]);
  else if (k === "click") { await p.mouse.click(v[0], v[1]); }
  else if (k === "move") await p.mouse.move(v[0], v[1], { steps: v[2] ?? 1 });
  else if (k === "down") await p.mouse.down();
  else if (k === "up") await p.mouse.up();
  else if (k === "drag") { // x0 y0 x1 y1 frames
    await p.mouse.move(v[0], v[1]); await p.mouse.down();
    for (let i = 1; i <= v[4]; i++) { await p.mouse.move(v[0] + (v[2] - v[0]) * i / v[4], v[1] + (v[3] - v[1]) * i / v[4]); await sleep(16); }
    await p.mouse.up();
  }
  else if (k === "wheel") { await p.mouse.move(v[0], v[1]); for (let i = 0; i < v[3]; i++) { await p.mouse.wheel({ deltaY: v[2] }); await sleep(16); } }
  else if (k === "key") await p.keyboard.press(v[0]);
  else if (k === "keydown") await p.keyboard.down(v[0]);
  else if (k === "keyup") await p.keyboard.up(v[0]);
  else if (k === "type") await p.keyboard.type(v[0], { delay: 30 });
  else if (k === "hover") { for (const [x, y] of v[0]) { await p.mouse.move(x, y, { steps: 8 }); await sleep(250); } }
}
