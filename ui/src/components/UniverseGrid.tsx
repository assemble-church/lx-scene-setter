import { useEffect, useMemo, useRef } from "react";
import type { PatchFixture } from "@/lib/api";

const COLS = 100;
const FIX_BORDER = "hsl(210 90% 62%)"; // fixture outline
const GRID_LINE = "rgba(255,255,255,0.05)"; // faint grid

function cellColor(v: number) {
  const l = 7 + (v / 255) * 43;
  return `hsl(140 70% ${l}%)`;
}

interface CellMeta {
  owner: string | null; // patched fixture id
  letter: string;
  title: string;
  bt: string; // border colours per side
  br: string;
  bb: string;
  bl: string;
}

export function UniverseGrid({
  universe,
  channels,
  patch,
}: {
  universe: number;
  channels: number;
  patch: PatchFixture[];
}) {
  // Build per-channel ownership + letters for this universe.
  const meta = useMemo<CellMeta[]>(() => {
    const owner: (string | null)[] = new Array(channels + 1).fill(null);
    const letter: string[] = new Array(channels + 1).fill("");
    const title: string[] = new Array(channels + 1).fill("");
    for (const fx of patch) {
      if (fx.universe !== universe) continue;
      for (let i = 0; i < fx.channels; i++) {
        const ch = fx.address + i;
        if (ch < 1 || ch > channels) continue;
        owner[ch] = fx.id;
        letter[ch] = fx.letters?.[i] || "";
        title[ch] = `Ch ${ch} · ${fx.label} · ${letter[ch] || "—"}`;
      }
    }
    const side = (me: string | null, nbr: string | null) => {
      if (me && me === nbr) return "transparent"; // interior edge
      if (me) return FIX_BORDER; // fixture perimeter
      return GRID_LINE; // unpatched
    };
    const cells: CellMeta[] = [];
    for (let ch = 1; ch <= channels; ch++) {
      const me = owner[ch];
      const up = ch - COLS >= 1 ? owner[ch - COLS] : null;
      const down = ch + COLS <= channels ? owner[ch + COLS] : null;
      const left = ch - 1 >= 1 ? owner[ch - 1] : null;
      const right = ch + 1 <= channels ? owner[ch + 1] : null;
      cells.push({
        owner: me,
        letter: letter[ch],
        title: title[ch] || `Ch ${ch}`,
        bt: side(me, up),
        bb: side(me, down),
        bl: side(me, left),
        br: side(me, right),
      });
    }
    return cells;
  }, [universe, channels, patch]);

  // Live DMX colour, written imperatively so we don't re-render 512 cells.
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/dmx`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      const base = universe * channels;
      for (let i = 0; i < channels; i++) {
        const cell = refs.current[i];
        if (cell) cell.style.backgroundColor = cellColor(bytes[base + i] || 0);
      }
    };
    return () => ws.close();
  }, [universe, channels]);

  return (
    <div
      className="grid w-full"
      style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}
    >
      {meta.map((c, i) => (
        <div
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          title={c.title}
          className="flex aspect-square items-center justify-center overflow-hidden"
          style={{
            fontSize: "0.5rem",
            lineHeight: 1,
            color: "rgba(255,255,255,0.85)",
            borderStyle: "solid",
            borderWidth: 1,
            borderTopColor: c.bt,
            borderRightColor: c.br,
            borderBottomColor: c.bb,
            borderLeftColor: c.bl,
          }}
        >
          {c.letter}
        </div>
      ))}
    </div>
  );
}
