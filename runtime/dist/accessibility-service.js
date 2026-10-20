// The Accessibility service — the one thing a program says to assistive
// technology with no view to say it from (docs/system-design/accessibility.md
// §3.6): "Message sent", "3 results". A body service, like Focus and Keys:
// `Accessibility.announce("Saved")` in a handler.
//
// The platform says it (semantics-dom.ts on the web: a polite or an assertive
// live region; the Mac host: NSAccessibility's announcement). With no platform
// to say it — headless, a test, a program built without the layer — it is
// remembered and goes no further.
let speak = null;
/** The platform's voice, given by the host that has one. */
export function provideAnnouncer(fn) { speak = fn; }
const said = [];
export const Accessibility = {
    /** Say `text` to whoever is listening, without moving the focus: `polite` waits
     *  for a pause in what is being read, `assertive` interrupts. */
    announce(text, politeness = "polite") {
        const t = String(text);
        if (t === "")
            return;
        said.push({ text: t, politeness });
        if (said.length > 20)
            said.shift();
        speak?.(t, politeness);
    },
    /** What was said lately, oldest first — for a test, and for the semantic
     *  tree's readers to see what a program announced. */
    announced() { return said; },
};
//# sourceMappingURL=accessibility-service.js.map