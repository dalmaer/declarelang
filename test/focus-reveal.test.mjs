// focus-reveal — focus a program moves is shown, as Tab's is: the control is
// scrolled into view, clear of chrome pinned over the page. Focus a press takes
// is not (the person is pointing at it already).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { test, summarize, tempDir } from "./harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(tempDir("declare-focus-reveal-"), "probe.declare");
writeFileSync(FILE, `App [ width = 390, height = 700, scrolls = y,
    page: View [ width = 100%,
        layout: SimpleLayout [ axis = y, spacing = 20 ],
        View [ width = 100%, height = 620 ],
        field: TextInput [ width = 300, accessibilityLabel = "Note" ],
        View [ width = 100%, height = 600 ] ],
    bar: View [ ignoreScroll = true, y = { app.height - 80 }, width = 100%, height = 80, fill = #333333 ],
    go() { Focus.focus(this.page.field) } ]`);

function look(...args) {
  const r = spawnSync("node", [join(ROOT, "tools/look.mjs"), FILE, ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? ""));
  const out = {};
  for (const m of (r.stdout ?? "").matchAll(/^(\S+) = (.*)$/gm)) (out[m[1]] ??= []).push(JSON.parse(m[2]));
  return out;
}

await test("a field focused by the program scrolls clear of a bar pinned over it", () => {
  const r = look("--size", "390x700", "--read", "app.scrollY", "--call", "app.go()", "--wait", "300",
    "--read", "app.scrollY", "--read", "app.page.field.focused", "--read", "app.page.field.height");
  assert.equal(r["app.scrollY"][0], 0, "it starts under the bar");
  const fieldBottom = 640 + r["app.page.field.height"][0] - r["app.scrollY"][1];
  assert.ok(r["app.page.field.focused"][0], "focused");
  assert.ok(fieldBottom <= 700 - 80, `its bottom (${fieldBottom}) is clear of the bar's top (620)`);
});

summarize("focus-reveal");
