import { useEffect, useRef, useState } from "react";
import { getSequencePreview, type SequencePreview } from "@/lib/api";
import { effectHue } from "@/components/SequenceScope";
import { cn } from "@/lib/utils";

// A saved sequence's loop dials: one per effect, the same picture as the recorder
// — each channel's shape plotted around the dial over one pass. While the sequence
// plays, a hand sweeps each dial at the effect's real position in its loop (from
// the engine's playback clock) with a dot riding every shape, and the rim shows
// the fade level.

const previews = new Map<string, Promise<SequencePreview>>();
function loadPreview(id: string, created: number) {
  const key = `${id}@${created}`; // a re-used id is a different sequence
  let p = previews.get(key);
  if (!p) {
    p = getSequencePreview(id);
    p.catch(() => previews.delete(key));
    previews.set(key, p);
  }
  return p;
}

// Smooths the engine's elapsed time (arriving ~10×/s over the WebSocket) into a
// steady local clock, so the hands sweep without jitter but stay in step.
export function usePlaybackClock(elapsedMs: number | null) {
  const origin = useRef<number | null>(null); // performance.now() at the sequence's t = 0
  if (elapsedMs === null) origin.current = null;
  else {
    const candidate = performance.now() - elapsedMs;
    if (origin.current === null || Math.abs(candidate - origin.current) > 150) origin.current = candidate;
    else origin.current += (candidate - origin.current) * 0.1;
  }
  return origin;
}

export function SequenceDials({
  id,
  created,
  elapsedMs,
  level,
  max = 5,
  className,
}: {
  id: string;
  created: number;
  elapsedMs: number | null;
  level: number;
  max?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState<SequencePreview | null>(null);
  const origin = usePlaybackClock(elapsedMs);
  const live = useRef({ level, preview });
  live.current = { level, preview };

  useEffect(() => {
    let alive = true;
    loadPreview(id, created)
      .then((p) => alive && setPreview(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, created]);

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
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return;
      last = now;
      draw(c, now);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // draw reads everything through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw(c: HTMLCanvasElement, now: number) {
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr;
    const H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { level, preview } = live.current;
    if (!preview) return;
    const groups = preview.groups.slice(0, max);
    if (!groups.length) return;
    const playing = origin.current !== null;
    const t = playing ? now - (origin.current as number) : 0;
    const gap = 6;
    const R = Math.max(6, Math.min(H / 2 - 3, (W - gap * (groups.length - 1)) / groups.length / 2 - 3));
    const total = groups.length * 2 * (R + 3) + gap * (groups.length - 1);
    let x = (W - total) / 2 + R + 3;
    const cy = H / 2;

    groups.forEach((g, gi) => {
      const hue = effectHue(gi);
      const cx = x;
      x += 2 * (R + 3) + gap;
      const inner = R * 0.3;
      const radius = (v: number) => inner + (R - inner) * v;
      const alpha = playing ? 0.35 + 0.55 * level : 0.3;

      // dial
      ctx.lineWidth = 1;
      ctx.strokeStyle = "hsl(228 20% 60% / 0.12)";
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // shapes
      ctx.lineWidth = R > 20 ? 1.3 : 1;
      ctx.strokeStyle = `hsl(${hue} 90% 62% / ${alpha})`;
      for (const trace of g.traces) {
        ctx.beginPath();
        trace.forEach((v, i) => {
          const a = (i / trace.length) * Math.PI * 2 - Math.PI / 2;
          const px = cx + Math.cos(a) * radius(v);
          const py = cy + Math.sin(a) * radius(v);
          if (i) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
      }

      // level rim
      if (playing && level > 0) {
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.strokeStyle = `hsl(${hue} 90% 62% / 0.9)`;
        ctx.shadowColor = `hsl(${hue} 90% 62%)`;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(cx, cy, R + 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * level);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      if (!playing) return;
      // hand + a dot riding each shape, at the effect's position in its loop
      const phase = ((t / 1000) % g.period) / g.period;
      const a = phase * Math.PI * 2 - Math.PI / 2;
      ctx.lineWidth = 1;
      ctx.strokeStyle = `hsl(${hue} 90% 75% / 0.5)`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
      ctx.fillStyle = `hsl(${hue} 95% 75%)`;
      for (const trace of g.traces) {
        const pos = phase * trace.length;
        const i = Math.floor(pos) % trace.length;
        const f = pos - Math.floor(pos);
        const v = trace[i] + (trace[(i + 1) % trace.length] - trace[i]) * f;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * radius(v), cy + Math.sin(a) * radius(v), R > 20 ? 2.2 : 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  return <canvas ref={canvas} className={cn("block h-full w-full", className)} />;
}
