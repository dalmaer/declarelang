// check-gates-readonly — a gate that checks writes nothing. Each `--check` the ops
// gates run (tools/internal/ops.mjs) leaves every file derive produces exactly as
// it was: a gate that rewrote one left derive's record of it stale behind it, and
// the next push was refused over work already done.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test, summarize } from "./harness.mjs";
import { OPS } from "../tools/internal/ops.mjs";
import { fileSet } from "../tools/internal/filesets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file derive writes — outputs and stamped files — by content and by when
 *  it was last written: a check must not write at all, not even the same bytes. */
function snapshot() {
  const paths = execFileSync(process.execPath, [join(ROOT, "tools/internal/derive.mjs"), "--paths"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  const specs = paths.map((p) => p.endsWith("*") ? { dir: dirname(p), pre: p.slice(p.lastIndexOf("/") + 1, -1) } : p);
  const out = new Map();
  for (const f of fileSet(ROOT, specs)) out.set(f, createHash("sha1").update(readFileSync(join(ROOT, f))).digest("hex") + "@" + statSync(join(ROOT, f)).mtimeMs);
  return out;
}

const checks = Object.values(OPS).flatMap((section) => section.steps).map((e) => e.cmd).filter((c) => typeof c === "string" && /--check\b/.test(c) && !/</.test(c));

await test("every --check gate leaves what derive wrote untouched", () => {
  assert.ok(checks.length >= 3, `found the gates' checks: ${checks.join("; ")}`);
  const before = snapshot();
  for (const cmd of checks) spawnSync("sh", ["-c", cmd], { cwd: ROOT, encoding: "utf8" });
  const after = snapshot();
  const changed = [...before].filter(([f, h]) => after.get(f) !== h).map(([f]) => f);
  const added = [...after.keys()].filter((f) => !before.has(f));
  assert.deepEqual([...changed, ...added], [], `a check wrote (ran: ${checks.join("; ")})`);
});

summarize("check-gates-readonly");
