// devicePixelRatio change notification, shared by everything that holds a
// raster (the Canvas backend's compositor, the DOM backend's per-view
// drawing canvases): rasters must re-render crisply when the user zooms or
// the window moves between displays — even on an otherwise idle tree.
//
// ONE media query for every subscriber. The query names the *current* ratio,
// so each firing re-arms a fresh one against the new ratio. A subscriber
// leaves by the function onDprChange returns, at its owner's teardown.
// (Until 2026-10-17 each subscriber armed its own query and left only when
// the ratio next changed — so at a steady ratio, which is always, every
// listener stayed registered for the page's lifetime, and its closure held
// its surface, the surface its view, the view its cells: a virtualized list
// leaked every recycled row that drew, ~5 MB per 100 scroll jumps.)
const subs = new Set();
let armed = false;
function arm() {
    armed = true;
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener("change", () => {
        armed = false;
        for (const s of [...subs]) {
            if (!s.alive()) {
                subs.delete(s);
                continue;
            }
            s.changed();
        }
        if (subs.size > 0)
            arm();
    }, { once: true });
}
/** Call `changed` whenever devicePixelRatio changes, until the returned
 *  function is called or `alive()` stops holding. */
export function onDprChange(alive, changed) {
    const s = { alive, changed };
    subs.add(s);
    if (!armed)
        arm();
    return () => { subs.delete(s); };
}
//# sourceMappingURL=dpr.js.map