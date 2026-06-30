import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { UniverseGrid } from "@/components/UniverseGrid";
import { useEngine } from "@/lib/useEngine";
import { getPatch, type PatchFixture } from "@/lib/api";

export function Universes() {
  const { state, status } = useEngine();
  const universes = state?.universes ?? 0;
  const channels = state?.channels ?? 512;
  const [universe, setUniverse] = useState(0);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Universes</h1>
          <p className="text-sm text-muted-foreground">
            Live DMX output — dark → green by intensity; boxes show patched fixtures.
          </p>
        </div>
        <Select value={String(universe)} onValueChange={(v) => setUniverse(Number(v))}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: universes }, (_, u) => (
              <SelectItem key={u} value={String(u)}>
                Universe {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-3">
          <UniverseGrid universe={universe} channels={channels} patch={patch} />
        </CardContent>
      </Card>
    </div>
  );
}
