import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { UniverseGrid } from "@/components/UniverseGrid";
import { Plus, Trash2, Search } from "lucide-react";
import { useEngine } from "@/lib/useEngine";
import {
  searchFixtures,
  getFixture,
  getPatch,
  patchAdd,
  patchUpdate,
  patchDelete,
  importLibraryUpload,
  type FixtureHit,
  type Fixture,
  type PatchFixture,
} from "@/lib/api";

function snapChannels(fade: boolean[]) {
  return fade.map((f, i) => (f ? null : i + 1)).filter((x): x is number => x !== null);
}

// Lowest start address in `universe` with `channels` consecutive free channels.
function nextFreeAddress(fixtures: PatchFixture[], universe: number, channels: number, total = 512) {
  if (channels <= 0 || channels > total) return 1;
  const used = new Array(total + 2).fill(false);
  for (const fx of fixtures) {
    if (fx.universe !== universe) continue;
    for (let i = 0; i < fx.channels; i++) {
      const ch = fx.address + i;
      if (ch >= 1 && ch <= total) used[ch] = true;
    }
  }
  for (let a = 1; a + channels - 1 <= total; a++) {
    let ok = true;
    for (let i = 0; i < channels; i++)
      if (used[a + i]) {
        ok = false;
        break;
      }
    if (ok) return a;
  }
  return 1;
}

// ── Import / library status bar ───────────────────────────────────────────
function LibraryBar({ onImported }: { onImported: () => void }) {
  const { state } = useEngine();
  const fx = state?.fixtures;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    setUploading(true);
    setUploadPct(0);
    try {
      await importLibraryUpload(file, setUploadPct);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  const imp = fx?.import;
  const busy = uploading || imp?.running;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        <div className="flex-1">
          <div className="text-sm font-medium">Fixture library</div>
          <div className="text-xs text-muted-foreground">
            {fx?.libraryCount ? `${fx.libraryCount.toLocaleString()} fixtures imported` : "No library imported yet"}
          </div>
        </div>

        {busy ? (
          <div className="text-sm text-muted-foreground">
            {uploading
              ? `Uploading… ${uploadPct}%`
              : imp?.phase === "extracting"
                ? "Extracting…"
                : imp?.total
                  ? `Parsing ${imp.done.toLocaleString()} / ${imp.total.toLocaleString()}`
                  : "Importing…"}
          </div>
        ) : !fx?.sevenZip ? (
          <Badge variant="warning">{fx?.sevenZipHint || "7-Zip required to import"}</Badge>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".exe"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.currentTarget.value = "";
              }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              {fx?.libraryCount ? "Re-import library (.exe)" : "Import library (.exe)"}
            </Button>
          </>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
        {imp?.error && !busy && <span className="text-sm text-destructive">{imp.error}</span>}
      </CardContent>
    </Card>
  );
}

// ── Add-fixture dialog (mode / universe / address) ─────────────────────────
function AddDialog({
  hit,
  onClose,
  onAdded,
  universes,
  patch,
  total,
}: {
  hit: FixtureHit | null;
  onClose: () => void;
  onAdded: () => void;
  universes: number;
  patch: PatchFixture[];
  total: number;
}) {
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [mode, setMode] = useState("");
  const [universe, setUniverse] = useState(0);
  const [address, setAddress] = useState(1);
  const [count, setCount] = useState(1);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hit) return;
    setFixture(null);
    setError(null);
    getFixture(hit.id)
      .then((f) => {
        setFixture(f);
        setMode(f.modes[0]?.name ?? "");
        setLabel(f.name);
      })
      .catch((e) => setError(e.message));
  }, [hit]);

  const selectedMode = fixture?.modes.find((m) => m.name === mode);

  // Suggest the next free address whenever the universe or mode (channel count)
  // changes. Manual address edits are kept until one of those changes again.
  useEffect(() => {
    if (selectedMode) setAddress(nextFreeAddress(patch, universe, selectedMode.channels, total));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universe, mode, fixture, total]);

  async function add() {
    if (!hit) return;
    setBusy(true);
    setError(null);
    try {
      await patchAdd({ libId: hit.id, mode, universe, address, label, count });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!hit} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {hit ? `${hit.manufacturer} ${hit.name}` : ""}</DialogTitle>
          <DialogDescription>Patch this fixture to a universe and start address.</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!fixture ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              Mode
              <select
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                {fixture.modes.map((m) => (
                  <option key={m.name} value={m.name} className="bg-popover">
                    {m.name} ({m.channels} ch)
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Label
              <Input className="mt-1" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">
                Universe
                <Input
                  type="number"
                  className="mt-1 w-24"
                  value={universe}
                  min={0}
                  max={universes - 1}
                  onChange={(e) => setUniverse(Number(e.target.value))}
                />
              </label>
              <label className="text-sm">
                Address
                <Input
                  type="number"
                  className="mt-1 w-24"
                  value={address}
                  min={1}
                  max={512}
                  onChange={(e) => setAddress(Number(e.target.value))}
                />
              </label>
              <label className="text-sm">
                Count
                <Input
                  type="number"
                  className="mt-1 w-24"
                  value={count}
                  min={1}
                  max={512}
                  onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
                />
              </label>
            </div>
            <div className="text-xs text-muted-foreground">
              {count > 1
                ? `${count} fixtures × ${selectedMode?.channels ?? "?"} ch from U${universe}/${address}, wrapping to the next universe when full.`
                : `uses ${selectedMode?.channels ?? "?"} ch → ${address}–${address + (selectedMode?.channels ?? 1) - 1}`}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={busy || !fixture}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-channel snap/fade editor ───────────────────────────────────────────
function SnapDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: PatchFixture | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fade, setFade] = useState<boolean[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setFade([...entry.fade]);
    setLabels([]);
    getFixture(entry.libId)
      .then((f) => {
        const m = f.modes.find((x) => x.name === entry.mode);
        const names: string[] = new Array(entry.channels).fill("");
        for (const a of m?.attrs ?? []) for (const off of a.offsets) if (off >= 1 && off <= names.length) names[off - 1] = a.name;
        setLabels(names);
      })
      .catch(() => {});
  }, [entry]);

  async function save() {
    if (!entry) return;
    setBusy(true);
    try {
      await patchUpdate(entry.id, { fade });
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Channels — {entry?.label}</DialogTitle>
          <DialogDescription>
            Toggle each channel between <b>fade</b> (ramps with the crossfade) and <b>snap</b> (jumps
            instantly — shutters, control, etc.). Defaults come from the personality.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-96 space-y-1 overflow-auto">
          {fade.map((f, i) => (
            <button
              key={i}
              onClick={() => setFade((prev) => prev.map((v, idx) => (idx === i ? !v : v)))}
              className="flex w-full items-center justify-between rounded border border-border/50 px-3 py-1.5 text-left text-sm hover:bg-accent/40"
            >
              <span>
                <span className="tabular-nums text-muted-foreground">Ch {i + 1}</span>
                {labels[i] ? <span className="ml-2">{labels[i]}</span> : null}
              </span>
              <Badge variant={f ? "secondary" : "warning"}>{f ? "fade" : "snap"}</Badge>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Patch() {
  const { state } = useEngine();
  const universes = state?.universes ?? 1;
  const channels = state?.channels ?? 512;

  const [patch, setPatch] = useState<PatchFixture[]>([]);
  const [gridUniverse, setGridUniverse] = useState(0);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FixtureHit[]>([]);
  const [adding, setAdding] = useState<FixtureHit | null>(null);
  const [snapEdit, setSnapEdit] = useState<PatchFixture | null>(null);

  const refresh = () => getPatch().then((p) => setPatch(p.fixtures)).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  async function doSearch(query: string) {
    setQ(query);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      setResults(await searchFixtures(query));
    } catch {
      setResults([]);
    }
  }

  async function commitField(id: string, body: Partial<PatchFixture>) {
    const p = await patchUpdate(id, body);
    setPatch(p.fixtures);
  }

  async function remove(id: string) {
    await patchDelete(id);
    refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Patch &amp; Personalities</h1>

      <LibraryBar onImported={refresh} />

      {/* Search + add */}
      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search fixtures (manufacturer / name)…"
              value={q}
              onChange={(e) => doSearch(e.target.value)}
            />
            {results.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 divide-y divide-border/40 overflow-auto rounded-md border border-border bg-popover shadow-lg">
                {results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setAdding(r);
                      setResults([]);
                      setQ("");
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-accent/40"
                  >
                    <span>
                      <span className="text-muted-foreground">{r.manufacturer}</span> {r.name}
                    </span>
                    <Plus className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Patch grid — above the fixture list */}
      <Card>
        <CardContent className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Patch grid</div>
            <Select value={String(gridUniverse)} onValueChange={(v) => setGridUniverse(Number(v))}>
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
          <div className="overflow-x-auto">
            <UniverseGrid universe={gridUniverse} channels={channels} patch={patch} />
          </div>
        </CardContent>
      </Card>

      {/* Patch table */}
      <Card>
        <CardContent className="p-0">
          {patch.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Fixture</th>
                  <th className="px-4 py-2 font-medium">Mode</th>
                  <th className="w-20 px-4 py-2 font-medium">Universe</th>
                  <th className="w-20 px-4 py-2 font-medium">Address</th>
                  <th className="px-4 py-2 font-medium">Channels</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {patch.map((fx) => (
                  <tr key={fx.id} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2">
                      <Input
                        defaultValue={fx.label}
                        className="h-8 w-40"
                        onBlur={(e) => e.target.value !== fx.label && commitField(fx.id, { label: e.target.value })}
                      />
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {fx.manufacturer} {fx.name}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{fx.mode}</td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        defaultValue={fx.universe}
                        min={0}
                        max={universes - 1}
                        className="h-8 w-16"
                        onBlur={(e) => Number(e.target.value) !== fx.universe && commitField(fx.id, { universe: Number(e.target.value) })}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        defaultValue={fx.address}
                        min={1}
                        max={512}
                        className="h-8 w-16"
                        onBlur={(e) => Number(e.target.value) !== fx.address && commitField(fx.id, { address: Number(e.target.value) })}
                      />
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {fx.channels}
                      {snapChannels(fx.fade).length > 0 && (
                        <span className="ml-2 text-xs">({snapChannels(fx.fade).length} snap)</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setSnapEdit(fx)}>
                          Channels
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(fx.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              No fixtures patched yet. Import a library, search above, and add fixtures.
            </p>
          )}
        </CardContent>
      </Card>

      <AddDialog
        hit={adding}
        universes={universes}
        patch={patch}
        total={channels}
        onClose={() => setAdding(null)}
        onAdded={refresh}
      />
      <SnapDialog entry={snapEdit} onClose={() => setSnapEdit(null)} onSaved={refresh} />
    </div>
  );
}
