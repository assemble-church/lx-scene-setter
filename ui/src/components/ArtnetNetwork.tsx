import { useEffect, useState } from "react";
import { Radar, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  discoverArtnet,
  getArtnetNetwork,
  portAddressLabel,
  type ArtnetNetwork as Network,
  type ArtnetOutputRoute,
  type OutputNode,
} from "@/lib/api";

const MODE_TEXT: Record<ArtnetOutputRoute["mode"], { label: string; detail: string; tone: "secondary" | "warning" }> = {
  unicast: { label: "direct", detail: "only that device receives it", tone: "secondary" },
  "subnet-broadcast": { label: "subnet broadcast", detail: "every device on that network receives it", tone: "warning" },
  broadcast: { label: "broadcast", detail: "every device on the network receives it", tone: "warning" },
  routed: { label: "via router", detail: "not on a local network", tone: "secondary" },
};

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 2 ? "now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

// Art-Net discovery + live senders. `onAdd` appends a node to the (unsaved) outputs.
export function ArtnetNetwork({ onAdd, port }: { onAdd: (node: OutputNode) => void; port: number }) {
  const [net, setNet] = useState<Network | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Senders update continuously (the desk may start/stop), so refresh while open.
  useEffect(() => {
    const load = () => getArtnetNetwork().then(setNet).catch(() => {});
    load();
    const id = window.setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  async function discover() {
    setBusy(true);
    setError(null);
    try {
      setNet(await discoverArtnet());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Network</div>
          <div className="text-xs text-muted-foreground">
            {net?.interfaces.length
              ? `This machine: ${net.interfaces.map((i) => `${i.address} (${i.name})`).join(", ")}`
              : "No network interface"}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={discover} disabled={busy}>
          <Radar className="h-4 w-4" /> {busy ? "Polling…" : "Discover nodes"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          How outputs are sent (saved config)
        </div>
        {net?.outputs.length ? (
          <div className="space-y-1">
            {net.outputs.map((o, i) => {
              const m = MODE_TEXT[o.mode];
              return (
                <div key={i} className="rounded border border-border/50 px-2 py-1.5 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{o.name || "(unnamed)"}</span>
                    <span className="font-mono text-xs tabular-nums">{o.ip || "(blank)"}</span>
                    <Badge variant={m.tone}>{m.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {m.detail} · via {o.via.join(", ") || "—"} · {o.packetsPerUpdate} packet
                      {o.packetsPerUpdate === 1 ? "" : "s"} per update
                    </span>
                  </div>
                  {o.warning && <div className="mt-1 text-xs text-destructive">{o.warning}</div>}
                </div>
              );
            })}
            {net.outputs.some((o) => o.mode === "broadcast" || o.mode === "subnet-broadcast") && (
              <p className="text-xs text-muted-foreground">
                Broadcasts reach every device on the network (up to 25 updates/s per universe during fades). Once
                you know a node's own IP, enter it instead so only that node receives the traffic.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No outputs saved.</p>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Nodes (ArtPoll replies)</div>
        {net?.nodes.length ? (
          <div className="space-y-1">
            {net.nodes.map((n) => (
              <div key={`${n.ip}#${n.bindIndex}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/50 px-2 py-1.5 text-sm">
                <span className="font-mono tabular-nums">{n.ip}</span>
                <span className="font-medium">{n.shortName || n.longName || "(unnamed)"}</span>
                {n.longName && n.longName !== n.shortName && <span className="text-xs text-muted-foreground">{n.longName}</span>}
                <span className="text-xs text-muted-foreground" title={n.outputs.map(portAddressLabel).join("\n")}>
                  receives U{n.outputs.join(", U") || " —"}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{ago(n.lastSeen)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!n.outputs.length}
                    onClick={() => onAdd({ name: n.shortName || n.longName || n.ip, ip: n.ip, port, universes: n.outputs })}
                  >
                    <Plus className="h-4 w-4" /> Add as output
                  </Button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {net?.polled
              ? `No nodes answered (polled ${net.polled.join(", ")}). Some nodes don't reply to ArtPoll, or sit on another IP range — a broadcast output still reaches them if they're on the same wired network.`
              : "Press Discover to broadcast an ArtPoll and list the Art-Net nodes that answer."}
          </p>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sending Art-Net to this machine</div>
        {net?.senders.length ? (
          <div className="space-y-1">
            {net.senders.map((s) => (
              <div key={s.ip} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-mono tabular-nums">{s.ip}</span>
                {s.isConsole && <Badge variant="secondary">console</Badge>}
                <span className="text-xs text-muted-foreground" title={s.universes.map(portAddressLabel).join("\n")}>
                  U{s.universes.join(", U")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {s.packets.toLocaleString()} packets · {ago(s.lastSeen)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing has sent ArtDMX here since the engine started.</p>
        )}
      </div>
    </div>
  );
}
