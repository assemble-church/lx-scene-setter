import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEngine } from "@/lib/useEngine";
import { command, type ActivityEvent, type EngineState } from "@/lib/api";
import { SceneConsole } from "@/components/SceneConsole";
import { SequencePad } from "@/components/SequencePads";
import { UniverseViz } from "@/components/UniverseViz";
import { cn } from "@/lib/utils";

const agoText = (ms: number | null) =>
  ms == null ? "never" : ms < 1500 ? "now" : ms < 60000 ? `${Math.round(ms / 1000)}s ago` : ms < 3600000 ? `${Math.round(ms / 60000)}m ago` : `${Math.round(ms / 3600000)}h ago`;

// Lighting-desk detection: is the desk's Art-Net reaching us, from where, and who's in control.
function DeskCard({ state }: { state: EngineState }) {
  const d = state.desk;
  const override = state.consoleOverride;
  const live = state.consoleActive;
  const heard = d.lastPacketAgoMs != null;
  // Art-Net arriving from somewhere other than the configured desk IP — likely a
  // wrong console IP in Config.
  const others = state.artnetSenders.filter((s) => !s.isConsole && s.ip !== d.ip);

  const headline = live
    ? override === "on"
      ? "Desk forced live"
      : "Desk live"
    : state.holding
      ? "Holding desk look"
      : override === "off"
        ? "Desk ignored"
        : "Pi in control";
  const detail = live
    ? "The desk is driving the rig; the Pi is only listening (recording still works)."
    : state.holding
      ? "The desk went away. Its last look is held on stage until you press a scene."
      : override === "off"
        ? "Console override is OFF — desk Art-Net is ignored and the Pi stays in control."
        : heard
          ? `No Art-Net from the desk for over ${(d.timeoutMs / 1000).toFixed(d.timeoutMs % 1000 ? 1 : 0)}s, so the Pi is in control.`
          : "The desk hasn't been heard since the engine started.";

  return (
    <Card className={cn("shrink-0", live ? "glow-pgm" : state.holding ? "glow-amber" : "glow-live")}>
      <CardHeader className="pb-2">
        <CardTitle>Lighting desk</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xl font-semibold tracking-tight">{headline}</span>
          {live ? (
            <Badge variant="destructive">desk in control</Badge>
          ) : state.holding ? (
            <Badge variant="warning">hold on fail</Badge>
          ) : (
            <Badge variant="success">house control</Badge>
          )}
          {override !== "auto" && <Badge variant="info">override: {override}</Badge>}
          {state.holding && (
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => command("/hold/release", [FADE])}>
                Release hold ({FADE}s)
              </Button>
              <Button size="sm" variant="outline" onClick={() => command("/scenes/off", [FADE])}>
                Fade to black
              </Button>
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{detail}</p>

        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="text-muted-foreground">Desk IP </span>
            <span className="font-mono tabular-nums">{d.ip || "not set"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Last packet </span>
            <span className="tabular-nums">{agoText(d.lastPacketAgoMs)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Rate </span>
            <span className="tabular-nums">{d.packetsPerSec} packets/s</span>
          </div>
          <div className="truncate">
            <span className="text-muted-foreground">Universes </span>
            {d.universes.length ? (
              d.universes.map((u) => (
                <span
                  key={u.universe}
                  title={`last ${agoText(u.agoMs)}`}
                  className={cn("mr-1 tabular-nums", u.agoMs > d.timeoutMs && "text-muted-foreground line-through")}
                >
                  U{u.universe}
                </span>
              ))
            ) : (
              <span>—</span>
            )}
          </div>
        </div>

        {others.length > 0 && (
          <div className="rounded-md border border-busy/30 bg-busy/10 px-3 py-2 text-sm">
            Art-Net is arriving from{" "}
            {others.map((s, i) => (
              <span key={s.ip}>
                {i > 0 && ", "}
                <span className="font-mono">{s.ip}</span> (U{s.universes.join(", U")})
              </span>
            ))}
            {heard ? "" : ` but not from the desk IP ${d.ip || "(not set)"}`}. If that's the desk, set it as the
            console IP in Config.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Fade time (seconds) used by the dashboard's quick controls.
const FADE = 2;

const TYPE_COLOR: Record<string, string> = {
  scene: "text-sky-400",
  scenes: "text-sky-400",
  console: "text-rose-400",
  override: "text-amber-400",
  record: "text-emerald-400",
  sequence: "text-teal-300",
};

function LogLine({ e }: { e: ActivityEvent }) {
  const time = new Date(e.t).toLocaleTimeString();
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{time}</span>
      <span className={`w-16 shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] ${TYPE_COLOR[e.type] ?? "text-muted-foreground"}`}>
        {e.type}
      </span>
      <span className="min-w-0 break-words">{e.message}</span>
    </div>
  );
}

export function Dashboard() {
  const { state, status } = useEngine();

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {status === "open" ? "Waiting for data…" : "Connecting to the engine…"}
      </div>
    );
  }

  const log = [...state.log].reverse(); // newest first
  // Scene control is refused while the desk is live or the programmer/editor holds the rig.
  const locked = state.consoleActive || !!state.editing || !!state.programmerActive;
  const universes = Array.from({ length: state.universes }, (_, u) => u);

  return (
    <div className="flex h-full min-h-[640px] flex-col gap-4">
      <DeskCard state={state} />

      {/* Faders read best at a desk-like height; extra screen goes to output + activity. */}
      <div className="h-[clamp(380px,46vh,500px)] shrink-0">
        <SceneConsole scenes={state.scenes} disabled={locked} />
      </div>

      {state.sequences.length > 0 && (
        <Card className="glow-live shrink-0">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Sequences</CardTitle>
            {/* Always rendered (hidden when idle) so the header never changes height. */}
            <Button
              size="sm"
              variant="ghost"
              className={cn(!state.activeSequences.length && "invisible")}
              disabled={locked || !state.activeSequences.length}
              onClick={() => command("/sequences/off", [FADE])}
            >
              Stop all
            </Button>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {state.sequences.map((s) => (
                <SequencePad key={s.id} s={s} fade={FADE} disabled={locked} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid min-h-[240px] flex-1 gap-4 lg:grid-cols-3">
        <Card className="glow-info flex min-h-0 flex-col lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Output</CardTitle>
            <span className="text-[11px] text-muted-foreground">{state.universes} universes · live</span>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
              {universes.map((u) => (
                <UniverseViz key={u} universe={u} channels={state.channels} label={`U${u}`} className="w-full" />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
            {log.length ? (
              <div className="divide-y divide-white/[0.04]">
                {log.map((e, i) => (
                  <LogLine key={`${e.t}-${i}`} e={e} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
