import { useEffect, useMemo, useState } from "react";
import { Radar, Plus, Check, Trash2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  BROADCAST_IP,
  discoverArtnet,
  getArtnetNetwork,
  portAddressLabel,
  setNodePortAddresses,
  type ArtnetDevice,
  type ArtnetNetwork as Network,
  type ArtnetNode,
  type ArtnetOutputRoute,
  type OutputNode,
} from "@/lib/api";

const MODE_TEXT: Record<ArtnetOutputRoute["mode"], { label: string; detail: string; tone: "secondary" | "warning" }> = {
  unicast: { label: "direct", detail: "only that device receives it", tone: "secondary" },
  "subnet-broadcast": { label: "subnet broadcast", detail: "every device on that network receives it", tone: "warning" },
  broadcast: { label: "broadcast", detail: "every device on the network receives it", tone: "warning" },
  routed: { label: "via router", detail: "not on a local network", tone: "secondary" },
  fixed: { label: "one packet", detail: "sent only from the chosen address", tone: "secondary" },
};

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 2 ? "now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

const parseUniverses = (text: string) =>
  text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

// Same subnet as the desk = the address the desk will see us as. A Pi with a leg
// on both the house LAN and the Art-Net VLAN announces itself separately on each,
// and only one of those is the one to type into the console.
const facesDesk = (address: string, deskIp: string) =>
  !!deskIp && address.split(".").slice(0, 3).join(".") === deskIp.split(".").slice(0, 3).join(".");

const isDirect = (ip: string) => !!ip.trim() && ip.trim() !== BROADCAST_IP;

// ---------------------------------------------------------------------------
// Setting which universe each physical socket puts out (ArtAddress).
//
// One ArtAddress programs one of the node's replies, which holds up to 4 ports
// sharing a Net and Subnet — only the last nibble of the universe can differ
// within it. A node that answers once per port therefore has no such
// restriction, so the check is applied per reply, not across the whole box.
function DevicePorts({
  device,
  rawNodes,
  onDone,
}: {
  device: ArtnetDevice;
  rawNodes: ArtnetNode[];
  onDone: (net: Network) => void;
}) {
  const outputPorts = useMemo(() => device.ports.filter((p) => p.isOutput), [device]);
  const key = (bindIndex: number, slot: number) => `${bindIndex}:${slot}`;
  const initial = useMemo(
    () => Object.fromEntries(outputPorts.map((p) => [key(p.bindIndex, p.slot), String(p.output ?? 0)])),
    [outputPorts]
  );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(initial), [initial]);

  const valueOf = (bindIndex: number, slot: number) => Number(draft[key(bindIndex, slot)]);
  const rows = outputPorts.map((p) => ({ ...p, n: valueOf(p.bindIndex, p.slot) }));
  const bad = rows.find((r) => !Number.isInteger(r.n) || r.n < 0 || r.n > 32767);

  // Group by reply, because that's the unit ArtAddress programs.
  const pages = useMemo(() => {
    const m = new Map<number, typeof rows>();
    for (const r of rows) m.set(r.bindIndex, [...(m.get(r.bindIndex) || []), r]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [draft, outputPorts]);

  const split = bad
    ? null
    : pages
        .map(([, ps]) => ps.find((r) => r.n >> 4 !== ps[0].n >> 4))
        .find(Boolean);
  const changedPages = pages.filter(([, ps]) => ps.some((r) => r.n !== (r.output ?? 0)));
  const changed = changedPages.length > 0;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      let latest: Network | null = null;
      for (const [bindIndex, ps] of changedPages) {
        // Keep the node's existing names for this reply — sending a blank name
        // would wipe it on nodes that label each port ("Port 1".."Port 8").
        const raw = rawNodes.find((n) => n.ip === device.ip && n.bindIndex === bindIndex);
        const swOut: (number | null)[] = [null, null, null, null];
        for (const r of ps) swOut[r.slot] = r.n & 0x0f;
        latest = await setNodePortAddresses({
          ip: device.ip,
          bindIndex,
          net: (ps[0].n >> 8) & 0x7f,
          subnet: (ps[0].n >> 4) & 0x0f,
          swOut,
          shortName: raw?.shortName,
          longName: raw?.longName,
        });
      }
      if (latest) onDone(latest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!outputPorts.length) return null;

  return (
    <div className="mt-2 space-y-1.5 border-t border-white/[0.06] pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Each socket puts out</span>
        {outputPorts.map((p) => (
          <label key={key(p.bindIndex, p.slot)} className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Port {p.port}</span>
            <Input
              value={draft[key(p.bindIndex, p.slot)] ?? ""}
              onChange={(e) => setDraft({ ...draft, [key(p.bindIndex, p.slot)]: e.target.value })}
              className="h-7 w-14 tabular-nums"
              title={p.output === null ? undefined : `Currently ${portAddressLabel(p.output)}`}
            />
          </label>
        ))}
        <Button
          size="sm"
          variant={changed ? "default" : "outline"}
          disabled={busy || !!bad || !!split || !changed}
          onClick={apply}
        >
          <Send className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save to node"}
        </Button>
      </div>
      {bad && <p className="text-xs text-destructive">Universe must be a whole number from 0 to 32767.</p>}
      {split && (
        <p className="text-xs text-destructive">
          This node programs ports {pages.find(([, ps]) => ps.includes(split))?.[1].map((r) => r.port).join(" and ")}{" "}
          together, so they must sit in the same block of 16 universes (0–15, 16–31, and so on). Port {split.port} is
          outside the block the others are in.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!bad && !split && changed && (
        <p className="text-[11px] text-amber-400">Not saved to the node yet.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One saved output: what we send, and which socket each universe lands on.
function OutputRow({
  o,
  route,
  device,
  onEdit,
  onRemove,
  port,
}: {
  o: OutputNode;
  route?: ArtnetOutputRoute;
  device?: ArtnetDevice;
  onEdit: (patch: Partial<OutputNode>) => void;
  onRemove: () => void;
  port: number;
}) {
  const m = route ? MODE_TEXT[route.mode] : null;
  // Match each universe we send to the socket that is listening for it.
  const landings = o.universes.map((u) => ({
    u,
    ports: (device?.ports || []).filter((p) => p.isOutput && p.output === u).map((p) => p.port),
  }));
  const unheard = landings.filter((l) => device && !l.ports.length);
  const idle = (device?.ports || []).filter(
    (p) => p.isOutput && p.output !== null && !o.universes.includes(p.output)
  );

  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Name" value={o.name} onChange={(e) => onEdit({ name: e.target.value })} className="h-8 w-36" />
        <Input
          placeholder="blank = broadcast"
          value={o.ip}
          onChange={(e) => onEdit({ ip: e.target.value })}
          className="h-8 w-36 font-mono tabular-nums"
        />
        <Input
          placeholder="Universes e.g. 0, 1"
          value={o.universes.join(", ")}
          onChange={(e) => onEdit({ universes: parseUniverses(e.target.value) })}
          className="h-8 w-44"
        />
        <Input
          placeholder="send from: auto"
          title="Optional: send only from this address of this machine, one packet per update. Blank = automatic."
          value={o.source ?? ""}
          onChange={(e) => onEdit({ source: e.target.value })}
          className="h-8 w-36 font-mono"
        />
        <Input
          type="number"
          title="UDP port on the node. 6454 unless the node is unusual."
          value={o.port ?? port}
          onChange={(e) => onEdit({ port: Number(e.target.value) })}
          className="h-8 w-20 tabular-nums"
        />
        <Button
          size="sm"
          variant={o.ip === BROADCAST_IP ? "secondary" : "outline"}
          title="Send to every Art-Net node on the network (no IP needed)"
          onClick={() => onEdit({ ip: BROADCAST_IP })}
        >
          Broadcast
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onRemove} title="Remove this output">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      {/* Where each universe physically comes out. */}
      {device ? (
        <div className="mt-1.5 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              {device.name} · {device.ports.filter((p) => p.isOutput).length} sockets
            </span>
            {landings.map((l) => (
              <span key={l.u} className="tabular-nums">
                <span className="text-muted-foreground">U{l.u}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                {l.ports.length ? (
                  <span>port {l.ports.join(" + ")}</span>
                ) : (
                  <span className="text-destructive">nowhere</span>
                )}
              </span>
            ))}
            {!o.universes.length && <span className="text-destructive">No universes set — this output sends nothing</span>}
          </div>
          {unheard.length > 0 && (
            <p className="text-xs text-destructive">
              No socket on {device.name} is set to U{unheard.map((l) => l.u).join(", U")}. Set a port to it below, or
              drop it from this output.
            </p>
          )}
          {idle.length > 0 && (
            <p className="text-xs text-amber-400">
              {idle.map((p) => `Port ${p.port}`).join(", ")} {idle.length === 1 ? "is" : "are"} set to U
              {idle.map((p) => p.output).join(", U")}, which this output doesn't send, so{" "}
              {idle.length === 1 ? "it stays" : "they stay"} dark.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-1 pl-1 text-[11px] text-muted-foreground">
          {o.universes.length ? o.universes.map((u) => `U${u} = ${portAddressLabel(u)}`).join("  ·  ") : "No universes set"}
          {isDirect(o.ip) && " — no node answering on that address, so where each universe lands is unknown"}
        </div>
      )}

      <div className="mt-1 pl-1 text-[11px] text-muted-foreground">
        {m ? (
          <>
            As saved: {m.label}, {m.detail} · via {route!.via.join(", ") || "—"} · {route!.packetsPerUpdate} packet
            {route!.packetsPerUpdate === 1 ? "" : "s"} per update
          </>
        ) : (
          "Not saved yet"
        )}
      </div>
      {route?.warning && <div className="mt-1 text-xs text-destructive">{route.warning}</div>}
    </div>
  );
}

// Art-Net discovery, node programming, and the saved output list, all editable in
// place. `outputs` is the config form's current (possibly unsaved) list.
export function ArtnetNetwork({
  outputs,
  onChangeOutputs,
  port,
}: {
  outputs: OutputNode[];
  onChangeOutputs: (next: OutputNode[]) => void;
  port: number;
}) {
  const [net, setNet] = useState<Network | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Senders and nodes update continuously (the desk may start/stop), so refresh
  // while the panel is open.
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

  const edit = (i: number, patch: Partial<OutputNode>) =>
    onChangeOutputs(outputs.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const remove = (i: number) => onChangeOutputs(outputs.filter((_, idx) => idx !== i));
  const deviceFor = (ip: string) => net?.devices?.find((d) => d.ip === ip.trim());

  const self = net?.self;
  const deskSender = net?.senders.find((s) => s.isConsole);
  const devices = net?.devices || [];

  return (
    <div className="space-y-4 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Art-Net network</div>
        <Button size="sm" variant="outline" onClick={discover} disabled={busy}>
          <Radar className="h-4 w-4" /> {busy ? "Polling…" : "Discover nodes"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ---- What the desk sees when it looks for us ---- */}
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          This machine, as the desk sees it
        </div>
        {self ? (
          <div className="space-y-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">{self.shortName}</span>
              {self.announcingAs
                .filter((a) => facesDesk(a.address, self.deskIp))
                .map((a) => (
                  <span key={a.address} className="flex items-baseline gap-1.5">
                    <span className="font-mono text-base tabular-nums">{a.address}</span>
                    <Badge variant="secondary">the address to pick on the desk</Badge>
                  </span>
                ))}
            </div>
            <div className="text-xs text-muted-foreground">
              Accepts U{self.universes.join(", U") || " —"} · announces itself every 15s on{" "}
              {self.announcingAs.map((a) => `${a.address} (${a.name})`).join(", ") || "no network"}
            </div>
            <div className="text-xs text-muted-foreground">
              Desk expected at <span className="font-mono tabular-nums">{self.deskIp || "(not set)"}</span>
              {deskSender ? (
                <span className="text-emerald-400">
                  {" "}
                  · sending now: U{deskSender.universes.join(", U")} ({deskSender.packets.toLocaleString()} packets)
                </span>
              ) : (
                " · nothing received from it yet — only Art-Net from this exact address is recorded"
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>

      {/* ---- Saved outputs, editable in place ---- */}
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Outputs — what we send, and where it comes out
        </div>
        <div className="space-y-1.5">
          {outputs.map((o, i) => (
            <OutputRow
              key={i}
              o={o}
              port={port}
              route={net?.outputs.find((r) => (r.ip || "").trim() === o.ip.trim())}
              device={deviceFor(o.ip)}
              onEdit={(patch) => edit(i, patch)}
              onRemove={() => remove(i)}
            />
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChangeOutputs([...outputs, { name: "", ip: "", port, universes: [] }])}
          >
            <Plus className="h-4 w-4" /> Add output
          </Button>
        </div>
      </div>

      {/* ---- Discovered nodes, one row per physical box ---- */}
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Nodes on the network</div>
        {devices.length ? (
          <div className="space-y-1.5">
            {devices.map((d) => {
              const existingIndex = outputs.findIndex((o) => (o.ip || "").trim() === d.ip);
              const existing = existingIndex >= 0 ? outputs[existingIndex] : null;
              const outPorts = d.ports.filter((p) => p.isOutput);
              const sameUniverses =
                existing && existing.universes.join(",") === d.outputs.join(",");
              return (
                <div key={d.ip} className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono tabular-nums">{d.ip}</span>
                    <span className="font-medium">{d.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {outPorts.length} DMX socket{outPorts.length === 1 ? "" : "s"}
                      {d.pages > 1 && ` · answers in ${d.pages} parts`}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">{ago(d.lastSeen)}</span>
                      {existing ? (
                        <>
                          <Badge variant="secondary" title={`Configured as "${existing.name || d.ip}"`}>
                            <Check className="mr-1 h-3 w-3" /> an output
                          </Badge>
                          {!sameUniverses && (
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Send exactly the universes this node's sockets are listening for"
                              onClick={() => edit(existingIndex, { universes: d.outputs })}
                            >
                              Send all {d.outputs.length}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => remove(existingIndex)} title="Remove from outputs">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!d.outputs.length}
                          onClick={() =>
                            onChangeOutputs([...outputs, { name: d.name, ip: d.ip, port, universes: d.outputs }])
                          }
                        >
                          <Plus className="h-4 w-4" /> Add as output
                        </Button>
                      )}
                    </span>
                  </div>
                  <DevicePorts device={d} rawNodes={net?.nodes || []} onDone={setNet} />
                </div>
              );
            })}
            <p className="text-[11px] text-muted-foreground">
              Changing a socket here writes the setting into the node itself, so it survives a power cycle and you don't
              need the node's own web page. Then make sure an output above sends those universes.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {net?.polled
              ? `No nodes answered (polled ${net.polled.join(", ")}). Some nodes don't reply to ArtPoll, or sit on another IP range — a broadcast output still reaches them if they're on the same wired network.`
              : "Press Discover to broadcast an ArtPoll and list the Art-Net nodes that answer."}
          </p>
        )}
      </div>

      {/* ---- Anything sending to us ---- */}
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sending Art-Net to this machine
        </div>
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
