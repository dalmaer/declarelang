import type { Node } from "./node.js";
/** path → vertical offset, or [x, y] when the view has scrolled across too.
 *  Views at their origin are left out: they are at the top. */
export type ScrollPlaces = Record<string, number | [number, number]>;
/** An entry's place: `s` the root's scroll (the host's own), `v` the panes. */
export interface Place {
    s?: number;
    v?: ScrollPlaces;
}
export declare function scrollPlaces(app: Node): ScrollPlaces;
/** Land `place` once the traversal that arrived has settled. A pane the place
 *  leaves out goes to the top — a reused pane may still hold the offset of the
 *  place just left. `rootTo` scrolls the host's root and answers where it got
 *  to (null on a host whose root does not scroll). */
export declare function holdScrollPlaces(app: Node, place: Place, rootTo: ((y: number) => number) | null): void;
/** Drop a held landing: the user scrolled, or the app moved on. */
export declare function dropScrollPlaces(app: Node): void;
