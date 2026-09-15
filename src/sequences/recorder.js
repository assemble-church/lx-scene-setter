// Sequence recorder: captures the desk's Art-Net frames while a chase/effect plays,
// analyses the take as it grows (so the UI can say when it has seen enough), and
// holds the final analysis as a draft until it's saved or discarded.
//
// The DMX hot path (onFrame) only copies bytes into a small pending batch; batches
// go to the analysis worker a few times a second, so the main thread never holds
// or processes the whole take.
//
// Auto stop: once every repeating group has been seen enough times, predicts the
// part of the take it wasn't fitted on, and two analyses in a row agree on the
// periods, the loop is known — recording stops by itself and the draft is ready.
//
// States: idle → recording → analysing → review → (save | discard) → idle.

const path = require("path");
const { performance } = require("perf_hooks");
const { Worker } = require("worker_threads");

const FLUSH_MS = 250; // how often pending frames move to the worker
const PROGRESS_EVERY_MS = 3000; // gap between live analyses
const MIN_PROGRESS_MS = 4000; // don't analyse a take shorter than this
const MAX_RECORD_MS = 5 * 60 * 1000; // hard stop: memory and analysis time on a Pi
const MIN_AUTO_STOP_MS = 8000; // never auto stop sooner than this
const MIN_PASSES = 3; // each repeating group seen at least this many times
const MIN_SCORE = 0.9; // …and predicting unseen frames this well
const PERIOD_AGREEMENT = 0.005; // consecutive analyses agree on periods within 0.5%
const IRREGULAR_WAIT_MS = 45000; // with channels that never repeat, loop a take this long
const MAX_MOVERS = 96; // moving channels described to the UI

// Every repeating group seen enough and predicting well.
function loopsLocked(analysis) {
  const regular = analysis.groups.filter((g) => g.key !== "irregular");
  return regular.length > 0 && regular.every((g) => g.passes >= MIN_PASSES && g.score >= MIN_SCORE);
}

// Two analyses found the same repeating periods.
function periodsAgree(a, b) {
  const pa = a.groups.filter((g) => g.period).map((g) => g.period);
  const pb = b.groups.filter((g) => g.period).map((g) => g.period);
  return pa.length === pb.length && pa.every((p, i) => Math.abs(p - pb[i]) / p <= PERIOD_AGREEMENT);
}

// Only what the UI needs from an analysis (no cycles).
function summarise(analysis) {
  if (!analysis) return null;
  return {
    durationMs: analysis.durationMs,
    groups: analysis.groups,
    stillCount: analysis.stillCount,
    stillLit: analysis.stillLit,
    longestPeriod: analysis.longestPeriod,
    ready: analysis.ready,
    locked: loopsLocked(analysis),
    // What moves, for the recorder's live plot: which group, 8/16-bit, main period.
    movers: analysis.channels
      .filter((c) => c.kind === "motion")
      .slice(0, MAX_MOVERS)
      .map((c) => ({
        universe: c.universe,
        channel: c.channel,
        wide: !!c.wide,
        group: c.irregular ? "irregular" : `p${c.cluster}`,
        periods: c.irregular ? [] : c.components.map((k) => Math.round(k.period * 1000) / 1000),
      })),
  };
}

function createRecorder({ logger, channels, onChange = () => {} }) {
  let state = "idle";
  let worker = null;
  let startedAt = 0;
  let stoppedAt = 0;
  let pending = new Map(); // universe → { times: number[], frames: Uint8Array, count }
  let frameCounts = new Map(); // universe → frames captured
  let flushTimer = null;
  let progressTimer = null;
  let requests = new Map(); // id → { resolve, reject }
  let nextRequest = 1;
  let analysing = false;
  let progress = null; // summary of the latest live analysis
  let draft = null; // full analysis awaiting review
  let error = null;
  let stoppedBy = null; // "manual" | "auto" | "limit"
  let lastAnalysis = null; // previous live analysis, for the agreement check

  function onFrame(universe, packet, length) {
    if (state !== "recording") return;
    const t = performance.now() - startedAt;
    if (t >= MAX_RECORD_MS) {
      // Hard stop; the outcome shows in status(). Frames after this are ignored.
      stop("limit").catch(() => {});
      return;
    }
    let p = pending.get(universe);
    if (!p) pending.set(universe, (p = { times: [], frames: new Uint8Array(16 * channels), count: 0 }));
    if ((p.count + 1) * channels > p.frames.length) {
      const grown = new Uint8Array(p.frames.length * 2);
      grown.set(p.frames);
      p.frames = grown;
    }
    const n = Math.min(length, channels, packet.length - 18);
    const at = p.count * channels;
    for (let i = 0; i < n; i++) p.frames[at + i] = packet[18 + i]; // rest stays 0 (fresh buffer)
    p.times.push(t);
    p.count++;
    frameCounts.set(universe, (frameCounts.get(universe) || 0) + 1);
  }

  function flush() {
    if (!worker || !pending.size) return;
    const universes = [];
    const transfer = [];
    for (const [universe, p] of pending) {
      const times = Float64Array.from(p.times);
      const frames = p.frames.slice(0, p.count * channels);
      universes.push({ universe, times, frames });
      transfer.push(times.buffer, frames.buffer);
    }
    pending = new Map();
    worker.postMessage({ type: "frames", universes }, transfer);
  }

  function request(durationMs) {
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      worker.postMessage({ type: "analyse", id, durationMs });
    });
  }

  function clearTimers() {
    clearInterval(flushTimer);
    clearTimeout(progressTimer);
    flushTimer = progressTimer = null;
  }

  function endWorker() {
    clearTimers();
    if (worker) worker.terminate().catch(() => {});
    worker = null;
    for (const r of requests.values()) r.reject(new Error("Recording ended"));
    requests = new Map();
    pending = new Map();
  }

  // Live analysis, back to back with a gap, so a slow Pi just updates less often.
  function scheduleProgress() {
    progressTimer = setTimeout(async () => {
      if (state !== "recording") return;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= MIN_PROGRESS_MS && [...frameCounts.values()].some((n) => n > 0)) {
        flush();
        analysing = true;
        try {
          const a = await request(elapsed);
          if (state === "recording") {
            progress = summarise(a);
            const agreed = lastAnalysis && periodsAgree(lastAnalysis, a);
            lastAnalysis = a;
            onChange();
            if (shouldAutoStop(a, agreed, elapsed)) {
              stop("auto").catch(() => {});
              return;
            }
          }
        } catch (err) {
          if (state === "recording") logger.warn(`Sequence progress analysis failed: ${err.message}`);
        } finally {
          analysing = false;
        }
      }
      if (state === "recording") scheduleProgress();
    }, PROGRESS_EVERY_MS);
  }

  function shouldAutoStop(a, agreed, elapsed) {
    if (!autoStop || !agreed || elapsed < MIN_AUTO_STOP_MS || !loopsLocked(a)) return false;
    // Long shapes need their passes, even when the score says yes early.
    if (elapsed < MIN_PASSES * a.longestPeriod * 1000) return false;
    // Channels that never repeat play back the whole take, so give them a decent one.
    if (a.groups.some((g) => g.key === "irregular") && elapsed < IRREGULAR_WAIT_MS) return false;
    return true;
  }

  let autoStop = true;

  function start({ autoStop: auto = true } = {}) {
    if (state === "recording" || state === "analysing") throw new Error("Already recording");
    endWorker();
    draft = progress = error = lastAnalysis = stoppedBy = null;
    autoStop = !!auto;
    frameCounts = new Map();
    worker = new Worker(path.join(__dirname, "analyse-worker.js"));
    worker.on("message", (msg) => {
      const r = requests.get(msg.id);
      if (!r) return;
      requests.delete(msg.id);
      if (msg.type === "result") r.resolve(msg.analysis);
      else r.reject(new Error(msg.message));
    });
    worker.on("error", (err) => {
      logger.error(`Sequence analysis worker failed: ${err.message}`);
      for (const r of requests.values()) r.reject(err);
      requests = new Map();
    });
    startedAt = performance.now();
    state = "recording";
    flushTimer = setInterval(flush, FLUSH_MS);
    scheduleProgress();
    logger.info("Sequence recording started");
    onChange();
  }

  // Stop capturing and run the final analysis. Resolves with the draft summary.
  async function stop(by = "manual") {
    if (state !== "recording") return summarise(draft);
    stoppedBy = by;
    lastAnalysis = null;
    stoppedAt = performance.now();
    const durationMs = stoppedAt - startedAt;
    state = "analysing";
    clearTimers();
    flush();
    onChange();
    if (![...frameCounts.values()].some((n) => n > 0)) {
      endWorker();
      state = "idle";
      error = "No Art-Net arrived from the desk while recording.";
      onChange();
      throw new Error(error);
    }
    try {
      draft = await request(durationMs);
      state = "review";
      logger.info(`Sequence recorded (${by} stop): ${(durationMs / 1000).toFixed(1)}s, ${draft.groups.length} group(s)`);
      return summarise(draft);
    } catch (err) {
      state = "idle";
      error = `Analysis failed: ${err.message}`;
      throw err;
    } finally {
      endWorker();
      onChange();
    }
  }

  function discard() {
    endWorker();
    state = "idle";
    draft = progress = error = lastAnalysis = stoppedBy = null;
    frameCounts = new Map();
    onChange();
  }

  // Turn auto stop on/off mid-recording.
  function setAutoStop(on) {
    autoStop = !!on;
    onChange();
  }

  // The full draft analysis (for saving), or null.
  function getDraft() {
    return state === "review" ? draft : null;
  }

  function status() {
    const elapsedMs = state === "recording" ? performance.now() - startedAt : startedAt ? stoppedAt - startedAt : 0;
    return {
      state,
      elapsedMs: Math.round(elapsedMs),
      maxMs: MAX_RECORD_MS,
      autoStop,
      stoppedBy,
      universes: [...frameCounts.entries()].sort((a, b) => a[0] - b[0]).map(([universe, frames]) => ({ universe, frames })),
      analysing: state === "analysing" || analysing,
      progress: state === "recording" ? progress : null,
      draft: state === "review" ? summarise(draft) : null,
      error,
    };
  }

  function close() {
    endWorker();
  }

  return { onFrame, start, stop, discard, setAutoStop, getDraft, status, close };
}

module.exports = { createRecorder, MAX_RECORD_MS };
