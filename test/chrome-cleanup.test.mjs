// chrome-cleanup — a Chrome the tools start leaves nothing behind: its profile is
// removed when it closes, and when the process that started it ends without
// closing it, that Chrome is stopped and its profile removed too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, summarize, tempDir } from "./harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function run(body) {
  const file = join(tempDir("declare-chrome-cleanup-"), "run.mjs");
  writeFileSync(file, `import { launchChrome } from ${JSON.stringify(join(ROOT, "tools/internal/chrome.mjs"))};
const b = await launchChrome({ args: ["--no-sandbox"] });
console.log(JSON.stringify({ pid: b.process().pid, profile: b.process().spawnargs.find((a) => a.startsWith("--user-data-dir=")).slice(16) }));
${body}`);
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return JSON.parse(r.stdout.trim().split("\n")[0]);
}

await test("a closed browser takes its profile with it", async () => {
  const r = run("await b.close();");
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(r.profile), false, r.profile);
});

await test("a process that ends without closing stops its Chrome and removes the profile", async () => {
  const r = run("process.exit(0);");
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(alive(r.pid), false, `Chrome ${r.pid} still running`);
  assert.equal(existsSync(r.profile), false, r.profile);
});

summarize("chrome-cleanup");
