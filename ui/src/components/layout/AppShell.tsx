import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Settings,
  Layers,
  Grid3x3,
  Plug,
  LayoutGrid,
  Lightbulb,
  Waves,
  Radio,
  PanelLeftClose,
  PanelLeftOpen,
  Maximize,
  Minimize,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useEngine } from "@/lib/useEngine";
import { useLayout } from "@/lib/layout";
import { UniverseViz } from "@/components/UniverseViz";
import type { EngineState } from "@/lib/api";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/scenes", label: "Scenes", icon: Layers, end: false },
  { to: "/sequences", label: "Sequences", icon: Waves, end: false },
  { to: "/fixtures", label: "Fixtures", icon: LayoutGrid, end: false },
  { to: "/universes", label: "Universes", icon: Grid3x3, end: false },
  { to: "/patch", label: "Patch", icon: Plug, end: false },
  { to: "/companion", label: "Companion", icon: Radio, end: false },
  { to: "/config", label: "Config", icon: Settings, end: false },
];

// Universes shown as live mini-grids in the top bar (the first four).
const TOPBAR_UNIVERSES = [0, 1, 2, 3];

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-foreground"
    >
      {children}
    </button>
  );
}

// A compact labelled status cell for the top bar.
function Chip({ label, value, tone, led }: { label: string; value: ReactNode; tone?: "live" | "pgm" | "busy" | "info"; led?: string }) {
  const tones = { live: "text-live", pgm: "text-pgm", busy: "text-busy", info: "text-info" };
  return (
    <div className="flex min-w-0 flex-col justify-center leading-none">
      <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">{label}</span>
      <span className={cn("mt-1 flex items-center gap-1.5 truncate text-[12px] font-semibold", tone && tones[tone])}>
        {led !== undefined && <span className={cn("led", led)} />}
        {value}
      </span>
    </div>
  );
}

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular text-[15px] font-semibold tracking-tight">{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
}

function StatusBar({ state }: { state: EngineState }) {
  const live = state.consoleActive;
  const desk = live
    ? { value: "Desk live", tone: "pgm" as const, led: "pgm" }
    : state.holding
      ? { value: "Holding look", tone: "busy" as const, led: "warn" }
      : { value: "House control", tone: "live" as const, led: "on" };
  const liveScenes = state.scenes.filter((s) => s.on);
  const liveSequences = state.sequences.filter((s) => s.on);
  const names = [...liveScenes.map((s) => s.label || `#${s.id}`), ...liveSequences.map((s) => `${s.label || `Sequence ${s.id}`} ~`)].join(", ");
  const lock = state.editing ? `Editing #${state.editing}` : state.programmerActive ? "Programmer live" : null;

  return (
    <div className="flex min-w-0 items-center gap-5">
      <div className="w-40 min-w-0 shrink-0">
      <Chip
        label="Desk"
        value={
          <>
            {desk.value}
            {state.desk.packetsPerSec > 0 && <span className="text-[10px] font-normal text-muted-foreground">{state.desk.packetsPerSec}/s</span>}
          </>
        }
        tone={desk.tone}
        led={desk.led}
      />
      </div>
      <div className="w-14 shrink-0">
        <Chip label="Output" value={state.controllerOutput ? "On" : "Off"} tone={state.controllerOutput ? "live" : undefined} />
      </div>
      {/* Fixed width: the text changes constantly and must not push its neighbours. */}
      <div className="hidden w-[16rem] min-w-0 shrink-0 md:block">
        <Chip
          label={`Live · ${liveScenes.length} scene${liveScenes.length === 1 ? "" : "s"}${liveSequences.length ? ` · ${liveSequences.length} seq` : ""}`}
          value={<span className="truncate" title={names}>{names || (state.holding ? "desk look held" : "none")}</span>}
        />
      </div>
      {state.fade.active && (
        <Chip label="Fade" value={<span className="tabular">{state.fade.remaining.toFixed(1)}s</span>} tone="busy" />
      )}
      {state.recording && state.recording.state !== "idle" && (
        <Chip
          label="Sequence"
          value={state.recording.state === "recording" ? "Recording" : state.recording.state === "analysing" ? "Analysing" : "Ready to save"}
          tone={state.recording.state === "recording" ? "pgm" : "busy"}
          led={state.recording.state === "recording" ? "pgm" : "warn"}
        />
      )}
      {lock && <Chip label="Locked" value={lock} tone="info" />}
      {state.consoleOverride !== "auto" && <Chip label="Override" value={state.consoleOverride} tone="info" />}
    </div>
  );
}

export function AppShell({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const { state, status } = useEngine();
  const { collapsed, toggleSidebar, fullscreen, toggleFullscreen } = useLayout();

  const engine =
    status === "open"
      ? { led: "on", text: "Engine connected" }
      : status === "connecting"
        ? { led: "warn", text: "Connecting…" }
        : { led: "", text: "Engine offline" };

  return (
    <div className="surface-bg fx-orbit relative flex h-screen overflow-hidden text-foreground">
      <div className="surface-aurora" />

      <aside
        className={cn(
          "glass-strip relative z-10 flex shrink-0 flex-col overflow-hidden border-r border-white/5 transition-[width] duration-200",
          collapsed ? "w-0 border-r-0" : "w-56"
        )}
      >
        {/* brand */}
        <div className="flex h-14 w-56 items-center gap-3 border-b border-white/5 px-4">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-amber-700 shadow-[0_0_18px_-4px_hsl(var(--primary))]">
            <Lightbulb className="h-4 w-4 text-black/80" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold tracking-tight">Light It</div>
            <div className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">House lighting</div>
          </div>
        </div>

        <nav className="w-56 flex-1 space-y-0.5 p-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-all",
                  isActive
                    ? "bg-white/[0.07] text-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.06)]"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary transition-opacity",
                      isActive ? "opacity-100 shadow-[0_0_10px_hsl(var(--primary))]" : "opacity-0"
                    )}
                  />
                  <n.icon className={cn("h-4 w-4 transition-colors", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                  {n.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex w-56 items-center gap-2.5 border-t border-white/5 px-4 py-3 text-xs text-muted-foreground">
          <span className={cn("led", engine.led)} />
          <span className="truncate">{engine.text}</span>
        </div>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {!bare && (
          <header className="glass-strip flex h-14 shrink-0 items-center gap-4 border-b border-white/5 px-3">
            <IconButton title={collapsed ? "Show menu" : "Hide menu"} onClick={toggleSidebar}>
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </IconButton>
            {collapsed && (
              <div className="flex items-center gap-2" title={engine.text}>
                <span className={cn("led", engine.led)} />
              </div>
            )}

            {state ? <StatusBar state={state} /> : <span className="text-xs text-muted-foreground">{engine.text}</span>}

            <div className="ml-auto flex shrink-0 items-center gap-3">
              {/* first four universes, live */}
              <div className="hidden items-center gap-1.5 lg:flex">
                {TOPBAR_UNIVERSES.filter((u) => !state || u < state.universes).map((u) => (
                  <UniverseViz key={u} universe={u} channels={state?.channels ?? 512} label={`U${u}`} className="h-9" />
                ))}
              </div>
              <Clock />
              <IconButton title={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
              </IconButton>
            </div>
          </header>
        )}
        <main className={cn("min-w-0 flex-1", bare ? "overflow-hidden" : "overflow-auto p-6")}>{children}</main>
      </div>
    </div>
  );
}
