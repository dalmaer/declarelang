// channel — a client for one of the host's control channels (Control.swift).
//
//   const main = channel();                       // the main channel (CTL_IN)
//   const lane = await openLane("g1", url);       // a window with its own channel
//   await lane.send("waitload 30");
//
// A command is written to the channel's inbox and answered in its reply file.
// One channel answers one command at a time, so a client owns its channel:
// several rigs at once each open a LANE (`lane NAME [url]` on the main
// channel), whose files are its own, and never share one.

import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { CTL_IN } from "./app.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A client for the channel listening on `inPath`. */
export function channel(inPath = CTL_IN) {
  const outPath = inPath.replace(/\.in$/, "") + ".out";
  // one command in flight per channel: a second caller waits its turn
  let queue = Promise.resolve();
  const exchange = async (cmd, timeoutMs) => {
    if (existsSync(outPath)) unlinkSync(outPath);
    writeFileSync(inPath, cmd + "\n");
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(20);
      // the reply file can exist before the host has written it: empty is "not yet"
      if (existsSync(outPath)) { const t = readFileSync(outPath, "utf8").trim(); if (t) return t; }
    }
    throw new Error(`no reply on ${inPath} to "${cmd.slice(0, 40)}"`);
  };
  return {
    inPath,
    send(cmd, timeoutMs = 20000) {
      const r = queue.then(() => exchange(cmd, timeoutMs));
      queue = r.catch(() => {});
      return r;
    },
  };
}

/** Ask the main channel for a lane: a new window running `url`, with a
 *  channel of its own. Resolves to that channel's client plus the window id
 *  (for a capture by id: win.mjs hostWindow(id), DECLARE_WINDOW). */
export async function openLane(name, url = "", main = channel()) {
  const r = await main.send(`lane ${name} ${url}`.trim());
  const m = r.match(/^ok lane=\S+ window=#(\d+) in=(\S+)/);
  if (m === null) throw new Error(`lane ${name}: ${r}`);
  return { ...channel(m[2]), window: Number(m[1]), name };
}
