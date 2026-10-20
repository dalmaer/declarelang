// test/visible-rows.test.mjs — which records a list shows: `firstVisibleRow` and
// `lastVisibleRow`, the first and last records of a view's replication any part
// of which is in view.
//
// Found by the Murmur eval (evals/reports/2026-10-17-murmur-run9, report §"No fact
// for the first visible row"): a chat's date chip read the top message's date by
// having every row work out whether it was on top and report it with
// trackChanges — and a recycled virtualized row that stays on top while it is
// handed another record changes nothing of its own, so the chip went stale. The
// fact is the list's, read off the windowing it already does (or off the rows'
// places, built in full), so recycling cannot hide a change from it.
import assert from "node:assert/strict";
import { test, summarize } from "./harness.mjs";
import { compileProgram } from "../compiler/dist/declarec.js";
import { instantiate } from "../runtime/dist/instantiate.js";
import { settle, provideMeasurer } from "../runtime/dist/index.js";
import { approximateMeasurer } from "../compiler/dist/headless.js";

provideMeasurer(approximateMeasurer());

const rows = JSON.stringify({ rows: Array.from({ length: 500 }, (_, n) => ({ id: n, day: "day " + Math.floor(n / 25) })) });
const program = (virtualize) => `App [ width = 300, height = 200, d: Dataset { ${rows} },
  chip: string = { list.firstVisibleRow < 0 ? "" : app.d.value.rows[list.firstVisibleRow].day },
  span: string = { list.firstVisibleRow + "–" + list.lastVisibleRow },
  list: View [ width = 300, height = 200, scrolls = y, datapath = { d.value }, layout: SimpleLayout [ axis = y ],
    View [ datapath = :rows[], ${virtualize ? "virtualize = true," : ""} width = 300, height = 20 ] ] ]`;

async function boot(src) {
  const b = await compileProgram(src, { originDir: process.cwd() + "/library", stripPos: false });
  assert.deepEqual(b.errors.map((e) => e.message), []);
  const app = instantiate(b.program);
  settle();
  return app;
}

for (const virtualize of [false, true]) {
  const kind = virtualize ? "a virtualized list" : "a list built in full";
  await test(`${kind}: the rows in view, followed as it scrolls, read by an ordinary formula`, async () => {
    const app = await boot(program(virtualize));
    assert.equal(app.span, "0–9", "ten 20px rows fill a 200px pane; the eleventh only touches its edge");
    app.list.scrollTo(1010); settle(); settle();
    assert.equal(app.span, "50–60", "a row cut by the top edge, and one cut by the bottom, are both in view");
    assert.equal(app.chip, "day 2");
    // far down, where a virtualized list has recycled its rows many times over
    for (const y of [4000, 7000, 9500, 2000]) { app.list.scrollTo(y); settle(); settle(); }
    assert.equal(app.span, "100–109");
    assert.equal(app.chip, "day 4", "the chip follows the record at the top, not the row that shows it");
  });
}

await test("a view with no replication has no rows in view", async () => {
  const app = await boot(`App [ v: View [ ], s: string = { v.firstVisibleRow + "/" + v.lastVisibleRow } ]`);
  assert.equal(app.s, "-1/-1");
});

summarize("visible rows");
