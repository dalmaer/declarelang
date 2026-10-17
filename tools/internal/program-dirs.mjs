// tools/internal/program-dirs.mjs — every program directory under apps/, at any depth.
//
// THE RULE (docs/system-design/requests.md, the directory-program rule): a directory
// is a program directory exactly when it holds a `.declare` file named after itself —
// `…/name/name.declare`. The hosts apply it per URL (browser/serve-core.js
// directoryProgram), so it holds at any depth; this is the same rule applied to the
// tree, for everything that must know the whole set ahead of time: the cold stubs
// (bake-app-stubs.mjs), the BUILD_ID stamp (stamp-version.mjs), and the tests that
// sweep every program.
//
// Every directory is walked, a program's included: a program may hold programs of its
// own (a desktop whose tenants live in its folder), and a directory with no program of
// its own (apps/games/) simply groups the ones below it. A dotted name is never a
// program directory (directoryProgram reads it as a file), and dot-directories,
// node_modules and build output (dist) are not walked.

import path from "node:path";
import { readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Absolute paths of every program directory under `<root>/apps`, sorted. */
export function programDirs(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
      const d = path.join(dir, e.name);
      const main = path.join(d, e.name + ".declare");
      if (!e.name.includes(".") && existsSync(main) && statSync(main).isFile()) out.push(d);
      walk(d);
    }
  };
  const apps = path.join(root, "apps");
  if (existsSync(apps)) walk(apps);
  return out.sort();
}

/** A program directory's main file: `<dir>/<name>.declare`. */
export function programFile(dir) {
  return path.join(dir, path.basename(dir) + ".declare");
}
