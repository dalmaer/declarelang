# Requests & modifiers

What you can ask for at a Declare **program URL** (`…/<name>.declare`), and how it
compiles. This is the normative surface; `compiler/src/reqtypes.ts` (the requests) and
`compiler/src/flags.ts` (the modifiers) are the code that enforces it, and every host —
the dev server (`server/index.mjs`), the static-host service worker
(`service-worker.js`), and the `declarec` CLI — derives from those two files so the
surface **cannot drift** between them.

Two orthogonal axes:

- **Request** — *what artifact you get back*. Exactly one per URL.
- **Modifier** — *how the app compiles*. Composes onto the app-producing requests
  (`run`, `build`) only.

The program URL is the app's canonical address (OpenLaszlo's `…/app.lzx?lzt=…` model).
A **directory carries no behavior** of its own — `…/<name>/` is a 404 unless the
directory-program rule below makes it a program URL; the `.declare` file is the
address.

## Requests

One key selects the artifact. `?viewer=` is the one key that takes a value, because the
viewer is a single app with tabs; everything else is a bare presence key, and the
absence of all of them is `run`. Every name is lowercase — there is no camelCase in the
URL surface.

| Request | URL | What you get back |
|---|---|---|
| **run** | *(none)* — the default | the running app, in a generated wrapper. Boot either loads a committed build or resolves the source (hosting.md). |
| **build** | `?build` | the standalone, minified, self-contained deployable (the `declarec` artifact). A *directory* of files — see the transport note below. |
| **reader** | `?viewer=reader` | the **viewer** app, reader tab: highlighted source with `/* */` prose rendered as Markdown. |
| **source** | `?viewer=source` | the **viewer** app, **Source** tab: the verbatim source shown *in the viewer*. (Distinct from `?file`.) |
| **sizes-tab** | `?viewer=sizes` | the **viewer** app, **Sizes** tab: the `sizes` report presented — the total and its parts, every file with how it came in, every runtime module with what brought it aboard. Needs the dev server for its data. |
| **edit** | `?viewer=edit` | the **viewer** app, live-edit tab: source in an editor, the running program below, compile errors between. |
| **file** | `?file` | the raw source **bytes** (`text/plain`) — what an `include`, the compiler, or `curl` reads. |
| **segments** | `?segments` | the highlighter's output as **JSON** (`highlight()` segments — the reader's data alone). |
| **sizes** | `?sizes` | what the **production build** is made of and what each part weighs, as **JSON** (`declarec --sizes --json`). Takes the build's modifiers (`?sizes&render=canvas`). Dev server only, as `?build` is: a static host has no compiler to build with. |
| **extract** | `?extract` | the **static-extraction** document alone (`text/html`) — the program's content as semantic HTML at its t=0 snapshot, for crawlers and AI readers (capabilities.md §5). |

`source` vs `file` is the split that removes the old collision: `?viewer=source` is the
viewer *showing* you the source; `?file` is the actual file. Before this scheme,
`?viewer=source` returned raw bytes and the viewer's Source tab was unreachable by URL.

**The directory-program rule.** A URL naming a directory is a program URL for that
directory's *name-matched* program: `…/name/` (or `…/name` — hosts 301 to the slash
form, the same canonicalization a static host applies to a real directory) means
`…/name/name.declare` when that file exists, and every request type and modifier above
composes exactly as on the explicit URL — `apps/calendar/?viewer`,
`apps/docs/?render=canvas`. The rule is fully general and unregistered
(serve-core.js `directoryProgram`, applied identically by the dev server and the
service worker): existence gates it, so it never shadows a real asset, and a dotted
final segment is file-like and never a program directory. On a cold static host (no
service worker yet) a directory URL degrades to the host's 404 exactly as an explicit
`.declare` URL degrades to raw bytes — the rule exists wherever the platform is
present, and nowhere else.

The same rule, applied to the tree rather than to one URL, says which directories are
programs: **every directory under `apps/`, at any depth, that holds its name-matched
`.declare`** (tools/internal/program-dirs.mjs `programDirs`, the one list the cold
stubs, the `BUILD_ID` stamp and the program-sweeping tests all read). Nothing stops at
a program: a program may hold programs of its own (a desktop whose tenants live in its
folder, `apps/desktop/notes/notes.declare`), each its own address. A directory without
its name-matched file is only a folder — `apps/games/` groups `apps/games/tempest/` and
the rest and is itself a 404 on every host. The flip side: a file named after its
directory *makes* that directory a program, so a file not meant to run on its own must
not take its directory's name.

## Modifiers

Three, and they compose onto `run`, `build` and `sizes` (nothing else):

| Modifier | URL | Meaning |
|---|---|---|
| **render** | `?render=canvas` | which renderer: managed DOM (default) or one `<canvas>`. |
| **crawler** | `?crawler=true` | embed the crawler DOM (`#declare-static`) in the run/build wrapper — "the running app **with** the crawler content." Removed before first paint (never CSS-hidden; see serve-core.js). Distinct from the `extract` *request*, which returns that document alone. |
| **clear** | `?clear` | on an **entry page** only (`/` or any `…/index.html`): drop every compiled-program cache in this browser — and, on the dev server, the server's too — then run. Ignored on a program URL. |

### Why `clear` exists, and why it is only on an entry page

Every cache in the system is keyed to a platform identity and drops itself when that
identity moves: the browser's `declare-compiled-<BUILD_ID>` buckets on a platform
change, the dev server's compile cache on its toolchain fingerprint. And every read
re-checks the stored dependency closure, so an ordinary stale entry is found and
recompiled with nobody asking.

What none of that covers is a closure that is **incomplete**. A compile that read a
file the tracker did not record stays "fresh" forever against an edit to that file,
the platform identity has not moved, so nothing drops it. Before `?clear` the recovery
on a deployed host was DevTools → Application → Clear storage — not something an
author should need to know, and not something they can be told at the moment they
need it.

**It is global, so it lives on a global address.** Every program URL names one
program; a flag on `calendar.declare` could not honestly mean "and every other program
too." An entry page — `/`, or any `…/index.html` — is the one address in the system
that is about the HOST rather than about a program, which makes it the only honest
place for a host-wide verb. On a program URL the flag is ignored.

(A program-scoped variant was built and removed: clearing one program is not worth a
URL surface.)

It deliberately does **not** touch a committed build (`bundles/cache/`). That is a
deployment artifact, not a cache: nothing about it goes stale behind your back, and
dropping it would only mean fetching the compiler to rebuild what was already right.

## Removed knobs

Three former flags are gone from the URL/CLI surface, because they were never real
per-request choices:

- **`slim`**, **`stripPos`** — folded into `build`. A production build always slims the
  registry and strips source positions; there is no coherent "prod but keep dead
  components / keep positions" a deployer asks for. The one caller who wants an
  un-stripped build to debug the *emitter* uses `declarec --debug` (not a public URL
  param), not a flag.
- **`typecheck`** — always on: a phase of every compile, with no flag or option.

The compiler's *internal* options still carry `stripPos`/`typecheck` (the `build` act
sets them); only the externally-named FLAG surface shrinks — to `render` and `seo`.

## Two precompiled tiers, kept distinct

"Precompiled" means two different things; they are not merged:

- **prewarm** — an *automatic optimization of `run`*. The commit hook writes a
  validated, serialized program to `bundles/cache/`; on `run`, the browser finds it,
  closure-checks it against the *live* source, and renders compiler-free if fresh, else
  falls through to cache, else compiles. Transparent — the caller never asks for it. It
  boots on the shared runtime (small per-app payload). This is the "request run and it
  finds the committed asset" mechanism.
- **build** — an *explicit eject*. A standalone minified bundle (runtime + program
  fused, tree-shaken) for shipping the app *away* from the distro. Requested as a build;
  served as plain static files, independent of the SW, the compiler, and the closure.

They optimize different targets: prewarm makes cold-loading a curated app in the hosted
distro compiler-free; build is the minimal single-app shippable.

## Uniformity — every surface, every artifact

The compiler core produces every non-interactive artifact, and each surface invokes it.
The **only** genuine exception is the interactive viewer on `declarec` (no browser at
build time).

| Request | declarec | dev server | static host (service worker) |
|---|---|---|---|
| run | — *(build-time, no live serve)* | ✓ | ✓ (load a build, else resolve the source) |
| build | ✓ *(its job)* | ✓ *(builds on demand, serves `/build/<name>/`)* | gap → build in-browser |
| view=reader | ✗ *(interactive — no build-time browser)* | ✓ | ✓ |
| view=source | ✗ | ✓ | ✓ |
| view=edit | ✗ | ✓ | ✓ |
| file | ✓ *(trivial — it's the input; a package answers it for every source its `ship [ files ]` lists)* | ✓ | ✓ |
| segments | ✓ `--highlight` *(and a package ships them beside every listed source)* | ✓ | gap → highlight in-browser |
| extract | ✓ `--extract` | ✓ | ✓ (`boot-extract.js`, in-browser) |

Blanks marked "gap" are implementation debt, not rules: the SW carries the full
compiler, so it *can* build a bundle and emit segments — those are follow-ups.

A built **package** is a fourth answerer for `file` and `segments`, and only for the
sources its program names in `ship [ files = […] ]`: the build copies each and computes
its segments, and the package's URL map serves `…/x.declare?segments` from the segments
file and `…/x.declare?file` (any other query) from the bytes. A source the program did
not list is not in the package, and the request 404s — by design (app-packaging.md §8).

## Transport notes

- **`build` is a directory.** The standalone artifact is `index.html` +
  `app.<hash>.js` + copied data assets, with relative asset links. So it is served at a
  **directory** address, not inlined at the `.declare?build` URL: the dev server builds
  on demand and serves it under `/build/<name>/` (a `?build` request redirects there);
  `declarec` writes it to an output dir; a static host serves the committed directory as
  plain files. This is the one place a real multi-file transport constraint outranks
  query-uniformity — honest about `build` being a discrete deployable, not a view.
- **`extract` on `declarec`** emits the extraction document as an *additional* output
  file alongside the build — a build may legitimately produce more than one file.
- **`?crawler=true` on a static host** is a *build-time* affair: crawlers don't install service
  workers, so the block is baked by `declarec --crawler=true`, the homepage bake
  (`tools/internal/bake-homepage-crawler.mjs`), or the prewarm seo tier — not embedded at request
  time by the SW.
- **The dev server names itself.** `GET /__identity` answers `{ pid, root, platform,
  started, toolchain }` — the same record the startup banner prints, that every page it
  emits carries as `window.__declareServer`, and that every `/compile` answer stamps
  (`build: { at, main, files, server }`, surfaced as `__declare.build` and one console
  line per load). A dev server refuses to start on a port where another already answers,
  and `tools/reload-dev.mjs` names a server it finds but did not start. None of this
  exists on a static host — there is no process to be. The reason is the one failure a
  cache cannot explain: a page faithfully rendering a fresh compile of a *different
  checkout* (two servers can share a port number — one bound to `127.0.0.1`, one to
  `0.0.0.0` — each serving its own tree) reads exactly like a stale build unless
  something says whose build it is.

## The navigate/fetch discrimination

`run` and the `view=` requests are **navigations** (a person browsing); `file` and a
plain subresource fetch (an `include`, the compiler, `curl`) want the **bytes**. Both
hosts read this the same way (the SW's navigate-vs-subresource signal; the dev server's
`Sec-Fetch-Mode`), so one URL serves a person and a program each the representation they
mean.

---

See also: `compiler/src/reqtypes.ts`, `compiler/src/flags.ts`, `docs/system-design/hosting.md`
(the narrative), `docs/system-design/capabilities.md` §5 (static extraction).
