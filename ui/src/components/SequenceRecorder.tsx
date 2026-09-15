import { useEffect, useState } from "react";
import { Circle, Square, RotateCcw, Save, Layers3, Sun, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SequenceScope, useEffectPalette, type EffectPalette } from "@/components/SequenceScope";
import { useEngine } from "@/lib/useEngine";
import {
  saveSequence,
  sequenceRecordAutoStop,
  sequenceRecordDiscard,
  sequenceRecordStart,
  sequenceRecordStop,
  type SequenceAnalysisSummary,
  type SequenceGroup,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// The "New sequence" recorder: watch the desk, record, let it find the loop (and
// stop by itself), review what it found, save.

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function GroupRow({
  g,
  palette,
  checked,
  onChange,
  takeMs,
}: {
  g: SequenceGroup;
  palette: EffectPalette;
  checked: boolean;
  onChange?: (v: boolean) => void;
  takeMs: number;
}) {
  const hue = palette.hueOf(g.key);
  const irregular = g.key === "irregular";
  const good = !irregular && g.passes >= 3 && g.score >= 0.9;
  return (
    <label
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-inset ring-white/[0.06] transition-colors",
        onChange && "cursor-pointer hover:bg-white/[0.03]",
        !checked && "opacity-50"
      )}
    >
      {onChange && <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />}
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: hue === null ? "hsl(228 10% 60%)" : `hsl(${hue} 90% 60%)`, boxShadow: hue === null ? undefined : `0 0 10px hsl(${hue} 90% 60%)` }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          {irregular ? "Doesn't repeat" : `Effect · ${g.period?.toFixed(2)}s`}
          <span className="text-xs font-normal text-muted-foreground">
            {g.channels} ch{g.wide ? ` · ${g.wide} × 16-bit` : ""}
            {g.layered ? ` · ${g.layered} layered` : ""} · U{g.universes.join(", U")}
          </span>
        </div>
        {irregular ? (
          <div className="text-xs text-muted-foreground">Loops the whole {Math.round(takeMs / 1000)}s take as recorded</div>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn("h-full rounded-full transition-[width] duration-500", good ? "bg-live" : "bg-primary")}
                style={{ width: `${Math.min(100, (g.passes / 3) * 100)}%` }}
              />
            </div>
            <span className={cn("tabular w-28 text-right text-[11px]", good ? "text-live" : "text-muted-foreground")}>
              {g.passes.toFixed(1)} passes · {Math.round(g.score * 100)}%
            </span>
          </div>
        )}
      </div>
    </label>
  );
}

export function SequenceRecorder({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state } = useEngine();
  const rec = state?.recording;
  const [autoStop, setAutoStop] = useState(true);
  const [label, setLabel] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [includeStill, setIncludeStill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phase = rec?.state ?? "idle";
  const summary: SequenceAnalysisSummary | null = rec?.draft ?? rec?.progress ?? null;
  const groups = summary?.groups ?? [];
  const [take, setTake] = useState(0);
  const palette = useEffectPalette(groups, take);
  // Effects in first-found order, so rows don't reshuffle between analyses.
  const ordered = [...groups].sort((a, b) => palette.slotOf(a.key) - palette.slotOf(b.key));

  // Fresh review choices (and effect colours) for each new take.
  useEffect(() => {
    if (phase === "recording") {
      setTake((n) => n + 1);
      setExcluded(new Set());
      setIncludeStill(true);
      setError(null);
    }
  }, [phase]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const close = (next: boolean) => {
    if (next) return onOpenChange(true);
    // Closing throws the take away (a draft is only kept until saved).
    if (phase === "recording" || phase === "review") sequenceRecordDiscard().catch(() => {});
    setLabel("");
    onOpenChange(false);
  };

  const desk = state?.desk;
  const deskLive = !!desk && desk.lastPacketAgoMs !== null && desk.lastPacketAgoMs < (desk.timeoutMs || 3000);
  const frames = rec?.universes.reduce((n, u) => n + u.frames, 0) ?? 0;
  const regular = groups.filter((g) => g.key !== "irregular");
  const keep = groups.filter((g) => !excluded.has(g.key)).map((g) => g.key);

  let headline: string;
  let detail: string;
  if (phase === "idle") {
    headline = "New sequence";
    detail = deskLive
      ? "Play the chase on the desk, then press Record. It stops by itself once it has worked out the loop."
      : "The desk isn't sending Art-Net. Play the chase from the desk first. Only the desk's output is recorded.";
  } else if (phase === "recording") {
    if (!frames) {
      headline = "Recording: waiting for the desk";
      detail = "No Art-Net has arrived from the desk yet.";
    } else if (!summary) {
      headline = "Recording: listening";
      detail = "Capturing frames. The first analysis runs after a few seconds.";
    } else if (summary.locked) {
      headline = rec?.autoStop ? "Loop locked: confirming" : "Loop locked";
      detail = rec?.autoStop
        ? "Every effect has repeated and predicts what comes next. Stopping once the next check agrees."
        : "Every effect has repeated and predicts what comes next. Stop when you're ready.";
    } else if (regular.length) {
      headline = `Found ${regular.length} effect${regular.length > 1 ? "s" : ""}: watching for repeats`;
      detail = "Each effect needs to come round about three times so its loop can be checked.";
    } else {
      headline = "Recording: nothing repeating yet";
      detail = summary.groups.length ? "Movement found, but no loop yet. Let it run longer." : "Nothing is moving yet.";
    }
  } else if (phase === "analysing") {
    headline = "Working out the loop";
    detail = "Analysing the whole take.";
  } else {
    headline = rec?.stoppedBy === "auto" ? "Got it: loop found" : "Review the recording";
    detail = "Choose what the sequence plays, name it and save.";
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="flex h-[min(680px,94vh)] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-3 space-y-0 border-b border-white/[0.07] px-6 py-4 pr-12">
          {phase === "recording" ? (
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pgm opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-pgm shadow-[0_0_10px_hsl(var(--pgm))]" />
            </span>
          ) : phase === "analysing" ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <span className={cn("led", phase === "review" ? "on" : deskLive ? "on" : "warn")} />
          )}
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate">{headline}</DialogTitle>
            <DialogDescription className="mt-1 truncate">{detail}</DialogDescription>
          </div>
          {(phase === "recording" || phase === "analysing" || phase === "review") && (
            <span className="tabular w-20 text-right text-2xl font-semibold tracking-tight">{clock(rec?.elapsedMs ?? 0)}</span>
          )}
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-1">
          <div className="relative min-h-0 border-b border-white/[0.07] bg-black/30 lg:border-b-0 lg:border-r">
            {open && (
              <SequenceScope
                channels={state?.channels ?? 512}
                movers={summary?.movers ?? null}
                groups={groups}
                palette={palette}
                locked={!!summary?.locked}
              />
            )}
            {phase === "analysing" && (
              <div className="fade-in absolute inset-0 grid place-items-center bg-black/40 backdrop-blur-[2px]">
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" /> Working out the loop…
                </div>
              </div>
            )}
          </div>

          <aside className="flex min-h-0 flex-col p-4">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {phase === "idle" && (
              <>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Desk</span>
                    <span className={deskLive ? "text-live" : "text-busy"}>{deskLive ? `${desk?.packetsPerSec ?? 0} packets/s` : "not sending"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Universes</span>
                    <span className="tabular">{desk?.universes.length ? `U${desk.universes.map((u) => u.universe).join(", U")}` : "—"}</span>
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Record just the chase if you can: anything else the desk has up joins the sequence as its still look. You
                  can leave the still look out when you review.
                </p>
              </>
            )}

            {(phase === "recording" || phase === "analysing") && (
              <div className="space-y-2">
                {groups.length ? (
                  ordered.map((g) => <GroupRow key={g.key} g={g} palette={palette} checked takeMs={rec?.elapsedMs ?? 0} />)
                ) : (
                  <p className="text-sm text-muted-foreground">Effects appear here as they're found.</p>
                )}
                {summary && summary.stillLit > 0 && (
                  <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                    <Sun className="h-3.5 w-3.5" /> {summary.stillLit} still channels lit
                  </p>
                )}
                <div className="flex justify-between px-1 text-[11px] text-muted-foreground">
                  <span>{frames.toLocaleString()} frames</span>
                  <span>max {clock(rec?.maxMs ?? 0)}</span>
                </div>
              </div>
            )}

            {phase === "review" && summary && (
              <div className="space-y-3">
                <Input autoFocus placeholder="Name (e.g. Blue sweep)" value={label} onChange={(e) => setLabel(e.target.value)} />
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    <Layers3 className="h-3 w-3" /> Movement
                  </div>
                  {ordered.map((g) => (
                    <GroupRow
                      key={g.key}
                      g={g}
                      palette={palette}
                      takeMs={summary.durationMs}
                      checked={!excluded.has(g.key)}
                      onChange={(v) =>
                        setExcluded((s) => {
                          const n = new Set(s);
                          if (v) n.delete(g.key);
                          else n.add(g.key);
                          return n;
                        })
                      }
                    />
                  ))}
                  {!groups.length && <p className="text-sm text-muted-foreground">Nothing moved in this take.</p>}
                </div>
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 ring-1 ring-inset ring-white/[0.06] hover:bg-white/[0.03]",
                    !summary.stillLit && "pointer-events-none opacity-50"
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={includeStill && summary.stillLit > 0}
                    onChange={(e) => setIncludeStill(e.target.checked)}
                  />
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Sun className="h-3.5 w-3.5" /> Still look
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {summary.stillLit
                        ? `${summary.stillLit} lit channels that didn't move (e.g. house lights) come up with the sequence, on top of scenes.`
                        : "Nothing else was lit."}
                    </div>
                  </div>
                </label>
                {rec?.stoppedBy === "limit" && <Badge variant="warning">stopped at the time limit</Badge>}
              </div>
            )}

            {(error || rec?.error) && (
              <p className="rounded-md bg-pgm/10 px-3 py-2 text-sm text-pgm ring-1 ring-inset ring-pgm/30">{error || rec?.error}</p>
            )}

            </div>

            <div className="shrink-0 space-y-3 border-t border-white/[0.07] pt-3">
              {(phase === "idle" || phase === "recording") && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={phase === "recording" ? !!rec?.autoStop : autoStop}
                    onChange={(e) => {
                      setAutoStop(e.target.checked);
                      if (phase === "recording") sequenceRecordAutoStop(e.target.checked).catch(() => {});
                    }}
                  />
                  Stop automatically when the loop is found
                </label>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {phase === "idle" && (
                  <>
                    <Button variant="ghost" onClick={() => close(false)}>
                      Cancel
                    </Button>
                    <Button onClick={() => run(() => sequenceRecordStart(autoStop))} disabled={busy}>
                      <Circle className="h-3.5 w-3.5 fill-current" /> Record
                    </Button>
                  </>
                )}
                {phase === "recording" && (
                  <>
                    <Button variant="ghost" onClick={() => run(sequenceRecordDiscard)} disabled={busy}>
                      Discard
                    </Button>
                    <Button variant={summary?.locked ? "default" : "outline"} onClick={() => run(sequenceRecordStop)} disabled={busy || !frames}>
                      <Square className="h-3.5 w-3.5 fill-current" /> Stop
                    </Button>
                  </>
                )}
                {phase === "review" && (
                  <>
                    <Button variant="ghost" onClick={() => run(sequenceRecordDiscard)} disabled={busy}>
                      Discard
                    </Button>
                    <Button variant="outline" onClick={() => run(() => sequenceRecordStart(autoStop))} disabled={busy}>
                      <RotateCcw className="h-3.5 w-3.5" /> Record again
                    </Button>
                    <Button
                      disabled={busy || (!keep.length && !(includeStill && summary && summary.stillLit))}
                      onClick={() =>
                        run(async () => {
                          await saveSequence({ label: label.trim(), groups: keep, includeStill });
                          setLabel("");
                          onOpenChange(false);
                        })
                      }
                    >
                      <Save className="h-4 w-4" /> Save sequence
                    </Button>
                  </>
                )}
              </div>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
