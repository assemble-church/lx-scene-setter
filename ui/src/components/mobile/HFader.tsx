import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// A horizontal fader for a thumb. The meter shows the channel's live output; the
// handle sits at `value` (where the user or a fade has it) or at the drag position
// while touched. Sends throttled while dragging, a final value on release.

const SEND_EVERY_MS = 40;
const HANDLE = 14; // px

export function HFader({
  value,
  live,
  tone = "hand",
  disabled,
  onChange,
  className,
}: {
  value: number; // 0..100 handle position
  live: number; // 0..100 what's actually going out
  tone?: "hand" | "scene"; // amber by hand, green when the scenes are driving it
  disabled?: boolean;
  onChange: (v: number, final: boolean) => void;
  className?: string;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const lastSent = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const released = useRef(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shown = drag ?? value;

  function fromEvent(e: React.PointerEvent) {
    const r = track.current!.getBoundingClientRect();
    const v = (e.clientX - r.left - HANDLE / 2) / (r.width - HANDLE);
    return Math.round(Math.min(1, Math.max(0, v)) * 100);
  }
  function send(v: number, final = false) {
    const t = performance.now();
    if (final || t - lastSent.current >= SEND_EVERY_MS) {
      lastSent.current = t;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      onChange(v, final);
    } else {
      pending.current = v;
      if (!timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          if (pending.current != null) send(pending.current, true);
        }, SEND_EVERY_MS);
      }
    }
  }
  function down(e: React.PointerEvent) {
    if (disabled) return;
    released.current = false;
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = fromEvent(e);
    setDrag(v);
    send(v);
  }
  function move(e: React.PointerEvent) {
    if (drag == null || released.current) return;
    const v = fromEvent(e);
    setDrag(v);
    send(v);
  }
  function up(e: React.PointerEvent) {
    if (drag == null || released.current) return;
    const v = fromEvent(e);
    send(v, true);
    setDrag(v);
    // Hold the released position until the engine's value catches up (~10×/s),
    // so the handle doesn't jump back for a frame.
    released.current = true;
    releaseTimer.current = setTimeout(() => {
      released.current = false;
      setDrag(null);
    }, 800);
  }
  useEffect(() => {
    if (released.current && drag != null && Math.abs(value - drag) < 2) {
      released.current = false;
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
      setDrag(null);
    }
  }, [value, drag]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
    },
    []
  );

  const colour = tone === "hand" ? "var(--primary)" : "var(--live)";
  const motion = drag == null ? "100ms linear" : "none";

  return (
    <div
      ref={track}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className={cn(
        "relative h-12 flex-1 touch-none select-none overflow-hidden rounded-xl bg-black/50 shadow-[inset_0_1px_3px_hsl(0_0%_0%/0.8)] ring-1 ring-inset ring-white/[0.06]",
        disabled && "opacity-50",
        className
      )}
    >
      {[25, 50, 75].map((t) => (
        <span key={t} className="absolute inset-y-0 w-px bg-white/[0.06]" style={{ left: `${t}%` }} />
      ))}
      {/* live meter */}
      <span
        className="absolute inset-y-0 left-0"
        style={{
          width: `${live}%`,
          background: `linear-gradient(90deg, hsl(${colour} / 0.35), hsl(${colour} / 0.85))`,
          boxShadow: `0 0 16px hsl(${colour} / ${0.1 + (live / 100) * 0.4})`,
          transition: `width ${motion}, background 200ms`,
        }}
      />
      {/* handle */}
      <span
        className={cn(
          "absolute inset-y-1 w-[14px] rounded-md border border-white/20 bg-gradient-to-b from-zinc-200 to-zinc-500 shadow-[0_2px_6px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.6)]",
          drag != null && "from-white to-zinc-400"
        )}
        style={{ left: `calc(${shown / 100} * (100% - ${HANDLE}px))`, transition: motion === "none" ? "none" : `left ${motion}` }}
      >
        <span className="absolute inset-x-[5px] top-1/2 h-3 -translate-y-1/2 border-x border-black/40" />
      </span>
    </div>
  );
}
