import { useEffect, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useEngine } from "@/lib/useEngine";

const CELL_PX = 14; // internal canvas resolution per channel (CSS scales to fit)

// Draw one universe's channels into its canvas. Dark → green by intensity.
function drawUniverse(canvas: HTMLCanvasElement, data: Uint8Array, channels: number) {
  const cols = Math.ceil(Math.sqrt(channels));
  const rows = Math.ceil(channels / cols);
  const w = cols * CELL_PX;
  const h = rows * CELL_PX;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "hsl(220 14% 12%)"; // grid background between cells
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < channels; i++) {
    const v = data[i] || 0;
    const x = (i % cols) * CELL_PX;
    const y = Math.floor(i / cols) * CELL_PX;
    const l = 7 + (v / 255) * 43; // 7% (dark) → 50% (bright green)
    ctx.fillStyle = `hsl(140 70% ${l}%)`;
    ctx.fillRect(x + 1, y + 1, CELL_PX - 2, CELL_PX - 2);
  }
}

export function Universes() {
  const { state, status } = useEngine();
  const universes = state?.universes ?? 0;
  const channels = state?.channels ?? 512;
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    if (!universes) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/dmx`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      for (let u = 0; u < universes; u++) {
        const canvas = canvasRefs.current[u];
        if (!canvas) continue;
        drawUniverse(canvas, bytes.subarray(u * channels, (u + 1) * channels), channels);
      }
    };
    return () => ws.close();
  }, [universes, channels]);

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
          Live DMX output — {channels} channels per universe, dark → green by intensity.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: universes }, (_, u) => (
          <Card key={u}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                Universe {u}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <canvas
                ref={(el) => {
                  canvasRefs.current[u] = el;
                }}
                className="block h-auto w-full rounded"
                style={{ imageRendering: "pixelated", aspectRatio: "1 / 1" }}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
