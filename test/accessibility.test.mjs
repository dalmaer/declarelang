// test/accessibility.test.mjs — what a program is to assistive technology
// (docs/system-design/accessibility.md): the vocabulary, the role contracts the
// compiler checks, and the semantic tree every platform is given.
//
// The two requirements the design answers are held here directly: an author's
// view is accessible by exactly the means the library's are (the contract is
// checked by name and type, and the tree's code names no library class), and
// none of it costs anything on a view that leaves it unset.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test, summarize } from "./harness.mjs";
import { compileProgram } from "../compiler/dist/declarec.js";
import { instantiate, createViewIn } from "../runtime/dist/instantiate.js";
import { settle, provideMeasurer } from "../runtime/dist/index.js";
import { approximateMeasurer } from "../compiler/dist/headless.js";
import { semanticTree, formatSemantics, NAMED_BY_CONTENT, PRESSED, STEPPED } from "../runtime/dist/semantics.js";
import { slotIndex } from "../runtime/dist/attributes.js";
import { View } from "../runtime/dist/view.js";
import { A11Y_MEMBERS, ROLES, ROLE_CONTRACTS } from "../runtime/dist/a11y-roles.js";

provideMeasurer(approximateMeasurer());

const compile = (src) => compileProgram(src, { originDir: process.cwd() + "/library", stripPos: false });
const a11y = (xs) => xs.filter((e) => /accessibility|DECLARE20(06|07)|DECLARE401[678]/.test(`${e.code} ${e.message}`));
const codes = (xs) => a11y(xs).map((e) => e.code);
async function boot(src) {
  const b = await compile(src);
  assert.deepEqual(b.errors.map((e) => e.message), []);
  const app = instantiate(b.program);
  settle();
  return app;
}
const tree = (app) => formatSemantics(semanticTree(app));

const WAVE = `class Wave extends View [ position: number = 12, duration: number = 65,
  accessibilityRole = slider, accessibilityLabel = "Voice message",
  accessibilityMin = 0, accessibilityMax = { duration }, accessibilityValue = { position },
  accessibilityValueText = { position + "s of " + duration + "s" },
  accessibilityIncrement() { position = position + 5 }, accessibilityDecrement() { position = position - 5 } ]`;

// ── the contract ──────────────────────────────────────────────────────────────

await test("an author's view meets a role's contract the way any class does, and compiles clean", async () => {
  const b = await compile(`${WAVE}\nApp [ Wave [ ] ]`);
  assert.deepEqual(a11y(b.errors), []);
  assert.deepEqual(a11y(b.warnings), []);
});

await test("a role whose contract is not met is an error naming every missing member", async () => {
  const b = await compile(`class Wave extends View [ accessibilityRole = slider, accessibilityLabel = "Voice", accessibilityMin = 0 ]\nApp [ Wave [ ] ]`);
  assert.deepEqual(codes(b.errors), ["DECLARE2006"]);
  const m = b.errors[0].message;
  for (const missing of ["accessibilityValue", "accessibilityMax", "accessibilityIncrement()", "accessibilityDecrement()"]) assert.match(m, new RegExp(missing.replace(/[()]/g, "\\$&")));
  assert.doesNotMatch(m, /no accessibilityMin/);
});

await test("a subclass inherits the contract its base met, and a use site may meet it too", async () => {
  const b = await compile(`${WAVE}\nclass LongWave extends Wave [ duration = 600 ]
class Bare extends View [ press() { } ]
App [ LongWave [ ], Bare [ accessibilityRole = button, accessibilityLabel = "Go" ] ]`);
  assert.deepEqual(a11y(b.errors), []);
});

await test("a role is a word: a { } role is an error", async () => {
  const b = await compile(`App [ on: boolean = true, View [ accessibilityRole = { app.on ? "button" : "none" } ] ]`);
  assert.deepEqual(codes(b.errors), ["DECLARE2007"]);
});

await test("a role is fixed for the view's life: written after the view is built, it throws", async () => {
  const app = await boot(`App [ v: View [ accessibilityRole = group ] ]`);
  assert.equal(app.v.accessibilityRole, "group");
  assert.throws(() => { app.v.accessibilityRole = "button"; }, /fixed for the view's life/);
});

await test("a role given to createView is checked as it is created, in the compiler's words", async () => {
  const app = await boot(`App [ ]`);
  assert.throws(() => createViewIn(app, "View", app, { accessibilityRole: "slider", accessibilityLabel: "Volume" }),
    /declares accessibilityRole = slider[\s\S]*no accessibilityValue/);
  const ok = createViewIn(app, "View", app, { accessibilityRole: "group", accessibilityLabel: "Tools" });
  assert.equal(ok.accessibilityRole, "group");
});

// ── the warnings ──────────────────────────────────────────────────────────────

await test("a Control is a button; a role that needs a name with none is a warning — words, a tip or a named mark are names", async () => {
  const b = await compile(`class Chip extends Control [ ]
class B extends View [ accessibilityRole = button, press() { } ]
App [ Chip [ ], Chip [ accessibilityLabel = "Tag" ], Chip [ tooltipLabel = "Tag" ], Chip [ CloseIcon [ ] ],
    B [ ], B [ Text [ text = "Send" ] ], B [ accessibilityLabel = "Close" ] ]`);
  assert.deepEqual(a11y(b.errors), []);
  assert.deepEqual(codes(b.warnings).sort(), ["DECLARE4017", "DECLARE4017"]);
});

await test("a wordless control is named by its tip, else by the mark it shows; words win", async () => {
  const app = await boot(`App [ width = 400, height = 300,
    layout: SimpleLayout [ axis = y ],
    Control [ width = 20, height = 20, CloseIcon [ ] ],
    Control [ width = 20, height = 20, tooltipLabel = "Dismiss", CloseIcon [ ] ],
    Control [ width = 80, height = 20, PlusIcon [ ], Text [ x = 20, text = "New" ] ]
    ]`);
  assert.equal(tree(app), `application\n  button "Close" {press}\n  button "Dismiss" {press}\n  button "New" {press}`);
});

await test("a drawn view that takes the focus and says nothing is a warning", async () => {
  const b = await compile(`class Dial extends View [ focusable = true, draw(d: Draw) { } ]\nApp [ Dial [ ] ]`);
  assert.deepEqual(codes(b.warnings), ["DECLARE4018"]);
});

await test("accessibility = false silences the warnings, not the errors", async () => {
  const off = await compile(`defaultFlags [ accessibility = false ]\nclass Chip extends Control [ ]\nApp [ Chip [ ] ]`);
  assert.deepEqual(a11y(off.warnings), []);
  const broken = await compile(`defaultFlags [ accessibility = false ]\nApp [ View [ accessibilityRole = slider ] ]`);
  assert.deepEqual(codes(broken.errors), ["DECLARE2006"]);
});

// ── the semantic tree ─────────────────────────────────────────────────────────

await test("the tree: an author's slider reads as a slider, with its value, range and actions", async () => {
  const app = await boot(`${WAVE}\nApp [ width = 400, height = 300, w: Wave [ width = 200, height = 30 ] ]`);
  app.w.accessibilityIncrement(); settle();
  assert.equal(tree(app), `application\n  slider "Voice message" = "17s of 65s" 17 (0–65) {increment, decrement}`);
});

await test("the tree: views with no role are transparent, hidden and faded-out views are pruned, text is content", async () => {
  const app = await boot(`class B extends View [ accessibilityRole = button, press() { } ]
App [ width = 400, height = 300, layout: SimpleLayout [ axis = y ],
  View [ View [ Text [ text = "Inbox" ] ] ],
  B [ width = 80, height = 30, Text [ text = "Send" ] ],
  B [ width = 30, height = 30, accessibilityLabel = "Close", accessibilityHint = "Closes the conversation" ],
  View [ visible = false, B [ accessibilityLabel = "Hidden" ] ],
  View [ opacity = 0, Text [ text = "Faded" ] ] ]`);
  assert.equal(tree(app), [
    "application",
    `  text "Inbox"`,
    `  button "Send" {press}`,
    `  button "Close" hint "Closes the conversation" {press}`,
  ].join("\n"));
});

await test("the tree: a long list reports every row it holds, and builds nodes only for the rows on screen", async () => {
  const app = await boot(`class Row extends View [ accessibilityRole = listItem, height = 20, width = 200, Text [ text = { "Item " + :n } ] ]
App [ width = 400, height = 100, d: Dataset { { "rows": [] } },
  onInit() { const rows = []; for (let i = 0; i < 30500; i++) rows.push({ n: i }); d.set([], { rows }) },
  list: View [ width = 400, height = 100, scrolls = y, accessibilityRole = list, accessibilityLabel = "Messages", datapath = { d.value },
    layout: SimpleLayout [ axis = y ], Row [ datapath = :rows[], virtualize = true ] ] ]`);
  const list = semanticTree(app).children[0];
  assert.equal(list.role, "list");
  assert.equal(list.rowCount, 30500);
  assert.ok(list.children.length > 0 && list.children.length < 100, `${list.children.length} rows built`);
  assert.deepEqual(list.children.slice(0, 2).map((r) => [r.name, r.rowIndex]), [["Item 0", 1], ["Item 1", 2]]);
});

await test("the tree: behind an open modal, everything is inert", async () => {
  const app = await boot(`App [ width = 400, height = 300, View [ accessibilityRole = button, accessibilityLabel = "Behind", press() { } ],
  dlg: View [ focusScope = modal, accessibilityRole = dialog, accessibilityLabel = "Confirm",
    View [ accessibilityRole = button, accessibilityLabel = "OK", press() { } ] ] ]`);
  assert.equal(tree(app), `application\n  dialog "Confirm" [modal]\n    button "OK" {press}`);
  app.dlg.visible = false; settle();
  assert.equal(tree(app), `application\n  button "Behind" {press}`);
});

await test("the tree: a rich document reads as headings, paragraphs, lists and links", async () => {
  const app = await boot(`App [ width = 500, height = 400, Markdown [ width = 500, text = "# Title\\n\\nSee [the guide](#guide).\\n\\n- one\\n- two" ] ]`);
  assert.equal(tree(app), [
    "application",
    `  heading "Title" level 1`,
    `  text "See the guide."`,
    `    link "the guide" {press}`,
    `  list 2 rows`,
    `    listItem "one" row 1`,
    `    listItem "two" row 2`,
  ].join("\n"));
});

await test("the tree: a field is a textField named by its placeholder; an unnamed picture is decoration", async () => {
  const app = await boot(`App [ width = 400, height = 300, layout: SimpleLayout [ axis = y ],
  TextInput [ width = 200, placeholder = "Search", text = "birds" ],
  Image [ width = 20, height = 20 ], Image [ width = 20, height = 20, accessibilityLabel = "Avatar" ] ]`);
  assert.equal(tree(app), `application\n  textField "Search" = "birds"\n  image "Avatar"`);
});

await test("expanded: a menu button and an accordion header say whether what they open is open", async () => {
  const app = await boot(`App [ width = 400, height = 400, layout: SimpleLayout [ axis = y ],
    opts: Button [ label = "Options", menu = { app.m } ],
    m: Menu [ items = { [ ({ id: "a", label: "Copy" }) ] } ],
    Accordion [ width = 300, Pane [ label = "First", initial = true, Text [ text = "inside" ] ], Pane [ label = "Second" ] ] ]`);
  const line = (name) => tree(app).split("\n").find((l) => l.includes(`"${name}"`)) ?? "";
  assert.match(line("Options"), /\[collapsed\]/);
  assert.match(tree(app), /button "First" \[expanded\]/);
  assert.match(tree(app), /button "Second" \[collapsed\]/);
  app.opts.openMenu(); settle();
  assert.match(line("Options"), /\[expanded\]/);
});

await test("the wider vocabulary: a search field, a radio group, landmarks, a separator", async () => {
  const app = await boot(`App [ width = 400, height = 400, layout: SimpleLayout [ axis = y ],
    nav: View [ accessibilityRole = navigation, accessibilityLabel = "Sections",
      Segmented [ value = { "a" }, input(v: object) { }, choices = { [ ({ id: "a", label: "All" }), ({ id: "b", label: "Mine" }) ] } ] ],
    View [ accessibilityRole = main, find: SearchField [ width = 200, placeholder = "Search messages" ] ],
    m: Menu [ items = { [ ({ id: "a", label: "Copy" }), ({ divider: true }), ({ id: "b", label: "Paste" }) ] } ] ]`);
  const t = tree(app);
  assert.match(t, /navigation "Sections"\n    radioGroup\n      radio "All" row 1 \[checked\]/);
  assert.match(t, /main\n    searchBox "Search messages"/);
  const b = await compile(`App [ SearchField [ ], SearchField [ placeholder = "Find" ] ]`);
  assert.deepEqual(codes(b.warnings), [], "a placeholder names a search field");
});

await test("Accessibility.announce: a handler says something with no view to say it from", async () => {
  const { Accessibility } = await import("../runtime/dist/accessibility-service.js");
  const app = await boot(`App [ n: number = 0, send() { n = n + 1; Accessibility.announce("Message sent") },
    alarm() { Accessibility.announce("Connection lost", "assertive") } ]`);
  app.send(); app.alarm();
  assert.deepEqual(Accessibility.announced().slice(-2), [{ text: "Message sent", politeness: "polite" }, { text: "Connection lost", politeness: "assertive" }]);
});

await test("a scroller holding nothing focusable is a Tab stop, and its keys scroll it; one holding a control is not", async () => {
  const { Focus } = await import("../runtime/dist/index.js");
  // lines of a fixed height (headless, a Text has no height until a renderer measures it)
  const lines = Array.from({ length: 60 }, () => `View [ width = 280, height = 20 ]`).join(", ");
  const app = await boot(`App [ width = 400, height = 400, layout: SimpleLayout [ axis = y ],
    a: Button [ label = "Before" ],
    prose: View [ width = 300, height = 100, scrolls = y, layout: SimpleLayout [ axis = y ], ${lines} ],
    withButton: View [ width = 300, height = 100, scrolls = y, layout: SimpleLayout [ axis = y ], ${lines}, inner: Button [ label = "Inside" ] ],
    b: Button [ label = "After" ] ]`);
  const order = [];
  Focus.focus(app.a); settle();
  for (let i = 0; i < 4; i++) { Focus.next(); settle(); order.push(Focus.getFocus()); }
  assert.deepEqual(order.slice(0, 3), [app.prose, app.withButton.inner, app.b], "the bare pane is a stop; the other is entered");
  Focus.focus(app.prose); settle();
  const key = (k, extra = {}) => { app.prose.onKeyDown({ key: k, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...extra }); settle(); };
  key("ArrowDown"); assert.equal(app.prose.scrollY, 40);
  key("PageDown"); assert.equal(app.prose.scrollY, 130);
  key("End"); assert.ok(app.prose.scrollY > 500, `End reached the end (${app.prose.scrollY})`);
  key("Home"); assert.equal(app.prose.scrollY, 0);
});

// ── the two requirements, held ────────────────────────────────────────────────

await test("authoring parity: the tree and the contracts name no library class", () => {
  const libraryClasses = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith(".declare")) for (const m of readFileSync(`${dir}/${e.name}`, "utf8").matchAll(/^\s*class (\w+) extends/gm)) libraryClasses.add(m[1]);
    }
  };
  walk("library");
  assert.ok(libraryClasses.has("Slider") && libraryClasses.has("Button"), "the library's classes were read");
  for (const f of ["runtime/src/semantics.ts", "runtime/src/a11y-roles.ts", "compiler/src/a11y-check.ts"]) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/`[^`]*`|"[^"\n]*"/g, "\"\"");
    const named = [...libraryClasses].filter((c) => new RegExp(`\\b${c}\\b`).test(code));
    assert.deepEqual(named, [], `${f} names a library class`);
  }
});

await test("pay-per-use: no accessibility attribute takes a slot in a view's kernel block", () => {
  for (const name of ["accessibilityRole", "accessibilityLabel", "accessibilityHint", "accessibilityLive", ...A11Y_MEMBERS]) {
    assert.equal(slotIndex(View, name), -1, `${name} is a block slot`);
  }
});

await test("the vocabulary: every role token parses as a literal, `switch` and `none` included", async () => {
  for (const role of ROLES) {
    const b = await compile(`App [ View [ accessibilityRole = ${role}, accessibilityLabel = "x", accessibilityValue = 1, accessibilityMin = 0, accessibilityMax = 2,
      accessibilityChecked = false, accessibilityPressed = false, accessibilitySelected = false,
      press() { }, accessibilityIncrement() { }, accessibilityDecrement() { } ] ]`);
    assert.deepEqual(b.errors.map((e) => e.message), [], role);
  }
});

await test("accessibility = false: the build carries none of the layer — no attribute, no contract, no binding", async () => {
  const { buildProduction } = await import("../tools/declarec.mjs");
  const src = (flag) => `${flag ? "defaultFlags [ accessibility = false ]\n" : ""}App [ Slider [ accessibilityLabel = "Volume" ], Checkbox [ label = "Mute" ], Button [ label = "Go" ] ]`;
  const js = async (s) => (await buildProduction(s, { name: "a11y" })).files.filter((f) => f.name.endsWith(".js")).map((f) => f.contents).join("");
  const off = await js(src(true)), on = await js(src(false));
  // no attribute, no binding, no contract: what remains is Control's key handler,
  // whose slider branch reads a role nothing set and so never runs
  for (const word of ["accessibilityValue", "accessibilityChecked", "accessibilityLabel", "accessibilityMin", "alertDialog", "nameFromContent", "fixed for the view"]) {
    assert.ok(!off.includes(word), `the layer-off build carries ${word}`);
  }
  assert.ok(on.includes("accessibilityRole") && on.includes("accessibilityIncrement"), "the layer-on build carries it");
});

await test("the semantic tree's role sets agree with the contracts it no longer ships", () => {
  for (const [role, k] of Object.entries(ROLE_CONTRACTS)) {
    assert.equal(NAMED_BY_CONTENT.has(role), k.nameFromContent === true, `${role}: named by its content`);
    const methods = [...k.methods, ...(k.mayMethods ?? [])];
    if (methods.includes("press")) assert.ok(PRESSED.has(role), `${role}: pressed`);
    assert.equal(STEPPED.has(role), methods.includes("accessibilityIncrement"), `${role}: stepped`);
  }
});

await test("a button given an empty label has no name, and is warned of", async () => {
  const warned = async (src) => (await compile(src)).warnings.filter((w) => /DECLARE4017/.test(w.code ?? "") || /with no name/.test(w.message)).length;
  assert.equal(await warned(`App [ width = 100, height = 100, Button [ label = "" ] ]`), 1);
  assert.equal(await warned(`App [ width = 100, height = 100, Button [ label = "", tooltipLabel = "Refresh" ] ]`), 0, "a tip names it");
  assert.equal(await warned(`App [ width = 100, height = 100, Button [ label = "Go" ] ]`), 0);
});

await test("the item a composite names as the one the keys are on is marked active, wherever it sits", async () => {
  const app = await boot(`App [ width = 300, height = 200, on: number = 1,
    list: View [ accessibilityRole = listbox, accessibilityLabel = "Fruit",
        accessibilityActiveItem = { app.on == 1 ? this.b : this.a },
        a: View [ accessibilityRole = option, accessibilityLabel = "Apple", press() { } ],
        b: View [ accessibilityRole = option, accessibilityLabel = "Banana", press() { } ] ] ]`);
  assert.match(tree(app), /option "Banana" \[active\]/);
  assert.doesNotMatch(tree(app), /option "Apple" \[active\]/);
  app.on = 0; settle();
  assert.match(tree(app), /option "Apple" \[active\]/);
});

summarize("accessibility");
