// Synthetic rig recordings for sequence-analysis tests.
// A colour chase, still house lights, 16-bit pan/tilt circles with a spread, a
// layered pan shape, and a random channel — at desk-like frame rates with jitter.

const COLOUR_PERIOD = 3.0;
const CIRCLE_PERIOD = 4.3;
const SWAY_PERIOD = 11.7;

// Colour chase: red → blue → green, 1s per step with a 0.3s crossfade.
function chase(t, offset) {
  const steps = [[255, 0, 0], [0, 0, 255], [0, 255, 0]];
  const pos = (((t / COLOUR_PERIOD + offset) % 1) + 1) % 1 * 3;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = steps[i];
  const b = steps[(i + 1) % 3];
  const mix = f < 0.9 ? 0 : (f - 0.9) / 0.1;
  return a.map((v, k) => Math.round(v + (b[k] - v) * mix));
}

// 16-bit position → [coarse, fine].
const bytes16 = (v) => {
  const n = Math.max(0, Math.min(65535, Math.round(v)));
  return [n >> 8, n & 255];
};

// Truth for every universe at time t (seconds): { [universe]: Uint8Array(512) }.
function rigAt(t, rng) {
  const u0 = new Uint8Array(512);
  for (let f = 0; f < 3; f++) u0.set(chase(t, f / 3), f * 3); // ch1–9 colour chase with spread
  for (let f = 0; f < 4; f++) u0.set([0, 0, 255], 12 + f * 3); // ch13–24 still blue house lights
  const u1 = new Uint8Array(512);
  for (let f = 0; f < 4; f++) {
    const ph = 2 * Math.PI * (t / CIRCLE_PERIOD + f / 4);
    let pan = 32768 + 12000 * Math.cos(ph);
    if (f === 3) pan += 9000 * Math.sin((2 * Math.PI * t) / SWAY_PERIOD); // layered sway
    const tilt = 32768 + 12000 * Math.sin(ph);
    u1.set([...bytes16(pan), ...bytes16(tilt), 255], f * 5); // pan, pan fine, tilt, tilt fine, dimmer
  }
  const u2 = new Uint8Array(512);
  u2[0] = rng ? rng(Math.floor(t * 2)) : 0; // random value every 0.5s
  return { 0: u0, 1: u1, 2: u2 };
}

// Deterministic "random" per step.
const rng = (k) => ((Math.sin(k * 12.9898) * 43758.5453) % 1 + 1) % 1 * 255 | 0;

function record(seconds, fps = 44, jitterMs = 6, startT = 17.4) {
  const unis = [0, 1, 2].map((u) => ({ universe: u, times: [], frames: [] }));
  let seed = 1;
  const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * jitterMs;
  for (let i = 0; i * (1000 / fps) < seconds * 1000; i++) {
    const tMs = Math.max(0, i * (1000 / fps) + jitter());
    const truth = rigAt(startT + tMs / 1000, rng);
    for (const u of unis) {
      u.times.push(tMs);
      u.frames.push(truth[u.universe]);
    }
  }
  return {
    durationMs: seconds * 1000,
    startT,
    universes: unis.map((u) => {
      const frames = new Uint8Array(u.frames.length * 512);
      u.frames.forEach((f, i) => frames.set(f, i * 512));
      return { universe: u.universe, times: Float64Array.from(u.times), frames };
    }),
  };
}

module.exports = { record, rigAt, rng, COLOUR_PERIOD, CIRCLE_PERIOD, SWAY_PERIOD };
