import { useState } from "react";
import { Link } from "react-router-dom";
import { Zap, SlidersHorizontal, Lightbulb, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEngine } from "@/lib/useEngine";
import { TriggerMode } from "@/components/mobile/TriggerMode";
import { ChannelMode } from "@/components/mobile/ChannelMode";
import type { EngineState } from "@/lib/api";

// The phone view: its own shell (no sidebar, no top bar clutter), two modes on a
// thumb-height tab bar. Trigger fires scenes and sequences; Channels drives
// individual dimmers and switches by hand.

export const DESKTOP_KEY = "lx.wantDesktop"; // session flag: this phone asked for the desktop UI
const MODE_KEY = "lx.mobileMode";

type Mode = "trigger" | "channels";

const MODES: { key: Mode; label: string; icon: typeof Zap }[] = [
  { key: "trigger", label: "Trigger", icon: Zap },
  { key: "channels", label: "Channels", icon: SlidersHorizontal },
];

function deskStatus(state: EngineState) {
  if (state.consoleActive) return { led: "pgm", text: "Desk live", tone: "text-pgm" };
  if (state.holding) return { led: "warn", text: "Holding look", tone: "text-busy" };
  return { led: "on", text: "House control", tone: "text-live" };
}

export function Mobile() {
  const { state, status } = useEngine();
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) === "channels" ? "channels" : "trigger"));

  function pick(m: Mode) {
    localStorage.setItem(MODE_KEY, m);
    setMode(m);
  }

  const live = state ? state.activeScenes.length + state.activeSequences.length : 0;
  const desk = state ? deskStatus(state) : null;
  // Scene and channel control is refused while the desk is live or the programmer/editor holds the rig.
  const locked = !!state && (state.consoleActive || !!state.editing || !!state.programmerActive);

  return (
    <div className="surface-bg fx-orbit relative flex h-dvh flex-col overflow-hidden text-foreground">
      <div className="surface-aurora" />

      <header className="glass-strip relative z-10 shrink-0 border-b border-white/5 pt-[env(safe-area-inset-top)]">
        <div className="flex h-14 items-center gap-3 px-4">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-amber-700 shadow-[0_0_18px_-4px_hsl(var(--primary))]">
            <Lightbulb className="h-4 w-4 text-black/80" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-[14px] font-semibold tracking-tight">Light It</div>
            <div className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {status !== "open" ? (status === "connecting" ? "Connecting…" : "Engine offline") : live ? `${live} live` : "House lighting"}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {desk && (
              <span className={cn("flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold ring-1 ring-inset ring-white/10", desk.tone)}>
                <span className={cn("led", desk.led)} />
                {desk.text}
              </span>
            )}
            <Link
              to="/"
              onClick={() => sessionStorage.setItem(DESKTOP_KEY, "1")}
              title="Desktop view"
              className="tap grid h-9 w-9 place-items-center rounded-lg text-muted-foreground ring-1 ring-inset ring-white/10 active:bg-white/[0.08]"
            >
              <Monitor className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-6 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {!state ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {status === "open" ? "Waiting for data…" : "Connecting to the engine…"}
          </div>
        ) : mode === "trigger" ? (
          <TriggerMode state={state} locked={locked} />
        ) : (
          <ChannelMode state={state} locked={locked} />
        )}
      </main>

      <nav className="glass-strip relative z-10 shrink-0 border-t border-white/5 pb-[env(safe-area-inset-bottom)]">
        <div className="flex">
          {MODES.map((m) => {
            const active = mode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => pick(m.key)}
                className={cn(
                  "tap relative flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors",
                  active ? "text-primary" : "text-muted-foreground active:text-foreground"
                )}
              >
                <span
                  className={cn(
                    "absolute inset-x-8 top-0 h-0.5 rounded-full bg-primary transition-opacity",
                    active ? "opacity-100 shadow-[0_0_10px_hsl(var(--primary))]" : "opacity-0"
                  )}
                />
                <m.icon className="h-5 w-5" />
                {m.label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
