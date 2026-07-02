import { useEffect, useMemo, useRef, useState } from "react";
import { Move, X, Crosshair, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FixtureIcon } from "@/components/fixture-icons";
import { FixtureEditor, locateUpdates, nameToHex, type Update } from "@/components/FixtureEditor";
import { useEngine } from "@/lib/useEngine";
import {
  getPatch,
  getFixture,
  getFixtureMap,
  setFixtureMap,
  programmerSet,
  programmerClear,
  programmerSaveScene,
  type PatchFixture,
  type FixtureKind,
  type Fixture,
  type FixtureMode,
} from "@/lib/api";

// How to read a fixture's colour + intensity from live DMX (offsets are 1-based).
interface FixDesc {
  dim: { off: number } | null;
  rgb: { r: number; g: number; b: number } | null;
  wheel: { off: number; size: number; fns: { name: string; min: number; max: number }[] } | null;
}

function buildDesc(f: Fixture, modeName: string): FixDesc {
  const mode = f.modes.find((m) => m.name === modeName) || f.modes[0];
  const attrs = (mode?.attrs || []).filter((a) => a.offsets?.length);
  const find = (re: RegExp) => attrs.find((a) => !a.functions && re.test(a.name.toLowerCase()));
  const dim = attrs.find((a) => !a.functions && a.group === "I" && !/shutter|strobe/.test(a.name.toLowerCase()));
  const r = find(/red/), g = find(/green/), b = find(/blue/);
  const wheel = attrs.find((a) => a.functions && (a.group === "C" || /colou?r/.test(a.name.toLowerCase())));
  return {
    dim: dim ? { off: dim.offsets[0] } : null,
    rgb: r && g && b ? { r: r.offsets[0], g: g.offsets[0], b: b.offsets[0] } : null,
    wheel: wheel ? { off: wheel.offsets[0], size: wheel.size, fns: wheel.functions! } : null,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// Blend towards a dim grey floor by intensity so off fixtures read as neutral.
function mixColour(r: number, g: number, b: number, i: number): string {
  const t = Math.max(0, Math.min(1, i));
  const base = 42;
  const m = (c: number) => Math.round(base + (c - base) * t);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

// One placeable light on the grid. A single-head fixture is one item; a
// multi-dimmer contributes one item per head.
interface GridItem {
  key: string;
  fixtureId: string;
  label: string;
  icon: FixtureKind;
  universe: number;
  address: number;
  channels: number;
}

function enumerateItems(fixtures: PatchFixture[]): GridItem[] {
  const items: GridItem[] = [];
  for (const fx of fixtures) {
    if (fx.heads?.length) {
      for (const h of fx.heads) {
        items.push({
          key: `${fx.id}#${h.offset}`,
          fixtureId: fx.id,
          label: h.label || fx.label,
          icon: h.icon,
          universe: fx.universe,
          address: fx.address + h.offset - 1,
          channels: h.span,
        });
      }
    } else {
      items.push({
        key: fx.id,
        fixtureId: fx.id,
        label: fx.label,
        icon: fx.icon ?? "par",
        universe: fx.universe,
        address: fx.address,
        channels: fx.channels,
      });
    }
  }
  return items;
}

// Canonical attribute role so one control drives the same *kind* of channel
// across fixture types (e.g. "dim" covers Dimmer, Dimmer 1..6, Master).
function roleOf(a: { name: string; group: string; functions?: unknown[] }): string {
  const n = a.name.toLowerCase();
  if (/shutter|strobe/.test(n)) return "shutter";
  if (/\bpan\b/.test(n)) return "pan";
  if (/\btilt\b/.test(n)) return "tilt";
  if (!a.functions) {
    if (/red/.test(n)) return "red";
    if (/green/.test(n)) return "green";
    if (/blue/.test(n)) return "blue";
    if (/cyan/.test(n)) return "cyan";
    if (/magenta/.test(n)) return "magenta";
    if (/yellow/.test(n)) return "yellow";
    if (/white/.test(n)) return "white";
    if (/amber/.test(n)) return "amber";
    if (a.group === "I" || /dim|intensit|master/.test(n)) return "dim";
  }
  if (a.functions && (a.group === "C" || /colou?r/.test(n))) return "colourwheel";
  if (/gobo/.test(n)) return /rot/.test(n) ? "goborot" : "gobo";
  if (/prism/.test(n)) return "prism";
  if (/frost/.test(n)) return "frost";
  if (/zoom/.test(n)) return "zoom";
  if (/focus/.test(n)) return "focus";
  if (/iris/.test(n)) return "iris";
  return `${a.group}:${n.replace(/\s*\d+$/, "").trim()}`;
}

interface MAttr {
  name: string;
  offsets: number[];
  size: number;
  role: string;
  functions?: { name: string; min: number; max: number }[];
}
interface Target {
  fx: PatchFixture;
  mode?: FixtureMode; // supplied for synthetic single heads
  address: number;
  universe: number;
  attrs: MAttr[];
  byRole: Map<string, MAttr[]>;
}

// A single dimmer channel presented as a standalone fixture (a dimmer-pack head).
const HEAD_MODE: FixtureMode = {
  name: "Head",
  channels: 1,
  attrs: [{ id: "dim", name: "Dimmer", group: "I", size: 1, fade: true, offsets: [1] }],
};

const colourDist = (a: [number, number, number], b: [number, number, number]) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Drives the editor with the richest selected target (a fixture, or a single head
// from a dimmer pack) and fans changes to all selected targets by role. Colour
// crosses models: a wheel pick tints RGB fixtures; an RGB change snaps wheel
// fixtures to the nearest slot.
function SelectionEditor({ items, patch, channels }: { items: GridItem[]; patch: PatchFixture[]; channels: number }) {
  const infoRef = useRef<{ rep: Target; all: Target[] } | null>(null);
  const [ready, setReady] = useState(false);
  const valuesRef = useRef<Record<number, number[]>>({});
  const pending = useRef<Record<string, Update>>({});
  const timer = useRef<number | null>(null);
  const [, setTick] = useState(0);

  function flush() {
    timer.current = null;
    const ups = Object.values(pending.current);
    pending.current = {};
    if (ups.length) programmerSet(ups);
  }
  function baseSet(ups: Update[]) {
    for (const x of ups) {
      (valuesRef.current[x.universe] ||= new Array(channels).fill(0))[x.channel - 1] = x.value;
      pending.current[`${x.universe}:${x.channel}`] = x;
    }
    if (timer.current == null) timer.current = window.setTimeout(flush, 40);
  }
  const getVal = (u: number, ch: number) => valuesRef.current[u]?.[ch - 1] ?? 0;
  const patchedMax = (a: MAttr) => (a.offsets.length >= 2 ? 65535 : 255);
  const readPatched = (t: Target, a: MAttr) => {
    const at = (o: number) => valuesRef.current[t.universe]?.[t.address + o - 2] ?? 0;
    return a.offsets.length >= 2 ? at(a.offsets[0]) * 256 + at(a.offsets[1]) : at(a.offsets[0]);
  };
  const readDeclared = (t: Target, a: MAttr) => {
    const at = (o: number) => valuesRef.current[t.universe]?.[t.address + o - 2] ?? 0;
    return a.offsets.length >= 2 ? at(a.offsets[0]) * 256 + at(a.offsets[1]) : a.size >= 2 ? at(a.offsets[0]) * 256 : at(a.offsets[0]);
  };
  function writeFrac(extra: Update[], t: Target, a: MAttr, frac: number) {
    const max = patchedMax(a);
    const v = Math.max(0, Math.min(max, Math.round(frac * max)));
    if (a.offsets.length >= 2) {
      extra.push({ universe: t.universe, channel: t.address + a.offsets[0] - 1, value: (v >> 8) & 0xff });
      extra.push({ universe: t.universe, channel: t.address + a.offsets[1] - 1, value: v & 0xff });
    } else extra.push({ universe: t.universe, channel: t.address + a.offsets[0] - 1, value: v & 0xff });
  }
  function activeSlot(fns: MAttr["functions"], declared: number) {
    if (!fns) return null;
    let best: { name: string; min: number; max: number } | null = null;
    let bw = Infinity;
    for (const f of fns) {
      const lo = Math.min(f.min, f.max);
      const hi = Math.max(f.min, f.max);
      if (declared >= lo && declared <= hi && hi - lo < bw) {
        bw = hi - lo;
        best = f;
      }
    }
    return best;
  }

  function fanSet(repUpdates: Update[]) {
    const info = infoRef.current;
    if (!info) return baseSet(repUpdates);
    baseSet(repUpdates);
    const { rep } = info;
    const others = info.all.filter((t) => t !== rep);
    const touched = new Map<string, MAttr>();
    for (const up of repUpdates) {
      const off = up.channel - rep.address + 1;
      const a = rep.attrs.find((x) => x.offsets.includes(off));
      if (a) touched.set(a.role, a);
    }
    const extra: Update[] = [];
    // Same-role fan-out (fraction, so bit-depths line up).
    for (const [role, a] of touched) {
      const frac = readPatched(rep, a) / patchedMax(a);
      for (const other of others) for (const oa of other.byRole.get(role) || []) writeFrac(extra, other, oa, frac);
    }
    // Wheel → RGB: tint colour-mix fixtures to the picked slot's colour.
    if (touched.has("colourwheel")) {
      const wa = touched.get("colourwheel")!;
      const slot = activeSlot(wa.functions, readDeclared(rep, wa));
      const hex = slot ? nameToHex(slot.name) : null;
      if (hex) {
        const [r, g, b] = hexToRgb(hex);
        for (const other of others) {
          for (const oa of other.byRole.get("red") || []) writeFrac(extra, other, oa, r / 255);
          for (const oa of other.byRole.get("green") || []) writeFrac(extra, other, oa, g / 255);
          for (const oa of other.byRole.get("blue") || []) writeFrac(extra, other, oa, b / 255);
        }
      }
    }
    // RGB → wheel: snap wheel fixtures to the nearest slot to the mixed colour.
    if (["red", "green", "blue"].some((r) => touched.has(r))) {
      const rr = rep.byRole.get("red")?.[0];
      const rg = rep.byRole.get("green")?.[0];
      const rb = rep.byRole.get("blue")?.[0];
      if (rr && rg && rb) {
        const rgb: [number, number, number] = [readPatched(rep, rr) & 0xff, readPatched(rep, rg) & 0xff, readPatched(rep, rb) & 0xff];
        for (const other of others)
          for (const oa of other.byRole.get("colourwheel") || []) {
            const declMax = oa.size >= 2 ? 65535 : 255;
            let best: { name: string; min: number; max: number } | null = null;
            let bd = Infinity;
            for (const f of oa.functions || []) {
              const hx = nameToHex(f.name);
              if (!hx) continue;
              const d = colourDist(rgb, hexToRgb(hx));
              if (d < bd) {
                bd = d;
                best = f;
              }
            }
            if (best) writeFrac(extra, other, oa, (Math.min(best.min, best.max) + Math.max(best.min, best.max)) / 2 / declMax);
          }
      }
    }
    if (extra.length) baseSet(extra);
  }

  // Resolve the selected grid items into targets.
  useEffect(() => {
    let alive = true;
    Promise.all(
      items.map(async (it): Promise<Target | null> => {
        const fx = patch.find((f) => f.id === it.fixtureId);
        if (!fx) return null;
        if (it.key.includes("#")) {
          const synth: PatchFixture = { ...fx, id: it.key, label: it.label, address: it.address, channels: it.channels || 1 };
          const attrs: MAttr[] = [{ name: "Dimmer", offsets: [1], size: 1, role: "dim" }];
          return { fx: synth, mode: HEAD_MODE, address: it.address, universe: it.universe, attrs, byRole: new Map([["dim", attrs]]) };
        }
        const f = await getFixture(fx.libId).catch(() => null);
        const m = f?.modes.find((x) => x.name === fx.mode) || f?.modes[0];
        if (!m) return null;
        const seen = new Set<string>();
        const attrs: MAttr[] = (m.attrs || [])
          .filter((a) => a.offsets?.length)
          .filter((a) => {
            const k = a.offsets.join(",");
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((a) => ({ name: a.name, offsets: a.offsets, size: a.size, role: roleOf(a), functions: a.functions }));
        const byRole = new Map<string, MAttr[]>();
        for (const a of attrs) {
          const arr = byRole.get(a.role) || [];
          arr.push(a);
          byRole.set(a.role, arr);
        }
        return { fx, address: fx.address, universe: fx.universe, attrs, byRole };
      })
    ).then((rs) => {
      if (!alive) return;
      const all = rs.filter(Boolean) as Target[];
      if (!all.length) return;
      const hasWheel = all.some((t) => t.byRole.has("colourwheel"));
      const hasRGB = all.some((t) => t.byRole.has("red") && t.byRole.has("green") && t.byRole.has("blue"));
      const cands = hasWheel && hasRGB ? all.filter((t) => t.byRole.has("colourwheel")) : all;
      const rep = cands.reduce((a, b) => (b.attrs.length > a.attrs.length ? b : a), cands[0]);
      infoRef.current = { rep, all };
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [items, patch]);

  // Seed from live output.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/dmx`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      const U = Math.floor(b.length / channels) || 1;
      const vals: Record<number, number[]> = {};
      for (let u = 0; u < U; u++) vals[u] = Array.from(b.subarray(u * channels, (u + 1) * channels));
      valuesRef.current = vals;
      setTick((n) => n + 1);
      ws.close();
    };
    ws.onerror = () => ws.close();
    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (timer.current) clearTimeout(timer.current);
      flush();
    };
  }, [channels]);

  if (!ready || !infoRef.current) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  return <FixtureEditor fx={infoRef.current.rep.fx} mode={infoRef.current.rep.mode} getVal={getVal} setChannels={fanSet} />;
}


// Keep stored placements for items that still exist; append any unplaced item
// (new fixtures, or everything when there's no map yet) into free cells in
// patch order.
function reconcile(items: GridItem[], stored: Record<string, number>, total: number) {
  const placements: Record<string, number> = {};
  const occupied = new Set<number>();
  for (const it of items) {
    const c = stored[it.key];
    if (typeof c === "number" && c >= 0 && c < total && !occupied.has(c)) {
      placements[it.key] = c;
      occupied.add(c);
    }
  }
  let next = 0;
  for (const it of items) {
    if (placements[it.key] == null) {
      while (next < total && occupied.has(next)) next++;
      if (next >= total) break;
      placements[it.key] = next;
      occupied.add(next);
      next++;
    }
  }
  return placements;
}

export function Fixtures() {
  const { state } = useEngine();
  const channels = state?.channels ?? 512;

  const [items, setItems] = useState<GridItem[]>([]);
  const [fixtures, setFixtures] = useState<PatchFixture[]>([]);
  const [grid, setGrid] = useState({ cols: 25, rows: 25 });
  const [cells, setCells] = useState<Record<string, number>>({});
  const [moving, setMoving] = useState<number | null>(null); // source cell being moved
  const [menu, setMenu] = useState<{ cell: number; x: number; y: number } | null>(null);
  const [sheetItems, setSheetItems] = useState<GridItem[] | null>(null);
  const [sheetShown, setSheetShown] = useState(false); // drives the slide-up animation
  const [selection, setSelection] = useState<string[]>([]); // shift-click multi-select (item keys)
  const [saveOpen, setSaveOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [hover, setHover] = useState<{ item: GridItem; x: number; y: number } | null>(null);
  const programmerActive = !!state?.programmerActive; // authoritative, from the engine
  const scenes = state?.scenes ?? [];
  const programmerFrom = state?.programmerFrom ?? [];
  const topScenes = scenes.filter((s) => programmerFrom.includes(s.id));
  const restScenes = scenes.filter((s) => !programmerFrom.includes(s.id));

  async function saveTo(sceneId: string) {
    await programmerSaveScene({ sceneId }).catch(() => {});
    setSaveOpen(false);
  }
  async function saveNew() {
    await programmerSaveScene({ label: newName.trim() }).catch(() => {});
    setNewName("");
    setShowNew(false);
    setSaveOpen(false);
  }
  const [desc, setDesc] = useState<Record<string, FixDesc>>({}); // per-fixture colour/dim map
  const dmxRef = useRef<Record<number, Uint8Array>>({}); // latest live DMX frame
  const [, setDmxTick] = useState(0); // repaint pulse

  useEffect(() => {
    Promise.all([getPatch(), getFixtureMap()])
      .then(([p, m]) => {
        setFixtures(p.fixtures);
        const its = enumerateItems(p.fixtures);
        const cols = m.cols || 25;
        const rows = m.rows || 25;
        const placements = reconcile(its, m.cells || {}, cols * rows);
        setItems(its);
        setGrid({ cols, rows });
        setCells(placements);
        // Persist if the reconciled layout differs from what's stored (no map
        // yet, or fixtures added/removed since).
        if (JSON.stringify(placements) !== JSON.stringify(m.cells || {})) {
          setFixtureMap({ cols, rows, cells: placements }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const { cols, rows } = grid;
  const total = cols * rows;

  const byCell = useMemo(() => {
    const byKey = new Map(items.map((i) => [i.key, i]));
    const m = new Map<number, GridItem>();
    for (const [key, cell] of Object.entries(cells)) {
      const it = byKey.get(key);
      if (it) m.set(cell, it);
    }
    return m;
  }, [items, cells]);

  // Build colour/intensity descriptors for the patched fixtures' personalities.
  useEffect(() => {
    if (!fixtures.length) return setDesc({});
    let alive = true;
    const uniq = new Map<string, PatchFixture>();
    for (const fx of fixtures) uniq.set(`${fx.libId}:${fx.mode}`, fx);
    Promise.all(
      [...uniq.values()].map((fx) =>
        getFixture(fx.libId)
          .then((f) => ({ key: `${fx.libId}:${fx.mode}`, d: buildDesc(f, fx.mode) }))
          .catch(() => null)
      )
    ).then((rs) => {
      if (!alive) return;
      const byMode: Record<string, FixDesc> = {};
      for (const r of rs) if (r) byMode[r.key] = r.d;
      const out: Record<string, FixDesc> = {};
      for (const fx of fixtures) {
        const d = byMode[`${fx.libId}:${fx.mode}`];
        if (d) out[fx.id] = d;
      }
      setDesc(out);
    });
    return () => {
      alive = false;
    };
  }, [fixtures]);

  // Live DMX feed — stored in a ref, repainted on a decoupled ~8 Hz pulse.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/dmx`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      const U = Math.floor(b.length / channels) || 1;
      const m: Record<number, Uint8Array> = {};
      for (let u = 0; u < U; u++) m[u] = b.subarray(u * channels, (u + 1) * channels);
      dmxRef.current = m;
    };
    ws.onerror = () => ws.close();
    const id = window.setInterval(() => setDmxTick((t) => t + 1), 120);
    return () => {
      ws.close();
      clearInterval(id);
    };
  }, [channels]);

  // Icon colour = live output colour scaled by dim level (grey floor when off).
  function itemColour(it: GridItem): string {
    const row = dmxRef.current[it.universe];
    if (!row) return "#3a3f4a";
    const at = (off: number) => row[it.address + off - 2] ?? 0; // (address+off-1) - 1
    const d = it.key.includes("#") ? null : desc[it.fixtureId];
    let i = 1;
    let r = 255;
    let g = 255;
    let b = 255;
    if (!d) {
      i = (row[it.address - 1] ?? 0) / 255; // a head / plain dimmer
    } else {
      if (d.dim) i = at(d.dim.off) / 255;
      if (d.rgb) {
        r = at(d.rgb.r);
        g = at(d.rgb.g);
        b = at(d.rgb.b);
        if (!d.dim) i = Math.max(r, g, b) / 255;
        const mx = Math.max(r, g, b, 1);
        r = (r / mx) * 255;
        g = (g / mx) * 255;
        b = (b / mx) * 255;
      } else if (d.wheel) {
        const raw = at(d.wheel.off);
        const declared = d.wheel.size >= 2 ? raw * 256 : raw;
        let best: { name: string; min: number; max: number } | null = null;
        let bw = Infinity;
        for (const f of d.wheel.fns) {
          const lo = Math.min(f.min, f.max);
          const hi = Math.max(f.min, f.max);
          if (declared >= lo && declared <= hi && hi - lo < bw) {
            bw = hi - lo;
            best = f;
          }
        }
        const hex = best ? nameToHex(best.name) : null;
        if (hex) [r, g, b] = hexToRgb(hex);
      }
    }
    return mixColour(r, g, b, i);
  }

  // Escape cancels a move / clears selection / closes the menu / hides the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMoving(null);
      setMenu(null);
      setSelection([]);
      if (sheetItems) closeProgrammer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetItems]);

  // Releasing Shift opens the editor for the multi-selection.
  useEffect(() => {
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || !selection.length) return;
      const sel = selection.map((k) => items.find((i) => i.key === k)).filter(Boolean) as GridItem[];
      setSelection([]);
      if (sel.length) setSheetItems(sel);
    };
    window.addEventListener("keyup", onUp);
    return () => window.removeEventListener("keyup", onUp);
  }, [selection, items]);

  function saveCells(next: Record<string, number>) {
    setCells(next);
    setFixtureMap({ cols, rows, cells: next }).catch(() => {});
  }

  // Place the item being moved into `target`; swap if that cell is occupied.
  function place(target: number) {
    const src = moving;
    setMoving(null);
    setMenu(null);
    if (src == null || src === target) return;
    const srcItem = byCell.get(src);
    if (!srcItem) return;
    const dstItem = byCell.get(target);
    const next = { ...cells, [srcItem.key]: target };
    if (dstItem) next[dstItem.key] = src; // swap back into the source cell
    saveCells(next);
  }

  function openItem(it: GridItem) {
    setSheetItems([it]);
  }
  function toggleSelect(key: string) {
    setSelection((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));
  }
  function closeProgrammer() {
    setSheetShown(false); // just hide the editor; programmer values stay live
    window.setTimeout(() => setSheetItems(null), 300); // let it slide out
  }

  // Locate — put the fixture into a known, visible state, live in the programmer.
  async function locate(fixtureId: string) {
    const fx = fixtures.find((f) => f.id === fixtureId);
    if (!fx) return;
    const f = await getFixture(fx.libId).catch(() => null);
    const mode = f?.modes.find((m) => m.name === fx.mode) || f?.modes[0];
    if (!mode) return;
    programmerSet(locateUpdates(fx, mode));
  }
  // Slide the sheet up once it mounts.
  useEffect(() => {
    if (sheetItems) requestAnimationFrame(() => setSheetShown(true));
  }, [sheetItems]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Fixtures</h1>
        <div className="flex items-center gap-3">
          {programmerActive && (
            <>
              <Button variant="default" size="sm" onClick={() => setSaveOpen(true)}>
                Save scene
              </Button>
              <Button variant="outline" size="sm" onClick={() => programmerClear()}>
                Clear programmer
              </Button>
            </>
          )}
          <div className="text-sm text-muted-foreground">
            {items.length} fixture{items.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {Array.from({ length: total }, (_, cell) => {
          const it = byCell.get(cell);
          const selected = it ? selection.includes(it.key) : false;
          return (
            <div
              key={cell}
              onMouseEnter={(e) => {
                if (!it) return setHover(null);
                const r = e.currentTarget.getBoundingClientRect();
                setHover({ item: it, x: r.left, y: r.bottom });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                setHover(null);
                if (moving != null) return place(cell);
                if (!it) return setMenu(null);
                if (e.shiftKey) return toggleSelect(it.key); // build multi-select
                openItem(it);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (moving != null) return place(cell);
                if (it) setMenu({ cell, x: e.clientX, y: e.clientY });
                else setMenu(null);
              }}
              className={cn(
                "relative aspect-square overflow-hidden rounded-lg border text-center transition-colors",
                it ? "border-border bg-card" : "border-border/60 bg-card/40",
                moving != null ? "cursor-pointer hover:border-primary" : it && "cursor-context-menu hover:border-primary",
                (moving === cell || selected) && "ring-2 ring-primary"
              )}
            >
              <span className="absolute left-1 top-0.5 z-10 text-[8px] tabular-nums text-muted-foreground/50">
                {cell + 1}
              </span>
              {it && (
                // Absolutely filled so content never stretches the square.
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-1">
                  <FixtureIcon kind={it.icon} className="h-6 w-6 shrink-0" style={{ color: itemColour(it) }} />
                  <span className="w-full truncate text-[8px] leading-tight text-muted-foreground">
                    {it.label}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hover &&
        (() => {
          const it = hover.item;
          const fx = fixtures.find((f) => f.id === it.fixtureId);
          const isHead = it.key.includes("#");
          const W = window.innerWidth;
          const H = window.innerHeight;
          const left = hover.x + 240 > W ? Math.max(8, hover.x - 232) : hover.x;
          const top = hover.y + 170 > H ? hover.y - 176 : hover.y + 6;
          return (
            <div
              className="pointer-events-none fixed z-50 w-56 rounded-md border border-border bg-popover p-3 text-xs shadow-xl"
              style={{ left, top }}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <FixtureIcon kind={it.icon} className="h-4 w-4 shrink-0 text-foreground" />
                <span className="truncate text-sm font-semibold">{it.label}</span>
              </div>
              {fx && (
                <div className="truncate text-muted-foreground">
                  {[fx.manufacturer, fx.name].filter(Boolean).join(" ")}
                </div>
              )}
              {fx && <div className="truncate text-muted-foreground">Mode: {fx.mode}</div>}
              {isHead && fx && <div className="truncate text-muted-foreground">Head of “{fx.label}”</div>}
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span className="text-muted-foreground">Universe</span>
                <span className="text-right tabular-nums">{it.universe}</span>
                <span className="text-muted-foreground">Start address</span>
                <span className="text-right tabular-nums">{it.address}</span>
                <span className="text-muted-foreground">Channels</span>
                <span className="text-right tabular-nums">{it.channels}</span>
                <span className="text-muted-foreground">Range</span>
                <span className="text-right tabular-nums">
                  {it.address}–{it.address + it.channels - 1}
                </span>
              </div>
            </div>
          );
        })()}

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-32 rounded-md border border-border bg-popover p-1 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
              onClick={() => {
                setMoving(menu.cell);
                setMenu(null);
              }}
            >
              <Move className="h-4 w-4" /> Move
            </button>
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
              onClick={() => {
                const it = byCell.get(menu.cell);
                setMenu(null);
                if (it) locate(it.fixtureId);
              }}
            >
              <Crosshair className="h-4 w-4" /> Locate
            </button>
          </div>
        </>
      )}

      {/* Programmer — sweeps up from the bottom over the grid */}
      {sheetItems && (
        <>
          <div className="fixed inset-y-0 left-56 right-0 z-40 bg-black/40" onClick={closeProgrammer} />
          <div
            className="fixed bottom-0 left-56 right-0 z-50 flex h-[80vh] flex-col rounded-t-2xl border-t border-border bg-background shadow-2xl transition-transform duration-300 ease-out"
            style={{ transform: sheetShown ? "translateY(0)" : "translateY(100%)" }}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <FixtureIcon kind={sheetItems[0].icon} className="h-5 w-5 text-foreground" />
                <span className="font-semibold">
                  {sheetItems.length === 1 ? sheetItems[0].label : `${sheetItems.length} fixtures`}
                </span>
                <span className="text-xs text-muted-foreground">programmer</span>
              </div>
              <Button variant="ghost" size="sm" onClick={closeProgrammer}>
                <X className="h-4 w-4" /> Close
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <SelectionEditor
                key={sheetItems.map((i) => i.key).join(",")}
                items={sheetItems}
                patch={fixtures}
                channels={channels}
              />
            </div>
          </div>
        </>
      )}

      {/* Save the programmer look into a scene */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save to scene</DialogTitle>
            <DialogDescription>Store the current programmer look.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {showNew ? (
              <div className="flex gap-2">
                <Input
                  autoFocus
                  placeholder="New scene name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveNew()}
                />
                <Button onClick={saveNew}>Create</Button>
              </div>
            ) : (
              <Button variant="secondary" className="w-full" onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> Create new scene
              </Button>
            )}

            {topScenes.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Was live when you started
                </div>
                {topScenes.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded border border-primary/40 bg-primary/5 px-3 py-1.5">
                    <span className="truncate text-sm">
                      <span className="mr-2 text-xs text-muted-foreground">#{s.id}</span>
                      {s.label || `Scene ${s.id}`}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => saveTo(s.id)}>
                      Update Scene
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                All scenes
              </div>
              <div className="max-h-64 space-y-1 overflow-auto">
                {restScenes.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded border border-border/50 px-3 py-1.5">
                    <span className="truncate text-sm">
                      <span className="mr-2 text-xs text-muted-foreground">#{s.id}</span>
                      {s.label || `Scene ${s.id}`}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => saveTo(s.id)}>
                      Update Scene
                    </Button>
                  </div>
                ))}
                {restScenes.length === 0 && topScenes.length === 0 && (
                  <div className="text-sm text-muted-foreground">No scenes yet — create one above.</div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
