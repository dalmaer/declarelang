// verify-requests — an assert script asks what the program sent: drive.requests()
// lists its data requests (not the page's own files), and expect.request checks
// one by method, path, count and body, failing with what was sent instead.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, summarize, tempDir } from "./harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = tempDir("declare-verify-requests-");
const APP = join(DIR, "probe.declare");
writeFileSync(APP, `App [ width = 300, height = 200,
    save: DataSource [ url = "/no-such-endpoint", method = "POST" ],
    go: Button [ label = "Save", onClick() { app.save.body = ({ title: "Notes", n: 2 }); app.save.fetch() } ] ]`);

function verify(script) {
  const f = join(DIR, `assert-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, script);
  return spawnSync(process.execPath, [join(ROOT, "tools/verify.mjs"), APP, "--assert", f, "--rung=5", "--no-boot"], { cwd: ROOT, encoding: "utf8" });
}

await test("expect.request: by method, path, count and body", () => {
  const r = verify(`export default async ({ drive, expect }) => {
    await drive.click("app.go");
    await drive.wait(200);
    await expect.request("POST", "/no-such-endpoint", { count: 1, body: { title: "Notes" } });
    const qs = drive.requests();
    if (qs.length !== 1 || qs[0].status !== 404) throw new Error(JSON.stringify(qs));
  };`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

await test("a request that was not sent fails, naming what was", () => {
  const r = verify(`export default async ({ drive, expect }) => {
    await drive.click("app.go");
    await drive.wait(200);
    await expect.request("POST", "/no-such-endpoint", { body: { title: "Other" } });
  };`);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /sent: POST \/no-such-endpoint → 404/);
});

summarize("verify-requests");
