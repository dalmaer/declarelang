// Theme tokens are a closed set at compile time. `provided("theme")` reads a
// record whose keys are all declared somewhere the compile sees — the presets,
// the library defaults, the program's own `theme` declarations, and the records
// its theme provisions write — so a misspelled token is refused at the read,
// naming the token it most likely meant, instead of painting with undefined.
import assert from "node:assert";
import { compileProgram } from "../compiler/dist/declarec.js";

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ok —", name); }
  catch (e) { fail++; console.log("  FAIL —", name, "\n     ", e.message); }
}
async function errorsOf(src) {
  const r = await compileProgram(src, { stripPos: false });
  return r.errors.map((e) => e.message);
}
async function clean(src) {
  const errs = await errorsOf(src);
  assert.equal(errs.length, 0, "compile errors: " + errs.join("; "));
}

console.log("theme tokens");

await test("a misspelled token is refused, naming the near miss", async () => {
  const errs = await errorsOf(`App [ theme = SanFrancisco, fill = { provided("theme").surfce } ]`);
  assert.equal(errs.length, 1, errs.join("; "));
  assert.match(errs[0], /'surfce' is not a token any theme declares — did you mean 'surface'\?/);
});

await test("another system's name for a role is answered with the token that plays it", async () => {
  const errs = await errorsOf(`App [ theme = SanFrancisco, fill = { provided("theme").bg } ]`);
  assert.equal(errs.length, 1, errs.join("; "));
  assert.match(errs[0], /'bg' is not a token any theme declares — did you mean 'background'\?/);
});

await test("a token nobody declares names the fix", async () => {
  const errs = await errorsOf(`App [ fill = { provided("theme").brandWash } ]`);
  assert.equal(errs.length, 1, errs.join("; "));
  assert.match(errs[0], /'brandWash' is not a token any theme declares — fix the name, or declare the token in a theme of your own/);
});

await test("a read through a local is checked the same", async () => {
  const errs = await errorsOf(`App [ fill = { (() => { const t = provided("theme"); return t.accnt })() } ]`);
  assert.equal(errs.length, 1, errs.join("; "));
  assert.match(errs[0], /did you mean 'accent'\?/);
});

await test("the library's tokens are accepted — preset, defaults, and the ones only a fallback names", () => clean(`
App [ theme = SanFrancisco,
    View [ fill = { provided("theme").accent }, cornerRadius = { provided("theme").controlCornerRadius } ],
    View [ height = { provided("theme").segmentedHeight }, shadow = { provided("theme").menuShadow } ],
    View [ fill = { provided("theme").menuHighlightFill }, shadow = { provided("theme").dialogShadow ?? provided("theme").menuShadow } ]
    ]`));

await test("a token the program's own theme declares is accepted", () => clean(`
theme Brand [ wash = #FFF7F5, inks = [#A8445E, #3F6E8C] ]
App [ theme = { { ...SanFrancisco, ...Brand } },
    View [ fill = { provided("theme").wash } ],
    View [ fill = { provided("theme").inks[1] } ]
    ]`));

await test("a token a provision writes as a record is accepted", () => clean(`
App [ theme = { { ...SanFrancisco, ...app.extra() } },
    extra() { return { rail: 0xECF0F4 } },
    View [ fill = { provided("theme").rail } ]
    ]`));

await test("a declared numeric token reads as a number", async () => {
  const errs = await errorsOf(`App [ theme = SanFrancisco, View [ height = { provided("theme").buttonHeight.length } ] ]`);
  assert.equal(errs.length, 1, errs.join("; "));
  assert.match(errs[0], /'length' is not a member of number/);
});

await test("another provided value keeps its open reading", () => clean(`
App [ density: number = 2,
    View [ height = { 10 * provided("density").anything } ]
    ]`));

console.log(`\ntheme-tokens: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
