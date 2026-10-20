import { type RenderBackend, type Surface } from "./backend.js";
import { App, View } from "./view.js";
export declare class CanvasBackend implements RenderBackend {
    private readonly compositor;
    createSurface(): Surface;
    attachRoot(host: HTMLElement, root: Surface): void;
}
/** The pointer for a tenant composed into `island` — its root surface a child of the island's
 *  (boot.ts mountEmbeddedApp; the Mac's mac-boot.js `mountCompiled`). Such a tenant has no
 *  element and no input router of its own, so nothing hands it the pointer as
 *  `wireEnvironmentEmbedded` hands an element-mounted one: these listeners do, until the
 *  returned function stops them. Window, capture phase, added after its host's
 *  (wireEnvironment, or the host tenant's own), so each event finds the host's facts current
 *  and lands before the event is routed (a press-then-drag inside one frame must not read
 *  the press point). Its coordinates are its island box's frame (the hit walk's mapping,
 *  rootToLocal: scroll, scale, rotation, 3D) and follow the pointer out of the box, so a drag
 *  that leaves it continues (the DOM's pointer capture); the press is its own only when it
 *  began inside the box; hover is inside the box. Only the renderers that compose call it,
 *  so it lives with the canvas renderer, and a DOM build carries none of it. */
export declare function feedPointer(app: App, island: View): () => void;
