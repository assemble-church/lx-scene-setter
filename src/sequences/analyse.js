// Sequence analysis — turn a recording of raw Art-Net frames into a looping model
// that plays back the same movement indefinitely, without knowing the patch.
//
// Why per channel: a rig running several effects (a colour chase on some fixtures,
// a pan/tilt shape on others, each at its own speed, often from layered shape
// generators) has no single loop — the combination may never repeat. But each
// effect does. So every channel is modelled as
//
//     value(t) = base + Σ component_i( (t mod period_i) / period_i )
//
// — one or more periodic components (layered shapes add together on an
// attribute), each stored as one averaged cycle. Playing every channel from the
// same t = 0 reproduces the whole look, including the relative phase between
// fixtures and between effects, for as long as it runs.
//
// Steps:
//   1. resample each universe onto a uniform 50 Hz grid (sample-and-hold),
//   2. classify channels: still, moving, or the fine byte of a 16-bit pair (found
//      from the data: coarse·256 + fine is smooth, and inverting fine ruins it) —
//      16-bit pairs are modelled as one value,
//   3. find the strongest frequency peak (grouping harmonics, so a stepped chase
//      isn't mistaken for a faster one), refine its period on the autocorrelation
//      many cycles out, fold-average one cycle, subtract it, and repeat on what's
//      left — separating layered shapes; then re-refine each with the others removed,
//   4. snap near-identical periods across channels to one shared value, so
//      channels from the same effect never drift apart,
//   5. score each channel by fitting on the first 70% of the recording and
//      predicting the last 30% it hasn't seen; poor predictors are "irregular".

const DT = 0.02; // analysis grid: 50 Hz
const MIN_PERIOD = 0.25; // seconds — faster than this is strobing, not a shape
const STILL_RANGE = 2; // moved by at most this much → still
const MAX_COMPONENTS = 3;
const SNAP_TOLERANCE = 0.002; // periods within 0.2% are the same effect (looser on short takes)
const JUMP = 32; // playback blends neighbouring samples closer than this (8-bit units), steps otherwise
const IRREGULAR_BELOW = 0.6; // held-out score under this → doesn't repeat usefully
const PHASE_REFINE_BELOW_PASSES = 8; // fewer passes than this → sharpen the period by phase drift

// ---- numeric helpers -------------------------------------------------------------

// In-place iterative radix-2 FFT on (re, im) of power-of-two length.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function meanOf(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i];
  return s / (to - from || 1);
}

function varianceOf(x) {
  const m = meanOf(x);
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - m) ** 2;
  return v / (x.length || 1);
}

function median(values) {
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ---- cycles ------------------------------------------------------------------------

// One averaged cycle of x at `period` samples over [from, to): median per phase bin
// (ignores jitter, and a second effect on the same channel averages away).
function fold(x, period, from = 0, to = x.length) {
  const bins = Math.max(4, Math.round(period));
  const buckets = Array.from({ length: bins }, () => []);
  for (let n = from; n < to; n++) buckets[Math.floor(((n % period) / period) * bins) % bins].push(x[n]);
  const cycle = new Float64Array(bins);
  const empty = [];
  for (let b = 0; b < bins; b++) {
    if (buckets[b].length) cycle[b] = median(buckets[b]);
    else empty.push(b);
  }
  for (const b of empty) {
    let l = b - 1;
    let r = b + 1;
    while (empty.includes(((l % bins) + bins) % bins) && l > b - bins) l--;
    while (empty.includes(r % bins) && r < b + bins) r++;
    cycle[b] = (cycle[((l % bins) + bins) % bins] + cycle[r % bins]) / 2;
  }
  return cycle;
}

// Value of a cycle at phase 0..1, blending neighbours unless they jump by > jump.
function sampleCycle(cycle, phase, jump = JUMP) {
  const n = cycle.length;
  const pos = (((phase % 1) + 1) % 1) * n;
  const i = Math.floor(pos) % n;
  const f = pos - Math.floor(pos);
  const a = cycle[i];
  const b = cycle[(i + 1) % n];
  if (Math.abs(a - b) > jump) return f < 0.5 ? a : b;
  return a + (b - a) * f;
}

// Normalised, unbiased autocorrelation r[k] for k < n/2.
function autocorrelation(x) {
  const n = x.length;
  const m = meanOf(x);
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i] - m;
  fft(re, im);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im); // power spectrum → autocorrelation (the scale cancels below)
  const half = Math.floor(n / 2);
  const r = new Float64Array(half);
  const r0 = re[0] || 1;
  for (let k = 0; k < half; k++) r[k] = (re[k] / r0) * (n / (n - k));
  return r;
}

// Refine a period estimate (samples) to high precision: find the autocorrelation
// peak at the furthest clear multiple m·p and divide by m — the position error is
// shared across m cycles.
function refinePeriod(x, p0) {
  const r = autocorrelation(x);
  const peakAt = (around, radius) => {
    let best = -1;
    for (let k = Math.max(1, Math.floor(around - radius)); k <= Math.min(r.length - 2, Math.ceil(around + radius)); k++) {
      if (best < 0 || r[k] > r[best]) best = k;
    }
    if (best <= 0 || best >= r.length - 1) return null;
    const a = r[best - 1];
    const b = r[best];
    const c = r[best + 1];
    const d = a - 2 * b + c;
    return { k: d === 0 ? best : best + (0.5 * (a - c)) / d, value: b };
  };
  const first = peakAt(p0, Math.max(2, 0.03 * p0));
  if (!first) return p0;
  let period = first.k;
  // Walk outwards through multiples, re-centring each search on the refined period.
  for (let m = 2; m * period < r.length - 2; m++) {
    const pk = peakAt(m * period, Math.max(2, 0.02 * period));
    if (!pk || pk.value < 0.5 * first.value) break;
    period = pk.k / m;
  }
  return period;
}

// Mean cycle of x at `period` over [from, to) with a fixed bin count (empty bins
// borrow their neighbours). Fast; used for phase measurement.
function meanFold(x, period, bins, from, to) {
  const sums = new Float64Array(bins);
  const counts = new Uint32Array(bins);
  for (let n = from; n < to; n++) {
    const b = Math.floor(((n % period) / period) * bins) % bins;
    sums[b] += x[n];
    counts[b]++;
  }
  const out = new Float64Array(bins);
  for (let b = 0; b < bins; b++) out[b] = counts[b] ? sums[b] / counts[b] : NaN;
  for (let b = 0; b < bins; b++) {
    if (!Number.isNaN(out[b])) continue;
    for (let d = 1; d < bins; d++) {
      const v = out[(b + d) % bins];
      if (!Number.isNaN(v)) {
        out[b] = v;
        break;
      }
    }
  }
  const m = meanOf(out);
  for (let b = 0; b < bins; b++) out[b] = (out[b] || 0) - m;
  return out;
}

// Sharpen a period (samples) by phase drift: fold each segment of the recording,
// measure how far its cycle has slid against the whole-recording cycle, and fit a
// line through those offsets. A wrong period makes the phase slide steadily; the
// slope corrects it, using every pass rather than a few autocorrelation peaks.
function refineByPhase(x, p0) {
  let p = p0;
  const n = x.length;
  // With plenty of passes the autocorrelation multiples are already sharper.
  if (n / p0 >= PHASE_REFINE_BELOW_PASSES) return p0;
  const segments = Math.min(12, Math.floor(n / p0));
  if (segments < 3) return p0;
  const bins = Math.max(16, Math.min(256, Math.round(p0)));
  for (let iter = 0; iter < 3; iter++) {
    const template = meanFold(x, p, bins, 0, n);
    const seg = Math.floor(n / segments);
    const ts = [];
    const offsets = [];
    for (let i = 0; i < segments; i++) {
      const from = i * seg;
      const cycle = meanFold(x, p, bins, from, from + seg);
      let best = 0;
      let bestV = -Infinity;
      const corr = new Float64Array(bins);
      for (let L = 0; L < bins; L++) {
        let v = 0;
        for (let b = 0; b < bins; b++) v += cycle[(b + L) % bins] * template[b];
        corr[L] = v;
        if (v > bestV) {
          bestV = v;
          best = L;
        }
      }
      const a = corr[(best - 1 + bins) % bins];
      const c = corr[(best + 1) % bins];
      const d = a - 2 * bestV + c;
      let lag = d === 0 ? best : best + (0.5 * (a - c)) / d;
      if (lag > bins / 2) lag -= bins;
      ts.push(from + seg / 2);
      offsets.push(lag);
    }
    // Unwrap consecutive offsets, then least-squares slope (bins per sample).
    for (let i = 1; i < offsets.length; i++) {
      while (offsets[i] - offsets[i - 1] > bins / 2) offsets[i] -= bins;
      while (offsets[i] - offsets[i - 1] < -bins / 2) offsets[i] += bins;
    }
    const mt = meanOf(ts);
    const mo = meanOf(offsets);
    let num = 0;
    let den = 0;
    for (let i = 0; i < ts.length; i++) {
      num += (ts[i] - mt) * (offsets[i] - mo);
      den += (ts[i] - mt) ** 2;
    }
    const slope = den ? num / den : 0;
    const next = 1 / (1 / p - slope / bins);
    if (!Number.isFinite(next) || Math.abs(next / p - 1) > 0.02) break;
    if (Math.abs(next / p - 1) < 1e-7) {
      p = next;
      break;
    }
    p = next;
  }
  return p;
}

// Strongest periodic component of x: { period (samples), concentration } or null.
// Uses a Hann-windowed spectrum; if a clean sub-harmonic of the peak exists, the
// peak is a harmonic and the sub-harmonic is the true (slower) period.
function strongestPeriod(x, minLag, maxLag) {
  const n = x.length;
  const m = meanOf(x);
  let size = 1;
  while (size < 4 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = (x[i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const half = size >> 1;
  const power = new Float64Array(half);
  let total = 0;
  for (let k = 1; k < half; k++) {
    power[k] = re[k] * re[k] + im[k] * im[k];
    total += power[k];
  }
  if (total <= 0) return null;
  const kLo = Math.max(1, Math.ceil(size / maxLag)); // slowest: ≥ 2 passes
  const kHi = Math.min(half - 2, Math.floor(size / minLag));
  let kPeak = -1;
  for (let k = kLo; k <= kHi; k++) if (kPeak < 0 || power[k] > power[kPeak]) kPeak = k;
  if (kPeak < 0) return null;
  const interp = (k) => {
    const a = power[k - 1];
    const b = power[k];
    const c = power[k + 1];
    const d = a - 2 * b + c;
    return d === 0 ? k : k + (0.5 * (a - c)) / d;
  };
  let kFund = interp(kPeak);
  const resolution = size / n; // padded bins per true frequency bin
  // Sub-harmonic check, slowest first: an exact k/h peak means kPeak is its harmonic.
  for (let h = 6; h >= 2; h--) {
    const target = kFund / h;
    if (target < kLo) continue;
    const r = Math.round(target);
    let local = r;
    for (let k = Math.max(kLo, r - 3); k <= Math.min(kHi, r + 3); k++) if (power[k] > power[local]) local = k;
    if (local <= kLo || local >= kHi) continue;
    const isPeak = power[local] >= power[local - 1] && power[local] >= power[local + 1];
    if (isPeak && power[local] >= 0.05 * power[kPeak] && Math.abs(interp(local) - target) < 0.25 * resolution) {
      kFund = interp(local);
      break;
    }
  }
  // Energy near the peak as a share of the whole spectrum (noise spreads out).
  let near = 0;
  for (let k = Math.max(1, kPeak - Math.ceil(2 * resolution)); k <= Math.min(half - 1, kPeak + Math.ceil(2 * resolution)); k++) near += power[k];
  return { period: size / kFund, concentration: near / total };
}

// ---- channel models ---------------------------------------------------------------

// value(t) for a model: base + Σ components, clamped to the model's scale.
function evaluate(model, t) {
  let v = model.base;
  const jump = model.wide ? JUMP * 256 : JUMP;
  for (const c of model.components) v += sampleCycle(c.cycle, t / c.period, jump);
  return Math.max(0, Math.min(model.wide ? 65535 : 255, Math.round(v)));
}

// Channel value at t seconds. `wideModel` evaluates a 16-bit pair for a fine byte.
function valueAt(model, t, coarseModel) {
  if (model.kind === "static") return model.value;
  if (model.kind === "fine") return coarseModel ? evaluate(coarseModel, t) & 255 : 0;
  const v = evaluate(model, t);
  return model.wide ? v >> 8 : v;
}

// Fit components (periods in seconds, in order) to x over [from, to).
function fitComponents(x, periods, from, to) {
  const base = meanOf(x, from, to);
  const residual = Float64Array.from(x, (v) => v - base);
  const components = [];
  for (const periodSec of periods) {
    const p = periodSec / DT;
    const cycle = fold(residual, p, from, to);
    const m = meanOf(cycle);
    for (let b = 0; b < cycle.length; b++) cycle[b] -= m;
    for (let n = 0; n < residual.length; n++) residual[n] -= sampleCycle(cycle, (n % p) / p, Infinity);
    components.push({ period: periodSec, cycle });
  }
  return { base, components };
}

// Peel periodic components off x, strongest first, then backfit: re-refine each
// period with the other components subtracted, so a layered shape can't bias its
// neighbour's timing. Returns [{ period (s), explained }].
function discoverPeriods(x, maxLag) {
  const base = meanOf(x);
  const centred = Float64Array.from(x, (v) => v - base);
  const total = varianceOf(centred);
  const residual = Float64Array.from(centred);
  let remaining = total;
  const found = []; // { p (samples), cycle, explained }
  const subtract = (target, p, cycle, sign) => {
    const m = meanOf(cycle);
    for (let n = 0; n < target.length; n++) target[n] -= sign * (sampleCycle(cycle, (n % p) / p, Infinity) - m);
  };
  for (let i = 0; i < MAX_COMPONENTS && remaining > 0.002 * total && remaining > 1; i++) {
    const s = strongestPeriod(residual, MIN_PERIOD / DT, maxLag);
    if (!s || s.concentration < 0.08) break;
    const p = refineByPhase(residual, refinePeriod(residual, s.period));
    if (x.length / p < 2) break;
    // A whole-number fraction of a period already found is just its harmonic — the
    // stored cycle already contains it.
    if (found.some((f) => Math.abs(f.p / p - Math.round(f.p / p)) < 0.01 && Math.round(f.p / p) >= 2)) break;
    const cycle = fold(residual, p);
    const next = Float64Array.from(residual);
    subtract(next, p, cycle, 1);
    const after = varianceOf(next);
    if (after > 0.8 * remaining || remaining - after < 0.02 * total) break; // didn't explain enough to be real
    found.push({ p, cycle, explained: remaining - after });
    residual.set(next);
    remaining = after;
  }
  if (found.length > 1) {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < found.length; i++) {
        const others = Float64Array.from(centred);
        found.forEach((f, j) => j !== i && subtract(others, f.p, f.cycle, 1));
        found[i].p = refineByPhase(others, refinePeriod(others, found[i].p));
        found[i].cycle = fold(others, found[i].p);
      }
    }
  }
  return found.map((f) => ({ period: f.p * DT, explained: f.explained }));
}

function heldOutScore(model, x, from, to, range) {
  if (to <= from) return 0;
  let err = 0;
  for (let n = from; n < to; n++) err += Math.abs(evaluate(model, n * DT) - x[n]);
  return Math.max(0, 1 - err / (to - from) / Math.max(range, model.wide ? 16 * 256 : 16));
}

// ---- recording → grids -------------------------------------------------------------

// recording.universes: [{ universe, times: Float64Array (ms from start), frames: Uint8Array (n × width) }]
function resample(recording) {
  const steps = Math.floor(recording.durationMs / 1000 / DT);
  const out = [];
  for (const u of recording.universes) {
    const count = u.times.length;
    if (!count || steps < 2) continue;
    const width = Math.round(u.frames.length / count);
    const grid = new Uint8Array(steps * width);
    let p = 0;
    for (let s = 0; s < steps; s++) {
      const tMs = s * DT * 1000;
      while (p + 1 < count && u.times[p + 1] <= tMs) p++;
      grid.set(u.frames.subarray(p * width, (p + 1) * width), s * width);
    }
    out.push({ universe: u.universe, width, steps, grid });
  }
  return out;
}

// Is `fine` (samples) the low byte of a 16-bit value whose high byte is `coarse`?
// If so, coarse·256 + fine is a smooth curve and inverting the fine byte ruins it;
// for two unrelated channels both combinations are equally rough.
function looksLikeFineByte(fine, coarse) {
  let fmin = 255;
  let fmax = 0;
  for (const v of fine) {
    if (v < fmin) fmin = v;
    if (v > fmax) fmax = v;
  }
  if (fmax - fmin < 128) return false;
  let rough = 0;
  let roughInverted = 0;
  for (let s = 2; s < fine.length; s++) {
    const v = (k) => coarse[k] * 256 + fine[k];
    const w = (k) => coarse[k] * 256 + (255 - fine[k]);
    rough += Math.abs(v(s) - 2 * v(s - 1) + v(s - 2));
    roughInverted += Math.abs(w(s) - 2 * w(s - 1) + w(s - 2));
  }
  return rough < 0.75 * roughInverted; // real pairs measure ~0.5, unrelated channels ~1.0
}

// ---- main ----------------------------------------------------------------------------

// Returns { durationMs, dt, channels, groups, stillCount, stillLit, longestPeriod, ready }.
function analyse(recording) {
  const grids = resample(recording);
  const durationSec = recording.durationMs / 1000;
  const channels = [];
  const movers = [];
  const maxLag = Math.floor(durationSec / DT / 2); // at least two passes

  for (const g of grids) {
    for (let ch = 0; ch < g.width; ch++) {
      let min = 255;
      let max = 0;
      for (let s = 0; s < g.steps; s++) {
        const v = g.grid[s * g.width + ch];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min <= STILL_RANGE) {
        // Most channels are still: take the median from a histogram, no series needed.
        const counts = new Uint32Array(256);
        for (let s = 0; s < g.steps; s++) counts[g.grid[s * g.width + ch]]++;
        let value = 0;
        for (let seen = 0; value < 256 && (seen += counts[value]) < g.steps / 2; value++);
        channels.push({ universe: g.universe, channel: ch + 1, kind: "static", value });
        continue;
      }
      const x = new Float64Array(g.steps);
      for (let s = 0; s < g.steps; s++) x[s] = g.grid[s * g.width + ch];
      const c = { universe: g.universe, channel: ch + 1, x, range: max - min };
      const prev = movers[movers.length - 1];
      if (prev && prev.universe === c.universe && prev.channel === c.channel - 1 && !prev.wide && !prev.fineOf && looksLikeFineByte(c.x, prev.x)) {
        // Fold this fine byte into its coarse neighbour: model the 16-bit value.
        prev.wide = true;
        prev.x = Float64Array.from(prev.x, (v, s) => v * 256 + c.x[s]);
        prev.range = prev.range * 256 + 255;
        channels.push({ universe: c.universe, channel: c.channel, kind: "fine", of: prev.channel });
        continue;
      }
      movers.push(c);
    }
  }

  for (const m of movers) m.found = discoverPeriods(m.x, maxLag);

  // Snap near-identical periods across channels (weighted by what they explain).
  const candidates = [];
  for (const m of movers) for (const f of m.found) candidates.push(f);
  candidates.sort((a, b) => a.period - b.period);
  const clusters = [];
  for (const f of candidates) {
    const last = clusters[clusters.length - 1];
    // A short take measures periods roughly, so allow more slack early on (a few
    // percent of a period's share of the take), tightening as the take grows.
    const tolerance = last ? Math.min(0.03, Math.max(SNAP_TOLERANCE, (0.1 * last.mean) / durationSec)) : 0;
    if (last && Math.abs(f.period - last.mean) / last.mean <= tolerance) {
      last.items.push(f);
      const w = last.items.reduce((s, i) => s + Math.sqrt(i.explained), 0);
      last.mean = last.items.reduce((s, i) => s + i.period * Math.sqrt(i.explained), 0) / w;
    } else {
      clusters.push({ mean: f.period, items: [f] });
    }
  }
  clusters.forEach((cl, i) => cl.items.forEach((f) => ((f.period = cl.mean), (f.cluster = i))));

  const split = Math.floor(movers.length ? movers[0].x.length * 0.7 : 0);
  for (const m of movers) {
    const n = m.x.length;
    const periods = m.found.map((f) => f.period);
    let entry;
    if (periods.length) {
      const trial = { wide: !!m.wide, ...fitComponents(m.x, periods, 0, split) };
      const score = heldOutScore(trial, m.x, split, n, m.range);
      if (score >= IRREGULAR_BELOW) {
        const primary = m.found.reduce((a, b) => (b.explained > a.explained ? b : a));
        entry = { ...fitComponents(m.x, periods, 0, n), score, cluster: primary.cluster, passes: durationSec / Math.max(...periods) };
      }
    }
    if (!entry) {
      // Doesn't repeat usefully: loop the whole take as recorded.
      entry = { ...fitComponents(m.x, [n * DT], 0, n), score: 0, irregular: true, cluster: null, passes: 1 };
    }
    channels.push({ universe: m.universe, channel: m.channel, kind: "motion", wide: !!m.wide, ...entry });
  }
  channels.sort((a, b) => a.universe - b.universe || a.channel - b.channel);

  // Review groups: moving channels by the cluster of their main component.
  const groups = new Map();
  for (const c of channels) {
    if (c.kind !== "motion") continue;
    const key = c.irregular ? "irregular" : `p${c.cluster}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, period: c.irregular ? null : clusters[c.cluster].mean, channels: 0, wide: 0, layered: 0, universes: new Set(), scoreSum: 0, passes: Infinity };
      groups.set(key, g);
    }
    g.channels += c.wide ? 2 : 1;
    if (c.wide) g.wide++;
    if (!c.irregular && c.components.length > 1) g.layered++;
    g.universes.add(c.universe);
    g.scoreSum += c.score;
    g.passes = Math.min(g.passes, c.passes);
  }
  const groupList = [...groups.values()]
    .map((g) => {
      const members = channels.filter((c) => c.kind === "motion" && (g.key === "irregular" ? c.irregular : !c.irregular && `p${c.cluster}` === g.key));
      return {
        key: g.key,
        period: g.period,
        channels: g.channels,
        wide: g.wide,
        layered: g.layered,
        universes: [...g.universes].sort((a, b) => a - b),
        score: g.key === "irregular" ? 0 : g.scoreSum / members.length,
        passes: g.key === "irregular" ? 0 : Math.round(g.passes * 10) / 10,
      };
    })
    .sort((a, b) => (a.period ?? Infinity) - (b.period ?? Infinity));

  const regular = groupList.filter((g) => g.key !== "irregular");
  const stills = channels.filter((c) => c.kind === "static");
  return {
    durationMs: recording.durationMs,
    dt: DT,
    channels,
    groups: groupList,
    stillCount: stills.length,
    stillLit: stills.filter((c) => c.value > 0).length,
    longestPeriod: regular.reduce((mx, g) => Math.max(mx, g.period), 0),
    // Enough to stop: every repeating group seen ≥ 3 times and predicting well.
    ready: regular.length > 0 && regular.every((g) => g.passes >= 3 && g.score >= 0.9) && !groups.has("irregular"),
  };
}

module.exports = { analyse, valueAt, evaluate, sampleCycle, DT, JUMP };
