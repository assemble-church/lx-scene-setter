import { NavLink } from "react-router-dom";
import { LayoutDashboard, Settings, Layers, Grid3x3, Plug, LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useEngine } from "@/lib/useEngine";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/scenes", label: "Scenes", icon: Layers, end: false },
  { to: "/fixtures", label: "Fixtures", icon: LayoutGrid, end: false },
  { to: "/universes", label: "Universes", icon: Grid3x3, end: false },
  { to: "/patch", label: "Patch", icon: Plug, end: false },
  { to: "/config", label: "Config", icon: Settings, end: false },
];

export function AppShell({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const { state, status } = useEngine();

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="flex h-14 items-center border-b border-border px-4">
          <span className="font-semibold tracking-tight">LX Scene Setter</span>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )
              }
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3 text-xs text-muted-foreground">
          {status === "open" ? "● connected" : status === "connecting" ? "○ connecting…" : "○ offline"}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!bare && (
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
            <div className="text-sm text-muted-foreground">House lighting controller</div>
            <div className="flex items-center gap-2">
              {state && (
                <>
                  <Badge variant={state.consoleActive ? "destructive" : "success"}>
                    {state.consoleActive ? "DESK LIVE" : "HOUSE CONTROL"}
                  </Badge>
                  <Badge variant={state.controllerOutput ? "secondary" : "outline"}>
                    controller {state.controllerOutput ? "on" : "off"}
                  </Badge>
                </>
              )}
            </div>
          </header>
        )}
        <main className={cn("min-w-0 flex-1", bare ? "overflow-hidden" : "overflow-auto p-6")}>{children}</main>
      </div>
    </div>
  );
}
