// A script's HOST MARK (declare.md §script): a script runs on every host, so it
// may use only what every host provides; one written for some hosts says so —
// `script [ host = browser ] { … }`, `script [ "f.ts", host = browser ]` — and a
// host it is not written for refuses the program before any of it runs. Pins:
//   - an unmarked script that names a browser global is refused, at the name,
//     naming the mark;
//   - marked (inline, or a file), it compiles; the portable names need no mark;
//   - an unknown host and a files-plus-code script are refused by the parser;
//   - the mark survives compilation, and a host not named refuses the program.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, summarize, tempDir } from "./harness.mjs";
import { compile } from "../compiler/dist/compile-node.js";
import { parseProgram } from "../runtime/dist/parser.js";
import { instantiate } from "../runtime/dist/index.js";
import { applyDeps } from "../runtime/dist/deps.js";

const dir = tempDir("script-host-");
writeFileSync(path.join(dir, "dom.ts"), "export function title(): string { return document.title }\n");
const build = (src) => compile(src, { originDir: dir });
const APP = `App [ width = 10, height = 10 ]`;

await test("an unmarked script naming a browser global is refused at the name", async () => {
  const r = await build(`script {
    function title(): string { return document.title }
    }
${APP}`);
  assert.equal(r.source, null);
  const e = r.errors.find((x) => /'document' is not something every host provides/.test(x.message));
  assert.ok(e, "refused: " + r.errors.map((x) => x.message).join("; "));
  assert.equal(e.pos.line, 2, "at the line that names it");
  assert.match(e.message, /script \[ host = browser \]/, "naming the mark");
});

await test("what every host provides needs no mark", async () => {
  const r = await build(`script {
    function stamp(): number { return performance.now() + Date.now() }
    function later(f: () => void) { setTimeout(f, 10); queueMicrotask(f) }
    function u(): string { return new URL("x", "http://a/").href + structuredClone([1])[0] }
    }
${APP}`);
  assert.deepEqual(r.errors.map((e) => e.message), []);
});

await test("marked for the browser, inline or from a file, it compiles", async () => {
  const inline = await build(`script [ host = browser ] {
    function title(): string { return document.title }
    }
${APP}`);
  assert.deepEqual(inline.errors.map((e) => e.message), []);
  const file = await build(`script [ "dom.ts", host = browser ]
${APP}`);
  assert.deepEqual(file.errors.map((e) => e.message), []);
  const several = await build(`script [ host = [browser, mac] ] { function t(): string { return document.title } }
${APP}`);
  assert.deepEqual(several.errors.map((e) => e.message), []);
});

await test("an unmarked file is held to the same rule", async () => {
  const r = await build(`script [ "dom.ts" ]
${APP}`);
  assert.ok(r.errors.some((x) => /'document' is not something every host provides/.test(x.message)));
});

await test("the parser refuses an unknown host, and files with code", async () => {
  const bad = await build(`script [ host = tv ] { const a = 1 }
${APP}`);
  assert.match(bad.errors[0].message, /'tv' is not a host — a script runs on browser or mac/);
  const both = await build(`script [ "dom.ts" ] { const a = 1 }
${APP}`);
  assert.match(both.errors[0].message, /from files or written here, not both/);
});

await test("the mark survives compilation, and a host it does not name refuses the program", async () => {
  const r = await build(`script [ host = browser ] { function hi(): string { return "hi" } }
App [ width = 10, height = 10, t: string = { hi() } ]`);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const program = parseProgram(r.source);
  applyDeps(program, r.deps);
  assert.deepEqual(program.scripts.map((s) => s.hosts), [["browser"]]);
  const app = instantiate(program);
  assert.equal(app.t, "hi", "it runs on the browser host");
  globalThis.__declareHostName = "mac";
  try {
    const again = parseProgram(r.source);
    applyDeps(again, r.deps);
    assert.throws(() => instantiate(again), /a script written for browser .* does not run on the mac host/);
  } finally {
    delete globalThis.__declareHostName;
  }
});

summarize("script-host");
