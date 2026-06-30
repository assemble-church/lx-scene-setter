import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ArrowLeft, Save, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEngine } from "@/lib/useEngine";
import {
  sceneEditBegin,
  sceneEditSet,
  sceneEditSave,
  sceneEditEnd,
  getSceneRaw,
  getPatch,
  getFixture,
  type PatchFixture,
  type Fixture,
  type FixtureMode,
  type FixtureAttr,
} from "@/lib/api";

type Update = { universe: number; channel: number; value: number };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const h2 = (n: number) => n.toString(16).padStart(2, "0");

const COLOUR_HEX: Record<string, string> = {
  open: "#ffffff", white: "#ffffff", red: "#ff2d2d", orange: "#ff8c00", amber: "#ffb300",
  yellow: "#ffe600", lime: "#a6ff00", green: "#28d428", teal: "#15b8a6", aqua: "#00e0c0", cyan: "#00d8e0",
  "light blue": "#6db0ff", blue: "#2b6bff", lavender: "#b39ddb", purple: "#9b30ff",
  "ultra violet": "#6a2cff", uv: "#6a2cff", magenta: "#ff2bd6", pink: "#ff7ab8", rose: "#ff5e8a",
  cto: "#ffd9a0", ctb: "#cfe6ff", congo: "#1c2bff",
};
function nameToHex(name: string): string | null {
  const n = (name || "").toLowerCase().trim();
  if (COLOUR_HEX[n]) return COLOUR_HEX[n];
  for (const k of Object.keys(COLOUR_HEX)) if (n.includes(k)) return COLOUR_HEX[k];
  return null;
}
const PALETTE = [
  "#ffffff", "#ff2d2d", "#ff8c00", "#ffe600", "#28d428", "#00d8e0",
  "#2b6bff", "#9b30ff", "#ff2bd6", "#ff7ab8", "#ffb300", "#6a2cff",
];

// pointer-drag helper: calls onMove(clientX, clientY) on down + while dragging.
function startDrag(e: React.PointerEvent, onMove: (x: number, y: number) => void) {
  onMove(e.clientX, e.clientY);
  const m = (ev: PointerEvent) => onMove(ev.clientX, ev.clientY);
  const up = () => {
    window.removeEventListener("pointermove", m);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", m);
  window.addEventListener("pointerup", up);
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ── primitives ──────────────────────────────────────────────────────────────
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/50 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-1 gap-3">{children}</div>
    </div>
  );
}

function VFader({ label, value, max = 255, onChange }: { label: string; value: number; max?: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = value / max;
  const set = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(Math.round(clamp01(1 - (clientY - r.top) / r.height) * max));
  };
  const onDown = (e: React.PointerEvent) => {
    set(e.clientY);
    const move = (ev: PointerEvent) => set(ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={ref}
        onPointerDown={onDown}
        className="relative h-44 w-10 cursor-pointer touch-none overflow-hidden rounded-lg bg-muted"
      >
        <div className="absolute inset-x-0 bottom-0 bg-primary/70" style={{ height: `${pct * 100}%` }} />
        <div className="absolute inset-x-0 h-0.5 bg-foreground/80" style={{ bottom: `${pct * 100}%` }} />
      </div>
      <div className="tabular-nums text-[10px] text-muted-foreground">{Math.round(pct * 100)}%</div>
      <div className="w-12 text-center text-[10px] leading-tight" title={label}>{label}</div>
    </div>
  );
}

// Horizontal slider for picking a value within a ranged slot (strobe rate, spin
// speed, frost amount …). Always rendered when a panel has any scale slot, and
// disabled when the selected slot isn't a scale — so it never shifts layout.
function HSlider({ label, min, max, value, onChange, disabled }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const pct = clamp01((value - min) / span);
  const set = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(Math.round(min + clamp01((clientX - r.left) / r.width) * span));
  };
  const onDown = disabled
    ? undefined
    : (e: React.PointerEvent) => {
        set(e.clientX);
        const move = (ev: PointerEvent) => set(ev.clientX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      };
  return (
    <div className={cn("w-full", disabled && "opacity-40")}>
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="truncate">{disabled ? "Rate / speed" : label}</span>
        {!disabled && <span className="tabular-nums">{Math.round(pct * 100)}%</span>}
      </div>
      <div
        ref={ref}
        onPointerDown={onDown}
        className={cn("relative h-6 w-full overflow-hidden rounded-md bg-muted", disabled ? "cursor-not-allowed" : "cursor-pointer touch-none")}
      >
        {!disabled && (
          <>
            <div className="absolute inset-y-0 left-0 bg-primary/70" style={{ width: `${pct * 100}%` }} />
            <div className="absolute inset-y-0 w-0.5 bg-foreground/80" style={{ left: `${pct * 100}%` }} />
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, colour, active, onClick }: { label: string; colour?: string | null; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex h-9 w-9 items-center justify-center overflow-hidden rounded-md border text-center text-[8px] leading-tight transition",
        active ? "border-primary ring-2 ring-primary" : "border-border/60 hover:border-foreground/40"
      )}
      style={colour ? { backgroundColor: colour } : undefined}
    >
      {colour ? "" : <span className="line-clamp-2 px-0.5">{label}</span>}
    </button>
  );
}

function ColourMixer({ r, g, b, onRgb }: { r: number; g: number; b: number; onRgb: (r: number, g: number, b: number) => void }) {
  const [h, s, v] = rgbToHsv(r, g, b);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const hex = `#${h2(r)}${h2(g)}${h2(b)}`;

  const onSV = (e: React.PointerEvent) =>
    startDrag(e, (cx, cy) => {
      const rect = svRef.current!.getBoundingClientRect();
      const ns = clamp01((cx - rect.left) / rect.width);
      const nv = clamp01(1 - (cy - rect.top) / rect.height);
      onRgb(...hsvToRgb(h, ns, nv));
    });
  const onHue = (e: React.PointerEvent) =>
    startDrag(e, (_cx, cy) => {
      const rect = hueRef.current!.getBoundingClientRect();
      const nh = clamp01(1 - (cy - rect.top) / rect.height) * 360;
      onRgb(...hsvToRgb(nh, s || 1, v || 1));
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <div
          ref={svRef}
          onPointerDown={onSV}
          className="relative h-40 w-40 cursor-crosshair touch-none rounded-lg"
          style={{ backgroundColor: `hsl(${h} 100% 50%)` }}
        >
          <div className="absolute inset-0 rounded-lg" style={{ background: "linear-gradient(to right,#fff,rgba(255,255,255,0))" }} />
          <div className="absolute inset-0 rounded-lg" style={{ background: "linear-gradient(to top,#000,rgba(0,0,0,0))" }} />
          <div
            className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
          />
        </div>
        <div
          ref={hueRef}
          onPointerDown={onHue}
          className="relative h-40 w-4 cursor-pointer touch-none rounded"
          style={{ background: "linear-gradient(to top,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%)" }}
        >
          <div className="absolute inset-x-[-3px] h-1.5 -translate-y-1/2 rounded-sm border border-white bg-white/50" style={{ top: `${(1 - h / 360) * 100}%` }} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded border border-border" style={{ backgroundColor: hex }} />
        <span className="font-mono text-xs text-muted-foreground">{hex.toUpperCase()}</span>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onRgb(parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16))}
            className="h-5 w-5 rounded border border-border/50"
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
      </div>
    </div>
  );
}

function SlotPanel({ title, attr, value, onPick }: { title: string; attr: FixtureAttr; value: number; onPick: (v: number) => void }) {
  // A colour wheel (swatches) vs any other discrete wheel (text/radio) — decide
  // by the attribute, not slot names ("Open" appears in shutter/gobo/prism too).
  const colourish = /colou?r/i.test(attr.name) || attr.group === "C";
  const mid = (f: { min: number; max: number }) => Math.round((f.min + f.max) / 2);

  // Clean up the personality's slot list:
  //  - drop literal duplicate slots (same name + range appears twice in the data)
  //  - on a colour wheel, drop the "X - Y" split/transition slots so each colour
  //    shows exactly once (the solid bands), not also as a between-colours step.
  const seen = new Set<string>();
  const fns = attr
    .functions!.map((f) => ({ name: f.name, min: Math.min(f.min, f.max), max: Math.max(f.min, f.max) }))
    .filter((f) => {
      if (/^raw\s*dmx$/i.test(f.name)) return false; // Avolites catch-all, not a real slot
      if (colourish && / - /.test(f.name)) return false;
      const key = `${f.name}:${f.min}:${f.max}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Ranges overlap (split colours, scroll bands, a catch-all "Raw DMX" 0–max).
  // Highlight exactly ONE slot: the narrowest range that contains the value.
  let activeIdx = -1;
  let bestWidth = Infinity;
  fns.forEach((f, i) => {
    if (value >= f.min && value <= f.max) {
      const w = f.max - f.min;
      if (w < bestWidth) {
        bestWidth = w;
        activeIdx = i;
      }
    }
  });
  const activeF = activeIdx >= 0 ? fns[activeIdx] : null;

  // Some slots are a continuous scale (strobe rate, spin speed, frost amount)
  // rather than a discrete position. Detect by range width relative to the
  // channel's full scale. The slider is always reserved when the panel has any
  // scale slot, and disabled when the selected slot isn't one (no layout shift).
  // Full channel scale — from the raw functions (incl. the hidden Raw DMX) so
  // removing it doesn't change which slots count as a continuous scale.
  const full = attr.functions!.reduce((m, f) => Math.max(m, f.min, f.max), 0) || 255;
  const isScale = (f: { min: number; max: number }) => !colourish && f.max - f.min > full * 0.06;
  const panelHasScale = fns.some(isScale);
  const sliderEnabled = !!activeF && isScale(activeF);
  const slider = panelHasScale ? (
    <HSlider
      label={activeF ? activeF.name : ""}
      min={sliderEnabled ? activeF!.min : 0}
      max={sliderEnabled ? activeF!.max : 1}
      value={sliderEnabled ? Math.min(activeF!.max, Math.max(activeF!.min, value)) : 0}
      onChange={onPick}
      disabled={!sliderEnabled}
    />
  ) : null;

  // Few, non-colour options (Shutter, Frost, Movement Speed) → radio rows.
  if (!colourish && fns.length <= 6) {
    return (
      <Panel title={title}>
        <div className="flex w-full flex-col gap-3 self-center">
          <div className="grid grid-cols-2 gap-x-5 gap-y-2">
            {fns.map((f, i) => {
              const active = i === activeIdx;
              return (
                <button key={i} onClick={() => onPick(mid(f))} className="flex items-center gap-2 text-sm">
                  <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full border", active ? "border-primary bg-primary" : "border-border")} />
                  <span className={cn("truncate", active ? "" : "text-muted-foreground")}>{f.name || f.min}</span>
                </button>
              );
            })}
          </div>
          {slider}
        </div>
      </Panel>
    );
  }

  // Colour wheels / gobos → tile grid.
  return (
    <Panel title={title}>
      <div className="flex w-full flex-col gap-2 self-start">
        <div className="grid grid-cols-4 gap-1.5">
          {fns.map((f, i) => (
            <Tile
              key={i}
              label={f.name || String(f.min)}
              // Only pure single-colour slots get a swatch; split/transition slots
              // ("Op - Rd", "Pk - UV") and scroll modes render as plain text tiles
              // so each colour appears exactly once.
              colour={colourish && !/ - /.test(f.name) ? nameToHex(f.name) : null}
              active={i === activeIdx}
              onClick={() => onPick(mid(f))}
            />
          ))}
        </div>
        {slider}
      </div>
    </Panel>
  );
}

function XYPad({ x, y, onChange }: { x: number; y: number; onChange: (x: number, y: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const set = (cx: number, cy: number) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(clamp01((cx - r.left) / r.width), clamp01(1 - (cy - r.top) / r.height));
  };
  const onDown = (e: React.PointerEvent) => {
    set(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => set(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      className="relative h-44 w-44 cursor-crosshair touch-none rounded-lg bg-muted"
    >
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary"
        style={{ left: `${x * 100}%`, top: `${(1 - y) * 100}%` }}
      />
    </div>
  );
}

// ── fixture editor ──────────────────────────────────────────────────────────
function FixtureEditor({ fx, getVal, setChannels }: { fx: PatchFixture; getVal: (u: number, ch: number) => number; setChannels: (u: Update[]) => void }) {
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [mode, setMode] = useState<FixtureMode | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    getFixture(fx.libId).then((f) => {
      if (!alive) return;
      setFixture(f);
      setMode(f.modes.find((m) => m.name === fx.mode) || f.modes[0] || null);
    });
    return () => {
      alive = false;
    };
  }, [fx.libId, fx.mode]);

  if (!fixture || !mode) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const u = fx.universe;
  const ch = (offset: number) => fx.address + offset - 1;
  const v = (offset: number) => getVal(u, ch(offset));
  const apply = (ups: Update[]) => {
    setChannels(ups);
    setTick((t) => t + 1);
  };
  const setOne = (offset: number, value: number) => apply([{ universe: u, channel: ch(offset), value }]);

  // Cells/Master personalities emit duplicate attrs for the same channel(s)
  // (e.g. "Dimmer 1" and "Cell 1 Dimmer" both on offset 1) → one fader each.
  const seenOffsets = new Set<string>();
  const attrs = mode.attrs.filter((a) => {
    if (!a.offsets?.length) return false;
    const key = a.offsets.join(",");
    if (seenOffsets.has(key)) return false;
    seenOffsets.add(key);
    return true;
  });
  const isShutter = (a: FixtureAttr) => /shutter|strobe/i.test(a.name);
  const find = (re: RegExp) => attrs.find((a) => !a.functions && re.test(a.name.toLowerCase()));

  const rA = find(/red/), gA = find(/green/), bA = find(/blue/);
  const hasMix = rA && gA && bA;
  const panA = attrs.find((a) => !a.functions && /pan/i.test(a.name));
  const tiltA = attrs.find((a) => !a.functions && /tilt/i.test(a.name));

  const intensity = attrs.filter((a) => !a.functions && !isShutter(a) && (a.group === "I" || /dim|intensit|master/i.test(a.name)));
  const extraColour = attrs.filter((a) => !a.functions && a.group === "C" && a !== rA && a !== gA && a !== bA);
  const slots = attrs.filter((a) => a.functions?.length);
  const handled = new Set<FixtureAttr>([...intensity, ...slots, ...extraColour, rA, gA, bA, panA, tiltA].filter(Boolean) as FixtureAttr[]);
  const others = attrs.filter((a) => !a.functions && !handled.has(a));

  // Label for a single DMX channel (by 1-based offset) — what that channel does.
  const labelFor = (offset: number) => {
    for (const a of attrs) {
      const i = a.offsets.indexOf(offset);
      if (i >= 0) return a.offsets.length > 1 ? `${a.name} ${i === 0 ? "hi" : "lo"}` : a.name;
    }
    return `Ch ${offset}`;
  };

  // Bit-depth is determined by how many channels are actually patched in THIS
  // mode, not the personality's declared size — a "16-bit" attr often has only
  // its coarse byte patched in a basic mode (offsets.length === 1 → 8-bit).
  const wide = (a: FixtureAttr) => a.offsets.length >= 2;
  const maxOf = (a: FixtureAttr) => (wide(a) ? 65535 : 255);
  const v16 = (a: FixtureAttr) => (wide(a) ? v(a.offsets[0]) * 256 + v(a.offsets[1]) : v(a.offsets[0]));
  const setCont = (a: FixtureAttr, value: number) => {
    if (wide(a))
      apply([
        { universe: u, channel: ch(a.offsets[0]), value: (value >> 8) & 0xff },
        { universe: u, channel: ch(a.offsets[1]), value: value & 0xff },
      ]);
    else setOne(a.offsets[0], value);
  };

  // Slot functions are expressed in the attr's DECLARED bit-depth (size), but
  // only `offsets.length` channels are patched. Read/write in declared space so
  // ranges line up, then scale onto the patched (often coarse-only) channel(s).
  const declMax = (a: FixtureAttr) => (a.size >= 2 ? 65535 : 255);
  const declOf = (a: FixtureAttr) =>
    a.offsets.length >= 2
      ? v(a.offsets[0]) * 256 + v(a.offsets[1])
      : a.size >= 2
      ? v(a.offsets[0]) * 256 // single coarse byte represents the high byte
      : v(a.offsets[0]);
  const setDecl = (a: FixtureAttr, d: number) => {
    d = Math.max(0, Math.min(declMax(a), Math.round(d)));
    if (a.offsets.length >= 2)
      apply([
        { universe: u, channel: ch(a.offsets[0]), value: (d >> 8) & 0xff },
        { universe: u, channel: ch(a.offsets[1]), value: d & 0xff },
      ]);
    else if (a.size >= 2) setOne(a.offsets[0], (d >> 8) & 0xff); // coarse only
    else setOne(a.offsets[0], d & 0xff);
  };

  const sectionTitle = (a: FixtureAttr) => {
    const n = a.name.toLowerCase();
    if (/gobo/.test(n)) return n.includes("rot") ? "Gobo Rotation" : "Gobo";
    if (/colou?r/.test(n)) return "Colour";
    if (/prism/.test(n)) return "Prism";
    if (/shutter|strobe/.test(n)) return "Shutter / Strobe";
    return a.name;
  };

  return (
    <div className="space-y-3 p-4">
      <div>
        <div className="text-lg font-semibold">{fx.label}</div>
        <div className="text-xs text-muted-foreground">
          {fx.manufacturer} {fx.name} · {fx.mode} · U{fx.universe}/{fx.address}
        </div>
      </div>

      <div className="flex flex-wrap items-stretch gap-3">
        {intensity.length > 0 && (
          <Panel title="Dimmer">
            {intensity.map((a) => (
              <VFader key={a.id} label={a.name} value={v16(a)} max={maxOf(a)} onChange={(val) => setCont(a, val)} />
            ))}
          </Panel>
        )}

        {(hasMix || extraColour.length > 0) && (
          <Panel title="Colour">
            {hasMix && (
              <ColourMixer
                r={v(rA!.offsets[0])}
                g={v(gA!.offsets[0])}
                b={v(bA!.offsets[0])}
                onRgb={(r, g, b) =>
                  apply([
                    { universe: u, channel: ch(rA!.offsets[0]), value: r },
                    { universe: u, channel: ch(gA!.offsets[0]), value: g },
                    { universe: u, channel: ch(bA!.offsets[0]), value: b },
                  ])
                }
              />
            )}
            {extraColour.map((a) => (
              <VFader key={a.id} label={a.name} value={v16(a)} max={maxOf(a)} onChange={(val) => setCont(a, val)} />
            ))}
          </Panel>
        )}

        {panA && tiltA && (
          <Panel title="Position">
            <XYPad
              x={v16(panA) / maxOf(panA)}
              y={v16(tiltA) / maxOf(tiltA)}
              onChange={(x, y) => {
                setCont(panA, Math.round(x * maxOf(panA)));
                setCont(tiltA, Math.round(y * maxOf(tiltA)));
              }}
            />
          </Panel>
        )}

        {slots.map((a) => (
          <SlotPanel key={a.id} title={sectionTitle(a)} attr={a} value={declOf(a)} onPick={(val) => setDecl(a, val)} />
        ))}

        {others.length > 0 && (
          <Panel title="Other">
            {others.map((a) => (
              <VFader key={a.id} label={a.name} value={v16(a)} max={maxOf(a)} onChange={(val) => setCont(a, val)} />
            ))}
          </Panel>
        )}
      </div>

      {/* Raw per-channel bank — every DMX channel of this fixture, 0–255, for
          manual editing alongside the controls above. */}
      <div className="border-t border-border pt-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Raw channels
        </div>
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: mode.channels }, (_, i) => {
            const offset = i + 1;
            return (
              <div key={offset} className="flex flex-col items-center gap-1">
                <span className="text-[9px] tabular-nums text-muted-foreground">ch {ch(offset)}</span>
                <VFader label={labelFor(offset)} value={v(offset)} max={255} onChange={(val) => setOne(offset, val)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── raw / unpatched channels ────────────────────────────────────────────────
function RawEditor({ universes, channels, patch, getVal, setChannels }: { universes: number; channels: number; patch: PatchFixture[]; getVal: (u: number, ch: number) => number; setChannels: (u: Update[]) => void }) {
  const [u, setU] = useState(0);
  const [, setTick] = useState(0);
  const free = useMemo(() => {
    const owned = new Set<number>();
    for (const f of patch) if (f.universe === u) for (let i = 0; i < f.channels; i++) owned.add(f.address + i);
    const out: number[] = [];
    for (let c = 1; c <= channels; c++) if (!owned.has(c)) out.push(c);
    return out;
  }, [u, channels, patch]);

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Unpatched channels</div>
        <Select value={String(u)} onValueChange={(val) => setU(Number(val))}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: universes }, (_, i) => (
              <SelectItem key={i} value={String(i)}>Universe {i}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Panel title="Dimmers">
        <div className="flex flex-wrap gap-3">
          {free.map((c) => (
            <VFader key={c} label={`Ch ${c}`} value={getVal(u, c)} onChange={(val) => { setChannels([{ universe: u, channel: c, value: val }]); setTick((t) => t + 1); }} />
          ))}
          {free.length === 0 && <div className="text-sm text-muted-foreground">Every channel is patched.</div>}
        </div>
      </Panel>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────
export function SceneEditor() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { state } = useEngine();
  const universes = state?.universes ?? 1;
  const channels = state?.channels ?? 512;

  const [label, setLabel] = useState("");
  const [patch, setPatch] = useState<PatchFixture[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [, setReady] = useState(0); // bumped when scene values load → re-renders controls

  const valuesRef = useRef<Record<number, number[]>>({});
  const pending = useRef<Record<string, Update>>({});
  const flushTimer = useRef<number | null>(null);

  const getVal = (uni: number, cch: number) => valuesRef.current[uni]?.[cch - 1] ?? 0;
  function flush() {
    flushTimer.current = null;
    const ups = Object.values(pending.current);
    pending.current = {};
    if (ups.length) sceneEditSet(ups);
  }
  function setChannels(ups: Update[]) {
    for (const x of ups) {
      (valuesRef.current[x.universe] ||= new Array(channels).fill(0))[x.channel - 1] = x.value;
      pending.current[`${x.universe}:${x.channel}`] = x;
    }
    setSaved(false); // changes are live but NOT persisted until Save
    if (flushTimer.current == null) flushTimer.current = window.setTimeout(flush, 40);
  }

  // Load the scene's saved values into the editor buffer (mount + revert).
  function applyRaw(raw: { label: string; data: number[][] }) {
    setLabel(raw.label || `Scene ${id}`);
    const vals: Record<number, number[]> = {};
    raw.data.forEach((row, uni) => {
      vals[uni] = new Array(channels).fill(0);
      if (row) for (let c = 0; c < Math.min(channels, row.length); c++) vals[uni][c] = row[c] | 0;
    });
    valuesRef.current = vals;
    setReady((n) => n + 1); // force controls to re-read the loaded values
  }

  useEffect(() => {
    let alive = true;
    sceneEditBegin(id).catch(() => {});
    getSceneRaw(id)
      .then((raw) => alive && applyRaw(raw))
      .catch(() => {});
    getPatch().then((p) => alive && setPatch(p.fixtures)).catch(() => {});
    return () => {
      alive = false;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      sceneEditEnd(); // discards unsaved edits (no auto-save)
    };
  }, [id, channels]);

  const groups = useMemo(() => {
    const m: Record<string, PatchFixture[]> = {};
    for (const f of patch) (m[`${f.manufacturer} ${f.name} · ${f.mode}`] ||= []).push(f);
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.universe - b.universe || a.address - b.address);
    return m;
  }, [patch]);

  const selectedFx = patch.find((f) => f.id === selected);

  // Is any channel of this fixture non-zero in the scene being edited?
  const fixtureLit = (f: PatchFixture) => {
    const row = valuesRef.current[f.universe];
    if (!row) return false;
    for (let i = 0; i < f.channels; i++) if ((row[f.address - 1 + i] || 0) > 0) return true;
    return false;
  };

  async function save() {
    flush();
    await sceneEditSave().catch(() => {});
    setSaved(true);
  }

  // Discard all unsaved edits: reload the scene's saved data into the engine
  // buffer (re-solos it) and the UI controls.
  async function revert() {
    await sceneEditBegin(id).catch(() => {});
    const raw = await getSceneRaw(id).catch(() => null);
    if (raw) applyRaw(raw);
    setSaved(true);
  }

  function goBack() {
    if (saved || window.confirm("Discard unsaved changes and leave?")) navigate("/scenes");
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" /> Scenes
          </Button>
          <div>
            <span className="font-semibold">{label}</span>
            <span className="ml-2 text-xs text-muted-foreground">live editor</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state?.consoleActive && <Badge variant="destructive">Desk live — output suppressed</Badge>}
          {!saved && <span className="text-xs text-amber-400">unsaved changes</span>}
          <Button variant="outline" onClick={revert} disabled={saved}>
            <Undo2 className="h-4 w-4" /> Revert
          </Button>
          <Button onClick={save} disabled={saved}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-auto border-r border-border p-2">
          {Object.keys(groups).sort().map((g) => (
            <div key={g} className="mb-2">
              <div className="truncate whitespace-nowrap px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground" title={g}>
                {g}
              </div>
              {groups[g].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSelected(f.id)}
                  title={f.label}
                  className={cn(
                    "flex w-full items-center gap-2 rounded py-1.5 pl-5 pr-2 text-left text-sm",
                    selected === f.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
                  )}
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 shrink-0 rounded-full",
                      fixtureLit(f) ? "bg-green-500 shadow-[0_0_6px] shadow-green-500/70" : "bg-muted-foreground/30"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">{f.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">U{f.universe}/{f.address}</span>
                </button>
              ))}
            </div>
          ))}
          {patch.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">No fixtures patched.</div>
          )}
          <button
            onClick={() => setSelected("__raw__")}
            className={cn(
              "mt-2 flex w-full items-center rounded px-2 py-1.5 text-left text-sm",
              selected === "__raw__" ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
            )}
          >
            Unpatched channels
          </button>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto">
          {selected === "__raw__" ? (
            <RawEditor universes={universes} channels={channels} patch={patch} getVal={getVal} setChannels={setChannels} />
          ) : selectedFx ? (
            <FixtureEditor key={selectedFx.id} fx={selectedFx} getVal={getVal} setChannels={setChannels} />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">Select a fixture to edit.</div>
          )}
        </main>
      </div>
    </div>
  );
}
