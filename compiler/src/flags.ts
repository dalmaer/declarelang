// flags — the two compiler-side readers of the platform's modifiers: a URL's
// query (the dev server, the in-browser compile URL) and `declarec`'s argv.
// The modifiers themselves — names, values, defaults — are the ONE registry in
// runtime/src/flags.ts, which the program's `defaultFlags [ … ]` parser reads
// too, so the three surfaces cannot drift: `name=value` everywhere,
// `?render=canvas`, `--render=canvas`, `render = canvas`.
//
// They compose onto the app-producing REQUESTS (`run`, `build`; see reqtypes.ts
// and docs/system-design/requests.md). The request TYPE (what artifact a URL
// returns) is orthogonal and lives in reqtypes.ts. Everything is lowercase.
//
// A flag a request or the CLI does not name, the program's `defaultFlags`
// decides, and only then the registry's default.
//
// Deliberately NOT flags (see docs/system-design/requests.md §"Removed knobs"):
//   • `prod` is a REQUEST (`?build`, reqtypes.ts REQ.BUILD), not a modifier.
//   • `slim` / `stripPos` are what a build IS (always slimmed + position-stripped);
//     the one caller wanting an un-stripped build to debug the emitter uses
//     `declarec --debug`, not a public flag.
//   • `typecheck` is a mandatory phase of the one compile — always on, no opt-out.
// The compiler's INTERNAL options still carry stripPos/typecheck (the build act sets
// them); only this externally-named FLAG surface is the modifiers.

import { FLAG_SPECS, DEFAULT_FLAGS, flagValue, flagWords, type CompileFlags } from "../../runtime/dist/flags.js";

export { FLAG_SPECS, DEFAULT_FLAGS, FLAG_NAMES, flagWords, flagValue } from "../../runtime/dist/flags.js";
export type { CompileFlags, FlagSpec } from "../../runtime/dist/flags.js";

/** The read surface both a Node `URL`'s searchParams and the browser's
 *  `location.search` params satisfy. */
export interface FlagParams {
  has(name: string): boolean;
  get(name: string): string | null;
}

/** A URL query's modifiers (`?render=canvas&crawler=true`), over a base
 *  (defaults, or an entry point's own baseline). Unknown keys are ignored, and
 *  so is a value that is not one of the modifier's words: the base stands. */
export function parseFlags(params: FlagParams, base: CompileFlags = DEFAULT_FLAGS): CompileFlags {
  const out: Record<string, unknown> = { ...base };
  for (const spec of FLAG_SPECS) {
    const word = params.get(spec.name);
    if (word === null) continue;
    const v = flagValue(spec, word);
    if (v !== undefined) out[spec.name] = v;
  }
  return out as unknown as CompileFlags;
}

/** `declarec`'s modifiers from argv (`--render=canvas --crawler=true`), plus
 *  the leftover args (the input path, and the switches the CLI owns: `--out`,
 *  `--debug`, `--extract`, `--highlight`, `--quiet`). A modifier is
 *  `--name=value` with one of its words; any other spelling of a modifier's
 *  name is an error naming that form. */
export function parseArgvFlags(
  argv: readonly string[],
  base: CompileFlags = DEFAULT_FLAGS
): { flags: CompileFlags; rest: string[] } {
  const flags: Record<string, unknown> = { ...base };
  const rest: string[] = [];
  for (const a of argv) {
    const eq = a.indexOf("=");
    const name = a.startsWith("--") ? a.slice(2, eq < 0 ? undefined : eq) : null;
    const spec = FLAG_SPECS.find((s) => s.name === name);
    if (spec === undefined) { rest.push(a); continue; }
    const v = eq < 0 ? undefined : flagValue(spec, a.slice(eq + 1));
    if (v === undefined) throw new Error(`${a}: write --${spec.name}=${flagWords(spec).join("|")}`);
    flags[spec.name] = v;
  }
  return { flags: flags as unknown as CompileFlags, rest };
}
