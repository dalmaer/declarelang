// member-by-name — a member is a property of its view, reached as JavaScript
// reaches any property: `form.beta`, or by a name, `form["beta"]` / `form[name]`.
// A written string is checked as the dotted path is; a name computed at run time
// reaches the child (or undefined) unchecked.
import assert from "node:assert/strict";
import { compile } from "../compiler/dist/compile-node.js";
import { buildProgram, settle, HeadlessBackend, provideMeasurer } from "../runtime/dist/index.js";
import { approximateMeasurer } from "../compiler/dist/headless.js";
import { test, summarize } from "./harness.mjs";

provideMeasurer(approximateMeasurer());

const SRC = (extra) => `App [ width = 400, height = 300,
    which: string = "beta",
    form: View [
        layout: SimpleLayout [ axis = y ],
        alpha: TextInput [ width = 200 ],
        beta: TextInput [ width = 200 ],
        pane: View [ inner: TextInput [ width = 100 ] ] ],
    pick() -> object { return this.form[this.which] },
    deep(a: string, b: string) -> object { return this.form[a][b] },
    known() -> number { return this.form["alpha"].width + this.form["pane"]["inner"].width },
    ${extra}
    ]`;

await test("a written name is checked as a path is", async () => {
  const r = await compile(SRC(`typo() -> number { return this.form["gamma"].width }`));
  const msgs = r.errors.map((e) => e.message);
  assert.equal(msgs.length, 1, msgs.join("\n"));
  assert.match(msgs[0], /nothing named 'gamma' is a member of/);
});

await test("names that exist, written or computed, reach the child — and chain", async () => {
  const r = await compile(SRC(""));
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const app = buildProgram(r.program);
  app.$attach(new HeadlessBackend(), null);
  settle();
  assert.equal(app.pick(), app.form.beta, "form[which] is form.beta");
  app.which = "alpha";
  assert.equal(app.pick(), app.form.alpha, "and follows the name");
  assert.equal(app.deep("pane", "inner"), app.form.pane.inner, "each bracket steps one level");
  assert.equal(app.known(), 300);
  app.which = "nothing";
  assert.equal(app.pick(), undefined, "no child of that name: undefined");
});

await test("what is read off a child named at run time is checked against every child", async () => {
  const r = await compile(SRC(`label() -> string { return this.form[this.which].placeholder }`));
  const msgs = r.errors.map((e) => e.message);
  assert.equal(msgs.length, 1, msgs.join("\n"));
  assert.match(msgs[0], /'placeholder' is not something every child of .*form has — .*pane has no 'placeholder'/);
});

summarize("member-by-name");
