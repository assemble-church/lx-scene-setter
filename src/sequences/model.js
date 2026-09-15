// Stored sequence models, and compiling them for playback.
//
// A saved model is the reviewed analysis, trimmed to what plays back:
//   {
//     version: 1,
//     durationMs,                      // length of the take it came from
//     groups: [{ key, period, channels, wide, layered, universes, score, passes }],
//     still: [[universe, channel, value], …],   // lit still channels only (HTP look)
//     motion: [{ u, ch, wide, base, components: [{ period, cycle: [...] }] }],
//   }
// Channels are 1-based. A `wide` motion entry drives ch (coarse) and ch + 1 (fine).
// Still channels at 0 are never stored: they'd contribute nothing to an HTP merge.

const { evaluate } = require("./analyse");

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

// Reviewed analysis → stored model. `groups`: keys to keep (default all);
// `includeStill`: keep the still look (default true).
function buildModel(analysis, { groups, includeStill = true } = {}) {
  const keep = new Set(Array.isArray(groups) ? groups : analysis.groups.map((g) => g.key));
  const groupOf = (c) => (c.irregular ? "irregular" : `p${c.cluster}`);
  const motion = analysis.channels
    .filter((c) => c.kind === "motion" && keep.has(groupOf(c)))
    .map((c) => ({
      u: c.universe,
      ch: c.channel,
      wide: !!c.wide,
      base: round(c.base, 2),
      components: c.components.map((k) => ({
        period: k.period,
        cycle: Array.from(k.cycle, (v) => round(v, c.wide ? 0 : 2)),
      })),
    }));
  const still = includeStill
    ? analysis.channels.filter((c) => c.kind === "static" && c.value > 0).map((c) => [c.universe, c.channel, c.value])
    : [];
  return {
    version: 1,
    durationMs: analysis.durationMs,
    groups: analysis.groups.filter((g) => keep.has(g.key)),
    still,
    motion,
  };
}

// Stored model → playback form: typed arrays for the stills, cycles as Float64Array.
function compileModel(model) {
  const still = Array.isArray(model.still) ? model.still : [];
  const motion = (Array.isArray(model.motion) ? model.motion : []).map((m) => ({
    u: m.u | 0,
    ch: (m.ch | 0) - 1, // 0-based
    wide: !!m.wide,
    model: {
      wide: !!m.wide,
      base: Number(m.base) || 0,
      components: (m.components || []).map((k) => ({ period: Number(k.period), cycle: Float64Array.from(k.cycle || []) })),
    },
  }));
  let universes = 0;
  for (const [u] of still) universes = Math.max(universes, u + 1);
  for (const m of motion) universes = Math.max(universes, m.u + 1);
  return {
    stillU: Uint16Array.from(still, (s) => s[0]),
    stillCh: Uint16Array.from(still, (s) => s[1] - 1),
    stillV: Uint8Array.from(still, (s) => s[2]),
    motion,
    universes,
  };
}

// Value (0..255, or 0..65535 for wide) of a compiled motion entry at t seconds.
function motionValue(entry, t) {
  return evaluate(entry.model, t);
}

const PREVIEW_POINTS = 64;
const PREVIEW_TRACES = 6;

// What the UI's loop dials draw: per effect, its period and a few channels' shapes
// over one pass (0..1, downsampled). A layered channel contributes the layer that
// matches the effect; a take loop ("irregular") uses the take length.
function previewModel(model) {
  const takeSec = (model.durationMs || 0) / 1000;
  const groups = (model.groups || []).map((g) => ({ key: g.key, period: g.period || takeSec, traces: [] }));
  for (const m of model.motion || []) {
    for (const g of groups) {
      if (g.traces.length >= PREVIEW_TRACES) continue;
      const k = (m.components || []).find((c) => Math.abs(c.period - g.period) / g.period < 0.01);
      if (!k || !k.cycle.length) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of k.cycle) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo < (m.wide ? 256 : 1)) continue;
      const n = k.cycle.length;
      g.traces.push(Array.from({ length: PREVIEW_POINTS }, (_, i) => round((k.cycle[Math.floor((i / PREVIEW_POINTS) * n)] - lo) / (hi - lo), 3)));
      break;
    }
  }
  return { groups: groups.filter((g) => g.traces.length) };
}

// A short description for lists: what moves, how fast.
function describeModel(model) {
  const groups = model.groups || [];
  const periods = groups.filter((g) => g.period).map((g) => g.period);
  let movingChannels = 0;
  for (const m of model.motion || []) movingChannels += m.wide ? 2 : 1;
  return {
    groups: groups.length,
    periods: periods.map((p) => round(p, 2)),
    movingChannels,
    stillLit: (model.still || []).length,
    universes: [...new Set([...(model.motion || []).map((m) => m.u), ...(model.still || []).map((s) => s[0])])].sort((a, b) => a - b),
    irregular: groups.some((g) => g.key === "irregular"),
  };
}

module.exports = { buildModel, compileModel, motionValue, describeModel, previewModel };
