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
import { cn } from "@/lib/utils";
import { FixtureIcon, FIXTURE_KINDS } from "@/components/fixture-icons";
import { useEngine } from "@/lib/useEngine";
import {
  searchFixtures,
  getFixture,
  getPatch,
  patchAdd,
  patchUpdate,
  patchDelete,
  importLibraryUpload,
  clearFixtureCache,
  type FixtureHit,
  type Fixture,
  type PatchFixture,
  type FixtureKind,
  type FixtureHead,
  type ChannelType,
  type LedRemap,
  REMAP_DEFAULT,
  remapValue,
  manualSet,
  manualClear,
} from "@/lib/api";

// "2 switch, 1 led, 1 snap" — non-default channel behaviour, for the patch table.
function channelSummary(fx: PatchFixture) {
  const switches = fx.types?.filter((t) => t === "switch").length ?? 0;
  const leds = fx.types?.filter((t) => t === "led").length ?? 0;
  const snaps = fx.fade.filter((f, i) => !f && fx.types?.[i] !== "switch").length;
  return [switches && `${switches} switch`, leds && `${leds} led`, snaps && `${snaps} snap`].filter(Boolean).join(", ");
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
      // Once the file is sent, show the server's extract/parse progress instead.
      await importLibraryUpload(file, setUploadPct, () => setUploading(false));
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
              : imp?.phase === "uploading"
                ? "Receiving upload…"
                : imp?.phase === "extracting"
                  ? "Extracting personalities…"
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
                className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-[3px] focus:ring-ring/25"
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

// ── Add a built-in dimmer pack (no library needed) ─────────────────────────
function AddDimmerDialog({
  open,
  onClose,
  onAdded,
  universes,
  patch,
  total,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  universes: number;
  patch: PatchFixture[];
  total: number;
}) {
  const [channels, setChannels] = useState(12);
  const [switched, setSwitched] = useState(0);
  const [label, setLabel] = useState("Dimmer pack");
  const [universe, setUniverse] = useState(0);
  const [address, setAddress] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setAddress(nextFreeAddress(patch, universe, channels, total));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, universe, channels, total]);

  const dimmed = Math.max(0, channels - switched);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await patchAdd({ builtin: "dimmer", channels, switched, universe, address, label });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add dimmer pack</DialogTitle>
          <DialogDescription>
            A generic multi-channel dimmer, one head per channel. Switched channels (non-dim / hot power) are
            only ever fully on or off — change any channel later under <b>Channels</b>.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="space-y-3">
          <label className="block text-sm">
            Label
            <Input className="mt-1" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Channels
              <Input
                type="number"
                className="mt-1 w-24"
                value={channels}
                min={1}
                max={total}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(total, Number(e.target.value) || 1));
                  setChannels(n);
                  setSwitched((s) => Math.min(s, n));
                }}
              />
            </label>
            <label className="text-sm">
              Switched (last)
              <Input
                type="number"
                className="mt-1 w-24"
                value={switched}
                min={0}
                max={channels}
                onChange={(e) => setSwitched(Math.max(0, Math.min(channels, Number(e.target.value) || 0)))}
              />
            </label>
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
                max={total}
                onChange={(e) => setAddress(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="text-xs text-muted-foreground">
            U{universe}/{address}–{address + channels - 1}:{" "}
            {dimmed > 0 && `ch ${address}–${address + dimmed - 1} dimmed`}
            {dimmed > 0 && switched > 0 && ", "}
            {switched > 0 && `ch ${address + dimmed}–${address + channels - 1} switched`}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={busy}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-channel type + snap/fade editor ─────────────────────────────────────
interface ChannelRow {
  type: ChannelType;
  fade: boolean;
  name: string;
  remap: LedRemap;
}

const TYPE_LABEL: Record<ChannelType, string> = { level: "Level", switch: "Switch", led: "LED remap" };
const pct = (v: number) => Math.round((v / 255) * 100);
const fromPct = (p: number) => Math.round((Math.min(100, Math.max(0, p)) / 100) * 255);

const CURVES: { label: string; gamma: number }[] = [
  { label: "Softer", gamma: 0.45 },
  { label: "Soft", gamma: 0.65 },
  { label: "Linear", gamma: 1 },
  { label: "Hard", gamma: 1.6 },
  { label: "Harder", gamma: 2.4 },
];

// The remap as a picture: logical level across, DMX out up, with the lamp's
// usable band shaded.
function RemapCurve({ r }: { r: LedRemap }) {
  const W = 120;
  const H = 56;
  const pts = Array.from({ length: 33 }, (_, i) => {
    const v = Math.round((i / 32) * 255);
    return `${(i / 32) * W},${H - (remapValue(r, v) / 255) * H}`;
  });
  const yMin = H - (r.min / 255) * H;
  const yMax = H - (r.max / 255) * H;
  return (
    <svg width={W} height={H} className="shrink-0 rounded-md bg-black/40 ring-1 ring-inset ring-white/[0.06]">
      <rect x={0} y={yMax} width={W} height={Math.max(0, yMin - yMax)} fill="hsl(var(--primary) / 0.12)" />
      <line x1={0} x2={W} y1={yMin} y2={yMin} stroke="hsl(var(--primary) / 0.5)" strokeDasharray="2 3" />
      <line x1={0} x2={W} y1={yMax} y2={yMax} stroke="hsl(var(--primary) / 0.5)" strokeDasharray="2 3" />
      <polyline points={`0,${H} ${pts.slice(1).join(" ")}`} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} />
    </svg>
  );
}

// Min / max / curve for one led channel, with a live test fader that drives the
// real channel (by hand, on top of the scenes) so the lamp can be watched.
function RemapEditor({
  r,
  onChange,
  onTest,
  applied,
}: {
  r: LedRemap;
  onChange: (r: LedRemap) => void;
  onTest: (level: number) => void;
  applied: boolean; // the engine has these values (saved), so the test shows them
}) {
  const [test, setTest] = useState(0);
  const preset = CURVES.find((c) => Math.abs(c.gamma - r.gamma) < 0.01);
  const field = (label: string, value: number, set: (v: number) => void, hint: string) => (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      <span>
        {label} <span className="text-muted-foreground/60">{hint}</span>
      </span>
      <span className="flex items-center gap-1">
        <Input type="number" min={0} max={100} className="h-8 w-16" value={pct(value)} onChange={(e) => set(fromPct(Number(e.target.value)))} />
        <span>%</span>
        <span className="tabular text-[10px] text-muted-foreground/60">DMX {value}</span>
      </span>
    </label>
  );
  return (
    <div className="ml-14 mt-1 flex flex-wrap items-start gap-4 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2.5">
      <RemapCurve r={r} />
      {field("Min", r.min, (min) => onChange({ ...r, min, max: Math.max(min, r.max) }), "· lowest level that still lights")}
      {field("Max", r.max, (max) => onChange({ ...r, max, min: Math.min(max, r.min) }), "· highest before it misbehaves")}
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        <span>Curve</span>
        <span className="flex items-center gap-1">
          <div className="flex overflow-hidden rounded-md border border-border/60">
            {CURVES.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => onChange({ ...r, gamma: c.gamma })}
                className={cn("px-2 py-1 text-[11px]", preset?.label === c.label ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent/40")}
              >
                {c.label}
              </button>
            ))}
          </div>
          <Input type="number" step={0.05} min={0.2} max={5} className="h-8 w-16" value={r.gamma} onChange={(e) => onChange({ ...r, gamma: Number(e.target.value) || 1 })} />
        </span>
      </label>
      <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
        <span>
          Test {test}% → DMX {remapValue(r, fromPct(test))}
          {!applied && <span className="text-busy"> · apply to hear the new curve</span>}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={test}
          className="accent-[hsl(var(--primary))]"
          onChange={(e) => {
            const v = Number(e.target.value);
            setTest(v);
            onTest(v);
          }}
        />
      </label>
    </div>
  );
}

function ChannelsDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: PatchFixture | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [placeholders, setPlaceholders] = useState<string[]>([]); // personality names
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string>(""); // JSON of the remaps the engine has
  const tested = useRef(new Set<number>()); // channel offsets driven by the test fader

  const remapsJson = (rs: ChannelRow[]) => JSON.stringify(rs.map((r) => (r.type === "led" ? r.remap : null)));

  useEffect(() => {
    if (!entry) return;
    const initial = Array.from({ length: entry.channels }, (_, i) => ({
      type: entry.types?.[i] ?? "level",
      fade: entry.fade[i] !== false,
      name: entry.names?.[i] ?? "",
      remap: entry.remaps?.[i] ?? { ...REMAP_DEFAULT },
    }));
    setRows(initial);
    setApplied(remapsJson(initial));
    setPlaceholders([]);
    if (entry.libId == null) return;
    getFixture(entry.libId)
      .then((f) => {
        const m = f.modes.find((x) => x.name === entry.mode);
        const names: string[] = new Array(entry.channels).fill("");
        for (const a of m?.attrs ?? []) for (const off of a.offsets) if (off >= 1 && off <= names.length) names[off - 1] ||= a.name;
        setPlaceholders(names);
      })
      .catch(() => {});
  }, [entry]);

  const update = (i: number, patch: Partial<ChannelRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Switching type: switches never fade; keep default "Dimmer n"/"Power n" names in step.
  function setType(i: number, type: ChannelType) {
    const r = rows[i];
    const [from, to] = type === "switch" ? ["Dimmer", "Power"] : ["Power", "Dimmer"];
    update(i, {
      type,
      fade: type === "switch" ? false : true,
      name: r.name === `${from} ${i + 1}` ? `${to} ${i + 1}` : r.name,
    });
  }

  // Drive a channel by hand while the dialog is open, so the lamp can be watched.
  function test(i: number, level: number) {
    if (!entry) return;
    tested.current.add(i);
    manualSet([{ universe: entry.universe, channel: entry.address + i, value: fromPct(level) }]);
  }
  function releaseTests() {
    if (!entry || !tested.current.size) return;
    manualClear([...tested.current].map((i) => ({ universe: entry.universe, channel: entry.address + i })));
    tested.current.clear();
  }
  function close() {
    releaseTests();
    onClose();
  }

  const payload = () => rows.map((r) => ({ type: r.type, fade: r.fade, name: r.name, ...(r.type === "led" ? { remap: r.remap } : {}) }));

  // Apply: save and keep editing (the test fader then plays through the new curve).
  async function apply() {
    if (!entry) return;
    setBusy(true);
    try {
      await patchUpdate(entry.id, { channels: payload() });
      setApplied(remapsJson(rows));
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!entry) return;
    setBusy(true);
    try {
      await patchUpdate(entry.id, { channels: payload() });
      onSaved();
      close();
    } finally {
      setBusy(false);
    }
  }
  const hasLed = rows.some((r) => r.type === "led");

  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Channels — {entry?.label}</DialogTitle>
          <DialogDescription>
            <b>Level</b> channels ramp with crossfades, or <b>snap</b> instantly (shutters, control…).{" "}
            <b>Switch</b> channels are on/off only — non-dim loads and hot power: on as soon as a scene
            starts, off only once it has fully faded out. <b>LED remap</b> is a level channel for a lamp
            that doesn't dim cleanly: 0 is still off, but everything above is squeezed between a min and
            max through a curve, so scenes and faders keep using the full 0–100%.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-1 overflow-auto">
          {rows.map((r, i) => (
            <div key={i}>
            <div className="flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm">
              <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                Ch {i + 1}
                {entry && <span className="block text-[10px]">DMX {entry.address + i}</span>}
              </span>
              <Input
                className="h-8 flex-1"
                value={r.name}
                placeholder={placeholders[i] || `Channel ${i + 1}`}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <div className="flex overflow-hidden rounded-md border border-border/60">
                {(["level", "switch", "led"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setType(i, t)}
                    className={cn(
                      "whitespace-nowrap px-2.5 py-1 text-xs",
                      r.type === t
                        ? t === "switch"
                          ? "bg-amber-500 text-black"
                          : t === "led"
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-accent/40"
                    )}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
              <button
                disabled={r.type === "switch"}
                onClick={() => update(i, { fade: !r.fade })}
                title={r.type === "switch" ? "Switch channels never fade" : "Toggle fade / snap"}
                className="disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Badge variant={r.fade ? "secondary" : "warning"}>{r.fade ? "fade" : "snap"}</Badge>
              </button>
            </div>
            {r.type === "led" && (
              <RemapEditor
                r={r.remap}
                onChange={(remap) => update(i, { remap })}
                onTest={(level) => test(i, level)}
                applied={applied === remapsJson(rows)}
              />
            )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {hasLed && (
            <Button variant="outline" onClick={apply} disabled={busy} title="Save and keep editing — the test fader then plays through the new curve">
              Apply
            </Button>
          )}
          <Button onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Icon picker (row of the fixture icons) ─────────────────────────────────
function IconPicker({ value, onPick }: { value?: FixtureKind; onPick: (k: FixtureKind) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {FIXTURE_KINDS.map(({ key, label }) => (
        <button
          key={key}
          title={label}
          onClick={() => onPick(key)}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md border transition-colors",
            value === key
              ? "border-primary text-foreground ring-2 ring-primary"
              : "border-border/60 text-muted-foreground hover:border-foreground/40"
          )}
        >
          <FixtureIcon kind={key} className="h-6 w-6" />
        </button>
      ))}
    </div>
  );
}

// ── Icon / heads editor ────────────────────────────────────────────────────
function IconsDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: PatchFixture | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [icon, setIcon] = useState<FixtureKind>("par");
  const [heads, setHeads] = useState<FixtureHead[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setIcon(entry.icon ?? "par");
    setHeads(entry.heads ? entry.heads.map((h) => ({ ...h })) : null);
  }, [entry]);

  const patchHead = (i: number, patch: Partial<FixtureHead>) =>
    setHeads((hs) => (hs ? hs.map((h, idx) => (idx === i ? { ...h, ...patch } : h)) : hs));

  const splitAll = () =>
    setHeads(
      Array.from({ length: entry?.channels ?? 1 }, (_, i) => ({
        offset: i + 1,
        span: 1,
        label: entry?.names?.[i] || `Head ${i + 1}`,
        icon: entry?.types?.[i] === "switch" ? "power" : icon,
      }))
    );

  async function save() {
    if (!entry) return;
    setBusy(true);
    try {
      await patchUpdate(entry.id, heads ? { heads } : { icon, heads: null });
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Icon — {entry?.label}</DialogTitle>
          <DialogDescription>
            {heads
              ? "This fixture is split into heads — each is a separate light on the Fixtures page."
              : "Pick the icon shown on the Fixtures page. Dimmer packs can be split into one head per channel."}
          </DialogDescription>
        </DialogHeader>

        {entry && heads ? (
          <div className="max-h-96 space-y-2 overflow-auto">
            {heads.map((h, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-2">
                <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">
                  ch {entry.address + h.offset - 1}
                </span>
                <Input
                  className="h-8 w-36"
                  value={h.label}
                  onChange={(e) => patchHead(i, { label: e.target.value })}
                />
                <IconPicker value={h.icon} onPick={(k) => patchHead(i, { icon: k })} />
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setHeads(null)}>
              Merge into a single fixture
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <IconPicker value={icon} onPick={setIcon} />
            {entry && entry.channels > 1 && (
              <Button variant="outline" size="sm" onClick={splitAll}>
                Split into {entry.channels} heads (one per channel)
              </Button>
            )}
          </div>
        )}

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
  const [channelEdit, setChannelEdit] = useState<PatchFixture | null>(null);
  const [iconEdit, setIconEdit] = useState<PatchFixture | null>(null);
  const [addingDimmer, setAddingDimmer] = useState(false);

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

  async function commitField(id: string, body: Partial<Pick<PatchFixture, "label" | "universe" | "address">>) {
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

      <LibraryBar
        onImported={() => {
          clearFixtureCache();
          refresh();
        }}
      />

      {/* Search + add */}
      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <Button variant="outline" onClick={() => setAddingDimmer(true)}>
            <Plus className="h-4 w-4" /> Dimmer pack
          </Button>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search fixtures (manufacturer / name)…"
              value={q}
              onChange={(e) => doSearch(e.target.value)}
            />
            {results.length > 0 && (
              <div className="glass-pop pop-in absolute left-0 right-0 top-full z-30 mt-1 max-h-72 divide-y divide-white/[0.05] overflow-auto rounded-lg">
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
                <tr className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="w-16 px-4 py-2 font-medium">Icon</th>
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
                  <tr key={fx.id} className="border-b border-white/[0.04] transition-colors last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => setIconEdit(fx)}
                        title="Assign icon"
                        className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                      >
                        <FixtureIcon kind={fx.heads?.length ? fx.heads[0].icon : fx.icon ?? "par"} className="h-5 w-5" />
                        {fx.heads?.length ? <span className="text-xs tabular-nums">×{fx.heads.length}</span> : null}
                      </button>
                    </td>
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
                      {channelSummary(fx) && <span className="ml-2 text-xs">({channelSummary(fx)})</span>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setChannelEdit(fx)}>
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
              No fixtures patched yet. Add a dimmer pack, or import a library and search above.
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
      <AddDimmerDialog
        open={addingDimmer}
        universes={universes}
        patch={patch}
        total={channels}
        onClose={() => setAddingDimmer(false)}
        onAdded={refresh}
      />
      <ChannelsDialog entry={channelEdit} onClose={() => setChannelEdit(null)} onSaved={refresh} />
      <IconsDialog entry={iconEdit} onClose={() => setIconEdit(null)} onSaved={refresh} />
    </div>
  );
}
