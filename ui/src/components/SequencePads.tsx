import { Waves } from "lucide-react";
import { command, type SequenceStatus } from "@/lib/api";
import { SequenceDials } from "@/components/SequenceDials";
import { cn } from "@/lib/utils";

// Sequence buttons: press to run (fades in), press again to stop (fades out). The
// dials show the loops, sweeping at their real position while it plays.
//
// Every state change is colour and opacity only, inside a fixed box: nothing
// here may change size, so pressing a pad never moves the page.

// Room for each dial. Sized from the effect count in the engine state (not the
// shapes, which load later), so a pad is its final size from its first render.
const DIAL = 64;

export function SequencePad({ s, fade, disabled }: { s: SequenceStatus; fade: number; disabled?: boolean }) {
  const fading = s.state === 2;
  const width = Math.min(360, Math.max(208, Math.min(s.groups, 5) * DIAL + 20));
  return (
    <button
      disabled={disabled}
      onClick={() => command(`/sequence/${s.id}/toggle`, [fade]).catch(() => {})}
      className={cn(
        "group relative flex h-[116px] shrink-0 flex-col overflow-hidden rounded-xl text-left ring-1 ring-inset transition-colors active:brightness-110 disabled:pointer-events-none disabled:opacity-50",
        s.on
          ? "bg-live/[0.10] ring-live/40 shadow-[0_0_24px_-8px_hsl(var(--live))]"
          : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06] hover:ring-white/20"
      )}
      style={{ width }}
    >
      {fading && <span className="stripe-busy pointer-events-none absolute inset-0" />}
      <span className="relative flex h-8 shrink-0 items-center gap-2 px-3">
        <Waves className={cn("h-3.5 w-3.5 shrink-0", s.on ? "text-live" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{s.label || `Sequence ${s.id}`}</span>
        <span className={cn("tabular w-14 shrink-0 text-right text-[10px] font-semibold uppercase tracking-[0.1em]", s.on ? "text-live" : "text-muted-foreground/60")}>
          {fading ? `${s.fadeRemaining.toFixed(1)}s` : s.on ? "running" : "off"}
        </span>
      </span>
      <span className="relative min-h-0 flex-1 px-2 pb-2">
        <SequenceDials id={s.id} created={s.created} elapsedMs={s.elapsedMs} level={s.level} />
      </span>
      {/* level */}
      <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/[0.05]">
        <span className="block h-full bg-live shadow-[0_0_8px_hsl(var(--live))]" style={{ width: `${s.level * 100}%` }} />
      </span>
    </button>
  );
}
