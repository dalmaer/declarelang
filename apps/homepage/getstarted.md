# Try it now

Just as SQL is a domain-specific language for querying data, Declare is purpose-built for creating modern UIs. The quickest way to see what it does is to have it build you something.

## The easy way

Open Claude Code — or another coding agent — in an empty folder, and tell it what you want, with the address of Declare. Either of these will do, or write your own:

> Write me a kanban board using Declare, here: https://github.com/davidtemkin/declarelang

> Write me a budget app using Declare, here: https://github.com/davidtemkin/declarelang

There is nothing to install first. The agent downloads Declare, reads its guide, writes the app and checks its own work in a browser; along the way it asks to run a few commands — say yes. In 15–20 minutes it hands you a working app and the address to open it at.

## Or do it yourself

<!-- generated:setup-commands -->
```bash
git clone https://github.com/davidtemkin/declarelang.git && cd declarelang
```
Get the repository.

```bash
npm install
```
Install the toolchain's dependencies (TypeScript, esbuild, and the Chrome driver the checking tools run on). The clone ships prebuilt — no build step before first run. pnpm works too — the repo pre-approves esbuild's install script; if you instead add declarelang to another project as a git dependency, approve its build (`pnpm approve-builds`, or `"pnpm": { "onlyBuiltDependencies": ["declarelang"] }`) so its prepare step runs.

```bash
npm start
```
Start the dev server. It prints its address — http://127.0.0.1:8200/ unless that port is taken, in which case it says so and names the next (`PORT=8201 npm start`). Browse to any .declare file's URL under it and the server compiles and returns the running app.

Write a program to my-apps/hello.declare and browse to it under the server's address — http://127.0.0.1:8200/my-apps/hello.declare on the default port. The program URL is the app's address.
<!-- /generated:setup-commands -->

## The whole model in one program

<!-- generated:flagship-example -->
```declare
App [ width = 400, height = 140, fill = darkslategray, textColor = whitesmoke,
    count: number = 0,                               // reactive state
    col: View [ x = center, y = center,
        layout: SimpleLayout [ axis = y, spacing = 14, align = center ],
        Button [ label = "Add one", primary = true, onClick() { app.count = app.count + 1 } ],
        Text [ text = { `Clicked ${app.count} times` } ]
        ]
    ]
```
<!-- /generated:flagship-example -->

Two delimiters carry the whole model: **`[ … ]`** is the view tree — views, attributes, children; **`{ … }`** is TypeScript — a value, a handler body. The `{ }` lines are *constraints*, standing relationships the runtime keeps true: click the view and the text updates, resize and it re-centers — you wrote no update logic for either. (The hand-built button above shows the composition model; a themed `Button` also ships in the small standard library.)

## Where everything is

- [**docs/declare.md**](https://github.com/davidtemkin/declarelang/blob/main/docs/declare.md) — the language, in one file, for you and your LLM.
- [**The guide**](https://github.com/davidtemkin/declarelang/blob/main/docs/guide/01-what-declare-is.md) — what an idiomatic Declare app looks like, starting from an app just like the one above.
- [**GitHub**](https://github.com/davidtemkin/declarelang) — the full source. The homepage you are reading is itself a Declare app, and every app is editable in the browser.
