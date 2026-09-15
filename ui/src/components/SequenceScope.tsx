import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDmxFrames } from "@/lib/useDmx";
import type { SequenceGroup, SequenceMover } from "@/lib/api";
import { cn } from "@/lib/utils";

// Live picture of a chase being learned. It knows nothing about the patch, only
// what the analysis has found, so it draws what the numbers suggest:
//
//   - Orbits: one dial per repeating effect. Each moving channel is plotted around
//     the dial at its phase in the effect's period (radius = value). If the period
//     is right, every new pass lands on the last and the trace sharpens into a
//     closed shape; a wrong one smears into a spiral. The rim fills as passes are
//     seen and turns green once the loop is locked.
//   - Shapes: 16-bit channels two apart (pan, pan fine, tilt…) look like pan/tilt,
//     so they're drawn as an XY trail.
//   - Colour: three neighbouring 8-bit channels in the same effect look like RGB,
//     so they're drawn as swatches.
//   - Signal: a scrolling trace of everything that moves.
//
// Before the first analysis it shows which channels are moving, from the frames
// alone.

const HISTORY_MS = 30000;
const SIGNAL_MS = 10000;
const MAX_ORBITS = 6;
const MAX_PER_ORBIT = 8;
const MAX_SIGNAL = 24;

const HUES = [40, 188, 318, 145, 222, 12];
// Accent hue for the i-th effect of a saved sequence (same palette as the recorder).
export const effectHue = (i: number) => HUES[i % HUES.length];
const SAME_EFFECT = 0.03; // periods within 3% between analyses are the same effect

export interface EffectPalette {
  hueOf: (key: string) => number | null; // null = irregular
  slotOf: (key: string) => number; // first-seen order, for stable placement
}

// Colour and position per effect that stay put while a take is analysed again and
// again: group keys are renumbered every pass, so effects are matched by period.
// `take` changes → start over.
export function useEffectPalette(groups: SequenceGroup[], take: unknown): EffectPalette {
  const slots = useRef<number[]>([]); // period per slot
  const lastTake = useRef(take);
  if (lastTake.current !== take) {
    lastTake.current = take;
    slots.current = [];
  }
  return useMemo(() => {
    const byKey = new Map<string, number>();
    const taken = new Set<number>();
    for (const g of [...groups].sort((a, b) => b.channels - a.channels)) {
      if (!g.period) continue;
      let slot = slots.current.findIndex((p, i) => !taken.has(i) && Math.abs(p - g.period!) / g.period! <= SAME_EFFECT);
      if (slot < 0) slot = slots.current.push(g.period) - 1;
      slots.current[slot] = g.period;
      taken.add(slot);
      byKey.set(g.key, slot);
    }
    return {
      hueOf: (key) => (byKey.has(key) ? HUES[byKey.get(key)! % HUES.length] : null),
      slotOf: (key) => byKey.get(key) ?? 99,
    };
  }, [groups]);
}
const col = (hue: number | null, a: number, l = 62) => (hue === null ? `hsl(228 10% 70% / ${a})` : `hsl(${hue} 90% ${l}% / ${a})`);

interface Sample {
  t: number;
  f: Uint8Array;
}

type Pair = { pan: SequenceMover; tilt: SequenceMover };
type Triple = SequenceMover[];

// Guess what the movers are from their layout.
function guess(movers: SequenceMover[]) {
  const key = (m: SequenceMover) => `${m.universe}:${m.channel}`;
  const byKey = new Map(movers.map((m) => [key(m), m]));
  const used = new Set<string>();
  const pairs: Pair[] = [];
  for (const m of movers) {
    if (!m.wide || used.has(key(m))) continue;
    const t = byKey.get(`${m.universe}:${m.channel + 2}`);
    if (t && t.wide && !used.has(key(t))) {
      pairs.push({ pan: m, tilt: t });
      used.add(key(m));
      used.add(key(t));
    }
  }
  const triples: Triple[] = [];
  for (const m of movers) {
    if (m.wide || used.has(key(m))) continue;
    const g = byKey.get(`${m.universe}:${m.channel + 1}`);
    const b = byKey.get(`${m.universe}:${m.channel + 2}`);
    if (g && b && !g.wide && !b.wide && !used.has(key(g)) && !used.has(key(b)) && g.group === m.group && b.group === m.group) {
      triples.push([m, g, b]);
      used.add(key(m));
      used.add(key(g));
      used.add(key(b));
    }
  }
  return { pairs, triples };
}

export function SequenceScope({
  channels,
  movers,
  groups,
  palette,
  locked,
  className,
}: {
  channels: number;
  movers: SequenceMover[] | null;
  groups: SequenceGroup[];
  palette: EffectPalette;
  locked: boolean;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<Sample[]>([]);
  const activity = useRef<Float32Array | null>(null);
  const props = useRef({ movers, groups, palette, locked, channels });
  props.current = { movers, groups, palette, locked, channels };

  const onFrame = useCallback((f: Uint8Array) => {
    const t = performance.now();
    const h = history.current;
    const prev = h[h.length - 1];
    h.push({ t, f });
    while (h.length && t - h[0].t > HISTORY_MS) h.shift();
    // Client-side "is it moving" for before the analysis has an opinion.
    if (!activity.current || activity.current.length !== f.length) activity.current = new Float32Array(f.length);
    const act = activity.current;
    if (prev && prev.f.length === f.length) {
      for (let i = 0; i < f.length; i++) act[i] = act[i] * 0.96 + Math.abs(f[i] - prev.f[i]);
    }
  }, []);
  useDmxFrames(onFrame);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    });
    ro.observe(c);

    let raf = 0;
    let lastDraw = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - lastDraw < 30) return; // ~30 fps is plenty, and kind to a Pi
      lastDraw = now;
      draw(c, now);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  function draw(c: HTMLCanvasElement, now: number) {
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr;
    const H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { movers, groups, palette, locked, channels: C } = props.current;
    const hueOf = (key: string) => palette.hueOf(key);
    const h = history.current;
    const valueOf = (f: Uint8Array, m: SequenceMover) => {
      const i = m.universe * C + m.channel - 1;
      return m.wide ? (f[i] || 0) * 256 + (f[i + 1] || 0) : f[i] || 0;
    };
    // Observed range per mover over the history, for normalising.
    const range = new Map<SequenceMover, [number, number]>();
    const rangeOf = (m: SequenceMover) => {
      let r = range.get(m);
      if (!r) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < h.length; k += 2) {
          const v = valueOf(h[k].f, m);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        r = [lo, Math.max(hi, lo + 1)];
        range.set(m, r);
      }
      return r;
    };
    const norm = (v: number, m: SequenceMover) => {
      const [lo, hi] = rangeOf(m);
      return (v - lo) / (hi - lo);
    };

    const signalH = Math.min(90, H * 0.24);
    const topH = H - signalH - 12;
    const known = movers && movers.length > 0;

    // ---- orbits ----
    const regular = groups
      .filter((g) => g.key !== "irregular" && g.period)
      .sort((a, b) => palette.slotOf(a.key) - palette.slotOf(b.key))
      .slice(0, MAX_ORBITS);
    const orbitsW = known ? W * 0.62 : W;
    if (!known || !regular.length) {
      drawListening(ctx, orbitsW / 2, topH / 2, Math.min(orbitsW, topH) * 0.42, now);
    } else {
      // Each dial needs its rim + glow around it and a caption below: pick the grid
      // that gives the biggest dial with all of that inside its own cell.
      const n = regular.length;
      const RIM = 18; // rim offset + glow
      const CAPTION = 22;
      const radiusFor = (cols: number) => {
        const rows = Math.ceil(n / cols);
        return Math.min(orbitsW / cols / 2 - RIM, (topH / rows - CAPTION) / 2 - RIM);
      };
      let cols = 1;
      for (let c = 2; c <= n; c++) if (radiusFor(c) > radiusFor(cols)) cols = c;
      const rows = Math.ceil(n / cols);
      const cellW = orbitsW / cols;
      const cellH = topH / rows;
      const R = Math.max(12, Math.min(radiusFor(cols), 120));
      regular.forEach((g, gi) => {
        const row = Math.floor(gi / cols);
        // centre a short last row
        const inRow = row === rows - 1 ? n - row * cols : cols;
        const cx = (orbitsW - inRow * cellW) / 2 + cellW * (gi % cols) + cellW / 2;
        const cy = cellH * row + (cellH - CAPTION) / 2;
        const hue = hueOf(g.key);
        const periodMs = (g.period as number) * 1000;
        const passDone = Math.min(1, g.passes / 3);
        const good = g.passes >= 3 && g.score >= 0.9;

        // dial
        ctx.lineWidth = 1;
        ctx.strokeStyle = "hsl(228 20% 60% / 0.10)";
        for (const k of [0.35, 0.675, 1]) {
          ctx.beginPath();
          ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
          ctx.stroke();
        }
        // passes rim
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.strokeStyle = good ? "hsl(145 60% 55% / 0.9)" : col(hue, 0.85);
        ctx.shadowColor = good ? "hsl(145 60% 55%)" : col(hue, 1);
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, R + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * passDone);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // trails
        const members = (movers as SequenceMover[]).filter((m) => m.group === g.key).slice(0, MAX_PER_ORBIT);
        const span = Math.min(HISTORY_MS, periodMs * 3);
        members.forEach((m, mi) => {
          ctx.lineWidth = 1.4;
          let prevX = 0;
          let prevY = 0;
          let prevPhase = -1;
          for (let k = 0; k < h.length; k++) {
            const age = now - h[k].t;
            if (age > span) continue;
            const phase = (h[k].t % periodMs) / periodMs;
            const r = R * (0.35 + 0.65 * norm(valueOf(h[k].f, m), m));
            const a = phase * Math.PI * 2 - Math.PI / 2;
            const x = cx + Math.cos(a) * r;
            const y = cy + Math.sin(a) * r;
            if (prevPhase >= 0 && phase >= prevPhase) {
              const fresh = 1 - age / span;
              ctx.strokeStyle = col(hue, 0.08 + 0.75 * fresh * fresh, 55 + (mi % 3) * 8);
              ctx.beginPath();
              ctx.moveTo(prevX, prevY);
              ctx.lineTo(x, y);
              ctx.stroke();
            }
            prevX = x;
            prevY = y;
            prevPhase = phase;
          }
        });
        // sweep hand
        const phaseNow = (now % periodMs) / periodMs;
        const a = phaseNow * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = col(hue, 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();

        // labels
        ctx.fillStyle = "hsl(228 14% 93%)";
        ctx.font = "600 13px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        ctx.fillText(`${(g.period as number).toFixed(2)}s`, cx, cy + 4);
        ctx.font = "500 10px ui-sans-serif, system-ui";
        ctx.fillStyle = good ? "hsl(145 60% 60%)" : "hsl(228 10% 62%)";
        ctx.fillText(`${g.channels} ch · ${g.passes.toFixed(1)} passes · ${Math.round(g.score * 100)}%`, cx, cy + R + RIM + 12);
      });
    }

    // ---- shapes & colour ----
    if (known) {
      const x0 = orbitsW + 8;
      const w = W - x0;
      const { pairs, triples } = guess(movers as SequenceMover[]);
      const colourH = triples.length ? 54 : 0;
      const shapeH = topH - colourH - (colourH ? 10 : 0);
      if (pairs.length) {
        const size = Math.min(w, shapeH - 22) - 8;
        const sx = x0 + (w - size) / 2;
        const sy = (shapeH - size) / 2 + 11;
        ctx.strokeStyle = "hsl(228 20% 60% / 0.12)";
        ctx.lineWidth = 1;
        ctx.strokeRect(sx, sy, size, size);
        ctx.beginPath();
        ctx.moveTo(sx + size / 2, sy);
        ctx.lineTo(sx + size / 2, sy + size);
        ctx.moveTo(sx, sy + size / 2);
        ctx.lineTo(sx + size, sy + size / 2);
        ctx.stroke();
        // shared scale so relative positions stay true
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of pairs) for (const m of [p.pan, p.tilt]) {
          const [a, b] = rangeOf(m);
          lo = Math.min(lo, a);
          hi = Math.max(hi, b);
        }
        const pad = (hi - lo) * 0.12 + 1;
        const map = (v: number) => (v - lo + pad) / (hi - lo + 2 * pad);
        pairs.forEach((p) => {
          const hue = hueOf(p.pan.group);
          const trail = Math.min(HISTORY_MS, (p.pan.periods[0] || 4) * 1000);
          let first = true;
          ctx.lineWidth = 1.5;
          let px = 0;
          let py = 0;
          for (let k = 0; k < h.length; k++) {
            const age = now - h[k].t;
            if (age > trail) continue;
            const x = sx + map(valueOf(h[k].f, p.pan)) * size;
            const y = sy + (1 - map(valueOf(h[k].f, p.tilt))) * size;
            if (!first) {
              ctx.strokeStyle = col(hue, 0.05 + 0.7 * (1 - age / trail));
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(x, y);
              ctx.stroke();
            }
            first = false;
            px = x;
            py = y;
          }
          if (!first) {
            ctx.fillStyle = col(hue, 1, 70);
            ctx.shadowColor = col(hue, 1);
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        });
        caption(ctx, sx, sy - 6, `looks like pan / tilt · ${pairs.length} fixture${pairs.length > 1 ? "s" : ""}`);
      } else {
        // Nothing positional: pulse bars for whatever moves.
        const bars = (movers as SequenceMover[]).slice(0, 24);
        const bw = Math.max(3, (w - 16) / Math.max(1, bars.length) - 3);
        const latest = h[h.length - 1];
        bars.forEach((m, i) => {
          if (!latest) return;
          const v = norm(valueOf(latest.f, m), m);
          const hue = hueOf(m.group);
          const x = x0 + 8 + i * (bw + 3);
          const bh = Math.max(2, v * (shapeH - 30));
          ctx.fillStyle = col(hue, 0.25 + 0.6 * v);
          ctx.fillRect(x, shapeH - 8 - bh, bw, bh);
        });
        caption(ctx, x0 + 8, 14, "moving channels");
      }
      if (triples.length) {
        const y = topH - colourH / 2;
        const latest = h[h.length - 1];
        const n = Math.min(triples.length, Math.floor((w - 16) / 30));
        const step = (w - 16) / Math.max(1, n);
        for (let i = 0; i < n && latest; i++) {
          const [r, g, b] = triples[i].map((m) => valueOf(latest.f, m));
          const x = x0 + 8 + step * i + step / 2;
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          ctx.shadowColor = `rgb(${r}, ${g}, ${b})`;
          ctx.shadowBlur = 16;
          ctx.beginPath();
          ctx.arc(x, y + 6, Math.min(11, step / 2 - 3), 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        caption(ctx, x0 + 8, y - 14, `looks like colour · ${triples.length} RGB`);
      }
    }

    // ---- signal ----
    const sy0 = H - signalH;
    ctx.fillStyle = "hsl(232 14% 5% / 0.5)";
    ctx.fillRect(0, sy0, W, signalH);
    let traces: { m: SequenceMover; hue: number | null }[];
    if (known) {
      traces = (movers as SequenceMover[]).slice(0, MAX_SIGNAL).map((m) => ({ m, hue: hueOf(m.group) }));
    } else {
      // Before analysis: the busiest channels by recent change.
      const act = activity.current;
      const picks: { i: number; a: number }[] = [];
      if (act) for (let i = 0; i < act.length; i++) if (act[i] > 3) picks.push({ i, a: act[i] });
      picks.sort((a, b) => b.a - a.a);
      traces = picks.slice(0, MAX_SIGNAL).map(({ i }) => ({
        m: { universe: Math.floor(i / C), channel: (i % C) + 1, wide: false, group: "", periods: [] },
        hue: 40,
      }));
      caption(ctx, 10, sy0 + 14, traces.length ? `${picks.length} channel${picks.length > 1 ? "s" : ""} moving` : "no movement yet");
    }
    traces.forEach(({ m, hue }, ti) => {
      ctx.strokeStyle = col(hue, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      const lane = ((ti % 6) - 2.5) * 2;
      for (let k = 0; k < h.length; k++) {
        const age = now - h[k].t;
        if (age > SIGNAL_MS) continue;
        const x = W - (age / SIGNAL_MS) * W;
        const y = sy0 + signalH - 6 - norm(valueOf(h[k].f, m), m) * (signalH - 16) + lane;
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
    });
    if (locked) {
      ctx.font = "700 10px ui-sans-serif, system-ui";
      ctx.textAlign = "right";
      const tw = ctx.measureText("LOOP LOCKED").width;
      ctx.fillStyle = "hsl(232 14% 6% / 0.85)";
      ctx.fillRect(W - tw - 18, sy0 + 3, tw + 14, 16);
      ctx.fillStyle = "hsl(145 60% 60%)";
      ctx.fillText("LOOP LOCKED", W - 11, sy0 + 15);
    }
  }

  return <canvas ref={canvas} className={cn("block h-full w-full", className)} />;
}

function caption(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.fillStyle = "hsl(228 10% 60%)";
  ctx.font = "600 9px ui-sans-serif, system-ui";
  ctx.textAlign = "left";
  ctx.fillText(text.toUpperCase(), x, y);
}

// Radar sweep while there's nothing to plot yet.
function drawListening(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, now: number) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = "hsl(40 90% 60% / 0.12)";
  for (const k of [0.33, 0.66, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  const a = ((now / 2400) % 1) * Math.PI * 2;
  for (let i = 0; i < 24; i++) {
    const aa = a - i * 0.045;
    ctx.strokeStyle = `hsl(40 90% 60% / ${0.5 * (1 - i / 24)})`;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(aa) * R, cy + Math.sin(aa) * R);
    ctx.stroke();
  }
  ctx.fillStyle = "hsl(228 10% 62%)";
  ctx.font = "600 10px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.fillText("LISTENING FOR A LOOP", cx, cy + R + 18);
}
