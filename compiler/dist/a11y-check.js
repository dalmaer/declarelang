// a11y-check — what the compiler can say about accessibility before anything
// runs (docs/system-design/accessibility.md §3.7).
//
// A role is a CONTRACT (runtime/src/a11y-roles.ts): the element that declares
// `accessibilityRole = slider`, together with the class chain above it, must set
// what the role reads and have the methods its actions call. That is checked by
// name and type for every class alike — the library's Slider and an author's
// Waveform by the same rule — and a gap is an error. A role is a word, fixed
// for the view's life, so a `{ }` role is an error too.
//
// The rest are warnings, about what a person using a screen reader would miss:
// a Control with no role, a role that needs a name with none, a drawn view that
// takes the focus and says nothing. Warnings stay out of the merged library
// source (the author cannot edit it — the library's own test holds it clean)
// and out of a program that leaves the layer out (`accessibility = false`).
import { descendsFrom } from "../../runtime/dist/schema.js";
import { Diag } from "../../runtime/dist/diagnostics.js";
import { ROLE_CONTRACTS, contractGaps, contractMessage } from "../../runtime/dist/a11y-roles.js";
/** Roles whose name never comes from the text inside them. */
const NAME_NOT_FROM_CONTENT = (role) => ROLE_CONTRACTS[role]?.nameFromContent !== true;
export function accessibilityDiagnostics(program, schemas, opts) {
    const errors = [];
    const warnings = [];
    const classByBody = new Map(program.classes.map((c) => [c.body, c]));
    const classByName = new Map(program.classes.map((c) => [c.name, c]));
    const inLibrary = (el) => (el.pos?.offset ?? 0) < opts.libraryEnd;
    /** The class bodies above a tag, nearest first (empty for a built-in tag). */
    const chainOf = (tag) => {
        const out = [];
        const seen = new Set();
        for (let t = tag; !seen.has(t);) {
            seen.add(t);
            const c = classByName.get(t);
            if (c === undefined)
                break;
            out.push(c.body);
            t = c.base;
        }
        return out;
    };
    const schemaOf = (tag) => schemas[tag];
    const isA = (tag, base) => {
        const s = schemaOf(tag);
        return s !== undefined && descendsFrom(s, base);
    };
    /** What an element's levels set: its own attributes, its States' (a state
     *  sets its parent's attributes while applied), and its declarations. */
    const sets = (levels, name) => levels.some((b) => b.attrs.some((a) => a.name === name) || b.decls.some((d) => d.name === name)
        || b.children.some((s) => isA(s.tag, "State") && s.attrs.some((a) => a.name === name)));
    const has = (levels, method) => levels.some((b) => b.methods.some((m) => m.name === method));
    /** The literal role the nearest level declares, or null (none written). */
    const roleOf = (levels) => {
        for (const b of levels) {
            const a = b.attrs.find((x) => x.name === "accessibilityRole");
            if (a !== undefined)
                return a.value.kind === "ident" ? a.value.name : null;
        }
        return null;
    };
    /** Does any element in these subtrees hold text a name can come from? A
     *  child's own class body counts (a Label that IS a Text, a Chip that holds one). */
    const holdsText = (els, seen = new Set()) => els.some((e) => {
        if (seen.has(e))
            return false;
        seen.add(e);
        return isA(e.tag, "Text") || isA(e.tag, "RichText") || holdsText(e.children, seen) || holdsText(chainOf(e.tag), seen);
    });
    /** Does any element in these subtrees show a named mark — a role-less view
     *  whose class gives it a label (CloseIcon is "Close")? */
    const holdsMark = (els, seen = new Set()) => els.some((e) => {
        if (seen.has(e))
            return false;
        seen.add(e);
        const chain = [e, ...chainOf(e.tag)];
        return (roleOf(chain) === null && sets(chain, "accessibilityLabel")) || holdsMark(e.children, seen);
    });
    /** Is the element named — does it set accessibilityLabel? A name read from a
     *  provided value alone (`accessibilityLabel = { provided("fieldLabel", "") }`,
     *  a Switch inside a Field) counts only where an element above provides it. */
    const PROVIDED_ONLY = /^\s*(?:this\.\$)?provided\(\s*"(\w+)"\s*,\s*""\s*\)\s*$/;
    const named = (levels, above) => {
        for (const b of levels) {
            const a = b.attrs.find((x) => x.name === "accessibilityLabel");
            if (a === undefined)
                continue;
            const m = a.value.kind === "code" ? PROVIDED_ONLY.exec(a.value.src) : null;
            if (m === null)
                return true;
            return above.some((p) => sets([p, ...chainOf(p.tag)], m[1]));
        }
        return false;
    };
    const walk = (el, above = []) => {
        const decl = classByBody.get(el);
        const owner = decl !== undefined ? decl.name : (el.name ?? el.tag);
        // the levels this element answers with: itself, then its class chain
        const levels = [el, ...chainOf(decl !== undefined ? decl.base : el.tag)];
        const own = el.attrs.find((a) => a.name === "accessibilityRole");
        if (own !== undefined && own.value.kind === "code")
            errors.push(Diag.accessibilityRoleComputed(own.value.pos));
        if (own !== undefined && own.value.kind === "ident") {
            const role = own.value.name;
            const gaps = contractGaps(role, (n) => sets(levels, n), (m) => has(levels, m));
            if (gaps.length > 0)
                errors.push(Diag.accessibilityContract(contractMessage(owner, role, gaps), own.value.pos));
        }
        if (opts.warnings && !inLibrary(el)) {
            const role = roleOf(levels);
            const tag = decl !== undefined ? decl.base : el.tag;
            // a role that needs a name — judged where the view is USED, since a class
            // may leave its name to each use site
            // (a field's placeholder names it, as it does to every screen reader)
            const placeholderNames = (role === "textField" || role === "searchBox" || role === "combobox") && sets(levels, "placeholder");
            // (a row whose class each record picks — classFor — is judged by those
            // classes, which the source names but the use site cannot know)
            const picked = el.attrs.some((a) => a.name === "classFor");
            if (decl === undefined && role !== null && ROLE_CONTRACTS[role]?.named === true && !named(levels, above) && !placeholderNames && !picked) {
                // its words, the tip it shows, or a mark that has a name (a close icon);
                // a label given as "" is no words, though a child holds it
                const emptyLabel = el.attrs.some((a) => a.name === "label" && a.value.kind === "string" && a.value.value === "");
                const fromContent = !NAME_NOT_FROM_CONTENT(role) && ((!emptyLabel && holdsText([el, ...levels.slice(1)].flatMap((b) => b.children)))
                    || sets(levels, "tooltipLabel") || holdsMark([el, ...levels.slice(1)].flatMap((b) => b.children)));
                if (!fromContent)
                    warnings.push(Diag.accessibilityNoName(owner, role, el.pos));
            }
            // a drawn view that takes the focus and says nothing — said once, where
            // the drawing or the focus is written (a use site inherits the class's)
            const focusable = (b) => b.attrs.some((a) => a.name === "focusable" && a.value.kind === "ident" && a.value.name === "true");
            if (role === null && !isA(tag, "Control") && has(levels, "draw") && levels.some(focusable)
                && (el.methods.some((m) => m.name === "draw") || focusable(el))) {
                warnings.push(Diag.accessibilityDrawnFocusable(owner, el.pos));
            }
        }
        for (const c of el.children)
            walk(c, [...above, el]);
    };
    for (const c of program.classes)
        walk(c.body);
    walk(program.root);
    return { errors, warnings };
}
//# sourceMappingURL=a11y-check.js.map