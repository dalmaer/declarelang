# Modifiers (flags)

There are exactly **three** compile-time modifiers, defined once in the registry
(`compiler/src/flags.ts` — `FLAG_SPECS`) and read the same way by every surface: a CLI switch,
a server URL query, and a browser URL query all mean the same thing and cannot drift. They
compose onto a run or a build; `kernel` matters only to a build.

<!-- generated:flags-table -->
| modifier | what it does | CLI (`declarec`) | URL | default |
|---|---|---|---|---|
| **render** | render through managed DOM, a single <canvas>, or the native Mac host; unset, the program's flags decide | `--render dom` / `--canvas` | `?render=dom` | `dom` |
| **crawler** | embed the crawled document in the host page, for crawlers; unset, the program's flags decide | `--crawler` | `?crawler` | `false` |
| **kernel** | the reactive kernel a build carries: the C kernel as WebAssembly, or the JavaScript one (a smaller download); unset, the program's flags decide | `--kernel wasm` | `?kernel=wasm` | `wasm` |
<!-- /generated:flags-table -->

Every name is lowercase, and the same name works everywhere: `?render=canvas` on the server,
`--canvas` on the CLI, and `?render=canvas` in the browser are one modifier. Booleans accept
`?crawler`, `?crawler=1`, `?crawler=true` (on) and `?crawler=0`/`false` (off).

## A program's own flags

A program can set its own defaults for the three, in a top-level
[`defaultFlags [ … ]`](declare-docs:language:defaultFlags) block:

```
defaultFlags [ render = canvas ]
```

A flag the request or the command names wins; one it leaves out, the program's block
decides; one neither names takes the default in the table. So the games, which declare
`render = canvas`, open on the canvas, and `?render=dom` or `declarec --render dom` still runs
them on the DOM. The block takes `render = dom | canvas` (not `mac`, which is a host asking
for the compiled program), `kernel = wasm | js` and `crawler = true | false`.

Where each is read:

- `render`: the page boot, the dev server's `/build` and `declarec`. A program running as an
  `AppIsland` takes the outer program's renderer, and the Mac host renders natively.
- `kernel`: production builds (`declarec`, `/build`).
- `crawler`: production builds, and the dev server's run page. The static site's pages never
  embed a crawl.

## Not flags (though they once looked like it)

- **typecheck** — a phase of every compile, always on, with no opt-out.
- **slim / stripPos** — these are simply what a build *is*: always slimmed, always
  position-stripped. `declarec --debug` keeps both for debugging a build.
- **build** — a *request type*, not a modifier: `?build` (see [dev-server](declare-docs:operational:dev-server)).

Because the surfaces derive from `FLAG_SPECS`, adding a modifier is one registry edit and every
surface picks it up — this page is generated from that same registry, so it never drifts from
what the compiler accepts.
