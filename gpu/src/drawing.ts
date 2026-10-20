// drawing — a view's draw() recording, encoded into the engine as a picture.
//
// A recording (runtime/src/draw.ts DisplayList) is Canvas2D calls as plain data. This
// replays it with Canvas2D's own meaning — the same op list replayDirect plays onto a
// real context — into the engine's path, stroke, clip and text calls, once per change of
// the drawing; the frame then places the finished picture by the view's transform alone.
//
// The Canvas2D rules that matter here: a path's points are transformed as they are added
// (kept in the drawing's space); a stroke's width and dashes are in the space of the
// transform current when it is stroked (so the path is taken back into that space and
// stroked under it); a gradient lies in the space current when its shape is painted; a
// clip lasts until the `restore` that undoes the `save` before it.

import type { Engine } from "../dist/engine.js";
import { rgba, filterPassList, layerScaleOf, scalePassList, type WireFilter } from "./host.js";
import { resolveFamilies } from "./fonts.js";
import { replay } from "../../runtime/dist/draw.js";
import { drawImageBitmap, registerDrawImage } from "../../runtime/dist/draw-image.js";
import { imageBitmapOf } from "./env.js";

/** Canvas2D's compositing operators → the engine's blend numbers (lib.rs push_blend). */
const COMPOSITE: Record<string, number> = {
  "source-over": 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, "color-dodge": 6,
  "color-burn": 7, "hard-light": 8, "soft-light": 9, difference: 10, exclusion: 11, hue: 12,
  saturation: 13, color: 14, luminosity: 15, copy: 20, "source-in": 21, "source-out": 22,
  "source-atop": 23, "destination-over": 24, "destination-in": 25, "destination-out": 26,
  "destination-atop": 27, xor: 28, lighter: 29,
};

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const inv = (m: M): M => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) return I;
  const d = 1 / det;
  return [m[3] * d, -m[1] * d, -m[2] * d, m[0] * d, (m[2] * m[5] - m[3] * m[4]) * d, (m[1] * m[4] - m[0] * m[5]) * d];
};
const ap = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface GradientRec { kind: "linear" | "radial" | "conic"; coords: number[]; stops: [number, string][] }
type Op = Record<string, unknown> & { op: string };
interface DisplayList { ops: Op[] }

interface State {
  m: M;
  fill: { css?: string; grad?: GradientRec };
  stroke: { css?: string; grad?: GradientRec };
  lineWidth: number; cap: number; join: number; miter: number;
  dash: number[]; dashOffset: number;
  alpha: number;
  font: string; align: string; baseline: string; letterSpacing: number;
  comp: number;        // COMPOSITE number of globalCompositeOperation
  filters: WireFilter[];   // the filter, parsed (empty: none)
  // the shadow: its colour, and its blur and offsets in the drawing's units (as the DOM's
  // canvas draws them)
  shadowColor: string; shadowBlur: number; shadowX: number; shadowY: number;
  smooth: boolean;     // imageSmoothingEnabled
  clips: number;
}

const warned = new Set<string>();
const warnOnce = (what: string): void => {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[gpu] drawings: ${what} not drawn yet`);
};

/** CSS font shorthand → what the engine shapes with. */
const fontMemo = new Map<string, { families: string; size: number; weight: number; italic: boolean }>();
function drawFont(font: string): { families: string; size: number; weight: number; italic: boolean } {
  const hit = fontMemo.get(font);
  if (hit !== undefined) return hit;
  let italic = false, weight = 400, size = 10, families = "sans-serif";
  const m = font.match(/^\s*((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00|ultra-condensed|condensed|semi-condensed|semi-expanded|expanded)\s+)*)([\d.]+)(px|pt|em|rem)(?:\s*\/\s*[\d.]+\w*)?\s+(.+)$/i);
  if (m !== null) {
    for (const t of m[1].trim().split(/\s+/)) {
      if (/^(italic|oblique)$/i.test(t)) italic = true;
      else if (/^bold(er)?$/i.test(t)) weight = 700;
      else if (/^lighter$/i.test(t)) weight = 300;
      else if (/^[1-9]00$/.test(t)) weight = parseInt(t, 10);
    }
    const n = parseFloat(m[2]);
    size = m[3] === "pt" ? n * 4 / 3 : m[3] === "px" ? n : n * 16;
    families = m[4];
  }
  const out = { families: resolveFamilies(families), size, weight, italic };
  fontMemo.set(font, out);
  return out;
}

/** A Canvas2D colour string → 0xRRGGBBAA, any CSS form (the worker's own 2D context
 *  normalizes what the quick parser does not read). */
let norm: OffscreenCanvasRenderingContext2D | null = null;
function colorOf(css: string): number {
  if (/^(#|rgba?\()/i.test(css)) return rgba(css) ?? 0;
  norm ??= new OffscreenCanvas(1, 1).getContext("2d");
  if (norm === null) return 0x000000ff;
  norm.fillStyle = "#000000";
  norm.fillStyle = css;
  return rgba(String(norm.fillStyle)) ?? 0;
}
const withAlpha = (c: number, a: number): number => a >= 1 ? c : ((c & 0xffffff00) | Math.round((c & 255) * a)) >>> 0;

function brushOf(p: { css?: string; grad?: GradientRec }, alpha: number): Float64Array {
  if (p.grad === undefined) return new Float64Array([0, withAlpha(colorOf(p.css ?? "#000"), alpha)]);
  const g = p.grad;
  const stops: number[] = [g.stops.length];
  for (const [o, c] of g.stops) stops.push(o, withAlpha(colorOf(c), alpha));
  const head = g.kind === "linear" ? [1, ...g.coords.slice(0, 4)] : g.kind === "radial" ? [2, ...g.coords.slice(0, 6)] : [3, ...g.coords.slice(0, 3)];
  return new Float64Array([...head, ...stops]);
}

/** A canvas `filter` string as the filter list views use (WireFilter), or null for one the
 *  engine's layers do not run (url(…) and the like). Its lengths are drawing units. */
function parseCanvasFilter(v: string): WireFilter[] | null {
  const t = v.trim();
  if (t === "" || t === "none") return [];
  const out: WireFilter[] = [];
  const re = /([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/gi;
  let seen = 0;
  for (let m = re.exec(t); m !== null; m = re.exec(t)) {
    seen += m[0].replace(/\s/g, "").length;
    const name = m[1].toLowerCase(), arg = m[2].trim();
    const amount = (x: string): number => (x === "" ? 1 : x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x));
    switch (name) {
      case "blur": out.push({ fn: "blur", v: parseFloat(arg) || 0 }); break;
      case "brightness": case "contrast": case "saturate": case "grayscale": case "sepia": case "invert": case "opacity":
        out.push({ fn: name, v: amount(arg) }); break;
      case "hue-rotate": {
        const n = parseFloat(arg) || 0;
        out.push({ fn: "hueRotate", v: arg.endsWith("turn") ? n * 360 : arg.endsWith("grad") ? n * 0.9 : arg.endsWith("rad") ? (n * 180) / Math.PI : n });
        break;
      }
      case "drop-shadow": {
        // lengths (dx dy [σ]) and a colour, in either order; the wire's blur is 2σ (effects.ts)
        const parts = arg.match(/(?:[a-z-]+\([^)]*\)|[^\s]+)/gi) ?? [];
        const lens = parts.filter((x) => /^-?[\d.]+(px)?$/.test(x)).map((x) => parseFloat(x));
        const color = parts.find((x) => !/^-?[\d.]+(px)?$/.test(x)) ?? "#000";
        if (lens.length < 2) return null;
        out.push({ fn: "shadow", dx: lens[0], dy: lens[1], blur: 2 * (lens[2] ?? 0), color });
        break;
      }
      default: return null;
    }
  }
  return seen === t.replace(/\s/g, "").length ? out : null;
}

/** What the engine cannot draw: a filter its layers do not run (an SVG `url()`). A drawing
 *  that uses one is rastered whole (below); the filters it does run, and shadows, are each
 *  op's layer (play). */
function needsRaster(list: DisplayList): boolean {
  for (const o of list.ops) {
    if (o.op === "set" && o.k === "filter" && parseCanvasFilter(String(o.v)) === null) return true;
  }
  return false;
}
/** Does the drawing composite with anything but source-over (clearRect included)? Then
 *  it is drawn in a group of its own, so its operators act on its own marks only — as a
 *  drawing does on a canvas of its own. */
function composites(list: DisplayList): boolean {
  for (const o of list.ops) {
    if (o.op === "clearRect") return true;
    if (o.op === "set" && o.k === "globalCompositeOperation" && o.v !== "source-over") return true;
  }
  return false;
}

/** The engine image handles a rastered drawing lives under: apart from images' own. */
export const RASTER_BASE = 0x40000000;

/** Encode `list` as engine picture `id`. `box` is the area the drawing can reach (its
 *  recorded bounds, else the view's box) and `density` the device pixels per unit it is
 *  seen at — what a rastered drawing is made at. */
export function encodePicture(engine: Engine, id: number, list: DisplayList,
                              box: { x: number; y: number; w: number; h: number }, density: number, pixelated: boolean): void {
  if (needsRaster(list) && rasterInto(engine, id, list, box, density)) {
    engine.picture_begin(id);
    const px = Math.max(1, Math.ceil(box.w * density)), py = Math.max(1, Math.ceil(box.h * density));
    engine.draw_image_rect(new Float64Array(I), RASTER_BASE + id, 0, 0, px, py, box.x, box.y, px / density, py / density, pixelated ? 0 : 2, 1);
    engine.picture_end();
    return;
  }
  engine.drop_image(RASTER_BASE + id);
  engine.picture_begin(id);
  const iso = composites(list);
  if (iso) engine.push_blend(0);
  let made = 0;
  // the ops' layers are made with every other drawing's, before the frame (makeOpLayers)
  engine.layers_begin();
  try { made = play(engine, list, pixelated, id, box, density, opPictures); } finally { if (iso) engine.pop(); engine.picture_end(); }
  // the layers an earlier recording of this drawing made and this one did not
  for (let k = made; k < (layersMade.get(id) ?? 0); k++) engine.layer_drop(DRAW_LAYER_BASE + id * 256 + k);
  layersMade.set(id, made);
}

/** The pictures of filtered ops whose layers are still to be made. */
const opPictures: number[] = [];

/** Make the layers of the filtered ops recorded since the last frame — all of them together
 *  (engine.layers_end) — and let their pictures go. The host calls this before it paints. */
export function makeOpLayers(engine: Engine): void {
  try { engine.layers_end(); } catch (e) { console.error("[gpu] drawing filter:", e); }
  for (const p of opPictures) engine.picture_drop(p);
  opPictures.length = 0;
}

/** Layers of filtered ops, by drawing: DRAW_LAYER_BASE + id·256 + the op's number. */
const DRAW_LAYER_BASE = 0x20000000;
const layersMade = new Map<number, number>();

/** Replay the recording onto a 2D context of the worker's own — the runtime's replay, so
 *  every Canvas2D rule holds — at `density`, and hand the pixels to the engine. */
function rasterInto(engine: Engine, id: number, list: DisplayList, box: { x: number; y: number; w: number; h: number }, density: number): boolean {
  const px = Math.max(1, Math.ceil(box.w * density)), py = Math.max(1, Math.ceil(box.h * density));
  if (px * py > 16384 * 16384 || !Number.isFinite(px * py)) return false;
  const c = new OffscreenCanvas(px, py);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (ctx === null) return false;
  ctx.setTransform(density, 0, 0, density, -box.x * density, -box.y * density);
  // a recording's images are the program's Image objects; the 2D context wants their bitmaps
  const swapped: [number, unknown][] = [];
  for (const o of list.ops) if (o.op === "drawImage") {
    const h = o.h as number, src = drawImageBitmap(h), bmp = imageBitmapOf(src);
    if (bmp !== undefined) { swapped.push([h, src]); registerDrawImage(h, bmp); }
  }
  try { replay(ctx as unknown as CanvasRenderingContext2D, list as never); }
  finally { for (const [h, src] of swapped) registerDrawImage(h, src as CanvasImageSource); }
  const data = ctx.getImageData(0, 0, px, py);
  engine.add_image(RASTER_BASE + id, px, py, new Uint8Array(data.data.buffer));
  return true;
}

function play(engine: Engine, list: DisplayList, pixelated: boolean, id: number,
              box: { x: number; y: number; w: number; h: number }, density: number, opPictures: number[]): number {
  let st: State = {
    m: I, fill: { css: "#000000" }, stroke: { css: "#000000" }, lineWidth: 1, cap: 0, join: 0, miter: 10,
    dash: [], dashOffset: 0, alpha: 1, font: "10px sans-serif", align: "start", baseline: "alphabetic",
    letterSpacing: 0, comp: 0, filters: [], shadowColor: "rgba(0,0,0,0)", shadowBlur: 0, shadowX: 0, shadowY: 0,
    smooth: true, clips: 0,
  };
  /** The filters an op is drawn through: the filter, then the shadow as a drop shadow
   *  (Canvas2D's shadowBlur is the wire's 2σ). */
  const filtersFor = (): readonly WireFilter[] => {
    if (!(st.shadowBlur > 0 || st.shadowX !== 0 || st.shadowY !== 0) || !inked(st.shadowColor)) return st.filters;
    return [...st.filters, { fn: "shadow", dx: st.shadowX, dy: st.shadowY, blur: st.shadowBlur, color: st.shadowColor }];
  };
  /** Paint under the current filter, shadow and compositing operator. A filtered op is drawn
   *  into a layer of its own over its reach (`at`, its bounds in the drawing's space; the
   *  drawing's area when not given) at the density it is seen at, run through the filter there
   *  (host.ts filterPassList — the views' passes; lengths are drawing units through the
   *  transform), and the result composited where the op would have been. */
  let layers = 0;
  const painted = (paint: () => void, at?: [number, number, number, number]): void => {
    const fl = filtersFor();
    if (fl.length === 0 || layers >= 256) { composed(paint); return; }
    const k = Math.hypot(st.m[0], st.m[1]) * density;
    // the op's own picture, under its layer's id, kept until the layers are made
    const lid = DRAW_LAYER_BASE + id * 256 + layers++;
    engine.picture_begin(lid);
    try { paint(); } finally { engine.picture_end(); }
    opPictures.push(lid);
    const { passes, reach } = filterPassList(fl, k);
    // the layer: the op's reach (its bounds and the filter's), inside the drawing's area
    const r = reach / density;
    const x0 = Math.max(box.x, at === undefined ? box.x : at[0] - r), y0 = Math.max(box.y, at === undefined ? box.y : at[1] - r);
    const x1 = Math.min(box.x + box.w, at === undefined ? box.x + box.w : at[2] + r), y1 = Math.min(box.y + box.h, at === undefined ? box.y + box.h : at[3] + r);
    if (!(x1 > x0 && y1 > y0)) return;
    const lx = Math.floor(x0 * density), ly = Math.floor(y0 * density);
    const px = Math.max(1, Math.ceil(x1 * density) - lx), py = Math.max(1, Math.ceil(y1 * density) - ly);
    const sc = layerScaleOf(passes);
    const cmds = new Float64Array([6, density, 0, 0, density, 0, 0, lid]);
    try { engine.layer(lid, cmds, lx, ly, px, py, new Float64Array(scalePassList(passes, sc)), sc); }
    catch (e) { console.error("[gpu] drawing filter:", e); return; }
    composed(() => engine.draw_layer(ID, lid, lx / density, ly / density, px / density, py / density));
  };
  /** A path's bounds (drawing space; commands as `path` holds them), widened by `grow`. */
  const boundsOf = (d: number[], grow: number): [number, number, number, number] => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < d.length;) {
      const c = d[i];
      const n = c === 0 || c === 1 ? 1 : c === 2 ? 2 : c === 3 ? 3 : 0;
      for (let j = 0; j < n; j++) {
        const x = d[i + 1 + 2 * j], y = d[i + 2 + 2 * j];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      i += 1 + 2 * n;
    }
    return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
  };
  /** Paint under the current compositing operator. */
  const composed = (paint: () => void): void => {
    if (st.comp === 0) { paint(); return; }
    engine.push_blend(st.comp);
    try { paint(); } finally { engine.pop(); }
  };
  const stack: State[] = [];
  let path: number[] = [];               // in the drawing's space
  let cx = 0, cy = 0, sx = 0, sy = 0;   // current and subpath-start points, drawing space
  let open = false;                      // a subpath is under way
  const ID = new Float64Array(I);

  const moveTo = (x: number, y: number): void => {
    const [X, Y] = ap(st.m, x, y);
    path.push(0, X, Y); cx = sx = X; cy = sy = Y; open = true;
  };
  const lineTo = (x: number, y: number): void => {
    const [X, Y] = ap(st.m, x, y);
    if (!open) { path.push(0, X, Y); sx = X; sy = Y; open = true; } else path.push(1, X, Y);
    cx = X; cy = Y;
  };
  const cubicTo = (a: number, b: number, c: number, d: number, x: number, y: number): void => {
    if (!open) moveTo(a, b);
    const [A, B] = ap(st.m, a, b), [C, D] = ap(st.m, c, d), [X, Y] = ap(st.m, x, y);
    path.push(3, A, B, C, D, X, Y); cx = X; cy = Y;
  };
  const quadTo = (a: number, b: number, x: number, y: number): void => {
    if (!open) moveTo(a, b);
    const [A, B] = ap(st.m, a, b), [X, Y] = ap(st.m, x, y);
    path.push(2, A, B, X, Y); cx = X; cy = Y;
  };
  /** An elliptical arc in user space as cubics (≤ 90° each); joined by a line from the
   *  current point, as Canvas2D does. */
  const ellipse = (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw: boolean): void => {
    let sweep = a1 - a0;
    const TAU = Math.PI * 2;
    if (!ccw && sweep >= TAU) sweep = TAU;
    else if (ccw && sweep <= -TAU) sweep = -TAU;
    else {
      if (!ccw) { while (sweep < 0) sweep += TAU; }
      else { while (sweep > 0) sweep -= TAU; }
    }
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const pt = (t: number): [number, number] => {
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      return [x + ex * cr - ey * sr, y + ex * sr + ey * cr];
    };
    const d = (t: number): [number, number] => {
      const ex = -rx * Math.sin(t), ey = ry * Math.cos(t);
      return [ex * cr - ey * sr, ex * sr + ey * cr];
    };
    const [px, py] = pt(a0);
    if (open) lineTo(px, py); else moveTo(px, py);
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const k = (4 / 3) * Math.tan(step / 4);
    let t = a0;
    for (let i = 0; i < n; i++) {
      const t1 = t + step;
      const [x0, y0] = pt(t), [x1, y1] = pt(t1), [dx0, dy0] = d(t), [dx1, dy1] = d(t1);
      cubicTo(x0 + k * dx0, y0 + k * dy0, x1 - k * dx1, y1 - k * dy1, x1, y1);
      t = t1;
    }
  };
  const close = (): void => { if (open) { path.push(4); cx = sx; cy = sy; } };
  const rectPath = (x: number, y: number, w: number, h: number): void => {
    moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); close(); moveTo(x, y);
  };
  /** The current point, back in user space (arcTo works there). */
  const userPoint = (): [number, number] => ap(inv(st.m), cx, cy);

  const fillNow = (d: number[], evenOdd: boolean): void => {
    if (d.length === 0) return;
    painted(() => engine.fill_path(ID, new Float64Array(d), evenOdd, brushOf(st.fill, st.alpha), new Float64Array(st.m)), boundsOf(d, 1));
  };
  const strokeNow = (d: number[]): void => {
    if (d.length === 0 || st.lineWidth <= 0) return;
    // back into the space current now, and stroked under it
    const back = inv(st.m);
    const u: number[] = [];
    for (let i = 0; i < d.length;) {
      const c = d[i];
      const n = c === 0 || c === 1 ? 1 : c === 2 ? 2 : c === 3 ? 3 : 0;
      u.push(c);
      for (let k = 0; k < n; k++) { const [x, y] = ap(back, d[i + 1 + 2 * k], d[i + 2 + 2 * k]); u.push(x, y); }
      i += 1 + 2 * n;
    }
    // its reach: half the width, as far as a miter can run, through the transform
    const grow = st.lineWidth * Math.max(1, st.join === 0 ? st.miter : 1) * Math.max(Math.hypot(st.m[0], st.m[1]), Math.hypot(st.m[2], st.m[3])) / 2 + 1;
    painted(() => engine.stroke_path(new Float64Array(st.m), new Float64Array(u), st.lineWidth, st.cap, st.join, st.miter,
      new Float64Array(st.dash), st.dashOffset, brushOf(st.stroke, st.alpha), new Float64Array(I)), boundsOf(d, grow));
  };
  const textNow = (text: string, x: number, y: number, maxWidth: number | undefined, paint: { css?: string; grad?: GradientRec }, stroked = false): void => {
    const f = drawFont(st.font);
    const w = engine.width(f.families, f.size, f.weight, f.italic, st.letterSpacing, text);
    const r = engine.measure(f.families, f.size, f.weight, f.italic, st.letterSpacing, text);
    const ascent = r[1], descent = r[2];
    let dx = st.align === "center" ? -w / 2 : st.align === "right" || st.align === "end" ? -w : 0;
    const dy = st.baseline === "top" ? ascent : st.baseline === "hanging" ? ascent * 0.8
      : st.baseline === "middle" ? (ascent - descent) / 2 : st.baseline === "bottom" || st.baseline === "ideographic" ? -descent : 0;
    let m = mul(st.m, [1, 0, 0, 1, x, y]);
    if (maxWidth !== undefined && maxWidth > 0 && w > maxWidth) {
      m = mul(m, [maxWidth / w, 0, 0, 1, 0, 0]);
      dx = dx * maxWidth / w;
    }
    painted(() => stroked
      ? engine.text_stroke_brush(new Float64Array(m), f.families, f.size, f.weight, f.italic, st.letterSpacing, text, dx, dy,
          st.lineWidth, st.cap, st.join, st.miter, new Float64Array(st.dash), st.dashOffset, brushOf(paint, st.alpha))
      : engine.text_brush(new Float64Array(m), f.families, f.size, f.weight, f.italic, st.letterSpacing, text, dx, dy,
          brushOf(paint, st.alpha)));
  };

  for (const o of list.ops) {
    switch (o.op) {
      case "fillStyle": st.fill = o.grad !== undefined ? { grad: o.grad as GradientRec } : { css: o.v as string }; break;
      case "strokeStyle": st.stroke = o.grad !== undefined ? { grad: o.grad as GradientRec } : { css: o.v as string }; break;
      case "set": {
        const v = o.v;
        switch (o.k) {
          case "lineWidth": st.lineWidth = Number(v); break;
          case "lineCap": st.cap = v === "round" ? 1 : v === "square" ? 2 : 0; break;
          case "lineJoin": st.join = v === "round" ? 1 : v === "bevel" ? 2 : 0; break;
          case "miterLimit": st.miter = Number(v); break;
          case "lineDashOffset": st.dashOffset = Number(v); break;
          case "globalAlpha": st.alpha = Math.max(0, Math.min(1, Number(v))); break;
          case "font": st.font = String(v); break;
          case "textAlign": st.align = String(v); break;
          case "textBaseline": st.baseline = String(v); break;
          case "letterSpacing": st.letterSpacing = parseFloat(String(v)) || 0; break;
          case "globalCompositeOperation": {
            const c = COMPOSITE[String(v)];
            if (c === undefined) warnOnce(`globalCompositeOperation ${String(v)}`); else st.comp = c;
            break;
          }
          case "imageSmoothingEnabled": st.smooth = v !== false; break;
          case "filter": st.filters = parseCanvasFilter(String(v)) ?? []; break;
          case "shadowColor": st.shadowColor = String(v); break;
          case "shadowBlur": st.shadowBlur = Math.max(0, Number(v) || 0); break;
          case "shadowOffsetX": st.shadowX = Number(v) || 0; break;
          case "shadowOffsetY": st.shadowY = Number(v) || 0; break;
        }
        break;
      }
      case "setLineDash": st.dash = (o.segments as number[]).length % 2 === 1 ? [...(o.segments as number[]), ...(o.segments as number[])] : [...(o.segments as number[])]; break;
      case "fillRect": {
        const saved = path; path = []; const so = open; open = false;
        rectPath(o.x as number, o.y as number, o.w as number, o.h as number);
        fillNow(path, false); path = saved; open = so;
        break;
      }
      case "strokeRect": {
        const saved = path; path = []; const so = open; open = false;
        rectPath(o.x as number, o.y as number, o.w as number, o.h as number);
        strokeNow(path); path = saved; open = so;
        break;
      }
      case "clearRect": {
        // transparent black over the rectangle, whatever the operator and alpha: erased
        const saved = path; path = []; const so = open; open = false;
        rectPath(o.x as number, o.y as number, o.w as number, o.h as number);
        const d = path; path = saved; open = so;
        engine.push_blend(COMPOSITE["destination-out"]);
        engine.fill_path(ID, new Float64Array(d), false, new Float64Array([0, 0x000000ff]), new Float64Array(st.m));
        engine.pop();
        break;
      }
      case "drawImage": {
        const src = drawImageBitmap(o.h as number) as { __handle?: number } | undefined;
        if (src?.__handle === undefined) break;
        painted(() => engine.draw_image_rect(new Float64Array(st.m), src.__handle!, o.sx as number, o.sy as number, o.sw as number, o.sh as number,
          o.dx as number, o.dy as number, o.dw as number, o.dh as number, pixelated || !st.smooth ? 0 : 2, st.alpha));
        break;
      }
      case "beginPath": path = []; open = false; break;
      case "moveTo": moveTo(o.x as number, o.y as number); break;
      case "lineTo": lineTo(o.x as number, o.y as number); break;
      case "arc": ellipse(o.x as number, o.y as number, o.r as number, o.r as number, 0, o.a0 as number, o.a1 as number, o.ccw === true); break;
      case "ellipse": ellipse(o.x as number, o.y as number, o.rx as number, o.ry as number, o.rot as number, o.a0 as number, o.a1 as number, o.ccw === true); break;
      case "arcTo": {
        const [x0, y0] = open ? userPoint() : [o.x1 as number, o.y1 as number];
        if (!open) moveTo(x0, y0);
        const x1 = o.x1 as number, y1 = o.y1 as number, x2 = o.x2 as number, y2 = o.y2 as number, r = o.r as number;
        const v1x = x0 - x1, v1y = y0 - y1, v2x = x2 - x1, v2y = y2 - y1;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        const cross = v1x * v2y - v1y * v2x;
        if (l1 === 0 || l2 === 0 || r === 0 || Math.abs(cross) < 1e-9) { lineTo(x1, y1); break; }
        const angle = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2))));
        const t = r / Math.tan(angle / 2);
        const p1x = x1 + v1x / l1 * t, p1y = y1 + v1y / l1 * t;
        const p2x = x1 + v2x / l2 * t, p2y = y1 + v2y / l2 * t;
        const bis = Math.hypot(v1x / l1 + v2x / l2, v1y / l1 + v2y / l2);
        const d = r / Math.sin(angle / 2);
        const ccx = x1 + (v1x / l1 + v2x / l2) / bis * d, ccy = y1 + (v1y / l1 + v2y / l2) / bis * d;
        const a0 = Math.atan2(p1y - ccy, p1x - ccx), a1 = Math.atan2(p2y - ccy, p2x - ccx);
        lineTo(p1x, p1y);
        ellipse(ccx, ccy, r, r, 0, a0, a1, cross > 0);
        break;
      }
      case "rect": rectPath(o.x as number, o.y as number, o.w as number, o.h as number); break;
      case "roundRect": {
        const x = o.x as number, y = o.y as number, w = o.w as number, h = o.h as number;
        const rv = o.radii as number | number[];
        const rs = Array.isArray(rv) ? rv.map(Number) : [Number(rv)];
        const [tl, tr, br, bl] = rs.length === 1 ? [rs[0], rs[0], rs[0], rs[0]] : rs.length === 2 ? [rs[0], rs[1], rs[0], rs[1]]
          : rs.length === 3 ? [rs[0], rs[1], rs[2], rs[1]] : [rs[0], rs[1], rs[2], rs[3]];
        const f = Math.min(1, w / Math.max(1e-9, tl + tr), w / Math.max(1e-9, bl + br), h / Math.max(1e-9, tl + bl), h / Math.max(1e-9, tr + br));
        const [a, b, c, e] = [tl * f, tr * f, br * f, bl * f];
        moveTo(x + a, y);
        lineTo(x + w - b, y); if (b > 0) ellipse(x + w - b, y + b, b, b, 0, -Math.PI / 2, 0, false);
        lineTo(x + w, y + h - c); if (c > 0) ellipse(x + w - c, y + h - c, c, c, 0, 0, Math.PI / 2, false);
        lineTo(x + e, y + h); if (e > 0) ellipse(x + e, y + h - e, e, e, 0, Math.PI / 2, Math.PI, false);
        lineTo(x, y + a); if (a > 0) ellipse(x + a, y + a, a, a, 0, Math.PI, Math.PI * 1.5, false);
        close(); moveTo(x, y);
        break;
      }
      case "quadraticCurveTo": quadTo(o.cpx as number, o.cpy as number, o.x as number, o.y as number); break;
      case "bezierCurveTo": cubicTo(o.cp1x as number, o.cp1y as number, o.cp2x as number, o.cp2y as number, o.x as number, o.y as number); break;
      case "closePath": close(); break;
      case "fill": fillNow(path, o.rule === "evenodd"); break;
      case "stroke": strokeNow(path); break;
      case "clip":
        engine.push_clip_path(ID, new Float64Array(path.length > 0 ? path : [0, 0, 0]), o.rule === "evenodd");
        st.clips++;
        break;
      case "fillText": textNow(String(o.text), o.x as number, o.y as number, o.maxWidth as number | undefined, st.fill); break;
      case "strokeText": textNow(String(o.text), o.x as number, o.y as number, o.maxWidth as number | undefined, st.stroke, true); break;
      case "save": stack.push(st); st = { ...st, dash: [...st.dash], clips: 0 }; break;
      case "restore": {
        for (let i = 0; i < st.clips; i++) engine.pop();
        const prev = stack.pop();
        if (prev !== undefined) st = prev; else st = { ...st, clips: 0 };
        break;
      }
      case "translate": st.m = mul(st.m, [1, 0, 0, 1, o.x as number, o.y as number]); break;
      case "rotate": { const a = o.angle as number, c = Math.cos(a), s = Math.sin(a); st.m = mul(st.m, [c, s, -s, c, 0, 0]); break; }
      case "scale": st.m = mul(st.m, [o.x as number, 0, 0, o.y as number, 0, 0]); break;
      case "transform": st.m = mul(st.m, [...(o.m as number[])] as M); break;
      case "setTransform": st.m = [...(o.m as number[])] as M; break;
      case "resetTransform": st.m = I; break;
    }
  }
  // close what the recording left open
  for (let s: State | undefined = st; s !== undefined; s = stack.pop()) for (let i = 0; i < s.clips; i++) engine.pop();
  return layers;
}

/** Does a CSS colour show at all (not transparent)? */
function inked(css: string): boolean {
  return !/^(transparent|rgba\([^)]*,\s*0(\.0*)?\s*\)|hsla\([^)]*,\s*0(\.0*)?\s*\)|#[0-9a-f]{6}00|#[0-9a-f]{3}0)$/i.test(css.trim());
}
