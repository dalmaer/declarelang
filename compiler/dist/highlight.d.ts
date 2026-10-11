/** One rendered piece of a source file: a Markdown block lifted from a
 *  `/* … *\/` comment, or a run of syntax-highlighted code as `<pre>` HTML. */
export type Segment = {
    kind: "prose";
    md: string;
    nested?: boolean;
} | {
    kind: "code";
    html: string;
    nested?: boolean;
};
/** Honest line counts for a .declare source — computed, never claimed (the
 *  homepage's "lines of Declare" figures). `total` physical lines; `code`
 *  lines carrying at least one non-comment token (a trailing `//` after code
 *  counts the line as code); `comment` lines whose only content is comment;
 *  `blank` whitespace-only lines. The same lexical walk as highlight() below —
 *  strings, `"""` blocks, and `{ }` bodies can hide `/*` and `//` from a
 *  regex, never from this scan. One granularity note: a `{ }` TypeScript body
 *  is a single expression token to this layer, so comment lines INSIDE one
 *  count as code. */
export interface LineMetrics {
    total: number;
    code: number;
    comment: number;
    blank: number;
}
export declare function lineMetrics(src: string): LineMetrics;
/** The same count for a TypeScript file — a `script [ "file.ts" ]` the program
 *  loads. Here every comment is a comment (a .declare `{ }` body is one token;
 *  a script file is all TypeScript), and strings and template literals are
 *  code. A regular-expression literal is read as code character by character. */
export declare function scriptLineMetrics(src: string): LineMetrics;
/** The module paths a TypeScript source imports — `import … from "x"`,
 *  `import "x"`, `export … from "x"`, `import("x")`, `require("x")` — in order,
 *  never from inside a comment, string or template. */
export declare function scriptImports(src: string): string[];
/** What a file's top level says about the program it belongs to: the paths its
 *  `include [ … ]` and `script [ … ]` directives name, the modules its inline
 *  `script { … }` blocks import, the classes and schemas it declares, each in
 *  order, and whether it declares the `App` (the file a program is run from).
 *  The same lexical walk as lineMetrics — comments, strings, `"""` blocks and
 *  `{ }` bodies hide nothing from it. */
export interface TopLevel {
    includes: string[];
    scripts: string[];
    imports: string[];
    defs: string[];
    hasApp: boolean;
}
export declare function topLevel(src: string): TopLevel;
/** What a reader of a file is told about the program it belongs to.
 *
 *  `metrics` — the file's line metrics, and when the file declares the App the
 *  whole program's: the file plus every file it includes, transitively, every
 *  script file any of them loads (`script [ "file.ts" ]`), and every module of
 *  the program's own that script imports by a relative path, each counted
 *  once.
 *
 *  `defs` — where each class and schema the program declares lives: name →
 *  the declaring file's path from this file's folder ("" for this file). A
 *  file with no App answers for itself only.
 *
 *  What is not the program's own is left out of both: a path `isLibrary`
 *  names, an include the program's folder cannot answer (a bare name the
 *  library root resolves, include-search.ts), and a package imported by name
 *  (`"dayjs"`). Paths resolve as URLs against the naming file's (`new URL(path,
 *  url)`), so one walk serves every host: the dev server reads `file:` URLs
 *  from disk, a static page and the Mac host read what they can fetch. */
export interface ProgramMetrics extends LineMetrics {
    app?: LineMetrics & {
        files: number;
    };
}
export interface ProgramIndex {
    metrics: ProgramMetrics;
    defs: Record<string, string>;
}
export declare function programMetrics(src: string, url: string, read: (url: string) => string | null | Promise<string | null>, isLibrary: (url: string) => boolean): Promise<ProgramMetrics>;
export declare function programIndex(src: string, url: string, read: (url: string) => string | null | Promise<string | null>, isLibrary: (url: string) => boolean): Promise<ProgramIndex>;
/** Preprocess a .declare source into renderable segments. Pure and
 *  dependency-free, so it runs at build time (the `--highlight` flag), on the
 *  dev server (`GET /highlight/…`), or in the browser alike. */
export declare function highlight(src: string): Segment[];
