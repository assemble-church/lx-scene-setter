import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEngine } from "@/lib/useEngine";
import { command, type SceneStatus, type ActivityEvent } from "@/lib/api";

// Fade time (seconds) used by the dashboard's quick controls.
const FADE = 2;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {sub && <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function SceneRow({ s }: { s: SceneStatus }) {
  const pct = Math.round(s.level * 100);
  const hue = Math.round(s.level * 120); // 0 = red, 120 = green
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-40 shrink-0 truncate text-sm font-medium" title={s.label || `Scene ${s.id}`}>
        {s.label || `Scene ${s.id}`}
      </div>

      <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            backgroundColor: `hsl(${hue} 75% 45%)`,
            transition: "width 120ms linear, background-color 120ms linear",
          }}
        />
      </div>

      <div className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </div>

      <div className="w-28 shrink-0">
        {s.state === 2 ? (
          <Badge variant="warning" className="tabular-nums">
            fading {s.fadeRemaining.toFixed(1)}s
          </Badge>
        ) : s.state === 1 ? (
          <Badge variant="success">on</Badge>
        ) : (
          <Badge variant="outline">off</Badge>
        )}
      </div>

      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant={s.on ? "secondary" : "default"}
          className="w-24"
          onClick={() => command(`/scene/${s.id}/${s.on ? "off" : "on"}`, [FADE])}
        >
          {s.on ? "Deactivate" : "Activate"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => command(`/scene/${s.id}/play`, [FADE])}
        >
          Solo
        </Button>
      </div>
    </div>
  );
}

const TYPE_COLOR: Record<string, string> = {
  scene: "text-sky-400",
  scenes: "text-sky-400",
  console: "text-rose-400",
  override: "text-amber-400",
  record: "text-emerald-400",
};

function LogLine({ e }: { e: ActivityEvent }) {
  const time = new Date(e.t).toLocaleTimeString();
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{time}</span>
      <span className={`shrink-0 text-xs uppercase ${TYPE_COLOR[e.type] ?? "text-muted-foreground"}`}>
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

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="grid shrink-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Console"
          value={state.consoleActive ? "Live" : "Idle"}
          sub={`override: ${state.consoleOverride}`}
        />
        <Stat label="Controller output" value={state.controllerOutput ? "On" : "Off"} />
        <Stat
          label="Active scenes"
          value={String(state.activeScenes.length)}
          sub={state.activeScenes.join(", ") || "none"}
        />
        <Stat
          label="Fade"
          value={state.fade.active ? `${state.fade.remaining.toFixed(1)}s` : "—"}
          sub={state.fade.active ? `of ${state.fade.total.toFixed(1)}s` : undefined}
        />
      </div>

      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-3">
        <Card className="flex min-h-0 flex-col lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle>Scenes</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            {state.scenes.length ? (
              <div className="divide-y divide-border/60">
                {state.scenes.map((s) => (
                  <SceneRow key={s.id} s={s} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No scenes recorded yet.</p>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <CardHeader className="pb-2">
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            {log.length ? (
              <div className="divide-y divide-border/40">
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
