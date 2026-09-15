import { useCallback, useEffect, useRef } from "react";
import { useDmxFrames } from "@/lib/useDmx";
import { cn } from "@/lib/utils";

// Scalable live picture of one universe: a canvas grid, one cell per channel,
// dark → green by level. Fills whatever box it's given (any size from a 64px
// top-bar chip to a full-width panel); the aspect ratio follows the grid.

const COLS = 32; // 512 channels → 32 × 16

function cellColour(v: number) {
  if (v === 0) return "hsl(232 12% 13%)";
  const l = 14 + (v / 255) * 44;
  return `hsl(140 70% ${l}%)`;
}

export function UniverseViz({
  universe,
  channels = 512,
  label,
  className,
}: {
  universe: number;
  channels?: number;
  label?: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<Uint8Array | null>(null);
  const rows = Math.ceil(channels / COLS);

  // Draw the last frame at the current canvas size.
  const draw = useCallback(() => {
    const c = canvas.current;
    const f = frame.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const cw = w / COLS;
    const ch = h / rows;
    const gap = cw > 4 ? 1 : 0; // hairline gaps once cells are big enough to show them
    const base = universe * channels;
    for (let i = 0; i < channels; i++) {
      const v = f ? f[base + i] || 0 : 0;
      ctx.fillStyle = cellColour(v);
      const x = (i % COLS) * cw;
      const y = Math.floor(i / COLS) * ch;
      ctx.fillRect(x, y, Math.max(1, cw - gap), Math.max(1, ch - gap));
    }
  }, [universe, channels, rows]);

  // Size the backing store to the element (HiDPI aware) and redraw on resize.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      draw();
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [draw]);

  const onFrame = useCallback(
    (f: Uint8Array) => {
      frame.current = f;
      draw();
    },
    [draw]
  );
  useDmxFrames(onFrame);

  return (
    <div
      className={cn("relative overflow-hidden rounded-md bg-black/40 ring-1 ring-inset ring-white/[0.06]", className)}
      style={{ aspectRatio: `${COLS} / ${rows}` }}
      title={label ?? `Universe ${universe}`}
    >
      <canvas ref={canvas} className="block h-full w-full" />
      {label && (
        <span className="pointer-events-none absolute left-1 top-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/60 [text-shadow:0_0_4px_rgba(0,0,0,0.9)]">
          {label}
        </span>
      )}
    </div>
  );
}
