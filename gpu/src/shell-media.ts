// shell-media — the page's half of media.ts: the real media elements and Web Audio.
//
// Each element the worker's stand-in names is made here, kept out of sight (a video must
// be in the document for its frames to be presented), and driven by the verbs that
// arrive; its facts go back as events. A video's frames go to the worker as ImageBitmaps,
// one per frame the browser presents (requestVideoFrameCallback), and after a load or a
// seek. In-memory sounds are the runtime's own Web Audio clip host (clip-host.ts) here on
// the page, so its autoplay rule (the first key or press resumes the context) holds.

import { clipHost, type ClipSink, type ClipVoice } from "../../runtime/dist/clip-host.js";

type Post = (m: { t: string } & Record<string, unknown>, transfer?: Transferable[]) => void;

export function shellMedia(post: Post): (m: Record<string, unknown>) => boolean {
  const els = new Map<number, HTMLMediaElement>();
  let shelf: HTMLElement | null = null;
  const hide = (el: HTMLElement): void => {
    if (shelf === null) {
      shelf = document.createElement("div");
      shelf.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";
      document.body.appendChild(shelf);
    }
    shelf.appendChild(el);
  };
  const ev = (id: number, type: string, a = 0, b = 0, c = 0): void => post({ t: "media-ev", id, type, a, b, c });
  const sendFrame = (id: number, v: HTMLVideoElement): void => {
    if (v.videoWidth === 0 || v.readyState < 2) return;
    createImageBitmap(v).then((bitmap) => post({ t: "media-frame", id, bitmap }, [bitmap]), () => {});
  };
  const watchFrames = (id: number, v: HTMLVideoElement): void => {
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
    if (typeof rvfc !== "function") return;
    const each = (): void => { if (!els.has(id)) return; sendFrame(id, v); rvfc.call(v, each); };
    rvfc.call(v, each);
  };

  const clips = new Map<number, unknown>();
  const sinks = new Map<number, ClipSink>();
  const voices = new Map<number, ClipVoice>();

  return (m) => {
    if (m.t === "media") {
      const id = m.id as number;
      if (m.op === "create") {
        const el = document.createElement(m.kind === "video" ? "video" : "audio");
        el.preload = "metadata";
        (el as HTMLVideoElement).playsInline = true;
        el.crossOrigin = "anonymous";
        els.set(id, el);
        hide(el);
        el.onloadedmetadata = () => ev(id, "metadata", Number.isFinite(el.duration) ? el.duration : 0,
          (el as HTMLVideoElement).videoWidth ?? 0, (el as HTMLVideoElement).videoHeight ?? 0);
        el.ontimeupdate = () => ev(id, "time", el.currentTime);
        el.onplay = () => ev(id, "play");
        el.onpause = () => ev(id, "pause");
        el.onended = () => ev(id, "ended", el.currentTime);
        el.onwaiting = () => ev(id, "waiting");
        el.onplaying = () => ev(id, "playing");
        el.onerror = () => ev(id, "error");
        if (el instanceof HTMLVideoElement) {
          el.onloadeddata = () => sendFrame(id, el);
          el.onseeked = () => sendFrame(id, el);
          watchFrames(id, el);
        }
        return true;
      }
      const el = els.get(id);
      if (el === undefined) return true;
      switch (m.op) {
        case "load": el.src = m.url as string; break;
        case "set": {
          const v = m.v as number;
          if (m.key === "muted") el.muted = v !== 0;
          else if (m.key === "loop") el.loop = v !== 0;
          else if (m.key === "volume") el.volume = Math.max(0, Math.min(1, v));
          else if (m.key === "rate") el.playbackRate = v;
          break;
        }
        case "seek": el.currentTime = m.v as number; break;
        // a refused play (autoplay with sound) leaves it paused, and says so
        case "play": el.play().catch(() => ev(id, "pause")); break;
        case "pause": el.pause(); break;
      }
      return true;
    }
    if (m.t === "clip") {
      const host = clipHost();
      const id = m.id as number;
      switch (m.op) {
        case "decode":
          if (host === null) { post({ t: "clip-ev", id, type: "error", a: 0 }); break; }
          host.decode(m.url as string).then(
            (r) => { clips.set(id, r.clip); post({ t: "clip-ev", id, type: "decoded", a: r.duration }); },
            () => post({ t: "clip-ev", id, type: "error", a: 0 }));
          break;
        case "sink": if (host !== null) sinks.set(id, host.sink()); break;
        case "volume": sinks.get(id)?.setVolume(m.v as number, false); break;
        case "start": {
          const sink = sinks.get(m.sink as number), clip = clips.get(m.clip as number);
          const ended = (): void => { voices.delete(id); post({ t: "clip-ev", id, type: "ended", a: 0 }); };
          const v = sink !== undefined && clip !== undefined ? sink.start(clip, m.offset as number, m.loop === true, m.rate as number, ended) : null;
          if (v === null) ended(); else voices.set(id, v);
          break;
        }
        case "stop": voices.get(id)?.stop(); voices.delete(id); break;
        case "loop": voices.get(id)?.setLoop(m.v === true); break;
        case "rate": voices.get(id)?.setRate(m.v as number); break;
        case "release": sinks.get(id)?.release(); sinks.delete(id); break;
      }
      return true;
    }
    return false;
  };
}
