// size-probe — did a size's { } read its parent's content size on this run?
//
// A size that reads the parent's size in only some of its branches
// (`height = { compact ? this.contentHeight : parent.height }`) takes its size
// from the parent only while that branch is the one taken, and the parent's
// content size skips it only then (bind.ts). A read of the parent's own size
// slot is a cell the kernel records; a read of its CONTENT size is the content
// walk itself, which says so here.
let probe = null;
/** Run `fn` watching for a read of `view`'s content size on `size`. */
export function watchingContentRead(view, size, fn) {
    const prev = probe;
    const mine = { view, size, hit: false };
    probe = mine;
    try {
        return { value: fn(), hit: mine.hit };
    }
    finally {
        probe = prev;
    }
}
/** The content walk (view.ts extentOf) reports itself. */
export function noteContentRead(view, size) {
    if (probe !== null && probe.view === view && probe.size === size)
        probe.hit = true;
}
//# sourceMappingURL=size-probe.js.map