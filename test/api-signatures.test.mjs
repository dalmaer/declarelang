// api-signatures — the methods the compiler declares by hand for a program to call
// (compiler/src/scaffold.ts LANGUAGE_API) take the parameters the runtime's own
// methods take. The two are written separately, and a parameter added to one and
// not the other is a documented call the compiler refuses (or an undocumented one
// it lets through). Compared by count, read with TypeScript's own parser from the
// runtime's declaration files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { test, summarize } from "./harness.mjs";
import { LANGUAGE_API } from "../compiler/dist/scaffold.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "runtime/dist");

/** method arity per class, from every runtime declaration file */
function runtimeMethods() {
  const out = new Map();
  for (const f of readdirSync(DIST).filter((n) => n.endsWith(".d.ts"))) {
    const src = ts.createSourceFile(f, readFileSync(join(DIST, f), "utf8"), ts.ScriptTarget.Latest, true);
    src.forEachChild((n) => {
      if (!ts.isClassDeclaration(n) || n.name === undefined) return;
      const m = out.get(n.name.text) ?? new Map();
      for (const mem of n.members) {
        if (!ts.isMethodDeclaration(mem) || mem.name === undefined || !ts.isIdentifier(mem.name)) continue;
        const ps = mem.parameters;
        const cur = m.get(mem.name.text);
        const arity = { min: ps.filter((p) => p.questionToken === undefined && p.initializer === undefined && p.dotDotDotToken === undefined).length, max: ps.some((p) => p.dotDotDotToken) ? Infinity : ps.length };
        // overloads: the widest reading
        m.set(mem.name.text, cur === undefined ? arity : { min: Math.min(cur.min, arity.min), max: Math.max(cur.max, arity.max) });
      }
      out.set(n.name.text, m);
    });
  }
  return out;
}

/** method arity from one scaffold member line, e.g. "  scrollTo(y: number, glide?: …): void;" */
function scaffoldMethod(line) {
  const src = ts.createSourceFile("x.ts", `declare class X {\n${line}\n}`, ts.ScriptTarget.Latest, true);
  const cls = src.statements[0];
  const mem = cls.members[0];
  if (mem === undefined || !ts.isMethodDeclaration(mem) || !ts.isIdentifier(mem.name)) return null;
  const ps = mem.parameters;
  return { name: mem.name.text, min: ps.filter((p) => p.questionToken === undefined && p.initializer === undefined && p.dotDotDotToken === undefined).length, max: ps.some((p) => p.dotDotDotToken) ? Infinity : ps.length };
}

await test("every hand-declared method takes the parameters its runtime method takes", () => {
  const rt = runtimeMethods();
  const drift = [];
  let compared = 0;
  for (const [cls, lines] of Object.entries(LANGUAGE_API)) {
    const methods = rt.get(cls);
    if (methods === undefined) continue;
    for (const line of lines) {
      const s = scaffoldMethod(line);
      if (s === null) continue;
      const r = methods.get(s.name);
      if (r === undefined) continue;
      compared++;
      if (s.max !== r.max || s.min !== r.min) drift.push(`${cls}.${s.name}: compiler takes ${s.min}–${s.max}, runtime ${r.min}–${r.max}`);
    }
  }
  assert.ok(compared > 20, `compared ${compared} methods — the reader found the classes`);
  assert.deepEqual(drift, []);
});

summarize("api-signatures");
