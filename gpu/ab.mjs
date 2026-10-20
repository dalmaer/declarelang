// gpu/ab.mjs — two builds of render=gpu compared back to back: the census's scenarios run with
// each build in turn, alternating (A B A B …), so the machine's changing load falls on both
// alike. Each build is a copy of gpu/dist (`cp -R gpu/dist <dir>` after building it); the tool
// puts each in place before its round and leaves B in place at the end.
//   node gpu/ab.mjs <dirA> <dirB> [app filter] [--rounds N] [--scenarios file.json] [--a "&sw"] [--b "&sw"]
// --a / --b add URL switches to one variant's pages (the same build twice, a switch apart).
// Prints, per scenario, the medians over the rounds of frames a second, the runtime column
// (busy less encode), the compositor worker's busy time a frame, encode and GPU time — A, then B.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : d; };
const rounds = Number(opt("--rounds", "3"));
const scen = opt("--scenarios", path.join(HERE, "census-scenarios.json"));
const sw = { A: opt("--a", ""), B: opt("--b", "") };
const [dirA, dirB, only = ""] = args;
if (!dirA || !dirB) { console.error("usage: node gpu/ab.mjs <dirA> <dirB> [app] [--rounds N] [--scenarios f]"); process.exit(1); }

const tmp = mkdtempSync(path.join(os.tmpdir(), "ab-"));
const runs = { A: [], B: [] };
for (let r = 0; r < rounds; r++) {
  for (const [k, dir] of r % 2 === 0 ? [["A", dirA], ["B", dirB]] : [["B", dirB], ["A", dirA]]) {
    cpSync(dir, path.join(HERE, "dist"), { recursive: true });
    const out = path.join(tmp, `${k}${r}.json`);
    execFileSync("node", [path.join(HERE, "census.mjs"), scen, only, "--json", out], { stdio: "ignore", env: { ...process.env, GPU_SWITCHES: sw[k] } });
    runs[k].push(JSON.parse(readFileSync(out, "utf8")));
  }
}
cpSync(dirB, path.join(HERE, "dist"), { recursive: true });

const med = (v) => { const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const key = (row) => `${row.app} · ${row.sc}`;
const names = runs.A[0].map(key);
const pick = (k, name, f) => med(runs[k].map((rows) => { const row = rows.find((x) => key(x) === name); return row ? f(row) : NaN; }));
console.log(`${rounds} rounds, alternating; medians — A ${dirA}${sw.A}, B ${dirB}${sw.B}`);
for (const name of names) {
  const col = (f, d = 1) => `${pick("A", name, f).toFixed(d)}→${pick("B", name, f).toFixed(d)}`;
  console.log(`${name.padEnd(36)} fps ${col((r) => r.fps, 0).padEnd(9)} runtime ${col((r) => r.runtime, 2).padEnd(12)} compositor ${col((r) => r.compositor, 2).padEnd(12)} encode ${col((r) => r.encode).padEnd(9)} gpu ${col((r) => r.gpu, 2)}`);
}
