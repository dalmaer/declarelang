import { type CompileFlags } from "../../runtime/dist/flags.js";
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
export declare function parseFlags(params: FlagParams, base?: CompileFlags): CompileFlags;
/** `declarec`'s modifiers from argv (`--render=canvas --crawler=true`), plus
 *  the leftover args (the input path, and the switches the CLI owns: `--out`,
 *  `--debug`, `--extract`, `--highlight`, `--quiet`). A modifier is
 *  `--name=value` with one of its words; any other spelling of a modifier's
 *  name is an error naming that form. */
export declare function parseArgvFlags(argv: readonly string[], base?: CompileFlags): {
    flags: CompileFlags;
    rest: string[];
};
