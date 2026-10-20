// remote-host — the MacHost the runtime calls under render=gpu, in the runtime's worker.
//
// The host itself (the engine's, host.ts) runs in the compositor worker, which owns the
// canvas, so a scroll moves there while the runtime is busy. This side answers what the
// runtime must have at once and sends the rest across, a flush at a time:
//
// - Measuring: an engine of this worker's own, with the same fonts and no GPU, so the widths
//   the runtime lays out with are the widths the compositor draws with.
// - Drawings: drawing.ts records a view's draw() into a stand-in engine here (it needs the
//   program's images and its 2D context for what the GPU cannot draw); the engine calls it
//   makes are made in the compositor's engine, in order, with the flush's commit.
// - 3D views' projections: the runtime's own homography (projective.ts), for the views the
//   compositor names.

import type { Engine } from "../dist/engine.js";
import { surfaceById } from "../../runtime/dist/mac-backend.js";
import { rasterPad } from "../../runtime/dist/draw.js";
import { homography, type Parts3D } from "../../runtime/dist/projective.js";
import { encodePicture, makeOpLayers } from "./drawing.js";
import { parseFont } from "./host.js";
import { imageSizes } from "./env.js";

/** The engine methods a drawing's recording answers from this worker's engine (it needs their
 *  results); every other call is recorded for the compositor's. */
const ANSWERED = new Set(["measure", "width"]);

export class RemoteHost {
  /** Engine calls recorded since the last flush, and what their arguments transfer. */
  private calls: [string, unknown[]][] = [];
  private transfer: Transferable[] = [];
  /** The stand-in engine drawing.ts records into. */
  private readonly recorder: Engine;
  /** The 3D views the compositor named. */
  private three: number[] = [];
  /** The earliest input not yet answered by a frame (its page timestamp). */
  private input: number | null = null;

  constructor(private engine: Engine, private port: MessagePort) {
    const calls = this.calls, transfer = this.transfer;
    this.recorder = new Proxy({} as Engine, {
      get: (_t, name: string) => {
        if (ANSWERED.has(name)) return (...a: unknown[]) => (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...a);
        return (...a: unknown[]) => {
          calls.push([name, a]);
          for (const x of a) if (x instanceof Uint8Array && x.byteLength > 65536) transfer.push(x.buffer);
        };
      },
    });
  }

  // ── the MacHost interface ───────────────────────────────────────────────────

  commit = (json: string): void => this.send(json, new Float64Array(0), 0);
  commitGeom = (json: string, geoms: Float64Array, n: number): void => this.send(json, geoms.slice(0, n * 6), n);
  measure = (text: string, font: string, ls: number): number[] => {
    const f = parseFont(font);
    const r = this.engine.measure(f.families, f.size, f.weight, f.italic, ls, text);
    return [r[0], r[1], r[2], this.engine.ink(f.families, f.size, f.weight, f.italic, ls, text)[0]];
  };
  imageSize = (handle: number): number[] => { const z = imageSizes.get(handle); return z === undefined ? [0, 0] : [z.w, z.h]; };
  /** A view's drawing changed: recorded as the node's picture (vector, at any scale —
   *  `density` is a bitmap's concern, and nothing here is a bitmap). */
  drawRaster = (id: number, _nums: unknown, _at: unknown, _strs: unknown,
                bx = 0, by = 0, bw = 0, bh = 0, density = 1, pixelated = 0): number => {
    const s = surfaceById(id) as unknown as { drawing?: { ops: unknown[] } | null } | undefined;
    const list = s?.drawing;
    if (list == null) return 0;
    // a drawing that must be rastered is made over its bounds grown by what bleeds past
    // them (shadows, blur), at the density MacBackend says it is seen at (device pixels)
    const pad = rasterPad(list as never);
    const box = { x: bx - pad, y: by - pad, w: bw + 2 * pad, h: bh + 2 * pad };
    try { encodePicture(this.recorder, id, list as never, box, density, pixelated !== 0); }
    catch (e) { console.error("[gpu] drawing:", e); return 0; }
    const lb = (list as { bounds?: { x: number; y: number; w: number; h: number } | null }).bounds;
    // null bounds: the recording paints nothing; bounds not finite: its reach is unknown
    this.recorder.host_picture_made(id, lb == null ? new Float64Array(5) : !Number.isFinite(lb.x) ? new Float64Array(0)
      : new Float64Array([lb.x, lb.y, lb.w, lb.h, (list as { exact?: boolean }).exact === false ? Math.max(lb.w, lb.h) : 4]));
    return id;
  };
  /** Rich text: -1 says "no native flow here", and the runtime lays the flow out as views
   *  of its own (rich-text.ts, the canvas renderer's path), which the host draws like any. */
  richLayout = (): number => -1;
  richClamp = (): number => -1;

  /** The canvas-2d-shaped measurer the runtime measures with (measure.ts provideMeasurer). */
  measurer(): unknown {
    const engine = this.engine;
    return {
      font: "13px system-ui",
      letterSpacing: "0px",
      measureText(this: { font: string; letterSpacing: string }, text: string) {
        const f = parseFont(this.font);
        const ls = parseFloat(this.letterSpacing) || 0, t = String(text);
        const r = engine.measure(f.families, f.size, f.weight, f.italic, ls, t);
        // the ink is read from the glyphs' outlines: only when asked (a cap or x height)
        let ink: Float32Array | null = null;
        const inkOf = (): Float32Array => (ink ??= engine.ink(f.families, f.size, f.weight, f.italic, ls, t));
        return { width: r[0], fontBoundingBoxAscent: r[1], fontBoundingBoxDescent: r[2],
          get actualBoundingBoxAscent() { return inkOf()[0]; }, get actualBoundingBoxDescent() { return inkOf()[1]; } };
      },
    };
  }

  // ── to the compositor ──────────────────────────────────────────────────────

  /** An input arrived (its page timestamp): the frame that answers it says how long it took. */
  inputArrived(ts: number): void { if (this.input === null) this.input = ts; }

  /** The flush's commit, with the drawings recorded for it and the 3D views' projections. */
  private send(json: string, geoms: Float64Array, n: number): void {
    // the layers of drawings' filtered ops recorded this flush, made together, before the frame
    makeOpLayers(this.recorder);
    this.port.postMessage({ t: "commit", calls: this.takeCalls(), json, geoms, n, proj: this.projections(), input: this.input },
      [geoms.buffer, ...this.takeTransfer()]);
    this.input = null;
  }
  /** Drawings recorded outside a commit (none is due this flush) go on their own. */
  flush(): void {
    if (this.calls.length === 0) return;
    makeOpLayers(this.recorder);
    this.port.postMessage({ t: "calls", calls: this.takeCalls() }, this.takeTransfer());
  }
  private takeCalls(): [string, unknown[]][] { return this.calls.splice(0); }
  private takeTransfer(): Transferable[] { return this.transfer.splice(0); }

  /** The compositor named its 3D views: their projections go at once, and with every commit. */
  setThree(ids: number[]): void {
    this.three = ids;
    if (ids.length > 0) this.port.postMessage({ t: "proj", proj: this.projections() });
  }
  /** Each 3D view's projection: the runtime's homography, and whether its back hides (the id
   *  alone: drawn flat). */
  private projections(): number[][] {
    const out: number[][] = [];
    for (const id of this.three) {
      const sf = surfaceById(id) as unknown as { spec3D: (Parts3D & { backfaceHidden: boolean; perspective: number; originX: number; originY: number }) | null;
        xform: number[]; x: number; y: number; pivotX: number; pivotY: number } | undefined;
      const d = sf?.spec3D;
      if (sf === undefined || d == null) { out.push([id]); continue; }
      const H = homography(sf.xform as never, sf.x, sf.y, sf.pivotX, sf.pivotY, d, d.perspective, d.originX, d.originY);
      out.push([id, ...H, d.backfaceHidden ? 1 : 0]);
    }
    return out;
  }
}
