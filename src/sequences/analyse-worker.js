// Worker thread that owns a sequence recording and analyses it. Frames stream in
// from the main thread in small batches (so the DMX hot path only ever copies
// bytes), and analysis — seconds of work on a Pi for a long take — never blocks
// output, OSC or the web UI.
//
// Messages in:
//   { type: "frames", universes: [{ universe, times: Float64Array, frames: Uint8Array }] }
//   { type: "analyse", id, durationMs }
// Messages out:
//   { type: "result", id, analysis }  |  { type: "error", id, message }

const { parentPort } = require("worker_threads");
const { analyse } = require("./analyse");

// universe → { times: Float64Array[], frames: Uint8Array[], count }
const takes = new Map();

function concat(parts, Type) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Type(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

parentPort.on("message", (msg) => {
  if (msg.type === "frames") {
    for (const u of msg.universes) {
      let take = takes.get(u.universe);
      if (!take) takes.set(u.universe, (take = { times: [], frames: [] }));
      take.times.push(u.times);
      take.frames.push(u.frames);
    }
    return;
  }
  if (msg.type === "analyse") {
    try {
      const universes = [...takes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([universe, take]) => {
          // Compact the batches so the next pass concatenates less.
          const times = concat(take.times, Float64Array);
          const frames = concat(take.frames, Uint8Array);
          take.times = [times];
          take.frames = [frames];
          return { universe, times, frames };
        });
      const analysis = analyse({ durationMs: msg.durationMs, universes });
      parentPort.postMessage({ type: "result", id: msg.id, analysis });
    } catch (err) {
      parentPort.postMessage({ type: "error", id: msg.id, message: err.message });
    }
  }
});
