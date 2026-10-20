// fonts — what a family name means under render=gpu.
//
// The engine draws only fonts whose bytes it has: the three families bundled with the
// renderer, and (later) the faces a program declares. A worker cannot read the device's
// installed fonts, so every name a program writes resolves through THE FALLBACK TABLE:
//
//   1. the program's own list is honored in order — the first name the renderer has wins;
//   2. generic families and well-known device fonts map by category to a bundled family
//      (system-ui and the sans faces to Inter, the serifs to Source Serif 4, the monospaced
//      faces to JetBrains Mono);
//   3. a name the table does not know falls through to the next in the list, and the list
//      always ends in the default family;
//   4. each unknown name is reported once, so a substitution is never silent.

type Category = "sans" | "serif" | "mono";

/** The bundled families: files relative to gpu/fonts/, registered at boot. */
export const BUNDLED: Record<Category, string[]> = {
  sans: ["InterVariable.woff2", "InterVariable-Italic.woff2"],
  serif: ["SourceSerif4Variable.woff2", "SourceSerif4Variable-Italic.woff2"],
  mono: ["JetBrainsMonoVariable.ttf", "JetBrainsMonoVariable-Italic.ttf"],
};

/** Generic and device family names → the category that stands in for them. */
const TABLE: Record<string, Category> = {
  // generic
  "system-ui": "sans", "sans-serif": "sans", "ui-sans-serif": "sans", "ui-rounded": "sans",
  "-apple-system": "sans", "blinkmacsystemfont": "sans", "cursive": "sans", "fantasy": "sans",
  "serif": "serif", "ui-serif": "serif", "math": "serif",
  "monospace": "mono", "ui-monospace": "mono",
  // device sans
  "sf pro": "sans", "sf pro text": "sans", "sf pro display": "sans", ".sf ns": "sans", "sf ui text": "sans",
  "helvetica": "sans", "helvetica neue": "sans", "arial": "sans", "avenir": "sans", "avenir next": "sans",
  "futura": "sans", "gill sans": "sans", "segoe ui": "sans", "roboto": "sans", "verdana": "sans",
  "tahoma": "sans", "trebuchet ms": "sans", "lucida grande": "sans", "open sans": "sans", "noto sans": "sans",
  "ubuntu": "sans", "cantarell": "sans", "inter": "sans", "geneva": "sans", "arial narrow": "sans",
  "avenir next condensed": "sans", "optima": "sans", "sf compact": "sans", "lucida sans": "sans",
  // device serif
  "georgia": "serif", "times": "serif", "times new roman": "serif", "palatino": "serif", "book antiqua": "serif",
  "baskerville": "serif", "garamond": "serif", "charter": "serif", "iowan old style": "serif",
  "new york": "serif", "cambria": "serif", "noto serif": "serif", "hoefler text": "serif", "didot": "serif",
  // device monospace
  "sf mono": "mono", "sfmono-regular": "mono", "lucida console": "mono", "menlo": "mono", "monaco": "mono", "courier": "mono", "courier new": "mono",
  "consolas": "mono", "andale mono": "mono", "dejavu sans mono": "mono", "source code pro": "mono",
  "fira code": "mono", "jetbrains mono": "mono", "roboto mono": "mono",
};

/** Category → the family name the engine registered for it (filled at boot). */
const registered: Partial<Record<Category, string>> = {};
/** Declared faces: a program's family name → the engine's (font.ts generations). */
const declared = new Map<string, string>();
const warned = new Set<string>();
const cache = new Map<string, string>();

export function setRegistered(cat: Category, family: string): void { registered[cat] = family; cache.clear(); }
export function setDeclared(name: string, family: string): void { declared.set(name.toLowerCase(), family); cache.clear(); }

const quote = (f: string): string => /^[\w-]+$/.test(f) ? f : `"${f.replace(/"/g, "")}"`;

/** A CSS family list as written → the list the engine shapes with. */
export function resolveFamilies(list: string): string {
  const hit = cache.get(list);
  if (hit !== undefined) return hit;
  const out: string[] = [];
  for (const raw of list.split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "");
    if (name === "") continue;
    const key = name.toLowerCase();
    const d = declared.get(key);
    if (d !== undefined) { out.push(d); continue; }
    const cat = TABLE[key];
    if (cat !== undefined) { const f = registered[cat]; if (f !== undefined) out.push(f); continue; }
    if (!warned.has(key)) { warned.add(key); console.warn(`[gpu] font "${name}" is not available to the GPU renderer; using the next family in its list`); }
  }
  if (registered.sans !== undefined) out.push(registered.sans);
  const resolved = [...new Set(out)].map(quote).join(", ");
  cache.set(list, resolved);
  return resolved;
}
