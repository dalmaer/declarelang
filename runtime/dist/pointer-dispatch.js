// pointer-dispatch — is a pointer event being delivered right now?
//
// Focus moved by a program is shown, as Tab's is (focus.ts): the control is
// scrolled into view, clear of pinned chrome. Focus taken by a press is not —
// the person is pointing at it already. The difference is whether a pointer
// event is being delivered when the focus moves; the view's input sink says so.
let depth = 0;
/** Deliver one pointer event, marked as such. */
export function inPointer(fn) {
    depth++;
    try {
        return fn();
    }
    finally {
        depth--;
    }
}
export function inPointerDispatch() { return depth > 0; }
//# sourceMappingURL=pointer-dispatch.js.map