// bench — timing the render=gpu pipeline from inside the page, in any browser.
//
// Loaded by a harness into a page booted with ?render=gpu (`await import("/gpu/dist/bench.js")`),
// it drives the program with events dispatched at the canvas — so they pass through the
// shell's own listeners and the same transport a person's input takes — and then reads the
// worker's timing: how long each event took to reach the worker, how long after an input
// its frame was submitted, each frame's encode and GPU time, and the gaps between frames.
// The calendar's view switches are the workload (the segmented control's four buttons).

type Stats = Record<string, unknown>;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));
/** Where the run is, for a harness polling a stalled one. */
const stage = (s: string) => { (window as unknown as { __benchStage?: string }).__benchStage = s; };

function worker(): Worker {
  const w = (window as unknown as { __declareGpu?: { worker: Worker } }).__declareGpu?.worker;
  if (w === undefined) throw new Error("not a ?render=gpu page");
  return w;
}

function stats(clear: boolean): Promise<Stats> {
  const w = worker();
  return new Promise((resolve) => {
    const on = (e: MessageEvent) => { if (e.data?.t === "stats") { w.removeEventListener("message", on); resolve(e.data); } };
    w.addEventListener("message", on);
    w.postMessage({ t: "stats", clear });
  });
}

function pointer(type: string, x: number, y: number, buttons: number): void {
  const canvas = document.querySelector("canvas")!;
  canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, buttons, button: 0, pointerId: 1,
    pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true }));
}

async function click(x: number, y: number): Promise<void> {
  pointer("pointermove", x, y, 0); await frame();
  pointer("pointerdown", x, y, 1); await frame();
  pointer("pointerup", x, y, 0);
}

/** One interaction's story, from the worker's raw records: the press (pointerup) to the
 *  first frame it changed, how long the motion ran and in how many frames, the longest
 *  gap inside it, the worker's CPU time and the GPU's. */
function interaction(st: Stats): Stats {
  const frames = st.frames_raw as [number, number, number][];
  const inputs = st.inputs_raw as [string, number, number][];
  const busy = st.busy_raw as [number, number][];
  const ticks = (st.raf_raw as number[]) ?? [];
  const up = inputs.filter((i) => i[0] === "pointerup").pop();
  if (up === undefined || frames.length === 0) return { frames: frames.length };
  const after = frames.filter((f) => f[0] >= up[2]);
  if (after.length === 0) return { frames: 0 };
  const first = after[0][0] - up[1];
  const gaps = after.slice(1).map((f, i) => f[0] - after[i][0]);
  const end = after[after.length - 1][0] + after[after.length - 1][1];
  const cpu = busy.filter(([t]) => t >= up[2] && t <= end).reduce((a, [, d]) => a + d, 0);
  const firstBusy = busy.filter(([t]) => t >= up[2] && t <= after[0][0]).reduce((a, [, d]) => a + d, 0);
  return {
    pressToFirstFrame: +first.toFixed(1), workerBeforeFirstFrame: +firstBusy.toFixed(1),
    motionMs: +(end - after[0][0]).toFixed(1), frames: after.length,
    longestGap: +Math.max(0, ...gaps).toFixed(1), gapsOver20: gaps.filter((g) => g > 20).length,
    workerCpu: +cpu.toFixed(1), encode: +after.reduce((a, f) => a + f[1], 0).toFixed(1),
    gpu: +after.filter((f) => f[2] >= 0).reduce((a, f) => a + f[2], 0).toFixed(1),
    gpuMax: +Math.max(0, ...after.map((f) => f[2])).toFixed(1),
    // the worker's own frame clock over the same stretch: ticks given, and their spacing
    rafTicks: ticks.filter((t) => t >= after[0][0] && t <= end).length,
    rafMedianGap: (() => { const g = ticks.filter((t) => t >= after[0][0] && t <= end).slice(1).map((t, i, a) => t - (i === 0 ? ticks.filter((x) => x >= after[0][0])[0] : a[i - 1])).sort((a, b) => a - b); return g.length ? +g[Math.floor(g.length / 2)].toFixed(1) : 0; })(),
  };
}

/** Run the workload; answers the worker's timing for each part. */
export async function run(): Promise<Record<string, Stats>> {
  const W = innerWidth, H = innerHeight;
  const out: Record<string, Stats> = { ua: { ua: navigator.userAgent, size: `${W}x${H}@${devicePixelRatio}` } };
  stage("start");
  await stats(true);

  // hover: a move every frame, across the page
  for (let i = 0; i < 180; i++) { pointer("pointermove", 20 + (i / 180) * (W - 40), H * 0.6 + Math.sin(i / 9) * 80, 0); await frame(); }
  stage("hover done");
  out.hover = await stats(true);

  // view switches: Day, Week, Month, Year are the last four slots of the header
  // the header is right-aligned: each button sits at a fixed distance from the right edge
  const seg = (k: number) => [W - [279, 205, 132, 59][k], 30] as const;   // 0 day, 1 week, 2 month, 3 year
  const names = ["day", "week", "month", "year"];
  const per: Stats[] = [];
  for (const k of [1, 0, 3, 2, 1, 2, 0, 2]) {
    const [x, y] = seg(k);
    stage("switch to " + names[k]);
    await click(x, y);
    await pause(1200);
    const st = await stats(true);
    per.push({ to: names[k], ...interaction(st) });
  }
  out.switches = { each: per } as Stats;

  stage("wheel");
  // wheel: a burst over the grid
  const canvas = document.querySelector("canvas")!;
  for (let i = 0; i < 60; i++) {
    canvas.dispatchEvent(new WheelEvent("wheel", { clientX: W / 2, clientY: H / 2, deltaY: 8, bubbles: true, cancelable: true }));
    await frame();
  }
  out.wheel = await stats(true);

  stage("keys");
  // keys
  for (let i = 0; i < 20; i++) {
    dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true, cancelable: true })); await frame();
    dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true, cancelable: true })); await frame();
  }
  out.keys = await stats(true);
  return out;
}
