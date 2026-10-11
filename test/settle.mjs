// settle.mjs — wait for a page's app to come to rest, instead of sleeping a
// guessed time.
//
//   import { settled } from "./settle.mjs";
//   await page.mouse.click(x, y);
//   await settled(page);          // the click's motion and fetches are done
//
// AT REST means three things at once: no request outstanding, no finite
// motion in flight (the bridge's `clock.settling` — a Time ticking or a
// looping animator doesn't hold it open), and a couple of frames painted
// since. It returns as soon as that is true, so a fast machine pays nothing
// and a loaded one waits as long as the app needs — which a fixed sleep gets
// wrong both ways.
//
// What it does NOT wait for is time the app itself measures: a double-click
// window, an `afterDelay`, a raster's at-rest beat. Nothing in flight marks
// those, so a test that needs one still waits that long, and says why.
//
// A page without the dev bridge (a production build) has no `clock`: there it
// waits for the network and the frames only.

const frames = (page, n) => page.evaluate((n) => new Promise((done) => {
  const step = (k) => (k === 0 ? done() : requestAnimationFrame(() => step(k - 1)));
  step(n);
}), n);

// The page's own requests in flight. Counted here rather than with puppeteer's
// waitForNetworkIdle, which never sees a WORKER's script load finish: the
// fetch `new Worker(url)` makes starts on the page (a script with an "other"
// initiator) but its completion is reported to the worker's own target, so
// the canvas renderer's raster worker reads as in flight forever. A page that
// navigates starts a fresh count.
const tracked = new WeakMap();
const workerLoad = (r) => r.resourceType() === "script" && r.initiator()?.type === "other";
function inflight(page) {
  let set = tracked.get(page);
  if (set === undefined) {
    set = new Set();
    tracked.set(page, set);
    page.on("request", (r) => { if (!workerLoad(r)) set.add(r); });
    page.on("requestfinished", (r) => set.delete(r));
    page.on("requestfailed", (r) => set.delete(r));
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) for (const r of set) if (!r.isNavigationRequest()) set.delete(r); });
  }
  return set;
}
/** Resolve once no page request has been in flight for `idle` ms. */
async function networkQuiet(page, until, idle = 100) {
  const set = inflight(page);
  let quietSince = set.size === 0 ? Date.now() : 0;
  for (;;) {
    if (set.size > 0) quietSince = 0;
    else if (quietSince === 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= idle) return;
    if (Date.now() > until) throw new Error(`settled: requests still in flight: ${[...set].map((r) => r.url()).slice(0, 3).join(" ")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const moving = (page) => page.evaluate(() => globalThis.__declare?.clock?.settling === true);

/** Resolve once the page is at rest (see above); throw after `timeout` ms. */
export async function settled(page, { timeout = 15000 } = {}) {
  const until = Date.now() + timeout;
  inflight(page);
  // two frames first: whatever the last input started has enrolled by then
  await frames(page, 2);
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) throw new Error(`settled: the page did not come to rest within ${timeout} ms`);
    await networkQuiet(page, until);
    if (!(await moving(page))) {
      await frames(page, 2);
      if (!(await moving(page))) return;
    } else {
      await page.waitForFunction(() => globalThis.__declare?.clock?.settling !== true,
        { polling: "raf", timeout: Math.max(1, until - Date.now()) });
    }
  }
}

/** Resolve once `expr` (evaluated in the page) has read the same for `n`
 *  frames running. For motion the clock does not carry — a scroll glide (a
 *  tween on the canvas scroll loop; the browser's own smooth scroll on the
 *  DOM) — where the test knows which value is moving. */
export async function still(page, expr, { n = 3, timeout = 15000 } = {}) {
  await page.waitForFunction((expr, n) => new Promise((done) => {
    let last, same = 0;
    const tick = () => {
      const v = JSON.stringify((0, eval)(expr));
      same = v === last ? same + 1 : 0;
      last = v;
      if (same >= n) done(true); else requestAnimationFrame(tick);
    };
    tick();
  }), { timeout, polling: "raf" }, expr, n);
}
