import { View } from "./view.js";
import { type InteractionView } from "./interaction.js";
/** A view's visibility or policy changed: list it as open, or not. A view that
 *  comes to be shown goes on top. */
export declare function noteOverlay(v: View): void;
/** The context an overlay belongs to: the nearest region above the view it
 *  paints in (or above itself, painting where it is declared), or null for
 *  the whole program. */
export declare function contextOf(v: View): View | null;
/** Is `node` inside `overlay`, along the paint tree? */
export declare function inside(node: InteractionView | null, overlay: View): boolean;
/** The view under a root point, walking on through an island into the program
 *  it hosts (an overlay may belong to a tenant). */
export declare function leafAcross(app: View, x: number, y: number): InteractionView | null;
/** A hosted program is leaving: its overlays are no longer open. */
export declare function withdrawOpen(root: View): void;
/** Anything open at all — a cheap gate for the router's hot path. */
export declare function anyOverlayOpen(): boolean;
/** A press at root point (x, y) of `app`: should the router swallow it? The
 *  overlays it passes are told (onOutsidePress) as their policies say. */
export declare function pressOutside(app: View, x: number, y: number): boolean;
/** A scroll (wheel or touch move) at root point (x, y) of `app`: should it be
 *  swallowed? */
export declare function scrollOutside(app: View, x: number, y: number): boolean;
