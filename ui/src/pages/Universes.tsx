import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { UniverseGrid } from "@/components/UniverseGrid";
import { useEngine } from "@/lib/useEngine";
import { getPatch, type PatchFixture } from "@/lib/api";

export function Universes() {
  const { state, status } = useEngine();
  const universes = state?.universes ?? 0;
  const channels = state?.channels ?? 512;
  const [patch, setPatch] = useState<PatchFixture[]>([]);

  useEffect(() => {
    getPatch()
      .then((p) => setPatch(p.fixtures))
      .catch(() => {});
  }, []);

  if (!universes) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {status === "open" ? "Waiting for data…" : "Connecting to the engine…"}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Universes</h1>
        <p className="text-sm text-muted-foreground">
          Live DMX output — dark → green by intensity; boxes show patched fixtures.
        </p>
      </div>

      {Array.from({ length: universes }, (_, u) => (
        <Card key={u}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Universe {u}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-3 pt-0">
            <UniverseGrid universe={u} channels={channels} patch={patch} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
