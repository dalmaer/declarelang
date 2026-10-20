// gpu/build.mjs — build the render=gpu renderer into gpu/dist/.
//
//   engine_bg.wasm + engine.js   the Rust engine (gpu/engine), through wasm-bindgen and wasm-opt
//   worker.js                    the runtime + MacBackend, one module (a module worker)
//   compositor.js                the GPU host and the scroll process, owning the canvas (a module worker)
//   shell.js                     the page's side, loaded by the boot when the address has ?render=gpu
//   bench.js                     the timing rig, loaded by a harness into a ?render=gpu page (never by the renderer)
//
// node gpu/build.mjs [--no-engine]   (--no-engine reuses the last engine build; NAMES=1 keeps the
//                                    engine's function names, for a profile; NOMINIFY=1 the JS's)
// Needs runtime/dist (derive's tsc step) and, for the engine, rustup (the toolchain is pinned
// in engine/rust-toolchain.toml), wasm-bindgen-cli at the version engine/Cargo.toml names, and
// binaryen's wasm-opt; each missing tool is named with the command that installs it.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const cargo = path.join(process.env.HOME, ".cargo/bin");
// NAMES=1 keeps the engine's function names in the wasm, for a profile that names them
const NAMES = !!process.env.NAMES;
const env = { ...process.env, PATH: `${cargo}:${process.env.PATH}`, ...(NAMES ? { CARGO_PROFILE_RELEASE_STRIP: "none" } : {}) };
const run = (cmd, args, cwd = HERE) => execFileSync(cmd, args, { cwd, env, stdio: "inherit" });

if (!process.argv.includes("--no-engine")) {
  const eng = path.join(HERE, "engine");
  // the tools, checked before anything is built
  const version = (cmd) => { try { return execFileSync(cmd, ["--version"], { env, encoding: "utf8" }).trim(); } catch { return null; } };
  const bindgen = /^wasm-bindgen = "([^"]+)"/m.exec(readFileSync(path.join(eng, "Cargo.toml"), "utf8"))[1];
  const missing = [];
  if (version("cargo") === null) missing.push("Rust: install rustup (https://rustup.rs); it installs the pinned toolchain itself");
  if (version("wasm-bindgen") !== `wasm-bindgen ${bindgen}`) missing.push(`wasm-bindgen ${bindgen}: cargo install wasm-bindgen-cli --version ${bindgen}`);
  if (version("wasm-opt") === null) missing.push("wasm-opt: brew install binaryen");
  if (missing.length) { console.error("gpu/build.mjs: the engine needs\n  " + missing.join("\n  ")); process.exit(1); }
  run("cargo", ["build", "-q", "--release", "--target", "wasm32-unknown-unknown"], eng);
  run("wasm-bindgen", ["--target", "web", "--out-dir", DIST, "--out-name", "engine",
    path.join(eng, "target/wasm32-unknown-unknown/release/declare_gpu_engine.wasm")]);
  run("wasm-opt", ["-O3", ...(NAMES ? ["-g"] : []), "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext",
    "--enable-mutable-globals", "--enable-reference-types", "--enable-multivalue",
    path.join(DIST, "engine_bg.wasm"), "-o", path.join(DIST, "engine_bg.wasm")]);
}

const common = { bundle: true, format: "esm", target: "es2022", minify: !process.env.NOMINIFY, sourcemap: true, logLevel: "warning",
  define: { __DECLARE_DEV_SWITCHES__: "false", __DECLARE_NATIVE_KERNEL__: "false" } };
await build({ ...common, entryPoints: [path.join(HERE, "src/worker.ts")], outfile: path.join(DIST, "worker.js") });
await build({ ...common, entryPoints: [path.join(HERE, "src/compositor.ts")], outfile: path.join(DIST, "compositor.js") });
await build({ ...common, entryPoints: [path.join(HERE, "src/shell.ts")], outfile: path.join(DIST, "shell.js") });
await build({ ...common, entryPoints: [path.join(HERE, "src/bench.ts")], outfile: path.join(DIST, "bench.js") });

const size = (f) => { const b = readFileSync(path.join(DIST, f)); return `${f.padEnd(16)} ${(b.length / 1024).toFixed(0).padStart(6)} KB   gz ${(gzipSync(b, { level: 9 }).length / 1024).toFixed(0).padStart(5)} KB   br ${(brotliCompressSync(b).length / 1024).toFixed(0).padStart(5)} KB`; };
for (const f of ["engine_bg.wasm", "worker.js", "compositor.js", "shell.js"]) console.log(size(f));
