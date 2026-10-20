// media — video, audio and in-memory sounds, across the worker.
//
// A worker has no media elements and no Web Audio, so these live on the page (shell.ts)
// and this side is their stand-in, the shape the Mac env gives the runtime
// (browser/mac-env.js): media.ts drives an element by its property and callback surface,
// every verb crossing by handle, every fact (metadata, time, play, pause, ended) arriving
// back as an event; clip-host.ts's seam (`__declareClipHost`) decodes sounds and starts
// voices on the page's AudioContext. A video's frames come back as ImageBitmaps, which
// the engine copies into a texture of the video's own (Engine.video_frame) and draws
// wherever the view shows it.

/** Engine image handles for videos' frames: apart from images' own and from layers. */
export const MEDIA_KEY = 0x70000000;

const post = (m: Record<string, unknown>): void => (self as unknown as Worker).postMessage(m);

type Handler = (() => void) | null;
let mediaSeq = 1;
const mediaEls = new Map<number, MediaElement>();

export class MediaElement {
  readonly __mediaHandle = mediaSeq++;
  videoWidth = 0; videoHeight = 0;
  duration = NaN;
  paused = true;
  playsInline = true; preload = "metadata";
  onloadedmetadata: Handler = null; onerror: Handler = null;
  onplay: Handler = null; onpause: Handler = null; onended: Handler = null;
  onwaiting: Handler = null; onplaying: Handler = null; ontimeupdate: Handler = null;
  style = {};
  private _muted = false; private _loop = false; private _volume = 1; private _rate = 1;
  private _pos = 0; private _src = "";
  constructor(readonly kind: "video" | "audio", private base: () => string) {
    mediaEls.set(this.__mediaHandle, this);
    post({ t: "media", op: "create", id: this.__mediaHandle, kind });
  }
  get src(): string { return this._src; }
  set src(v: string) {
    this._src = String(v);
    let abs = this._src;
    try { abs = new URL(this._src, this.base()).href; } catch { /* as given */ }
    post({ t: "media", op: "load", id: this.__mediaHandle, url: abs });
  }
  private set_(key: string, v: number): void { post({ t: "media", op: "set", id: this.__mediaHandle, key, v }); }
  get muted(): boolean { return this._muted; }
  set muted(on: boolean) { this._muted = !!on; this.set_("muted", on ? 1 : 0); }
  get loop(): boolean { return this._loop; }
  set loop(on: boolean) { this._loop = !!on; this.set_("loop", on ? 1 : 0); }
  get volume(): number { return this._volume; }
  set volume(n: number) { this._volume = +n; this.set_("volume", +n); }
  get playbackRate(): number { return this._rate; }
  set playbackRate(n: number) { this._rate = +n; this.set_("rate", +n); }
  get currentTime(): number { return this._pos; }
  set currentTime(t: number) { this._pos = +t; post({ t: "media", op: "seek", id: this.__mediaHandle, v: +t }); }
  play(): undefined { post({ t: "media", op: "play", id: this.__mediaHandle }); return undefined; }
  pause(): void { post({ t: "media", op: "pause", id: this.__mediaHandle }); }
  load(): void {}
  addEventListener(): void {} removeEventListener(): void {}
  setAttribute(): void {} removeAttribute(): void {}
  /** A fact from the page's element. */
  event(type: string, a: number, b: number, c: number): void {
    switch (type) {
      case "metadata": this.duration = a; this.videoWidth = b || 0; this.videoHeight = c || 0; this.onloadedmetadata?.(); break;
      case "time": this._pos = a; this.ontimeupdate?.(); break;
      case "play": this.paused = false; this.onplay?.(); break;
      case "pause": this.paused = true; this.onpause?.(); break;
      case "ended": this.paused = true; this._pos = a; this.onended?.(); break;
      case "waiting": this.onwaiting?.(); break;
      case "playing": this.onplaying?.(); break;
      case "error": this.onerror?.(); break;
    }
  }
}

/** The page's media facts, by handle. */
export function mediaEvent(id: number, type: string, a: number, b: number, c: number): void {
  try { mediaEls.get(id)?.event(type, a, b, c); } catch (e) { console.error("media:", e); }
}

// ── in-memory sounds: clip-host.ts's seam, served by the page's Web Audio ──────
let clipSeq = 1;
const clipWaits = new Map<number, { resolve: (v: { clip: unknown; duration: number }) => void; reject: (e: Error) => void }>();
const voiceEnds = new Map<number, () => void>();

export function installClipHost(base: () => string): void {
  (globalThis as { __declareClipHost?: unknown }).__declareClipHost = {
    decode(url: string): Promise<{ clip: unknown; duration: number }> {
      const id = clipSeq++;
      let abs = url;
      try { abs = new URL(url, base()).href; } catch { /* as given */ }
      return new Promise((resolve, reject) => { clipWaits.set(id, { resolve, reject }); post({ t: "clip", op: "decode", id, url: abs }); });
    },
    sink() {
      const id = clipSeq++;
      post({ t: "clip", op: "sink", id });
      return {
        setVolume(volume: number, muted: boolean): void { post({ t: "clip", op: "volume", id, v: muted ? 0 : volume }); },
        // a voice is started on the page; one the page refuses (autoplay not yet allowed)
        // ends at once, as a refused play() does
        start(clip: unknown, offset: number, loop: boolean, rate: number, onEnded: () => void) {
          const v = clipSeq++;
          voiceEnds.set(v, onEnded);
          post({ t: "clip", op: "start", id: v, sink: id, clip, offset, loop: !!loop, rate });
          return {
            stop(): void { voiceEnds.delete(v); post({ t: "clip", op: "stop", id: v }); },
            setLoop(on: boolean): void { post({ t: "clip", op: "loop", id: v, v: !!on }); },
            setRate(r: number): void { post({ t: "clip", op: "rate", id: v, v: r }); },
          };
        },
        release(): void { post({ t: "clip", op: "release", id }); },
      };
    },
  };
}

/** The page's clip facts: decoded (or not), and a voice that ended. */
export function clipEvent(id: number, type: string, a: number): void {
  if (type === "decoded" || type === "error") {
    const w = clipWaits.get(id);
    clipWaits.delete(id);
    if (type === "decoded") w?.resolve({ clip: id, duration: a });
    else w?.reject(new Error("the sound did not decode"));
  } else if (type === "ended") {
    const f = voiceEnds.get(id);
    voiceEnds.delete(id);
    try { f?.(); } catch (e) { console.error("clip:", e); }
  }
}
