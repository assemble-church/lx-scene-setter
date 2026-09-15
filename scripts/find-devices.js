#!/usr/bin/env node
// Find devices that don't announce themselves (e.g. a Botex DPX NET dimmer that
// self-assigns a 169.254.x.x address and never answers ArtPoll).
//
// Every device answers ARP ("who has this IP?") even if it ignores everything
// else, so we send one small UDP packet to each address in a range — the OS ARPs
// for each — then read the neighbour table for the addresses that answered.
// Once you know the device's IP, put it in the Art-Net output instead of a
// broadcast address so only that device receives the traffic.
//
// Fastest, and silent on the network: --listen. A device that self-assigns a
// 169.254.x.x address announces it with ARP when it powers up (RFC 3927), so
// listen, then power-cycle the device — its IP and MAC appear within seconds.
// Needs tcpdump (Pi: sudo apt install -y tcpdump) and root.
//
// Usage:
//   sudo node scripts/find-devices.js --listen    # then power-cycle the device
//   sudo node scripts/find-devices.js --listen eth0
//   node scripts/find-devices.js                  # every 169.254.x.x range we have an address in
//   node scripts/find-devices.js 192.168.1.0/24   # any range one of our interfaces is on
//   node scripts/find-devices.js 169.254.0.0/16 --rate=300
//
// A /16 is 65,534 addresses: ~4 minutes at the default 250/s. The ARP traffic is
// tiny (60-byte frames) but it is broadcast, so run it once, not continuously.

const dgram = require("dgram");
const os = require("os");
const { execFileSync } = require("child_process");

const { spawn } = require("child_process");

const args = process.argv.slice(2);

// ---- --listen: watch ARP for addresses being claimed / announced --------------
if (args.includes("--listen")) {
  const nics = Object.entries(os.networkInterfaces())
    .filter(([, a]) => (a || []).some((x) => x.family === "IPv4" && !x.internal))
    .map(([n]) => n);
  const dev = args.find((a) => !a.startsWith("-")) || nics.find((n) => /^(eth|en)/.test(n)) || nics[0];
  if (!dev) {
    console.error("No network interface to listen on.");
    process.exit(1);
  }
  console.log(`Listening for ARP on ${dev}. Power-cycle the device now (Ctrl+C to stop).\n`);
  const seen = new Map(); // ip → mac
  const td = spawn("tcpdump", ["-l", "-n", "-e", "-i", dev, "arp"], { stdio: ["ignore", "pipe", "pipe"] });
  td.on("error", (e) => {
    console.error(e.code === "ENOENT" ? "tcpdump isn't installed. On the Pi: sudo apt install -y tcpdump" : e.message);
    process.exit(1);
  });
  td.stderr.on("data", (d) => {
    const t = String(d);
    if (/permission|not permitted|You don't have/i.test(t)) console.error("tcpdump needs root: run with sudo.");
  });
  let buf = "";
  td.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const mac = (line.match(/^\S+ ([0-9a-f]{2}(?::[0-9a-f]{2}){5}) >/i) || [])[1];
      // Announcement / reply: "Reply 169.254.x.x is-at mac"  "Request who-has X tell 169.254.x.x"
      // Probe (claiming an address, sender 0.0.0.0): "Request who-has 169.254.x.x tell 0.0.0.0"
      const reply = line.match(/Reply (\d+\.\d+\.\d+\.\d+) is-at/);
      const tell = line.match(/who-has (\d+\.\d+\.\d+\.\d+) (?:\(\S+\) )?tell (\d+\.\d+\.\d+\.\d+)/);
      let ip = null;
      let how = "";
      if (reply) [ip, how] = [reply[1], "answered ARP"];
      else if (tell && tell[2] === "0.0.0.0") [ip, how] = [tell[1], "probing to claim this address"];
      else if (tell && tell[1] === tell[2]) [ip, how] = [tell[1], "announced its address"];
      else if (tell) [ip, how] = [tell[2], "asked for another address"];
      if (!ip || !ip.startsWith("169.254.") || !mac) continue;
      const key = `${ip} ${mac}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      console.log(`  ${ip}\t${mac}\t${how}`);
    }
  });
  process.on("SIGINT", () => {
    td.kill();
    console.log(seen.size ? `\n${seen.size} link-local device(s) seen.` : "\nNo 169.254.x.x devices seen.");
    process.exit(0);
  });
  return;
}

const rate = Number((args.find((a) => a.startsWith("--rate=")) || "--rate=250").split("=")[1]);
const cidrArg = args.find((a) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(a));

const toInt = (ip) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const maskBits = (mask) => mask.split(".").reduce((b, o) => b + (Number(o).toString(2).match(/1/g) || []).length, 0);

const ifaces = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
  (addrs || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, ...a }))
);

// Work out which ranges to scan and which local interface/address to scan each from.
let jobs = [];
if (cidrArg) {
  const [base, bits] = cidrArg.split("/");
  const size = 2 ** (32 - Number(bits));
  const net = (toInt(base) & ~(size - 1)) >>> 0;
  const iface = ifaces.find((i) => ((toInt(i.address) & ~(size - 1)) >>> 0) === net);
  if (!iface) {
    console.error(`No interface has an address in ${cidrArg} — the OS couldn't ARP there.`);
    console.error(`Interfaces: ${ifaces.map((i) => `${i.name} ${i.address}/${maskBits(i.netmask)}`).join(", ") || "none"}`);
    process.exit(1);
  }
  jobs.push({ iface, net, size });
} else {
  jobs = ifaces
    .filter((i) => i.address.startsWith("169.254."))
    .map((iface) => ({ iface, net: toInt("169.254.0.0"), size: 65536 }));
  if (!jobs.length) {
    console.error("No interface has a 169.254.x.x address. Add one to the port the device is cabled to, e.g.");
    console.error("  Linux:  sudo ip addr add 169.254.50.50/16 brd + dev eth0");
    console.error("  macOS:  sudo ifconfig en8 alias 169.254.50.50 255.255.0.0");
    console.error("or pass a range explicitly: node scripts/find-devices.js 192.168.1.0/24");
    process.exit(1);
  }
}

function neighbours(ifaceName) {
  const found = new Map();
  try {
    if (process.platform === "linux") {
      // "169.254.12.34 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
      for (const line of execFileSync("ip", ["-4", "neigh", "show", "dev", ifaceName], { encoding: "utf8" }).split("\n")) {
        const m = line.match(/^(\S+) lladdr (\S+) (\S+)/);
        if (m && !/FAILED|INCOMPLETE/.test(m[3])) found.set(m[1], m[2]);
      }
    } else {
      // "? (169.254.12.34) at aa:bb:cc:dd:ee:ff on en8 ifscope [ethernet]"
      for (const line of execFileSync("arp", ["-an", "-i", ifaceName], { encoding: "utf8" }).split("\n")) {
        const m = line.match(/\((\S+)\) at ([0-9a-f:]+) /i);
        if (m && !/permanent/.test(line) && m[2] !== "ff:ff:ff:ff:ff:ff") found.set(m[1], m[2]);
      }
    }
  } catch (_) {
    /* table unreadable this instant — try again next tick */
  }
  return found;
}

async function scan({ iface, net, size }) {
  const self = iface.address;
  const first = net + 1;
  const last = net + size - 2; // skip network + broadcast addresses
  const total = last - first + 1;
  console.log(`Scanning ${toIp(net)}/${32 - Math.log2(size)} from ${iface.name} ${self} — ${total.toLocaleString()} addresses at ${rate}/s (~${Math.ceil(total / rate / 60)} min)`);

  const sock = dgram.createSocket("udp4");
  sock.on("error", () => {}); // unreachable hosts / neighbour-table pressure are expected
  await new Promise((r) => sock.bind(0, self, r)); // bound to the interface address, so it leaves that port

  // A minimal ArtPoll — harmless to anything that receives it.
  const probe = Buffer.alloc(14);
  probe.write("Art-Net\0", 0, "ascii");
  probe.writeUInt16LE(0x2000, 8);
  probe.writeUInt16BE(14, 10);

  const results = new Map();
  const collect = () => {
    for (const [ip, mac] of neighbours(iface.name)) {
      const n = toInt(ip);
      if (ip === self || n < first || n > last || results.has(ip)) continue;
      results.set(ip, mac);
      console.log(`  found ${ip}  ${mac}`);
    }
  };

  let next = first;
  const perTick = Math.max(1, Math.round(rate / 20));
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      for (let i = 0; i < perTick && next <= last; i++, next++) {
        if (toIp(next) !== self) sock.send(probe, 6454, toIp(next), () => {});
      }
      // Read the neighbour table often: on a big sweep the OS evicts old entries
      // (the table holds ~1000 on Linux), so a reply can vanish if we wait.
      if ((next - first) % (perTick * 10) < perTick) {
        collect();
        process.stdout.write(`  … ${Math.round(((next - first) / total) * 100)}%\r`);
      }
      if (next > last) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
  // Give the last ARP replies a moment to land.
  await new Promise((r) => setTimeout(r, 3000));
  collect();
  sock.close();
  return results;
}

(async () => {
  for (const job of jobs) {
    const results = await scan(job);
    console.log(results.size ? `\n${results.size} device(s) answered on ${job.iface.name}:` : `\nNothing answered on ${job.iface.name}.`);
    for (const [ip, mac] of results) console.log(`  ${ip}\t${mac}`);
  }
})();
