// Art-Net I/O.
//
// Output: builds and sends ArtDMX packets to configured nodes. A node's IP should
//         be its own address (unicast — nothing else on the network sees the
//         traffic). For a node whose IP you don't know, use a broadcast address —
//         ideally the node's subnet (e.g. 169.254.255.255), else 255.255.255.255 —
//         which every device on that network receives. See route().
// Input:  listens for ArtDMX from the console (to record), answers ArtPoll
//         discovery with ArtPollReply so controllers/tools can find us, and can
//         itself send ArtPoll to discover the nodes on the network.
//
// Universe numbers throughout are the 15-bit Art-Net Port-Address:
//   Net (7 bits) · SubNet (4 bits) · Universe (4 bits) → net*256 + subnet*16 + universe
// so a node set to Net 0 / SubNet 0 / Universe 1 is universe 1 here.
//
// ArtDMX layout (OpDmx 0x5000):
//   0..7 "Art-Net\0" · 8..9 OpCode (LE) · 10..11 ProtVer (BE,=14) · 12 Seq ·
//   13 Physical · 14..15 Universe (LE) · 16..17 Length (BE) · 18.. DMX data

const dgram = require("dgram");
const os = require("os");

const HEADER_LEN = 18;
const OP_DMX = 0x5000;
const OP_POLL = 0x2000;
const OP_POLLREPLY = 0x2100;
const OP_ADDRESS = 0x6000;
const ADDRESS_LEN = 107;
// How often we re-announce ourselves to the network (unsolicited ArtPollReply).
const ANNOUNCE_INTERVAL_MS = 15000;
// Never broadcast an unsolicited reply more often than this, so a controller
// polling in a tight loop can't turn into a broadcast storm.
const ANNOUNCE_MIN_GAP_MS = 2000;
const ARTNET_ID = "Art-Net\0";
// How we announce ourselves to consoles. Kept here so the UI can show the desk
// exactly the name and universes it will see.
const NODE_SHORT_NAME = "Light It";
const NODE_LONG_NAME = "Light It - Assembly Rooms house lighting";
const POLLREPLY_LEN = 239;

// IPv4 interfaces with their directed-broadcast address.
function localInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac,
        broadcast: ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join("."),
      });
    }
  }
  return out;
}

function createArtnetOutput(config, logger) {
  const socket = dgram.createSocket("udp4");
  socket.on("error", (err) => logger.error("Art-Net out socket error:", err.message));
  // Broadcast outputs need SO_BROADCAST, which can only be set on a bound socket.
  socket.bind(0, () => socket.setBroadcast(true));

  // Track which targets are currently failing so a downed/unreachable node logs
  // once, not every packet.
  const failing = new Set();

  // One socket per network interface, bound to that interface's address AND the
  // Art-Net port. Both matter:
  //  - The OS routes 255.255.255.255 (and overlapping ranges like 169.254/16) via
  //    the default interface only — on a Mac that's Wi-Fi, so a node cabled into an
  //    Ethernet adapter never saw a broadcast. A socket bound to an interface's
  //    address sends out of that interface.
  //  - Art-Net traffic is meant to come FROM port 6454, and some nodes (e.g. Botex
  //    DPX NET dimmers) silently ignore packets from any other source port.
  // Binding address:6454 takes unicast packets addressed to that interface away
  // from the wildcard input socket, so everything received here is handed to the
  // input's handler (see onMessage). Re-scanned every 10s as adapters come and go.
  const ifaceSockets = new Map(); // local address → { socket, broadcast, ready }
  const receivers = [];
  let ifacesCheckedAt = 0;
  function interfaceSockets() {
    if (Date.now() - ifacesCheckedAt > 10000) {
      ifacesCheckedAt = Date.now();
      const current = new Map(localInterfaces().map((i) => [i.address, i]));
      for (const [addr, entry] of ifaceSockets) {
        if (!current.has(addr)) {
          try {
            entry.socket.close();
          } catch (_) {
            /* already closed */
          }
          ifaceSockets.delete(addr);
          logger.info(`Art-Net: interface ${addr} gone`);
        }
      }
      for (const [addr, iface] of current) {
        if (ifaceSockets.has(addr)) continue;
        const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const entry = { socket: s, name: iface.name, address: addr, netmask: iface.netmask, mac: iface.mac, broadcast: iface.broadcast, ready: false };
        s.on("error", (err) => logger.error(`Art-Net socket ${addr}:${config.artnetPort} error:`, err.message));
        s.on("message", (msg, rinfo) => receivers.forEach((fn) => fn(msg, rinfo)));
        s.bind(config.artnetPort, addr, () => {
          s.setBroadcast(true);
          entry.ready = true;
        });
        ifaceSockets.set(addr, entry);
        logger.info(`Art-Net: sending via ${addr}:${config.artnetPort} (broadcast ${iface.broadcast})`);
      }
    }
    return [...ifaceSockets.values()].filter((e) => e.ready);
  }
  interfaceSockets(); // bind now so unicast replies to our addresses are handled from the start

  const sameSubnet = (ip, entry) => {
    const a = ip.split(".").map(Number);
    const b = entry.address.split(".").map(Number);
    const m = entry.netmask.split(".").map(Number);
    return a.length === 4 && a.every((x, i) => (x & m[i]) === (b[i] & m[i]));
  };

  // How a packet for `ip` leaves this machine — ONE copy per destination, so a
  // universe update is one packet on the wire (not one per address/interface).
  //   unicast           — ip is in one of our subnets: sent from that interface,
  //                       only that device receives it. Preferred.
  //   subnet-broadcast  — ip is one of our subnets' broadcast address (e.g.
  //                       169.254.255.255): sent once, from that interface, to
  //                       every device on that network. Some nodes (Botex DPX NET)
  //                       only accept this form.
  //   broadcast         — 255.255.255.255 / blank: from EVERY local address, to both
  //                       255.255.255.255 and that address's subnet broadcast. The
  //                       widest net: it's what the venue Botex DPX NET is proven to
  //                       respond to (a single 169.254.50.50 → 169.254.255.255 copy
  //                       was not enough on 2026-09-15).
  //   routed            — anywhere else: handed to the OS routing table.
  //   fixed             — the output names a `source` address: exactly one copy,
  //                       from that address to ip. For nodes that only accept one
  //                       specific form (the Botex: 169.254.x.x → 255.255.255.255,
  //                       sent on the Art-Net VLAN only).
  // Returns { mode, sends: [{ socket, dest, via }], warning? }.
  function route(ip, source) {
    const entries = interfaceSockets();
    if (source) {
      const e = entries.find((x) => x.address === source);
      if (!e) {
        return {
          mode: "fixed",
          sends: [],
          warning: `not sending: this machine has no address ${source} (check the network port / VLAN it lives on)`,
        };
      }
      return { mode: "fixed", sends: [{ socket: e.socket, dest: ip || "255.255.255.255", via: `${e.name} ${e.address}` }] };
    }
    if (!ip || ip === "255.255.255.255") {
      const sends = [];
      for (const e of entries) {
        sends.push({ socket: e.socket, dest: "255.255.255.255", via: `${e.name} ${e.address}` });
        if (e.broadcast && e.broadcast !== "255.255.255.255") sends.push({ socket: e.socket, dest: e.broadcast, via: `${e.name} ${e.address}` });
      }
      return { mode: "broadcast", sends, warning: sends.length ? undefined : "no network interface is up" };
    }
    const bcast = entries.find((e) => e.broadcast === ip);
    if (bcast) return { mode: "subnet-broadcast", sends: [{ socket: bcast.socket, dest: ip, via: `${bcast.name} ${bcast.address}` }] };
    const local = entries.find((e) => sameSubnet(ip, e));
    if (local) return { mode: "unicast", sends: [{ socket: local.socket, dest: ip, via: `${local.name} ${local.address}` }] };
    // 169.254.x.x is never routed: without an address in that range there's no way
    // to reach it, so don't spray packets at the router — report it instead.
    if (ip.startsWith("169.254.")) {
      return {
        mode: "routed",
        sends: [],
        warning:
          "not sending: no network port has a 169.254.x.x address, so a self-addressed device can't be reached — add one (e.g. 169.254.50.50/16) to the port it's cabled to",
      };
    }
    return {
      mode: "routed",
      sends: [{ socket, dest: ip, via: "OS routing (default gateway)" }],
      warning: ip.endsWith(".255")
          ? "looks like a broadcast address, but no network port is in that range — it will go to the router and be dropped"
          : undefined,
    };
  }

  // Send any Art-Net packet as a broadcast, once per physical port.
  function broadcast(packet, port) {
    for (const s of route("255.255.255.255").sends) send(s.socket, packet, port, s.dest, `broadcast via ${s.via}`);
  }

  function sendUniverse(ip, port, universe, values, source) {
    const packet = buildDmx(universe, values);
    for (const s of route(ip, source).sends) send(s.socket, packet, port, s.dest, s.dest === ip ? ip : `${s.dest} via ${s.via}`);
  }

  // For the UI: how each configured output is actually being sent right now.
  function describeOutputs(outputs) {
    return (outputs || []).map((o) => {
      const r = route((o.ip || "").trim() || "255.255.255.255", (o.source || "").trim() || undefined);
      return {
        name: o.name,
        ip: o.ip,
        source: o.source || undefined,
        universes: o.universes,
        mode: r.mode,
        via: r.sends.map((s) => s.via),
        packetsPerUpdate: r.sends.length * (o.universes || []).length,
        warning: r.warning,
      };
    });
  }

  // Register a handler for packets arriving on the per-interface sockets.
  function onMessage(fn) {
    receivers.push(fn);
  }

  function buildDmx(universe, values) {
    const packet = Buffer.alloc(HEADER_LEN + config.channels);

    packet.write(ARTNET_ID, 0, "ascii");
    packet.writeUInt16LE(OP_DMX, 8);
    packet.writeUInt16BE(14, 10);
    packet[12] = 0; // sequence disabled
    packet[13] = 0; // physical
    packet.writeUInt16LE(universe, 14);
    packet.writeUInt16BE(config.channels, 16);

    Buffer.from(values).copy(packet, HEADER_LEN);
    return packet;
  }

  // `label` identifies the target for logging (one line when it fails, one when it recovers).
  function send(sock, packet, port, ip, label) {
    sock.send(packet, port, ip, (err) => {
      if (err) {
        if (!failing.has(label)) {
          failing.add(label);
          logger.error(
            `Art-Net send to ${label}:${port} failing: ${err.message} (further errors suppressed until it recovers)`
          );
        }
      } else if (failing.has(label)) {
        failing.delete(label);
        logger.info(`Art-Net send to ${label} recovered`);
      }
    });
  }

  // Every interface we can send from. An ArtPollReply has to carry the address of
  // the interface it leaves by, so the caller builds one packet per interface
  // rather than handing us a single packet to spray everywhere.
  function interfaces() {
    return interfaceSockets().map((e) => ({
      name: e.name,
      address: e.address,
      netmask: e.netmask,
      mac: e.mac,
      broadcast: e.broadcast,
      send: (packet, port, dest) => send(e.socket, packet, port, dest, `${dest} via ${e.name} ${e.address}`),
    }));
  }

  function close() {
    for (const s of [socket, ...[...ifaceSockets.values()].map((e) => e.socket)]) {
      try {
        s.close();
      } catch (_) {
        /* already closed */
      }
    }
  }

  return { sendUniverse, broadcast, describeOutputs, onMessage, interfaces, close };
}

// Pick the local IPv4 interface facing the desk (same /24), else the first
// non-internal one.
function pickIface(targetIp) {
  const ifaces = os.networkInterfaces();
  const prefix = targetIp ? targetIp.split(".").slice(0, 3).join(".") + "." : null;
  let fallback = null;
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (!fallback) fallback = addr;
      if (prefix && addr.address.startsWith(prefix)) return addr;
    }
  }
  return fallback;
}

function macBytes(mac) {
  const out = [0, 0, 0, 0, 0, 0];
  if (mac) {
    const parts = mac.split(":");
    for (let i = 0; i < 6 && i < parts.length; i++) out[i] = parseInt(parts[i], 16) || 0;
  }
  return out;
}

// Build one ArtPollReply describing up to 4 output ports (page = block of 4).
function buildPollReply(config, localIp, mac, universes, page) {
  const buf = Buffer.alloc(POLLREPLY_LEN);
  const ip = (localIp || "0.0.0.0").split(".").map((n) => parseInt(n, 10) & 0xff);
  const pageUnis = universes.slice(page * 4, page * 4 + 4);
  const first = pageUnis[0] || 0;

  buf.write(ARTNET_ID, 0, "ascii");
  buf.writeUInt16LE(OP_POLLREPLY, 8);
  buf[10] = ip[0] || 0;
  buf[11] = ip[1] || 0;
  buf[12] = ip[2] || 0;
  buf[13] = ip[3] || 0;
  buf.writeUInt16LE(config.artnetPort, 14); // Port (LE)
  buf[16] = 0; // VersInfoH
  buf[17] = 14; // VersInfoL
  buf[18] = (first >> 8) & 0x7f; // NetSwitch
  buf[19] = (first >> 4) & 0x0f; // SubSwitch
  buf.writeUInt16BE(0x00ff, 20); // Oem (Hi,Lo)
  buf[22] = 0; // Ubea
  buf[23] = 0xd0; // Status1: indicators normal
  buf.writeUInt16LE(0x0000, 24); // EstaMan (Lo,Hi)
  buf.write(NODE_SHORT_NAME, 26, 17, "ascii"); // ShortName
  buf.write(NODE_LONG_NAME, 44, 63, "ascii"); // LongName
  buf.write(`#0001 [${page}] Light It OK`, 108, 63, "ascii"); // NodeReport
  buf.writeUInt16BE(pageUnis.length, 172); // NumPorts (Hi,Lo)
  for (let i = 0; i < pageUnis.length; i++) {
    buf[174 + i] = 0x80; // PortType: output, DMX512
    buf[182 + i] = 0x80; // GoodOutput: transmitting
    buf[190 + i] = pageUnis[i] & 0x0f; // SwOut (low nibble)
  }
  buf[200] = 0x00; // Style = StNode
  const m = macBytes(mac);
  for (let i = 0; i < 6; i++) buf[201 + i] = m[i];
  buf[207] = ip[0] || 0; // BindIp
  buf[208] = ip[1] || 0;
  buf[209] = ip[2] || 0;
  buf[210] = ip[3] || 0;
  buf[211] = page + 1; // BindIndex (1-based)
  buf[212] = 0x08; // Status2: supports 15-bit Port-Address (Art-Net 3/4)
  return buf;
}

// Build an ArtAddress packet: programs a node's Port-Addresses, and optionally its
// names. Art-Net encodes a 15-bit Port-Address as Net (bits 14-8), Subnet (7-4)
// and the per-port Universe nibble (3-0), so the four ports of one bind page must
// share a Net and Subnet — only their low nibble differs.
//
// Every numeric field is "ignored unless bit 7 is set"; sending 0x00 resets it to
// zero. We always send an explicit value so the result is exactly what was asked
// for, and leave the name fields zeroed when the caller doesn't supply one.
function buildAddress({ bindIndex = 1, net = 0, subnet = 0, swOut = [], swIn = [], shortName, longName, command = 0 }) {
  const buf = Buffer.alloc(ADDRESS_LEN);
  const prog = (v) => (v === undefined || v === null ? 0x00 : 0x80 | (Number(v) & 0x0f));
  buf.write(ARTNET_ID, 0, "ascii");
  buf.writeUInt16LE(OP_ADDRESS, 8);
  buf[10] = 0; // ProtVerHi
  buf[11] = 14; // ProtVerLo
  buf[12] = 0x80 | (Number(net) & 0x7f); // NetSwitch
  buf[13] = bindIndex || 1; // BindIndex: which block of 4 ports we're programming
  if (shortName) buf.write(String(shortName).slice(0, 17), 14, 17, "ascii");
  if (longName) buf.write(String(longName).slice(0, 63), 32, 63, "ascii");
  for (let i = 0; i < 4; i++) buf[96 + i] = prog(swIn[i]);
  for (let i = 0; i < 4; i++) buf[100 + i] = prog(swOut[i]);
  buf[104] = 0x80 | (Number(subnet) & 0x0f); // SubSwitch
  buf[105] = 0; // SwVideo (deprecated)
  buf[106] = command & 0xff; // 0 = AcNone
  return buf;
}

// Parse an ArtPollReply into a plain node description.
function parsePollReply(packet, rinfo) {
  if (packet.length < 212) return null;
  const str = (start, len) => packet.toString("ascii", start, start + len).replace(/\0.*$/s, "").trim();
  const net = packet[18] & 0x7f;
  const sub = packet[19] & 0x0f;
  const numPorts = Math.min(4, packet.readUInt16BE(172));
  const bindIndex = packet[211] || 1;
  const outputs = [];
  const inputs = [];
  // Per-port detail for THIS reply only. A reply carries at most 4 ports, so a
  // bigger node answers several times (one per "bind page"). How many ports each
  // reply carries is up to the node: a NET8 sends 8 replies of 1 port each, while
  // others send 2 replies of 4. So the physical port number can't be worked out
  // here — it's the running count across a device's replies, done in getNodes().
  const ports = [];
  for (let i = 0; i < numPorts; i++) {
    const type = packet[174 + i];
    const isOutput = !!(type & 0x80);
    const isInput = !!(type & 0x40);
    const outAddr = (net << 8) | (sub << 4) | (packet[190 + i] & 0x0f);
    const inAddr = (net << 8) | (sub << 4) | (packet[186 + i] & 0x0f);
    if (isOutput) outputs.push(outAddr); // can output DMX
    if (isInput) inputs.push(inAddr); // can input DMX
    ports.push({
      slot: i, // position within this reply (0-3) — what ArtAddress indexes
      isOutput,
      isInput,
      output: isOutput ? outAddr : null,
      input: isInput ? inAddr : null,
    });
  }
  return {
    ip: [packet[10], packet[11], packet[12], packet[13]].join("."),
    from: rinfo.address,
    shortName: str(26, 18),
    longName: str(44, 64),
    report: str(108, 64),
    mac: [...packet.subarray(201, 207)].map((b) => b.toString(16).padStart(2, "0")).join(":"),
    bindIndex,
    net,
    subnet: sub,
    numPorts,
    ports,
    outputs,
    inputs,
  };
}

// onDmx(universe, packet, length) is called for valid ArtDMX from the console.
// `output` (optional) sends discovery polls out of every interface.
function createArtnetInput(config, logger, onDmx, output) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", (err) => logger.error("Art-Net in socket error:", err.message));

  // Discovery: nodes that answered an ArtPoll, keyed "ip#bindIndex" (a node with
  // more than 4 ports replies once per block of 4).
  const nodes = new Map();
  // Everyone sending ArtDMX to us (the desk, other controllers), keyed by IP.
  const senders = new Map();
  // Our own addresses (refreshed at most every 10s — this runs per DMX packet).
  let localIps = { set: new Set(), at: 0 };
  const isLocal = (ip) => {
    if (Date.now() - localIps.at > 10000) {
      localIps = { set: new Set(localInterfaces().map((i) => i.address)), at: Date.now() };
    }
    return ip.startsWith("127.") || localIps.set.has(ip);
  };

  // Broadcast ArtPoll out of every interface (plus subnet broadcasts and the
  // conventional Art-Net ranges). Nodes reply to port 6454, i.e. this socket.
  function poll() {
    const packet = Buffer.alloc(14);
    packet.write(ARTNET_ID, 0, "ascii");
    packet.writeUInt16LE(OP_POLL, 8);
    packet.writeUInt16BE(14, 10);
    packet[12] = 0x02; // Flags: send ArtPollReply whenever node conditions change
    packet[13] = 0; // DiagPriority
    if (output) output.broadcast(packet, config.artnetPort);
    const targets = new Set(["2.255.255.255", "10.255.255.255"]);
    for (const i of localInterfaces()) targets.add(i.broadcast);
    if (!output) targets.add("255.255.255.255");
    for (const t of targets) {
      socket.send(packet, config.artnetPort, t, (err) => {
        if (err) logger.warn(`ArtPoll to ${t} failed: ${err.message}`);
      });
    }
    return [...(output ? ["255.255.255.255 (every interface)"] : []), ...targets];
  }

  // Cheap view of current ArtDMX senders (heard in the last 10s), for the live
  // dashboard snapshot — no interface scan.
  function getSenders() {
    const cutoff = Date.now() - 10000;
    return [...senders.values()]
      .filter((s) => s.lastSeen >= cutoff)
      .map((s) => ({ ip: s.ip, isConsole: s.isConsole, universes: [...s.universes].sort((a, b) => a - b), agoMs: Date.now() - s.lastSeen }));
  }

  // Program a node's Port-Addresses over the network (ArtAddress). Sent from our
  // :6454 socket because some nodes ignore Art-Net from any other source port.
  // The node answers with a fresh ArtPollReply, which refreshes our node list.
  function setNodeAddress(opts) {
    if (!opts || !opts.ip) throw new Error("ip required");
    const packet = buildAddress(opts);
    return new Promise((resolve, reject) => {
      socket.send(packet, opts.port || config.artnetPort, opts.ip, (err) => (err ? reject(err) : resolve()));
    });
  }

  // What a console sees when it discovers us: the name, the universes we accept,
  // and the address we announce on each network. A desk on the Art-Net VLAN sees
  // the address of the interface facing it, not the Pi's "main" address.
  function getSelf() {
    const ifaces = output ? output.interfaces() : localInterfaces();
    return {
      shortName: NODE_SHORT_NAME,
      longName: NODE_LONG_NAME,
      universes: advertised,
      deskIp: config.consoleIp,
      announcingAs: ifaces.map((i) => ({ name: i.name, address: i.address, broadcast: i.broadcast })),
    };
  }

  // One physical box often answers ArtPoll several times, because a reply can
  // only describe 4 ports. Group those replies back into devices, so an 8-port
  // node reads as one node with 8 sockets instead of 8 separate nodes.
  //
  // Physical port numbers are the running count of ports across a device's
  // replies, ordered by BindIndex. They are NOT bindIndex * 4: a node that sends
  // one reply per port would then number its 6th port as 21.
  function getDevices() {
    const byIp = new Map();
    for (const n of nodes.values()) {
      if (!byIp.has(n.ip)) byIp.set(n.ip, []);
      byIp.get(n.ip).push(n);
    }
    return [...byIp.entries()]
      .map(([ip, pages]) => {
        pages.sort((a, b) => a.bindIndex - b.bindIndex);
        const ports = [];
        let counted = 0;
        for (const page of pages) {
          for (const port of page.ports) {
            ports.push({
              ...port,
              port: counted + port.slot + 1, // physical socket on the box
              bindIndex: page.bindIndex, // which reply programs it
              net: page.net,
              subnet: page.subnet,
            });
          }
          counted += page.ports.length;
        }
        const first = pages[0];
        const longNames = [...new Set(pages.map((p) => p.longName).filter(Boolean))];
        const shortNames = [...new Set(pages.map((p) => p.shortName).filter(Boolean))];
        // Nodes that name each reply after its own port ("Port 1".."Port 8") give
        // a useless device name, so prefer a name every reply agrees on.
        const agreed = (list) => (list.length === 1 ? list[0] : "");
        return {
          ip,
          from: first.from,
          mac: first.mac,
          name: agreed(longNames) || agreed(shortNames) || first.longName || first.shortName || ip,
          shortName: agreed(shortNames),
          longName: agreed(longNames) || first.longName,
          report: first.report,
          pages: pages.length,
          lastSeen: Math.max(...pages.map((p) => p.lastSeen || 0)),
          ports,
          outputs: ports.filter((p) => p.isOutput && p.output !== null).map((p) => p.output),
          inputs: ports.filter((p) => p.isInput && p.input !== null).map((p) => p.input),
        };
      })
      .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  }

  function getNodes() {
    return {
      nodes: [...nodes.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }) || a.bindIndex - b.bindIndex),
      senders: [...senders.values()].map((s) => ({ ...s, universes: [...s.universes].sort((a, b) => a - b) })),
      interfaces: localInterfaces().map(({ name, address, netmask, broadcast }) => ({ name, address, netmask, broadcast })),
      devices: getDevices(),
      outputs: output ? output.describeOutputs(config.outputs) : [],
      self: getSelf(),
    };
  }

  // Universes we advertise as outputs — everything we drive plus the configured
  // universe range — so a unicasting desk sends them to us and we can record them.
  const advertised = [
    ...new Set([
      ...(config.outputs || []).flatMap((o) => o.universes),
      ...Array.from({ length: config.universes }, (_, u) => u),
    ]),
  ]
    .filter((u) => Number.isInteger(u) && u >= 0 && u < 32768)
    .sort((a, b) => a - b);

  let announceTimer = null;
  const iface = pickIface(config.consoleIp);
  const localIp = config.artnetIp || (iface && iface.address) || "0.0.0.0";
  const mac = iface && iface.mac;
  const seenUniverses = new Set();

  // One ArtPollReply per block of 4 advertised universes, describing us as seen
  // from `localIp`.
  function replyPages(fromIp, fromMac) {
    const pages = Math.max(1, Math.ceil(advertised.length / 4));
    return Array.from({ length: pages }, (_, p) => buildPollReply(config, fromIp || localIp, fromMac || mac, advertised, p));
  }

  // Broadcast who we are out of every interface, unprompted. Art-Net nodes are
  // meant to do this at power-up and whenever their state changes, and some
  // consoles (Avolites) only list nodes they have heard announce themselves —
  // they never poll, so a node that answers polls and nothing else stays
  // invisible. Each interface advertises its own address, so the IP inside the
  // packet matches the address it was sent from.
  let lastAnnounceAt = 0;
  function announce(force) {
    if (!advertised.length) return;
    const now = Date.now();
    if (!force && now - lastAnnounceAt < ANNOUNCE_MIN_GAP_MS) return;
    lastAnnounceAt = now;
    const ifaces = output ? output.interfaces() : localInterfaces();
    for (const i of ifaces) {
      for (const reply of replyPages(i.address, i.mac)) {
        if (i.send) i.send(reply, config.artnetPort, i.broadcast);
        else
          socket.send(reply, config.artnetPort, i.broadcast, (err) => {
            if (err) logger.warn(`ArtPollReply broadcast to ${i.broadcast} failed: ${err.message}`);
          });
      }
    }
  }

  // Answer a poll: unicast straight back to whoever asked (what a polling
  // controller expects), then broadcast so listen-only controllers see us too.
  function sendPollReplies(rinfo) {
    const from = pickIface(rinfo.address) || {};
    for (const reply of replyPages(from.address, from.mac)) {
      socket.send(reply, config.artnetPort, rinfo.address, (err) => {
        if (err) logger.error(`ArtPollReply to ${rinfo.address} failed:`, err.message);
      });
    }
    announce();
  }

  function handleMessage(packet, rinfo) {
    if (packet.length < 10) return;
    if (packet.toString("ascii", 0, 8) !== ARTNET_ID) return;
    const opcode = packet.readUInt16LE(8);

    // Answer discovery from anyone (so tools + the desk can find us).
    if (opcode === OP_POLL) {
      sendPollReplies(rinfo);
      return;
    }

    if (opcode === OP_POLLREPLY) {
      const node = parsePollReply(packet, rinfo);
      if (node && !isLocal(node.ip) && !isLocal(rinfo.address)) {
        node.lastSeen = Date.now();
        nodes.set(`${node.ip}#${node.bindIndex}`, node);
      }
      return;
    }

    if (opcode !== OP_DMX) return;
    if (packet.length < HEADER_LEN) return;

    const universe = packet.readUInt16LE(14);
    const length = packet.readUInt16BE(16);

    // Record who's sending (skipping our own output looping back to us).
    if (!isLocal(rinfo.address) || rinfo.address === config.consoleIp) {
      let s = senders.get(rinfo.address);
      if (!s) {
        s = { ip: rinfo.address, universes: new Set(), packets: 0, isConsole: rinfo.address === config.consoleIp };
        senders.set(rinfo.address, s);
      }
      s.universes.add(universe);
      s.packets++;
      s.lastSeen = Date.now();
    }

    if (rinfo.address !== config.consoleIp) return; // only record the desk's DMX
    if (universe > 32767) return; // not a valid Port-Address (the engine grows to fit the rest)

    if (!seenUniverses.has(universe)) {
      seenUniverses.add(universe);
      logger.info(`Art-Net: receiving universe ${universe} from desk ${config.consoleIp}`);
    }

    onDmx(universe, packet, length);
  }

  socket.on("message", handleMessage);
  // Unicast to one of our addresses lands on the output's per-interface sockets.
  if (output) output.onMessage(handleMessage);

  socket.bind(config.artnetPort, "0.0.0.0", () => {
    socket.setBroadcast(true); // for ArtPoll discovery
    logger.info(`Listening for console Art-Net on :${config.artnetPort} from ${config.consoleIp}`);
    if (advertised.length) {
      logger.info(
        `ArtPoll: advertising output universes [${advertised.join(",")}] as ${localIp}`
      );
      // Announce at power-up, repeated in case the desk is still booting, then
      // keep announcing so a console started later lists us without polling.
      for (const ms of [200, 2000, 6000]) setTimeout(() => announce(true), ms).unref?.();
      announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
      announceTimer.unref?.();
    }
  });

  function close() {
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = null;
    try {
      socket.close();
    } catch (_) {
      /* already closed */
    }
  }

  return { close, poll, getNodes, getDevices, getSenders, getSelf, setNodeAddress, announce };
}

module.exports = { createArtnetOutput, createArtnetInput, buildPollReply, buildAddress, parsePollReply };
