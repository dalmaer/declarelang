// size-branch — a size that reads its parent's size in only some branches is
// taken from the parent only while that branch is the one taken. Its parent's
// content size counts it on the other branches, so a parent sized by its content
// neither collapses round it nor feeds back through it.
import assert from "node:assert/strict";
import { test, summarize } from "./harness.mjs";
import { compile } from "../compiler/dist/compile-node.js";
import { buildProgram, settle, HeadlessBackend } from "../runtime/dist/index.js";

async function boot(src) {
  const r = await compile(src);
  assert.deepEqual(r.errors.map((e) => e.message), [], "fixture compiles");
  const app = buildProgram(r.program);
  app.$attach(new HeadlessBackend(), null);
  settle();
  return app;
}

await test("a branch not taken does not take the child out of its parent's content size", async () => {
  const app = await boot(`App [ width = 400, height = 800,
    compact: boolean = true,
    screen: View [ width = 200, height = { app.compact ? this.contentHeight : 600 },
        layout: SimpleLayout [ axis = y ],
        head: View [ width = 200, height = 64 ],
        body: View [ width = 200, height = { app.compact ? this.contentHeight : parent.height - 64 },
            pane: View [ width = 200, height = { app.compact ? 840 : parent.height } ] ] ] ]`);
  assert.equal(app.screen.body.height, 840, "the body holds its pane");
  assert.equal(app.screen.height, 904, "the screen holds its header and body");
  app.compact = false; settle();
  assert.deepEqual([app.screen.height, app.screen.body.height, app.screen.body.pane.height], [600, 536, 536], "the other branch sizes from the parent");
  app.compact = true; settle();
  assert.equal(app.screen.height, 904, "and back");
});

await test("on the branch that reads the parent, the content size skips the child — no feedback", async () => {
  const app = await boot(`App [ width = 400, height = 800,
    flag: boolean = true,
    box: View [ width = 200, height = { this.contentHeight },
        a: View [ width = 100, height = 100 ],
        b: View [ width = 100, height = { app.flag ? 50 : parent.height + 10 } ] ] ]`);
  assert.deepEqual([app.box.height, app.box.b.height], [100, 50]);
  for (const f of [false, true, false]) {
    app.flag = f;
    settle();   // a feedback loop would throw a constraint cycle here
    assert.deepEqual([app.box.height, app.box.b.height], f ? [100, 50] : [100, 110], `flag ${f}`);
  }
});

summarize("size-branch");
