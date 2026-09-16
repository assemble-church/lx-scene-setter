import { useEffect, useState, type ReactNode } from "react";
import { Star, Waves, Power, Lock, Hand } from "lucide-react";
import { cn } from "@/lib/utils";
import { command, type EngineState, type SceneStatus, type SequenceStatus } from "@/lib/api";
import { useLongPress } from "./useLongPress";

// Trigger mode: big pads. Tap a scene to fade it in or out; hold one for solo
// (that scene alone). Sequences run and stop on a tap. "All off" needs a hold so
// a pocket can't black the room out.

const FADE = 2; // seconds

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</span>
        {count !== undefined && <span className="tabular text-[11px] text-muted-foreground/60">{count}</span>}
      </header>
      {children}
    </section>
  );
}

// Grows up from the bottom while the finger is down, so the hold reads as progress.
function HoldFill({ ms }: { ms: number }) {
  return <span className="hold-fill pointer-events-none absolute inset-0 bg-primary/20" style={{ animationDuration: `${ms}ms` }} />;
}

function Readout({ on, fading, remaining, level }: { on: boolean; fading: boolean; remaining: number; level: number }) {
  return (
    <span className="relative flex items-end justify-between">
      <span className={cn("text-[10px] font-semibold uppercase tracking-[0.14em]", fading ? "text-busy" : on ? "text-live" : "text-muted-foreground/50")}>
        {fading ? `${remaining.toFixed(1)}s` : on ? "on" : "off"}
      </span>
      <span className={cn("tabular text-lg font-semibold leading-none", on ? "text-foreground" : "text-muted-foreground/40")}>
        {Math.round(level * 100)}
        <span className="text-[10px] text-muted-foreground">%</span>
      </span>
    </span>
  );
}

function LevelBar({ level }: { level: number }) {
  return (
    <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/[0.05]">
      <span className="block h-full bg-live shadow-[0_0_10px_hsl(var(--live))] transition-[width] duration-100 ease-linear" style={{ width: `${level * 100}%` }} />
    </span>
  );
}

const padClass = (on: boolean, holding: boolean) =>
  cn(
    "tap relative flex h-[92px] flex-col justify-between overflow-hidden rounded-2xl p-3 text-left ring-1 ring-inset transition-[background-color,box-shadow,transform] duration-150 disabled:opacity-40",
    on ? "bg-live/[0.12] ring-live/40 shadow-[0_0_28px_-10px_hsl(var(--live))]" : "bg-white/[0.035] ring-white/10",
    holding && "scale-[0.97]"
  );

function ScenePad({ s, disabled }: { s: SceneStatus; disabled: boolean }) {
  const fading = s.state === 2;
  const HOLD = 550;
  const { handlers, holding } = useLongPress({
    disabled,
    ms: HOLD,
    onTap: () => command(`/scene/${s.id}/toggle`, [FADE]).catch(() => {}),
    onHold: () => command(`/scene/${s.id}/play`, [FADE]).catch(() => {}),
  });
  return (
    <button {...handlers} disabled={disabled} className={padClass(s.on, holding)}>
      {fading && <span className="stripe-busy pointer-events-none absolute inset-0 opacity-60" />}
      {holding && <HoldFill ms={HOLD} />}
      <span className="relative flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-[15px] font-semibold leading-snug">{s.label || `Scene ${s.id}`}</span>
        {s.favourite && <Star className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-current text-primary/80" />}
      </span>
      <Readout on={s.on} fading={fading} remaining={s.fadeRemaining} level={s.level} />
      <LevelBar level={s.level} />
    </button>
  );
}

function SequencePad({ s, disabled }: { s: SequenceStatus; disabled: boolean }) {
  const fading = s.state === 2;
  const { handlers, holding } = useLongPress({
    disabled,
    onTap: () => command(`/sequence/${s.id}/toggle`, [FADE]).catch(() => {}),
  });
  return (
    <button {...handlers} disabled={disabled} className={padClass(s.on, holding)}>
      {fading && <span className="stripe-busy pointer-events-none absolute inset-0 opacity-60" />}
      <span className="relative flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-[15px] font-semibold leading-snug">{s.label || `Sequence ${s.id}`}</span>
        <Waves className={cn("mt-0.5 h-4 w-4 shrink-0", s.on ? "text-live" : "text-muted-foreground/60")} />
      </span>
      <span className="relative flex items-end justify-between">
        <span className={cn("text-[10px] font-semibold uppercase tracking-[0.14em]", fading ? "text-busy" : s.on ? "text-live" : "text-muted-foreground/50")}>
          {fading ? `${s.fadeRemaining.toFixed(1)}s` : s.on ? "running" : "off"}
        </span>
        <span className="tabular text-[11px] text-muted-foreground/60">{s.periods.map((p) => `${p.toFixed(1)}s`).join(" · ")}</span>
      </span>
      <LevelBar level={s.level} />
    </button>
  );
}

// Everything off — a hold, with a nudge if it's only tapped.
function AllOff({ disabled, anythingOn }: { disabled: boolean; anythingOn: boolean }) {
  const HOLD = 700;
  const [nudge, setNudge] = useState(false);
  const { handlers, holding } = useLongPress({
    disabled,
    ms: HOLD,
    onTap: () => setNudge(true),
    onHold: () => command("/scenes/off", [FADE]).catch(() => {}),
  });
  useEffect(() => {
    if (!nudge) return;
    const id = setTimeout(() => setNudge(false), 1600);
    return () => clearTimeout(id);
  }, [nudge]);
  return (
    <button
      {...handlers}
      disabled={disabled}
      className={cn(
        "tap relative flex h-14 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl text-sm font-semibold ring-1 ring-inset transition-[transform,background-color] duration-150 disabled:opacity-40",
        anythingOn ? "bg-pgm/10 text-pgm ring-pgm/30" : "bg-white/[0.03] text-muted-foreground ring-white/10",
        holding && "scale-[0.98]"
      )}
    >
      {holding && <span className="hold-fill pointer-events-none absolute inset-0 bg-pgm/25" style={{ animationDuration: `${HOLD}ms` }} />}
      <Power className="relative h-4 w-4" />
      <span className="relative">{nudge ? "Hold to fade everything out" : "All off"}</span>
    </button>
  );
}

function Notice({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="glass glow-amber flex items-center gap-3 rounded-2xl px-4 py-3">
      <span className="text-busy">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-[12px] leading-snug text-muted-foreground">{text}</div>
      </div>
      {action}
    </div>
  );
}

export function TriggerMode({ state, locked }: { state: EngineState; locked: boolean }) {
  const favourites = state.scenes.filter((s) => s.favourite);
  const others = state.scenes.filter((s) => !s.favourite);
  const anythingOn = state.activeScenes.length + state.activeSequences.length > 0 || state.holding;

  return (
    <div className="space-y-5">
      {state.consoleActive ? (
        <Notice icon={<Lock className="h-5 w-5" />} title="Desk is live" text="The lighting desk is driving the rig. Scenes are locked until it goes quiet." />
      ) : state.programmerActive || state.editing ? (
        <Notice
          icon={<Lock className="h-5 w-5" />}
          title={state.editing ? `Editing scene ${state.editing}` : "Programmer live"}
          text="Someone is building a look on the Fixtures page. Scenes are locked until they finish."
        />
      ) : state.holding ? (
        <Notice
          icon={<Hand className="h-5 w-5" />}
          title="Holding the desk's last look"
          text="The desk went away. Press a scene to crossfade out of its look, or release it."
          action={
            <button
              onClick={() => command("/hold/release", [FADE]).catch(() => {})}
              className="tap h-9 shrink-0 rounded-lg bg-busy/15 px-3 text-xs font-semibold text-busy ring-1 ring-inset ring-busy/40 active:bg-busy/25"
            >
              Release
            </button>
          }
        />
      ) : null}

      {favourites.length > 0 && (
        <Section title="Favourites" count={favourites.length}>
          <div className="grid grid-cols-2 gap-2.5">
            {favourites.map((s) => (
              <ScenePad key={s.id} s={s} disabled={locked} />
            ))}
          </div>
        </Section>
      )}

      <Section title={favourites.length ? "More scenes" : "Scenes"} count={others.length}>
        {others.length ? (
          <div className="grid grid-cols-2 gap-2.5">
            {others.map((s) => (
              <ScenePad key={s.id} s={s} disabled={locked} />
            ))}
          </div>
        ) : (
          <p className="rounded-2xl bg-white/[0.03] px-4 py-6 text-center text-sm text-muted-foreground ring-1 ring-inset ring-white/10">
            {state.scenes.length ? "Every scene is a favourite." : "No scenes yet. Record one from the desk on the Scenes page."}
          </p>
        )}
      </Section>

      {state.sequences.length > 0 && (
        <Section title="Sequences" count={state.sequences.length}>
          <div className="grid grid-cols-2 gap-2.5">
            {state.sequences.map((s) => (
              <SequencePad key={s.id} s={s} disabled={locked} />
            ))}
          </div>
        </Section>
      )}

      <div className="space-y-2 pt-1">
        <AllOff disabled={locked} anythingOn={anythingOn} />
        <p className="px-1 text-center text-[11px] text-muted-foreground/60">Tap a scene to fade it in or out · hold for that scene alone</p>
      </div>
    </div>
  );
}
