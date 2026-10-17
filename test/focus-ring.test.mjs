// The focus ring and focus reveal against pinned chrome and turned controls
// (planes.md §14; my-apps/focus-stress is the browser page these came from):
// Tab reveals a control clear of a scroller's pinned bars; the ring over the
// scrolled content stacks beneath them; a turned control's geometry carries its
// turn; a second Tab flies the ring rather than landing it. Headless.

import assert from "node:assert/strict";
import { test, summarize } from "./harness.mjs";
import { compileProgram } from "../compiler/dist/declarec.js";
import { instantiate } from "../runtime/dist/instantiate.js";
import { settle, provideMeasurer, Focus, Keys, deliverKeys } from "../runtime/dist/index.js";
import { approximateMeasurer } from "../compiler/dist/headless.js";

provideMeasurer(approximateMeasurer());

async function boot(src) {
  const b = await compileProgram(src, { originDir: process.cwd() + "/library", stripPos: false });
  assert.equal(b.errors.length, 0, b.errors.map((e) => e.message).join("; "));
  Focus.reset();
  const app = instantiate(b.program);
  settle();
  Focus.setRoot(app);
  return app;
}

const stopAt = (want) => { for (let i = 0; i < 20 && Focus.getFocus() !== want; i++) { Focus.next(); settle(); } };

await test("Tab reveals a control clear of the page's pinned bars, both ways", async () => {
  const app = await boot(`App [ width = 400, height = 300,
    page: View [ width = 400, height = 1600,
        a: Button [ y = 80, label = "A" ],
        b: Button [ y = 700, label = "B" ],
        c: Button [ y = 1400, label = "C" ] ],
    bar: View [ ignoreScroll = true, width = 400, height = 50, fill = white ],
    foot: View [ ignoreScroll = true, y = 260, width = 400, height = 40, fill = white ] ]`);
  for (const v of [app.page.b, app.page.c]) {
    stopAt(v);
    const top = v.y - app.scrollY;
    assert.ok(top + v.height <= 260, `${v.label} lands above the bottom bar (bottom ${top + v.height})`);
    assert.ok(top >= 50, `${v.label} is not under the top bar (top ${top})`);
  }
  Focus.prev(); settle();
  const b = app.page.b, top = b.y - app.scrollY;
  assert.ok(top >= 50 && top + b.height <= 260, `Shift-Tab back to B lands it between the bars (top ${top})`);
});

await test("in a pane, a reveal lands below the pane's pinned header; the header's own control scrolls nothing", async () => {
  const app = await boot(`App [ width = 400, height = 400,
    pane: View [ width = 300, height = 150, scrolls = y,
        body: View [ width = 300, height = 700,
            one: Button [ y = 40, label = "One" ],
            two: Button [ y = 500, label = "Two" ] ],
        head: View [ ignoreScroll = true, width = 300, height = 36, fill = white,
            hb: Button [ label = "Head" ] ] ] ]`);
  stopAt(app.pane.body.two);
  stopAt(app.pane.body.one);
  const top = app.pane.body.one.y - app.pane.scrollY;
  assert.ok(top >= 36, `One is not under the header (top ${top})`);
  stopAt(app.pane.body.two);
  let g = null;
  const off = Focus.onGeometry((x) => { g = x; });
  stopAt(app.pane.head.hb);
  off();
  assert.ok(g !== null && g.view === app.pane.head.hb && g.scroller !== app.pane,
    "the header's button does not ride the pane it is pinned in (its ring would sit in the scrolled content, under the header)");
  assert.ok(Math.abs(g.homeY - g.y) < 1e-6, `it is homed where it is seen (homeY ${g.homeY}, y ${g.y})`);
  const s = app.pane.scrollY;
  Focus.prev(); settle(); Focus.next(); settle();
  assert.equal(app.pane.scrollY, s, "focusing the pinned header's button moves nothing");
});

await test("a turned control's geometry carries its turn and its own size", async () => {
  const app = await boot(`App [ width = 600, height = 400,
    w: Window [ x = 100, y = 60, width = 200, height = 120, rotation = 5, cornerRadius = 8 ] ]`);
  let g = null;
  const off = Focus.onGeometry((x) => { g = x; });
  Focus.focus(app.w); settle();
  off();
  assert.ok(g !== null && Math.abs(g.homeRot - 5) < 1e-6, `homeRot is the window's turn (${g?.homeRot})`);
  assert.ok(Math.abs(g.homeW - 200) < 1e-6 && Math.abs(g.homeH - 120) < 1e-6, "homeW/homeH are its own size, not its upright bounds");
  assert.ok(Math.abs(g.w - 200) > 1, "while w/h stay the root-space bounds");
});

await test("the ring over scrolled content stacks beneath the page's pinned bar, and a second Tab flies", async () => {
  const app = await boot(`App [ width = 400, height = 300,
    page: View [ width = 400, height = 900,
        a: Button [ y = 80, label = "A" ],
        b: Button [ x = 200, y = 80, label = "B" ] ],
    bar: View [ ignoreScroll = true, width = 400, height = 50, fill = white,
        hb: Button [ x = 300, y = 6, label = "Bar" ] ] ]`);
  stopAt(app.page.a);
  const ring = app.childViews.find((c) => "trad" in c);
  assert.ok(ring, "the ring arrived with the controls");
  const kids = () => app.childViews;
  assert.ok(kids().indexOf(ring) < kids().indexOf(app.bar), "ring for a page control paints beneath the pinned bar");
  Focus.next(); settle();
  assert.ok(Focus.getFocus() === app.page.b);
  assert.ok(Math.abs(ring.tx - ring.x) > 50, `the ring is headed for B, not landed on it (x ${ring.x}, tx ${ring.tx})`);
  stopAt(app.bar.hb);
  assert.ok(kids().indexOf(ring) > kids().indexOf(app.bar), "ring for the bar's own control paints above it");
});

await test("focus moved by an arrow's handler is keyboard focus: the ring stays on, and flies", async () => {
  const app = await boot(`App [ width = 500, height = 200, sel: string = "a",
    seg: Segmented [ x = 20, y = 20, value = { app.sel }, input(v: any) { app.sel = v },
        choices = { [ ({ id: "a", label: "A" }), ({ id: "b", label: "B" }), ({ id: "c", label: "C" }) ] } ],
    after: Button [ x = 20, y = 100, label = "After" ] ]`);
  deliverKeys(Keys, Focus);
  const segs = app.seg.segs();
  stopAt(segs[0]);
  assert.ok(Focus.byKeyboard(), "Tab landed by keyboard");
  const ring = app.childViews.find((c) => "trad" in c);
  const key = (k) => ({ code: k, key: k, shift: false, ctrl: false, alt: false, meta: false, repeat: false });
  Keys.keyDown(key("ArrowRight")); settle(); Keys.keyUp(key("ArrowRight"));
  assert.equal(Focus.getFocus(), segs[1], "the arrow roved to the next segment");
  assert.ok(Focus.byKeyboard(), "and the move kept keyboard modality");
  assert.ok(ring.shown, "so the ring stays shown");
  assert.ok(Math.abs(ring.tx - ring.x) > 10, `and flies there (x ${ring.x}, tx ${ring.tx})`);
  Keys.keyDown(key("ArrowRight")); settle(); Keys.keyUp(key("ArrowRight"));
  Keys.keyDown(key("ArrowRight")); settle(); Keys.keyUp(key("ArrowRight"));
  assert.equal(Focus.getFocus(), segs[0], "past the last segment the arrow wraps to the first");
  Keys.keyDown(key("ArrowLeft")); settle(); Keys.keyUp(key("ArrowLeft"));
  assert.equal(Focus.getFocus(), segs[2], "and back from the first to the last");
  assert.equal(app.sel, "a", "roving selects nothing");
  Focus.focus(app.after); settle();
  assert.ok(!Focus.byKeyboard(), "Focus.focus outside a key's handler is still pointer/programmatic");
});

await test("F6 moves focus to the next region, and Shift-F6 back", async () => {
  const app = await boot(`App [ width = 600, height = 300,
    w1: View [ focusScope = region, x = 10, y = 10, width = 200, height = 100, a: Button [ label = "A" ] ],
    w2: View [ focusScope = region, x = 260, y = 10, width = 200, height = 100, b: Button [ label = "B" ] ] ]`);
  const key = (k, mods = {}) => ({ code: k, key: k, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...mods });
  const press = (e) => { Keys.keyDown(e); settle(); Keys.keyUp(e); };
  deliverKeys(Keys, Focus);
  Focus.focus(app.w1.a); settle();
  press(key("F6"));
  assert.ok(Focus.holds(app.w2), "F6 moves to the next region");
  press(key("F6", { shift: true }));
  assert.ok(Focus.holds(app.w1), "Shift-F6 moves back");
});

await test("Esc then Tab leaves a region in either direction; Tab alone, or Esc then another key, stays", async () => {
  const app = await boot(`App [ width = 600, height = 300,
    w1: View [ focusScope = region, x = 10, y = 10, width = 200, height = 100,
        a: Button [ label = "A" ], a2: Button [ y = 50, label = "A2" ] ],
    w2: View [ focusScope = region, x = 260, y = 10, width = 200, height = 100, b: Button [ label = "B" ] ] ]`);
  const key = (k, mods = {}) => ({ code: k, key: k, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...mods });
  const press = (e) => { Keys.keyDown(e); settle(); Keys.keyUp(e); };
  deliverKeys(Keys, Focus);
  Focus.focus(app.w1.a); settle();
  press(key("Tab"));
  assert.ok(Focus.holds(app.w1), "Tab alone stays in the region (it wraps inside)");
  press(key("Escape")); press(key("Tab"));
  assert.ok(Focus.holds(app.w2), "Esc then Tab moves to the next region");
  press(key("Escape")); press(key("ShiftLeft", { shift: true })); press(key("Tab", { shift: true }));
  assert.ok(Focus.holds(app.w1), "Esc then Shift-Tab moves back (Shift pressed between keeps it armed)");
  press(key("Escape")); press(key("a")); press(key("Tab"));
  assert.ok(Focus.holds(app.w1), "another key in between disarms it");
});

await test("focused is every view's reactive fact, and Focus.getFocus() is a tracked read", async () => {
  const app = await boot(`App [ width = 400, height = 200,
    which: string = { Focus.getFocus() == null ? "none" : "" + Focus.getFocus().tagName },
    a: Button [ tagName: string = "a", label = "A" ],
    v: View [ tagName: string = "v", x = 100, width = 40, height = 20, focusable = true,
        lit: boolean = { focused } ],
    t: TextInput [ x = 200, width = 80, edge: boolean = { focused } ] ]`);
  assert.equal(app.which, "none");
  Focus.focus(app.a); settle();
  assert.equal(app.which, "a", "a constraint over Focus.getFocus() followed focus to the button");
  assert.ok(app.a.focused && !app.v.lit, "the button is focused; the plain view is not");
  Focus.focus(app.v); settle();
  assert.ok(app.v.lit && !app.a.focused, "a plain focusable view's own constraint saw focus arrive");
  assert.equal(app.which, "v");
  Focus.blur(); settle();
  assert.ok(!app.v.lit && app.which === "none", "and leave");
});

summarize("focus-ring");
