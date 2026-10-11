// highlight — the compiler's preprocessed form for the code viewer. Asserts the
// SEGMENT shape: /* */ comments become prose (Markdown, dedented), everything
// else becomes syntax-highlighted <pre> code, and the language's lexical islands
// (strings, { } bodies, datapaths, comments) are classified — and never let a
// brace or quote inside a body corrupt the scan.
import assert from "node:assert";
import { highlight, topLevel, programMetrics, programIndex } from "../compiler/dist/highlight.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok —", name); }
  catch (e) { fail++; console.log("  FAIL —", name, "\n     ", e.message); }
}
const kinds = (segs) => segs.map((s) => s.kind);
// the concatenated class names appearing in a code segment's html, in order
const roles = (html) => Array.from(html.matchAll(/class="(\w+)"/g)).map((m) => m[1]);
const codeHtml = (segs) => segs.filter((s) => s.kind === "code").map((s) => s.html).join("\n");

// ── segmentation: prose vs code ────────────────────────────────────────────────

test("a /* */ comment becomes a prose segment; code around it stays code", () => {
  const segs = highlight('App [ ]\n/* # Title\nsome **markdown** */\nText [ ]');
  assert.deepEqual(kinds(segs), ["code", "prose", "code"]);
  assert.equal(segs[1].md, "# Title\nsome **markdown**");
});

test("prose dedents and strips a jsdoc * gutter", () => {
  const segs = highlight("/*\n * # Doc\n * a line\n */\nApp [ ]");
  assert.equal(segs[0].kind, "prose");
  assert.equal(segs[0].md, "# Doc\na line");
});

test("prose dedents a plain (gutterless) block by common indent", () => {
  const segs = highlight("/*\n    # Doc\n    indented body\n*/\nApp [ ]");
  assert.equal(segs[0].md, "# Doc\nindented body");
});

test("blank lines between a comment and code don't open an empty code segment", () => {
  const segs = highlight("App [ ]\n\n/* note */\n\nText [ ]");
  assert.deepEqual(kinds(segs), ["code", "prose", "code"]);
  // neither code <pre> is just whitespace
  for (const s of segs) if (s.kind === "code") assert.ok(s.html.replace(/<\/?pre>/g, "").trim() !== "");
});

test("a file with no comments is a single code segment", () => {
  const segs = highlight("App [ width = 40 ]");
  assert.deepEqual(kinds(segs), ["code"]);
});

// ── token roles ────────────────────────────────────────────────────────────────

test("Uppercase idents are types; attribute names (before =) are attrs", () => {
  const segs = highlight("App [ width = 40 ]");
  const html = segs[0].html;
  assert.ok(/<span class="t">App<\/span>/.test(html), html);
  assert.ok(/<span class="a">width<\/span>/.test(html), html);
});

test("strings, numbers, hex colors, datapaths, keywords each get a role", () => {
  const segs = highlight('class Box extends Node [ readonly n = 42, tint = #ff0, label = "hi", at = :rec.name ]');
  const r = new Set(roles(segs[0].html));
  for (const want of ["t", "a", "n", "h", "s", "p", "k"]) assert.ok(r.has(want), "missing role " + want + " in " + [...r]);
});

test("a { } expression body is ONE span, blind to braces/quotes/comments inside", () => {
  // The body holds a string containing braces and a simple regex — the common
  // cases that corrupt a naive brace-match. It must stay one <b> span and NOT
  // leak a second code construct or split the segment. (This matches the
  // compiler's own skipBraces exactly: a `}` inside a regex char class would
  // truncate BOTH, so such a body can't compile and never reaches a viewer.)
  const segs = highlight('X [ v = { const s = "a{b}c"; return /\\d+/.test(s) ? 1 : 2 } ]');
  assert.deepEqual(kinds(segs), ["code"]);
  const bodies = Array.from(segs[0].html.matchAll(/<span class="b">([\s\S]*?)<\/span>/g));
  assert.equal(bodies.length, 1, "expected exactly one body span");
  assert.ok(bodies[0][1].includes("a{b}c"), "body content truncated");
});

test("a /* */ INSIDE a { } body is not mistaken for a prose comment", () => {
  const segs = highlight("X [ v = { /* inner */ return 1 } ]");
  assert.deepEqual(kinds(segs), ["code"]); // no prose segment carved out of the body
});

test("line comments stay in code as a comment role; block comments do not", () => {
  const segs = highlight("App [ ] // trailing\nText [ ]");
  assert.deepEqual(kinds(segs), ["code"]);
  assert.ok(roles(segs[0].html).includes("c"));
});

test("html is escaped inside code spans", () => {
  const segs = highlight('X [ v = { return a < b && c > d } ]');
  assert.ok(codeHtml(segs).includes("&lt;") && codeHtml(segs).includes("&gt;") && codeHtml(segs).includes("&amp;"));
  assert.ok(!/<[^sp/]/.test(codeHtml(segs).replace(/<\/?(pre|span)[^>]*>/g, "")), "unescaped markup leaked");
});

test("whitespace and indentation are preserved verbatim in code", () => {
  const segs = highlight("App [\n    width = 40,\n]");
  assert.ok(segs[0].html.includes("\n    "), "indentation lost");
});

test("triple-quoted text block is one string span, contents intact", () => {
  const segs = highlight('Markdown [ text = """\n# Hi\n- a\n""" ]');
  const strs = Array.from(segs[0].html.matchAll(/<span class="s">([\s\S]*?)<\/span>/g));
  assert.ok(strs.some((m) => m[1].includes("# Hi") && m[1].includes("- a")), "triple-quote body not captured");
});

// ── a program's line count: the file, and the whole app ──────────────────────

test("topLevel finds include paths and the App, never inside comments, strings or bodies", () => {
  const t = topLevel('// include [ "no.declare" ]\ninclude [ "a.declare", "b.declare" ]\n'
    + 'class X [ s: string = "include [ \\"no2\\" ]", v: number = { 1 } ]\nApp [ include = 1 ]');
  assert.deepEqual(t.includes, ["a.declare", "b.declare"]);
  assert.deepEqual(topLevel('script [ "x.ts" ]\nscript { const s = "script [ \\"no.ts\\" ]" }').scripts, ["x.ts"]);
  assert.equal(t.hasApp, true);
  assert.equal(topLevel('class Y [ App [ ] ]').hasApp, false);
});

const files = {
  "file:///p/main.declare": 'include [ "a.declare", "sub/b.declare", "lib.declare" ]\n// note\nApp [ ]\n',
  "file:///p/a.declare": 'include [ "sub/b.declare" ]\nscript [ "s.ts" ]\nclass A [ ]\n',
  // a script file: every comment counts as one, a `//` inside a template does not
  "file:///p/s.ts": "// helper\nexport const u = `http://${1}`\n/* a\n   b */\n",
  "file:///p/sub/b.declare": 'include [ "../a.declare" ]\nclass B [ ]\n\n',
  "file:///lib/x.declare": "class L [ ]\n",
};
// imports: from an inline script block and from a script file, followed through
// the bundler's spellings; a package and a data file are not the program's code
Object.assign(files, {
  "file:///q/main.declare": 'script { import dayjs from "dayjs"\nimport { a } from "./m/a" }\nscript [ "s.ts" ]\nApp [ ]\n',
  "file:///q/m/a.ts": 'import { b } from "./b.js"\nexport const a = 1\n',
  "file:///q/m/b.ts": 'import cfg from "../cfg.json"\nexport const b = 2 // two\n',
  "file:///q/s.ts": 'export * from "./m/a.ts"\nconst x = import("./lazy")\n// const y = import("./never")\n',
  "file:///q/lazy/index.ts": "export default 3\n",
  "file:///q/never.ts": "export default 4\n",
  "file:///q/cfg.json": "{}\n",
});
const read = (u) => files[u] ?? null;
const isLibrary = (u) => u.startsWith("file:///lib/");
await (async () => {
  try {
    const m = await programMetrics(files["file:///p/main.declare"], "file:///p/main.declare", read, isLibrary);
    // main 3 lines (2 code, 1 comment); a 3 code; s.ts 1 code + 3 comment;
    // b 2 code + 1 blank — each once, and lib.declare (not beside the program) left out
    assert.deepEqual({ total: m.total, code: m.code, comment: m.comment }, { total: 3, code: 2, comment: 1 });
    assert.deepEqual(m.app, { total: 13, code: 8, comment: 4, blank: 1, files: 4 });
    const inc = await programMetrics(files["file:///p/a.declare"], "file:///p/a.declare", read, isLibrary);
    assert.equal(inc.app, undefined, "an included file has no whole-app figure");
    // main 4 lines; m/a 2; m/b 2; s.ts 3 (1 comment); lazy/index 1 — never.ts
    // (named only in a comment), dayjs and cfg.json left out
    const q = await programMetrics(files["file:///q/main.declare"], "file:///q/main.declare", read, isLibrary);
    assert.deepEqual(q.app, { total: 12, code: 11, comment: 1, blank: 0, files: 5 });
    pass++; console.log("  ok — programMetrics counts the App's file and its includes once each, the library's not at all");
  } catch (e) { fail++; console.log("  FAIL — programMetrics\n     ", e.message); }
  try {
    // where each class lives, as a path from the asking file's folder
    const ix = await programIndex('include [ "a.declare" ]\nschema Row [ id: number ]\nApp [ ]\n', "file:///p/main.declare", read, isLibrary);
    assert.deepEqual(ix.defs, { Row: "", A: "a.declare", B: "sub/b.declare" });
    const own = await programIndex(files["file:///p/sub/b.declare"], "file:///p/sub/b.declare", read, isLibrary);
    assert.deepEqual(own.defs, { B: "" }, "a file with no App answers for itself");
    pass++; console.log("  ok — programIndex says where each class and schema of the program is declared");
  } catch (e) { fail++; console.log("  FAIL — programIndex\n     ", e.message); }
})();

console.log(`\nhighlight: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
