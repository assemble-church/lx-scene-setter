import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Download, Radio, Send, ArrowDownToLine, Variable } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEngine } from "@/lib/useEngine";
import { getCompanionModule, getConfigForm, type CompanionModuleInfo, type ConfigShape } from "@/lib/api";
import { cn } from "@/lib/utils";

// Companion integration: the Light It module (download + setup), and the raw OSC
// reference for anyone driving Light It without it.

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
    >
      {done ? <Check className="h-3.5 w-3.5 text-live" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function Row({ path, args, children }: { path: string; args?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,22rem)_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/[0.04] px-4 py-2 last:border-0">
      <code className="truncate font-mono text-[12px] text-primary/90" title={path}>
        {path}
        {args && <span className="text-muted-foreground"> {args}</span>}
      </code>
      <span className="text-[13px] text-muted-foreground">{children}</span>
      <CopyButton text={path} />
    </div>
  );
}

function Section({ title, icon, sub, children }: { title: string; icon: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-baseline gap-3 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        {sub && <span className="text-[12px] text-muted-foreground">{sub}</span>}
      </CardHeader>
      <CardContent className="p-0 pb-2">{children}</CardContent>
    </Card>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[12px] font-semibold text-primary">{n}</span>
      <span className="pt-0.5 text-sm text-muted-foreground">{children}</span>
    </li>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-foreground/90">{children}</span>;

export function Companion() {
  const { state } = useEngine();
  const [mod, setMod] = useState<CompanionModuleInfo | null>(null);
  const [cfg, setCfg] = useState<ConfigShape | null>(null);

  useEffect(() => {
    getCompanionModule().then(setMod).catch(() => {});
    getConfigForm().then(setCfg).catch(() => {});
  }, []);

  const host = window.location.hostname;
  const webPort = cfg?.web.port ?? 8080;
  const oscPort = cfg?.companion.listenPort ?? 9000;
  const targets = cfg?.companion.feedbackTargets ?? [];
  const cv = cfg?.companion.customVariables;
  const prefix = cv?.prefix ?? "";
  const scenes = state?.scenes ?? [];
  const sequences = state?.sequences ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Companion</h1>

      <Card className="glow-amber">
        <CardContent className="grid gap-6 p-6 lg:grid-cols-[1fr_auto]">
          <div className="flex gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/15">
              <Radio className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold">Light It Companion module</span>
                {mod?.version && <Badge variant="secondary">v{mod.version}</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                Native Companion buttons for scenes, sequences and the desk hand-over, with live colours, fade countdowns and
                ready-made presets. Scene and sequence lists update by themselves.
              </p>
              <ol className="space-y-2">
                <Step n={1}>Download the module package.</Step>
                <Step n={2}>
                  In Companion, open <Mono>Modules</Mono> and choose <Mono>Import module package</Mono>, then pick the file.
                  Importing a newer version replaces the old one.
                </Step>
                <Step n={3}>
                  Add a <Mono>Light It</Mono> connection with IP <Mono>{host}</Mono> and web port <Mono>{webPort}</Mono>.
                </Step>
                <Step n={4}>
                  Drag buttons from the connection's <Mono>Presets</Mono>, or build your own from its actions and feedbacks.
                </Step>
              </ol>
            </div>
          </div>
          <div className="flex flex-col items-start gap-2 lg:items-end">
            <a
              href="/companion/lightit.tgz"
              download={mod?.file}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-[0_0_18px_-6px_hsl(var(--primary)/0.9)] hover:bg-primary/85",
                mod && !mod.available && "pointer-events-none opacity-50"
              )}
            >
              <Download className="h-4 w-4" /> Download module
            </a>
            <span className="text-[11px] text-muted-foreground">
              {mod ? (mod.available ? `${mod.file} · ${Math.round(mod.size / 1024)} KB` : "Not built yet: run npm run build") : " "}
            </span>
          </div>
        </CardContent>
      </Card>

      <p className="pt-2 text-sm text-muted-foreground">
        Prefer raw OSC? Use Companion's Generic OSC module. Everything below works without the Light It module.
      </p>

      <Section
        title="OSC commands"
        icon={<Send className="h-4 w-4 text-primary" />}
        sub={
          <>
            send to <Mono>{host}</Mono> on UDP <Mono>{oscPort}</Mono>. Fades are seconds, as the first argument.
          </>
        }
      >
        <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Scenes</div>
        <Row path="/scene/<id>/on" args="[fade]">Turn a scene on.</Row>
        <Row path="/scene/<id>/off" args="[fade]">Turn a scene off (other scenes keep their channels).</Row>
        <Row path="/scene/<id>/toggle" args="[fade]">Flip a scene.</Row>
        <Row path="/scene/<id>/play" args="[fade]">Solo: this scene on, every other scene and sequence off.</Row>
        <Row path="/scene/<id>/level" args="<0–1 or 0–100> [fade]">Set a scene to a partial level (0 = off).</Row>
        <Row path="/scene/<id>/rec">Record the current output into a scene (works while the desk is live).</Row>
        <Row path="/scenes/off" args="[fade]">All off: every scene, sequence and held desk look.</Row>

        <div className="px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Sequences</div>
        <Row path="/sequence/<id>/on" args="[fade]">Run a sequence.</Row>
        <Row path="/sequence/<id>/off" args="[fade]">Stop a sequence.</Row>
        <Row path="/sequence/<id>/toggle" args="[fade]">Flip a sequence.</Row>
        <Row path="/sequences/off" args="[fade]">Stop every sequence (scenes untouched).</Row>

        <div className="px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Desk & output</div>
        <Row path="/hold/release" args="[fade]">Fade out of the held desk look to whatever scenes are on.</Row>
        <Row path="/scene-setter/console-override" args="<0 | 1 | 2>">Desk override: 0 ignore the desk, 1 desk in control, 2 auto (detect).</Row>
        <Row path="/output/on">Enable Pi output.</Row>
        <Row path="/output/off">Disable Pi output.</Row>
        <Row path="/state">Send all feedback now.</Row>
        <p className="px-4 pt-3 text-[12px] text-muted-foreground">
          While the desk is live, scene and sequence commands are ignored (recording still works). While a scene is being
          edited in the web UI, every command is ignored.
        </p>
      </Section>

      <Section
        title="OSC feedback"
        icon={<ArrowDownToLine className="h-4 w-4 text-primary" />}
        sub={
          targets.length ? (
            <>
              sent to {targets.map((t, i) => (
                <span key={`${t.ip}:${t.port}`}>
                  {i > 0 && ", "}
                  <Mono>
                    {t.ip}:{t.port}
                  </Mono>
                </span>
              ))}{" "}
              (Config → Companion) on change and every few seconds
            </>
          ) : (
            "no feedback targets set: add one in Config → Companion"
          )
        }
      >
        <Row path="/scene-setter/scene/<id>/active">0 off, 1 on, 2 fading.</Row>
        <Row path="/scene-setter/scene/<id>/fade-remaining">Seconds left in that scene's fade.</Row>
        <Row path="/scene-setter/sequence/<id>/active">0 off, 1 running, 2 fading.</Row>
        <Row path="/scene-setter/active-scenes">Comma-separated ids of the scenes that are on.</Row>
        <Row path="/scene-setter/active-sequences">Comma-separated ids of the running sequences.</Row>
        <Row path="/scene-setter/console-active">1 while the desk is in control.</Row>
        <Row path="/scene-setter/console-override">off, on or auto.</Row>
        <Row path="/scene-setter/holding">1 while the desk's last look is held.</Row>
        <Row path="/scene-setter/status">PRODUCTION_CONSOLE_ACTIVE or BUILDING_CONTROL_ACTIVE.</Row>
        <Row path="/scene-setter/pi-output">1 when Pi output is enabled.</Row>
        <Row path="/scene-setter/fade-active">1 while any fade runs.</Row>
        <Row path="/scene-setter/fade-remaining">Seconds left in the longest fade.</Row>
        <Row path="/scene-setter/editing">Id of the scene being edited ("" when none): controls are locked.</Row>
        <Row path="/scene-setter/programmer">1 while the programmer is live: controls are locked.</Row>
        <Row path="/scene-setter/recorded">Scene id, once, after a record.</Row>
        <Row path="/scene-setter/error">Why a command was refused.</Row>
      </Section>

      <Section
        title="Custom variables"
        icon={<Variable className="h-4 w-4 text-primary" />}
        sub={
          cv?.enabled ? (
            <>
              pushed into Companion at{" "}
              <Mono>
                {cv.ip}:{cv.port}
              </Mono>
            </>
          ) : (
            "off: turn on in Config → Companion (not needed with the Light It module, which has its own variables)"
          )
        }
      >
        {["console_active", "console_override", "holding", "active_scenes", "active_sequences", "fade_active", "fade_remaining", "scene_<id>_fade_remaining", "editing", "programmer"].map((v) => (
          <Row key={v} path={`${prefix}${v}`}>
            {
              {
                console_active: "1 while the desk is in control.",
                console_override: "off, on or auto.",
                holding: "1 while the desk's last look is held.",
                active_scenes: "Ids of the scenes that are on.",
                active_sequences: "Ids of the running sequences.",
                fade_active: "1 while any fade runs.",
                fade_remaining: "Seconds left in the longest fade, e.g. 2.4.",
                "scene_<id>_fade_remaining": "Seconds left in that scene's fade.",
                editing: "Id of the scene being edited.",
                programmer: "1 while the programmer is live.",
              }[v]
            }
          </Row>
        ))}
      </Section>

      <Section title="Ids" icon={<span className="font-mono text-primary">#</span>} sub="what <id> means in the addresses above">
        <div className="grid gap-x-8 px-4 py-2 md:grid-cols-2">
          <div>
            <div className="pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Scenes</div>
            {scenes.length ? (
              scenes.map((s) => (
                <div key={s.id} className="flex items-center gap-3 py-0.5 text-sm">
                  <span className="w-8 font-mono text-primary/90">{s.id}</span>
                  <span className="truncate text-muted-foreground">{s.label || `Scene ${s.id}`}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No scenes yet.</p>
            )}
          </div>
          <div>
            <div className="pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Sequences</div>
            {sequences.length ? (
              sequences.map((s) => (
                <div key={s.id} className="flex items-center gap-3 py-0.5 text-sm">
                  <span className="w-8 font-mono text-primary/90">{s.id}</span>
                  <span className="truncate text-muted-foreground">{s.label || `Sequence ${s.id}`}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No sequences yet.</p>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
