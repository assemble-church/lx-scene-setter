// A physical Art-Net node can answer one ArtPoll several times, because a reply
// describes at most 4 ports. How it splits them is up to the node:
//   - an ADJ NET 8 sends 8 replies of 1 port each
//   - other 8-port nodes send 2 replies of 4 ports
// Both must come back as ONE device with ports numbered 1..8.
const assert = require("assert");
const { createArtnetInput } = require("../src/artnet.js");

// Build an ArtPollReply the way a real node would.
function reply({ ip, bindIndex, shortName, longName, mac, swOut, net = 0, subnet = 0 }) {
  const buf = Buffer.alloc(239);
  buf.write("Art-Net\0", 0, "ascii");
  buf.writeUInt16LE(0x2100, 8);
  ip.split(".").forEach((o, i) => (buf[10 + i] = Number(o)));
  buf.writeUInt16LE(6454, 14);
  buf[17] = 14;
  buf[18] = net & 0x7f;
  buf[19] = subnet & 0x0f;
  buf.write(shortName, 26, 17, "ascii");
  buf.write(longName, 44, 63, "ascii");
  buf.writeUInt16BE(swOut.length, 172);
  swOut.forEach((u, i) => {
    buf[174 + i] = 0x80; // PortType: output
    buf[182 + i] = 0x80; // GoodOutput
    buf[190 + i] = u & 0x0f; // SwOut
  });
  mac.split(":").forEach((b, i) => (buf[201 + i] = parseInt(b, 16)));
  buf[211] = bindIndex;
  return buf;
}

function harness() {
  let handler = null;
  const out = {
    interfaces: () => [{ name: "eth0.20", address: "10.10.20.30", mac: "aa:bb:cc:dd:ee:ff", broadcast: "10.10.20.255", send: () => {} }],
    broadcast: () => {},
    onMessage: (fn) => (handler = fn),
  };
  const logger = { info() {}, warn() {}, error() {} };
  const config = { artnetPort: 6454, artnetIp: "", consoleIp: "10.10.20.2", universes: 8, channels: 512, outputs: [] };
  const input = createArtnetInput(config, logger, () => {}, out);
  return { input, feed: (pkt, from) => handler(pkt, { address: from }) };
}

// ---- an ADJ NET 8: one reply per port ---------------------------------------
{
  const { input, feed } = harness();
  for (let i = 1; i <= 8; i++) {
    feed(
      reply({
        ip: "10.10.20.4",
        bindIndex: i,
        shortName: `Port ${i}`, // the NET8 names each reply after its own port
        longName: "NET8",
        mac: "00:50:c2:11:22:33",
        swOut: [i - 1],
      }),
      "10.10.20.4"
    );
  }
  const devices = input.getDevices();
  assert.strictEqual(devices.length, 1, "8 replies from one box = 1 device");
  const d = devices[0];
  assert.strictEqual(d.ip, "10.10.20.4");
  assert.strictEqual(d.pages, 8, "8 bind pages");
  assert.strictEqual(d.name, "NET8", "uses the name every reply agrees on, not 'Port 1'");
  assert.deepStrictEqual(
    d.ports.map((p) => p.port),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "physical ports number 1..8 — the old bindIndex*4 maths made port 6 into 21"
  );
  assert.deepStrictEqual(d.outputs, [0, 1, 2, 3, 4, 5, 6, 7], "every universe the box listens for");
  // Each port still knows which reply programs it, for ArtAddress.
  assert.deepStrictEqual(
    d.ports.map((p) => [p.port, p.bindIndex, p.slot]),
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n, 0])
  );
  input.close();
}

// ---- an 8-port node that packs 4 ports per reply ----------------------------
{
  const { input, feed } = harness();
  feed(reply({ ip: "10.10.20.5", bindIndex: 1, shortName: "Big", longName: "Big Node", mac: "00:50:c2:44:55:66", swOut: [0, 1, 2, 3] }), "10.10.20.5");
  feed(reply({ ip: "10.10.20.5", bindIndex: 2, shortName: "Big", longName: "Big Node", mac: "00:50:c2:44:55:66", swOut: [4, 5, 6, 7] }), "10.10.20.5");
  const d = input.getDevices()[0];
  assert.strictEqual(d.pages, 2);
  assert.deepStrictEqual(d.ports.map((p) => p.port), [1, 2, 3, 4, 5, 6, 7, 8], "same 1..8 numbering");
  assert.deepStrictEqual(d.outputs, [0, 1, 2, 3, 4, 5, 6, 7]);
  // Port 6 lives in the second reply, at slot 1.
  const p6 = d.ports.find((p) => p.port === 6);
  assert.deepStrictEqual([p6.bindIndex, p6.slot, p6.output], [2, 1, 5]);
  input.close();
}

// ---- a single-port node still reads sensibly --------------------------------
{
  const { input, feed } = harness();
  feed(reply({ ip: "10.10.20.3", bindIndex: 1, shortName: "OutNode 0", longName: "Artnet2DMX Node 1", mac: "00:00:4d:25:a4:92", swOut: [0, 1] }), "10.10.20.3");
  const d = input.getDevices()[0];
  assert.strictEqual(d.name, "Artnet2DMX Node 1");
  assert.deepStrictEqual(d.ports.map((p) => p.port), [1, 2]);
  assert.deepStrictEqual(d.outputs, [0, 1]);
  input.close();
}

console.log("OK: multi-reply nodes group into one device with correct port numbers");
