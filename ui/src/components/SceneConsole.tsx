import { useEffect, useRef, useState } from "react";
import { Star, Radio } from "lucide-react";
import { SceneStrip } from "@/components/SceneStrip";
import { Card } from "@/components/ui/card";
import type { SceneStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

// The dashboard console: one full-width bank with two channel groups, like a DAW
// mixer. Favourites are pinned to the left edge and live non-favourites to the
// right edge. Each group is only as wide as its strips (flex-basis: auto), with
// empty space between them; once they'd collide, both shrink — in proportion to
// their size — and scroll horizontally.

function Group({
  title,
  icon,
  scenes,
  disabled,
  empty,
  side,
  lingerUntil,
}: {
  title: string;
  icon: React.ReactNode;
  scenes: SceneStatus[];
  disabled: boolean;
  empty?: string;
  side: "left" | "right";
  lingerUntil?: (scene: SceneStatus) => number | undefined;
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 min-w-[104px] flex-col",
        side === "left" ? "border-r border-white/[0.07]" : "ml-auto border-l border-white/[0.07]"
      )}
      style={{ flex: "0 1 auto" }}
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-white/[0.07] bg-black/20 px-3">
        <span className="flex items-center gap-2 truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {icon}
          {title}
        </span>
        <span className="tabular text-[11px] text-muted-foreground">{scenes.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        {scenes.length ? (
          <div className="flex h-full w-max items-stretch [&>*:last-child]:border-r-0">
            {scenes.map((s) => (
              <SceneStrip key={s.id} scene={s} disabled={disabled} lingerUntil={lingerUntil?.(s)} lingerTotal={LINGER_MS} />
            ))}
          </div>
        ) : (
          <div className="flex h-full w-64 items-center justify-center px-6 text-center text-sm text-muted-foreground">{empty}</div>
        )}
      </div>
    </section>
  );
}

// A non-favourite stays on the console this long after it goes to zero, so it can
// be brought straight back up.
const LINGER_MS = 10000;

export function SceneConsole({ scenes, disabled }: { scenes: SceneStatus[]; disabled: boolean }) {
  const lastLive = useRef(new Map<string, number>()); // scene id → last time it was up
  const [, setTick] = useState(0);

  const now = Date.now();
  for (const s of scenes) if (s.on || s.level > 0) lastLive.current.set(s.id, now);
  const favourites = scenes.filter((s) => s.favourite);
  const liveOthers = scenes.filter((s) => {
    const t = lastLive.current.get(s.id);
    return !s.favourite && t !== undefined && now - t < LINGER_MS;
  });

  // Re-render when the next lingering strip is due to leave.
  const nextExpiry = Math.min(
    ...liveOthers.filter((s) => !(s.on || s.level > 0)).map((s) => lastLive.current.get(s.id)! + LINGER_MS)
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const id = setTimeout(() => setTick((n) => n + 1), Math.max(0, nextExpiry - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [nextExpiry]);

  return (
    <Card className="glow-amber flex h-full min-h-0 overflow-hidden p-0">
      <Group
        side="left"
        title="Favourites"
        icon={<Star className="h-3 w-3 fill-current text-primary" />}
        scenes={favourites}
        disabled={disabled}
        empty="No favourites yet. Star a scene on the Scenes page to pin it here."
      />
      {liveOthers.length > 0 && (
        <Group
          side="right"
          title="Live · not pinned"
          icon={<Radio className="h-3 w-3 text-live" />}
          scenes={liveOthers}
          disabled={disabled}
          lingerUntil={(s) => (s.on || s.level > 0 ? undefined : lastLive.current.get(s.id)! + LINGER_MS)}
        />
      )}
    </Card>
  );
}
