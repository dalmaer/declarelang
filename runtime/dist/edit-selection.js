// The read half of a native field's selection (TextInput.selectionStart /
// selectionEnd): the field itself is the truth — typing, clicks, arrows and the
// platform's own commands move it between Declare's updates — so the backend
// re-reads it whenever it may have moved and reports only a change. A report is
// never trusted over the element: a late event re-reads the current range, so
// it cannot undo a newer `select()`.
export function watchSelection(el, report) {
    let s = -1, e = -1;
    const read = () => {
        const a = el.selectionStart, b = el.selectionEnd;
        if (a === null || b === null)
            return; // an input type without selection
        if (a === s && b === e)
            return;
        s = a;
        e = b;
        report(a, b);
    };
    for (const ev of ["select", "selectionchange", "input", "keyup", "pointerup", "focus"]) {
        el.addEventListener(ev, read);
    }
}
//# sourceMappingURL=edit-selection.js.map