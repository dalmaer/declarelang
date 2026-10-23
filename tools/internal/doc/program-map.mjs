// The map of a program file: its parts, each with the lines it spans and the
// first sentence of the comment that introduces it — so a reader takes an
// exemplar's header, then reads only the parts the work needs, by range, rather
// than the whole file. `declare-help map FILE` prints it.
//
// It reads the formatter's canon (tools/format.mjs): a top-level part starts in
// column 0 (`class`, `App`, `script`, `schema`, `theme`, `include`), and an App
// member or a class's named part starts one indent in. Programs off the canon
// still map, coarsely — the parts the column-0 rule finds.

/** What a comment says a part is: its heading (`## A heading`, `── a heading ──`)
 *  where it has one — the file's own title excepted (`title`: skip a `# Title`)
 *  — else the first sentence of its prose, markers and emphasis stripped. */
function firstSentence(lines, title = false) {
  const bare = lines.map((l) => l.replace(/^\s*(\/\*+|\*\/|\*|\/\/)\s?/, "").replace(/\*\/\s*$/, "").trim());
  for (const l of bare) {
    const h = l.match(/^#{2,}\s*(.+)$/) ?? (!title ? l.match(/^#\s*(.+)$/) : null) ?? l.match(/^[─—]{2,}\s*(.+?)\s*[─—]*$/);
    if (h) return h[1].replace(/\*\*|`/g, "").trim();
  }
  const prose = bare.filter((l) => l !== "" && !/^#/.test(l) && !/^[─—=-]{3,}/.test(l)).join(" ").replace(/\*\*|`/g, "").trim();
  const m = prose.match(/^(.{12,}?[.:!?])(\s|$)/);
  const s = m ? m[1] : prose;
  return s.length > 110 ? s.slice(0, 107).trimEnd() + "…" : s;
}

/** The comment lines just above line `i` (blank lines between allowed), as written. */
function commentAbove(src, i) {
  let j = i - 1;
  while (j >= 0 && src[j].trim() === "") j--;
  const end = j;
  if (j < 0) return [];
  if (/\*\/\s*$/.test(src[j])) { while (j >= 0 && !/\/\*/.test(src[j])) j--; return src.slice(Math.max(0, j), end + 1); }
  while (j >= 0 && /^\s*\/\//.test(src[j])) j--;
  return src.slice(j + 1, end + 1);
}

const TOP = /^(class\s+(\w+)|App\s*\[|script\s*\{|schema\s+(\w+)|theme\s+(\w+)|include\s*\[)/;
// a member that opens a block one indent in: a named child or declaration with
// [ … ], or a method with { … }
const MEMBER = /^ {4}(?:(\w+)\s*:\s*([\w.]+)\??\s*(?:=\s*)?\[|(\w+)\s*\([^)]*\)\s*(?:->\s*[^{]+)?\{\s*$)/;

/** The map of `text`: [{ from, to, depth, label, about }], lines 1-based. */
export function programMap(text) {
  const src = text.split("\n");
  const out = [];
  // the header: a leading block comment
  if (/^\/\*/.test(src[0] ?? "")) {
    let e = 0;
    while (e < src.length && !/\*\/\s*$/.test(src[e])) e++;
    out.push({ from: 1, to: e + 1, depth: 0, label: "the header", about: firstSentence(src.slice(0, e + 1), true) });
  }
  const tops = [];
  for (let i = 0; i < src.length; i++) if (TOP.test(src[i])) tops.push(i);
  for (let k = 0; k < tops.length; k++) {
    const i = tops[k];
    // a part runs to the line before the next part's introducing comment
    let next = k + 1 < tops.length ? tops[k + 1] : src.length;
    if (k + 1 < tops.length) { const c = commentAbove(src, next); next -= c.length; while (next - 1 > i && src[next - 1].trim() === "") next--; }
    let to = next;
    while (to - 1 > i && src[to - 1].trim() === "") to--;
    const m = src[i].match(TOP);
    const label = m[2] ? `class ${m[2]}` : m[3] ? `schema ${m[3]}` : m[4] ? `theme ${m[4]}` : src[i].startsWith("App") ? "App" : src[i].startsWith("script") ? "script" : "include";
    const about = label === "include" ? src[i].replace(/^include\s*\[\s*|\s*\]\s*$/g, "").replace(/"/g, "") : firstSentence(commentAbove(src, i));
    out.push({ from: i + 1, to, depth: 0, label, about });
    if (label !== "App" && !label.startsWith("class")) continue;
    // its members of any size: a part a reader would look for by name
    const starts = [];
    for (let j = i + 1; j < to; j++) if (MEMBER.test(src[j])) starts.push(j);
    for (let s = 0; s < starts.length; s++) {
      const j = starts[s];
      let end = s + 1 < starts.length ? starts[s + 1] : to;
      if (s + 1 < starts.length) end -= commentAbove(src, end).length;
      while (end - 1 > j && src[end - 1].trim() === "") end--;
      if (end - j < 6) continue;   // a few lines: the part's own listing shows it
      const mm = src[j].match(MEMBER);
      const name = mm[1] ? `${mm[1]}: ${mm[2]}` : `${mm[3]}()`;
      out.push({ from: j + 1, to: end, depth: 1, label: name, about: firstSentence(commentAbove(src, j)) });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.depth - b.depth);
}

/** The map as text, one part a line. */
export function formatMap(file, text) {
  const n = text.split("\n").length;
  const rows = programMap(text);
  const w = String(n).length;
  const lines = rows.map((r) => {
    const span = r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
    return `  ${span.padStart(2 * w + 1)}  ${"  ".repeat(r.depth)}${r.label}${r.about ? ` — ${r.about}` : ""}`;
  });
  return `${file} — ${n} lines. Read a part by its lines (Read with offset and limit, or sed -n 'A,Bp').\n${lines.join("\n")}`;
}
