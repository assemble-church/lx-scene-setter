// Verifies the Pi announces itself unprompted, broadcast, once per interface,
// with each packet carrying the address of the interface it leaves by.
const assert = require("assert");
const { createArtnetInput, parsePollReply } = require("../src/artnet.js");

const sent = [];
const fakeOutput = {
  interfaces: () => [
    { name: "eth0", address: "10.10.10.30", mac: "88:a2:9e:c7:53:fa", broadcast: "10.10.10.255",
      send: (p, port, dest) => sent.push({ p, port, dest, from: "10.10.10.30" }) },
    { name: "eth0.20", address: "10.10.20.50", mac: "88:a2:9e:c7:53:fa", broadcast: "10.10.20.255",
      send: (p, port, dest) => sent.push({ p, port, dest, from: "10.10.20.50" }) },
  ],
  broadcast: () => {},
  onMessage: () => {},
};
const logger = { info() {}, warn() {}, error() {} };
const config = { artnetPort: 6454, artnetIp: "", consoleIp: "10.10.20.2", universes: 6, channels: 512, outputs: [{ name: "Roar", ip: "10.10.20.3", universes: [0, 1] }] };

const input = createArtnetInput(config, logger, () => {}, fakeOutput);
input.announce();

assert.ok(sent.length > 0, "announce() sent nothing");
for (const s of sent) {
  assert.strictEqual(s.port, 6454, "wrong port");
  assert.ok(s.dest.endsWith(".255"), `not a broadcast dest: ${s.dest}`);
  const r = parsePollReply(s.p, { address: s.from });
  assert.strictEqual(r.ip, s.from, `packet advertises ${r.ip} but leaves via ${s.from}`);
  assert.strictEqual(r.shortName, "Light It");
  assert.ok(r.outputs.length > 0, "no output universes advertised");
}
const perIface = {};
for (const s of sent) perIface[s.from] = (perIface[s.from] || 0) + 1;
assert.deepStrictEqual(Object.keys(perIface).sort(), ["10.10.10.30", "10.10.20.50"]);
// 6 universes = 2 pages of <=4 ports, per interface
assert.strictEqual(perIface["10.10.20.50"], 2, "expected 2 pages per interface");

const unis = sent.filter((s) => s.from === "10.10.20.50").flatMap((s) => parsePollReply(s.p, { address: s.from }).outputs);
assert.deepStrictEqual(unis.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);

input.close();
console.log(`OK: announced ${sent.length} broadcast replies across ${Object.keys(perIface).length} interfaces, universes ${unis.join(",")}`);

// --- ArtAddress: programming a node's physical DMX ports ---------------------
const { buildAddress } = require("../src/artnet.js");

{
  // Ports 1 and 2 of the first bind page to universes 17 and 18, i.e.
  // Net 0 / Subnet 1 / Universe 1 and 2.
  const b = buildAddress({ bindIndex: 1, net: 0, subnet: 1, swOut: [1, 2, null, null], shortName: "Roar" });
  assert.strictEqual(b.length, 107, "ArtAddress is 107 bytes");
  assert.strictEqual(b.toString("ascii", 0, 7), "Art-Net");
  assert.strictEqual(b.readUInt16LE(8), 0x6000, "OpAddress");
  assert.strictEqual(b[11], 14, "protocol version 14");
  assert.strictEqual(b[12], 0x80, "NetSwitch 0 must still be sent as programmed (bit 7 set)");
  assert.strictEqual(b[13], 1, "BindIndex");
  assert.strictEqual(b[104], 0x81, "SubSwitch 1, programmed");
  assert.deepStrictEqual([...b.subarray(100, 104)], [0x81, 0x82, 0x00, 0x00], "SwOut nibbles, unused ports zeroed");
  assert.deepStrictEqual([...b.subarray(96, 100)], [0, 0, 0, 0], "SwIn untouched");
  assert.strictEqual(b.toString("ascii", 14, 18), "Roar", "ShortName kept so the node isn't renamed blank");
  assert.strictEqual(b[106], 0, "Command = AcNone");
}

{
  // A 15-bit Port-Address round-trips: universe 300 = Net 1, Subnet 2, Universe 12.
  const u = 300;
  const b = buildAddress({ net: (u >> 8) & 0x7f, subnet: (u >> 4) & 0x0f, swOut: [u & 0x0f] });
  assert.strictEqual(b[12] & 0x7f, 1, "net");
  assert.strictEqual(b[104] & 0x0f, 2, "subnet");
  assert.strictEqual(b[100] & 0x0f, 12, "universe nibble");
  assert.strictEqual(((b[12] & 0x7f) << 8) | ((b[104] & 0x0f) << 4) | (b[100] & 0x0f), u, "recombines to 300");
}

console.log("OK: ArtAddress encodes port programming correctly");
