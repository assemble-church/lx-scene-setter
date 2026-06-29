// Art-Net I/O.
//
// Output: builds and sends ArtDMX packets to configured nodes.
// Input:  listens for ArtDMX from the Avo console (to record), and answers
//         ArtPoll discovery with ArtPollReply so controllers/tools can find us
//         and a unicasting desk will send us the universes we advertise.
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
const ARTNET_ID = "Art-Net\0";
const POLLREPLY_LEN = 239;

function createArtnetOutput(config, logger) {
  const socket = dgram.createSocket("udp4");
  socket.on("error", (err) => logger.error("Art-Net out socket error:", err.message));

  // Track which targets are currently failing so a downed/unreachable node logs
  // once, not every packet.
  const failing = new Set();

  function sendUniverse(ip, port, universe, values) {
    const packet = Buffer.alloc(HEADER_LEN + config.channels);

    packet.write(ARTNET_ID, 0, "ascii");
    packet.writeUInt16LE(OP_DMX, 8);
    packet.writeUInt16BE(14, 10);
    packet[12] = 0; // sequence disabled
    packet[13] = 0; // physical
    packet.writeUInt16LE(universe, 14);
    packet.writeUInt16BE(config.channels, 16);

    Buffer.from(values).copy(packet, HEADER_LEN);

    socket.send(packet, port, ip, (err) => {
      if (err) {
        if (!failing.has(ip)) {
          failing.add(ip);
          logger.error(
            `Art-Net send to ${ip}:${port} failing: ${err.message} (further errors suppressed until it recovers)`
          );
        }
      } else if (failing.has(ip)) {
        failing.delete(ip);
        logger.info(`Art-Net send to ${ip} recovered`);
      }
    });
  }

  function close() {
    try {
      socket.close();
    } catch (_) {
      /* already closed */
    }
  }

  return { sendUniverse, close };
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
  buf.write("PiSceneSetter", 26, 17, "ascii"); // ShortName
  buf.write("Assembly Rooms Art-Net Scene Setter", 44, 63, "ascii"); // LongName
  buf.write(`#0001 [${page}] Scene Setter OK`, 108, 63, "ascii"); // NodeReport
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

// onDmx(universe, packet, length) is called for valid ArtDMX from the Avo.
function createArtnetInput(config, logger, onDmx) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", (err) => logger.error("Art-Net in socket error:", err.message));

  // Universes we advertise as outputs (the union of what we drive) — a unicasting
  // desk will then send these to us so we can record them.
  const advertised = [...new Set((config.outputs || []).flatMap((o) => o.universes))]
    .filter((u) => Number.isInteger(u) && u >= 0 && u < 32768)
    .sort((a, b) => a - b);

  const iface = pickIface(config.avoIp);
  const localIp = config.artnetIp || (iface && iface.address) || "0.0.0.0";
  const mac = iface && iface.mac;
  const seenUniverses = new Set();

  function sendPollReplies(rinfo) {
    const pages = Math.max(1, Math.ceil(advertised.length / 4));
    for (let p = 0; p < pages; p++) {
      const reply = buildPollReply(config, localIp, mac, advertised, p);
      socket.send(reply, config.artnetPort, rinfo.address, (err) => {
        if (err) logger.error(`ArtPollReply to ${rinfo.address} failed:`, err.message);
      });
    }
  }

  socket.on("message", (packet, rinfo) => {
    if (packet.length < 10) return;
    if (packet.toString("ascii", 0, 8) !== ARTNET_ID) return;
    const opcode = packet.readUInt16LE(8);

    // Answer discovery from anyone (so tools + the desk can find us).
    if (opcode === OP_POLL) {
      sendPollReplies(rinfo);
      return;
    }

    if (opcode !== OP_DMX) return;
    if (rinfo.address !== config.avoIp) return; // only record the desk's DMX
    if (packet.length < HEADER_LEN) return;

    const universe = packet.readUInt16LE(14);
    const length = packet.readUInt16BE(16);
    if (universe >= config.universes) return;

    if (!seenUniverses.has(universe)) {
      seenUniverses.add(universe);
      logger.info(`Art-Net: receiving universe ${universe} from desk ${config.avoIp}`);
    }

    onDmx(universe, packet, length);
  });

  socket.bind(config.artnetPort, "0.0.0.0", () => {
    logger.info(`Listening for Avo Art-Net on :${config.artnetPort} from ${config.avoIp}`);
    if (advertised.length) {
      logger.info(
        `ArtPoll: advertising output universes [${advertised.join(",")}] as ${localIp}`
      );
    }
  });

  function close() {
    try {
      socket.close();
    } catch (_) {
      /* already closed */
    }
  }

  return { close };
}

module.exports = { createArtnetOutput, createArtnetInput, buildPollReply };
