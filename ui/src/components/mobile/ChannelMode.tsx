import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, Lock, Hand } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPatch, manualSet, manualClear, type EngineState, type PatchFixture, type FixtureKind } from "@/lib/api";
import { FixtureIcon } from "@/components/fixture-icons";
import { useDmxFrames } from "@/lib/useDmx";
import { HFader } from "./HFader";

// Channel mode: every patched dimmer and switch, one row each, grouped by the
// fixture they belong to. Only single-channel heads are shown for now (moving
// lights have their own page). A fader or button takes the channel over by hand
// — it sits on top of the scenes until it's handed back.

const FADE = 1; // seconds, for the On/Off buttons (faders move instantly)

interface Item {
  key: string;
  label: string;
  icon: FixtureKind;
  universe: number;
  channel: number; // 1-based
  kind: "dimmer" | "switch";
}
interface Group {
  key: string;
  label: string;
  items: Item[];
}

function enumerate(fixtures: PatchFixture[]): Group[] {
  const groups: Group[] = [];
  const singles: Item[] = [];
  for (const fx of fixtures) {
    const kindAt = (offset: number): Item["kind"] => (fx.types?.[offset - 1] === "switch" ? "switch" : "dimmer");
    if (fx.heads?.length) {
      const items = fx.heads
        .filter((h) => h.span === 1)
        .map((h) => ({
          key: `${fx.id}#${h.offset}`,
          label: h.label || `${fx.label} ${h.offset}`,
          icon: h.icon,
          universe: fx.universe,
          channel: fx.address + h.offset - 1,
          kind: kindAt(h.offset),
        }));
      if (items.length) groups.push({ key: fx.id, label: fx.label || fx.name, items });
    } else if (fx.channels === 1) {
      const kind = kindAt(1);
      singles.push({
        key: fx.id,
        label: fx.label || fx.name,
        icon: fx.icon ?? (kind === "switch" ? "power" : "par"),
        universe: fx.universe,
        channel: fx.address,
        kind,
      });
    }
  }
  if (singles.length) groups.push({ key: "__singles__", label: "Single channels", items: singles });
  return groups;
}

const toDmx = (pct: number) => Math.round((pct / 100) * 255);
const toPct = (v: number) => Math.round((v / 255) * 100);

function SmallButton({ children, lit, disabled, onClick, className }: { children: ReactNode; lit?: boolean; disabled?: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "tap flex h-12 w-14 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold uppercase tracking-[0.12em] ring-1 ring-inset transition-colors active:translate-y-px disabled:opacity-40",
        lit ? "bg-primary/25 text-primary ring-primary/60 shadow-[0_0_14px_-2px_hsl(var(--primary)/0.9)]" : "bg-white/[0.04] text-muted-foreground ring-white/10 active:bg-white/[0.1]",
        className
      )}
    >
      {children}
    </button>
  );
}

function RowHeader({ it, live, byHand, lit, onRelease, right }: { it: Item; live: number; byHand: boolean; lit: boolean; onRelease: () => void; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1 ring-inset transition-colors", lit ? "bg-primary/15 text-primary ring-primary/30" : "bg-white/[0.03] text-muted-foreground/60 ring-white/[0.08]")}>
        <FixtureIcon kind={it.icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold leading-tight">{it.label}</div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
          U{it.universe} · {it.channel}
          {byHand && <span className="text-primary"> · by hand</span>}
        </div>
      </div>
      {right ?? (
        <span className={cn("tabular text-xl font-semibold leading-none", live > 0 ? "text-foreground" : "text-muted-foreground/40")}>
          {toPct(live)}
          <span className="text-[10px] text-muted-foreground">%</span>
        </span>
      )}
      {byHand && (
        <button
          onClick={onRelease}
          title="Hand back to the scenes"
          className="tap grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground ring-1 ring-inset ring-white/10 active:bg-white/[0.1]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

const rowClass = (byHand: boolean) =>
  cn("rounded-2xl p-3 ring-1 ring-inset transition-colors", byHand ? "bg-primary/[0.06] ring-primary/30" : "bg-white/[0.03] ring-white/10");

function DimmerRow({ it, live, target, disabled }: { it: Item; live: number; target: number | null; disabled: boolean }) {
  const byHand = target !== null;
  const set = (pct: number, fade = 0) => manualSet([{ universe: it.universe, channel: it.channel, value: toDmx(pct) }], fade);
  const release = () => manualClear([{ universe: it.universe, channel: it.channel }]);
  // Untouched, the handle follows whatever the scenes are doing — grab it to take over from there.
  const handle = byHand ? toPct(target) : toPct(live);
  return (
    <div className={rowClass(byHand)}>
      <RowHeader it={it} live={live} byHand={byHand} lit={live > 0} onRelease={release} />
      <div className="mt-2.5 flex items-stretch gap-2">
        <SmallButton disabled={disabled} lit={byHand && target === 0} onClick={() => set(0, FADE)}>
          Off
        </SmallButton>
        <HFader value={handle} live={toPct(live)} tone={byHand ? "hand" : "scene"} disabled={disabled} onChange={(v) => set(v)} />
        <SmallButton disabled={disabled} lit={byHand && target >= 255} onClick={() => set(100, FADE)}>
          On
        </SmallButton>
      </div>
    </div>
  );
}

function SwitchRow({ it, live, target, disabled }: { it: Item; live: number; target: number | null; disabled: boolean }) {
  const byHand = target !== null;
  const on = live >= 128;
  const set = (v: number) => manualSet([{ universe: it.universe, channel: it.channel, value: v }]);
  const release = () => manualClear([{ universe: it.universe, channel: it.channel }]);
  return (
    <div className={rowClass(byHand)}>
      <RowHeader
        it={it}
        live={live}
        byHand={byHand}
        lit={on}
        onRelease={release}
        right={
          <button
            role="switch"
            aria-checked={on}
            disabled={disabled}
            onClick={() => set(on ? 0 : 255)}
            className={cn(
              "tap relative h-9 w-16 shrink-0 rounded-full ring-1 ring-inset transition-colors disabled:opacity-40",
              on ? "bg-primary ring-primary shadow-[0_0_18px_-4px_hsl(var(--primary))]" : "bg-white/[0.08] ring-white/15"
            )}
          >
            <span
              className={cn(
                "absolute top-1 h-7 w-7 rounded-full shadow-[0_2px_6px_rgba(0,0,0,0.6)] transition-[left,background-color] duration-150",
                on ? "left-8 bg-white" : "left-1 bg-zinc-400"
              )}
            />
          </button>
        }
      />
    </div>
  );
}

export function ChannelMode({ state, locked }: { state: EngineState; locked: boolean }) {
  const [fixtures, setFixtures] = useState<PatchFixture[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getPatch()
      .then((p) => setFixtures(p.fixtures))
      .catch((e) => setError(String(e.message || e)));
  }, []);
  const groups = useMemo(() => enumerate(fixtures ?? []), [fixtures]);

  // Live output, sampled ~10×/s for the meters (the feed itself runs at 20 Hz).
  const frame = useRef<Uint8Array | null>(null);
  const [, setTick] = useState(0);
  useDmxFrames(
    useCallback((f: Uint8Array) => {
      frame.current = f;
    }, [])
  );
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  const liveAt = (it: Item) => frame.current?.[it.universe * state.channels + it.channel - 1] ?? 0;

  const overrides = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of state.manual ?? []) m.set(`${o.universe}:${o.channel}`, o.target);
    return m;
  }, [state.manual]);
  const targetAt = (it: Item) => overrides.get(`${it.universe}:${it.channel}`) ?? null;
  const byHand = overrides.size;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-3 -mt-3 bg-gradient-to-b from-[hsl(var(--background))] via-[hsl(var(--background)/0.85)] to-transparent px-3 pb-3 pt-3">
        <div className={cn("glass flex items-center gap-3 rounded-2xl px-4 py-2.5", byHand ? "glow-amber" : "")}>
          {locked ? <Lock className="h-5 w-5 shrink-0 text-busy" /> : <Hand className={cn("h-5 w-5 shrink-0", byHand ? "text-primary" : "text-muted-foreground/60")} />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">
              {locked
                ? state.consoleActive
                  ? "Desk is live — channels locked"
                  : "Programmer live — channels locked"
                : byHand
                  ? `${byHand} channel${byHand === 1 ? "" : "s"} by hand`
                  : "Following the scenes"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {locked ? "Control comes back when it finishes." : byHand ? "They stay put until handed back." : "Grab a fader to take a channel over."}
            </div>
          </div>
          <button
            disabled={!byHand}
            onClick={() => manualClear()}
            className="tap h-9 shrink-0 rounded-lg bg-white/[0.04] px-3 text-xs font-semibold ring-1 ring-inset ring-white/10 active:bg-white/[0.1] disabled:opacity-30"
          >
            Clear all
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-2xl bg-pgm/10 px-4 py-4 text-sm text-pgm ring-1 ring-inset ring-pgm/30">Couldn't load the patch: {error}</p>
      ) : fixtures === null ? (
        <p className="px-1 text-sm text-muted-foreground">Loading the patch…</p>
      ) : groups.length === 0 ? (
        <p className="rounded-2xl bg-white/[0.03] px-4 py-6 text-center text-sm text-muted-foreground ring-1 ring-inset ring-white/10">
          No dimmers or switches are patched yet. Add a dimmer pack on the Patch page and they'll appear here.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.key}>
            <header className="mb-2 flex items-baseline justify-between px-1">
              <span className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{g.label}</span>
              <span className="tabular text-[11px] text-muted-foreground/60">{g.items.length}</span>
            </header>
            <div className="space-y-2">
              {g.items.map((it) =>
                it.kind === "switch" ? (
                  <SwitchRow key={it.key} it={it} live={liveAt(it)} target={targetAt(it)} disabled={locked} />
                ) : (
                  <DimmerRow key={it.key} it={it} live={liveAt(it)} target={targetAt(it)} disabled={locked} />
                )
              )}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
