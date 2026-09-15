import { useEffect, useRef, useState } from "react";
import { Star, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { command, setFavourite, setSceneLevel, type SceneStatus } from "@/lib/api";

// One lighting-desk channel strip for a scene: label, SOLO / FULL above the
// fader, a draggable fader with a live level meter, ON / FLASH below.

const FADE = 2; // seconds, for the buttons (faders move instantly)
const SEND_EVERY_MS = 40; // throttle while dragging

function DeskButton({
  children,
  lit,
  tone = "amber",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { lit?: boolean; tone?: "amber" | "live" | "info" }) {
  const tones = {
    amber: "text-primary ring-primary/60 bg-primary/25 shadow-[0_0_14px_-2px_hsl(var(--primary)/0.9)]",
    live: "text-live ring-live/60 bg-live/25 shadow-[0_0_14px_-2px_hsl(var(--live)/0.9)]",
    info: "text-info ring-info/60 bg-info/25 shadow-[0_0_14px_-2px_hsl(var(--info)/0.9)]",
  };
  return (
    <button
      {...props}
      className={cn(
        "flex h-8 w-full select-none items-center justify-center gap-1 rounded-md text-[10px] font-bold uppercase tracking-[0.12em] ring-1 ring-inset transition-all active:translate-y-px disabled:opacity-40",
        lit ? tones[tone] : "bg-white/[0.04] text-muted-foreground ring-white/10 hover:bg-white/[0.08] hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  );
}

// Draining bar for a strip that's about to leave the console: full → empty until
// `until` (epoch ms), out of `total` ms. Restarts whenever `until` changes.
function LingerBar({ until, total }: { until: number; total: number }) {
  const bar = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const remaining = Math.max(0, until - Date.now());
    const anim = el.animate([{ transform: `scaleX(${Math.min(1, remaining / total)})` }, { transform: "scaleX(0)" }], {
      duration: remaining,
      easing: "linear",
      fill: "forwards",
    });
    return () => anim.cancel();
  }, [until, total]);
  return (
    <span
      className="absolute inset-x-0 bottom-0 h-[3px] bg-white/[0.06]"
      title={`Leaves the console ${Math.round(total / 1000)}s after going to zero — bring it back up to keep it`}
    >
      <span ref={bar} className="block h-full origin-left bg-busy shadow-[0_0_8px_hsl(var(--busy))]" />
    </span>
  );
}

export function SceneStrip({
  scene,
  disabled,
  lingerUntil,
  lingerTotal = 10000,
}: {
  scene: SceneStatus;
  disabled?: boolean;
  lingerUntil?: number; // set while a non-favourite is at zero and counting down to leave the console
  lingerTotal?: number;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null); // local fader position while dragging
  const lastSent = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashFrom = useRef<number | null>(null);
  const released = useRef(false); // pointer up, waiting for the engine level to match
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One value drives the meter, the handle and the readout, so the handle is stuck
  // to the top of the bar: the live level, or the drag position while dragging.
  const shown = drag ?? scene.level;
  const pct = Math.round(shown * 100);
  const hue = Math.round(shown * 120);
  const motion = drag == null ? "100ms linear" : "none";
  const on = scene.on;
  const fading = scene.state === 2;

  function levelFromEvent(e: React.PointerEvent | PointerEvent) {
    const r = track.current!.getBoundingClientRect();
    const v = 1 - (e.clientY - r.top) / r.height;
    return Math.min(1, Math.max(0, Math.round(v * 100) / 100));
  }

  function send(level: number, final = false) {
    const now = performance.now();
    if (final || now - lastSent.current >= SEND_EVERY_MS) {
      lastSent.current = now;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setSceneLevel(scene.id, level, 0);
    } else {
      pending.current = level;
      if (!timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          if (pending.current != null) send(pending.current, true);
        }, SEND_EVERY_MS);
      }
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (disabled) return;
    released.current = false;
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = levelFromEvent(e);
    setDrag(v);
    send(v);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (drag == null || released.current) return;
    const v = levelFromEvent(e);
    setDrag(v);
    send(v);
  }
  function onPointerUp(e: React.PointerEvent) {
    if (drag == null || released.current) return;
    const v = levelFromEvent(e);
    send(v, true);
    setDrag(v);
    // Keep showing the released position until the engine's level catches up
    // (it arrives ~10×/s), so the handle doesn't snap back for a frame.
    released.current = true;
    releaseTimer.current = setTimeout(() => {
      released.current = false;
      setDrag(null);
    }, 800);
  }
  useEffect(() => {
    if (released.current && drag != null && Math.abs(scene.level - drag) < 0.015) {
      released.current = false;
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
      setDrag(null);
    }
  }, [scene.level, drag]);

  // Flash: full while held, back to where it was on release.
  function flashDown() {
    if (disabled) return;
    flashFrom.current = scene.target;
    setSceneLevel(scene.id, 1, 0);
  }
  function flashUp() {
    if (flashFrom.current == null) return;
    setSceneLevel(scene.id, flashFrom.current, 0);
    flashFrom.current = null;
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
  }, []);

  const ticks = [100, 75, 50, 25, 0];

  return (
    <div
      className={cn(
        "relative flex w-[104px] shrink-0 flex-col items-stretch gap-2 border-r border-white/[0.07] px-2 pb-2 pt-3 transition-colors",
        on ? "bg-live/[0.05]" : "bg-transparent",
        disabled && "opacity-60"
      )}
    >
      {lingerUntil !== undefined && <LingerBar until={lingerUntil} total={lingerTotal} />}
      {/* channel colour bar: lit when the scene is up */}
      <span
        className={cn(
          "absolute inset-x-0 top-0 h-[3px] transition-colors",
          fading ? "bg-busy shadow-[0_0_10px_hsl(var(--busy))]" : on ? "bg-live shadow-[0_0_10px_hsl(var(--live))]" : "bg-white/[0.08]"
        )}
      />
      {/* header: id + favourite, label */}
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] leading-none text-muted-foreground">#{scene.id}</div>
          <div className="mt-1 line-clamp-2 text-[11px] font-semibold leading-tight" title={scene.label || `Scene ${scene.id}`}>
            {scene.label || `Scene ${scene.id}`}
          </div>
        </div>
        <button
          onClick={() => setFavourite(scene.id, !scene.favourite).catch(() => {})}
          title={scene.favourite ? "Unpin from console" : "Pin to console"}
          className={cn(
            "-mr-0.5 -mt-0.5 rounded p-0.5 transition-colors",
            scene.favourite ? "text-primary" : "text-muted-foreground/40 hover:text-foreground"
          )}
        >
          <Star className={cn("h-3.5 w-3.5", scene.favourite && "fill-current")} />
        </button>
      </div>

      {/* above the fader */}
      <div className="grid grid-cols-2 gap-1">
        <DeskButton title="Solo — this scene on, everything else off" disabled={disabled} onClick={() => command(`/scene/${scene.id}/play`, [FADE])}>
          Solo
        </DeskButton>
        <DeskButton title="Full — fade to 100%" disabled={disabled} lit={on && scene.target >= 1} tone="live" onClick={() => command(`/scene/${scene.id}/on`, [FADE])}>
          Full
        </DeskButton>
      </div>

      {/* fader */}
      <div className="flex flex-1 items-stretch gap-1.5 py-1">
        <div className="flex w-5 flex-col justify-between py-[3px] text-right font-mono text-[8px] leading-none text-muted-foreground/60">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div
          ref={track}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={cn(
            "relative min-h-[176px] flex-1 touch-none select-none overflow-visible rounded-md bg-black/50 shadow-[inset_0_1px_3px_hsl(0_0%_0%/0.8)] ring-1 ring-inset ring-white/[0.06]",
            disabled ? "cursor-not-allowed" : "cursor-ns-resize"
          )}
        >
          {/* tick marks */}
          {ticks.map((t) => (
            <span key={t} className="absolute left-0 right-0 h-px bg-white/[0.06]" style={{ top: `${100 - t}%` }} />
          ))}
          {/* live level meter */}
          <div
            className={cn("absolute inset-x-0 bottom-0 rounded-b-md", fading && "stripe-busy")}
            style={{
              height: `${shown * 100}%`,
              background: `linear-gradient(180deg, hsl(${hue} 75% 52%), hsl(${hue} 75% 32%))`,
              boxShadow: `0 0 14px hsl(${hue} 75% 50% / ${0.15 + shown * 0.5})`,
              transition: motion === "none" ? "none" : `height ${motion}`,
            }}
          />
          {/* fader cap, centred on the top of the meter */}
          <div
            className={cn(
              "absolute -left-1 -right-1 h-3.5 rounded-sm border border-white/20 bg-gradient-to-b from-zinc-200 to-zinc-500 shadow-[0_2px_6px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.6)]",
              drag != null && "from-white to-zinc-400"
            )}
            style={{ top: `calc(${(1 - shown) * 100}% - 7px)`, transition: motion === "none" ? "none" : `top ${motion}` }}
          >
            <div className="mx-auto mt-[5px] h-px w-3/4 bg-black/60" />
          </div>
        </div>
      </div>

      {/* readout */}
      <div className="flex items-baseline justify-between px-0.5">
        <span className={cn("tabular text-lg font-semibold leading-none", on ? "text-foreground" : "text-muted-foreground")}>
          {pct}
          <span className="text-[10px] text-muted-foreground">%</span>
        </span>
        <span className={cn("text-[9px] font-semibold uppercase tracking-[0.12em]", fading ? "text-busy" : on ? "text-live" : "text-muted-foreground/60")}>
          {fading ? `${scene.fadeRemaining.toFixed(1)}s` : on ? "on" : "off"}
        </span>
      </div>

      {/* below the fader */}
      <div className="grid grid-cols-2 gap-1">
        <DeskButton
          title={on ? "Fade out" : "Fade in"}
          disabled={disabled}
          lit={on}
          tone="live"
          onClick={() => command(`/scene/${scene.id}/${on ? "off" : "on"}`, [FADE])}
        >
          {on ? "On" : "Off"}
        </DeskButton>
        <DeskButton
          title="Flash — full while held"
          disabled={disabled}
          lit={flashFrom.current != null}
          onPointerDown={flashDown}
          onPointerUp={flashUp}
          onPointerLeave={flashUp}
          onPointerCancel={flashUp}
        >
          <Zap className="h-3 w-3" /> Flash
        </DeskButton>
      </div>
    </div>
  );
}
