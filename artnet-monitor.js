#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------------
// artnet-monitor — a terminal Art-Net (ArtDMX) receiver + visualiser.
//
// Listens for Art-Net on UDP 6454 and draws every channel of every universe
// as a live grid of [000] cells, full-screen. Each universe is a block with an
// alternating dark/grey background so you can see where one ends and the next
// begins.
//
//   node artnet-monitor.js --u 6            # show 6 universes (0..5)
//   node artnet-monitor.js --u 2 --port 6455
//
// Point this controller's Art-Net output at the machine/port running this.
// ---------------------------------------------------------------------------

const dgram = require("dgram");

// ---- args ----
function argVal(names, def) {
  for (let i = 2; i < process.argv.length; i++) {
    if (names.includes(process.argv[i])) return process.argv[i + 1];
  }
  return def;
}
const UNIVERSES = Math.max(1, Math.min(64, parseInt(argVal(["--u", "-u", "--universes"], "4"), 10) || 4));
const PORT = parseInt(argVal(["--port", "-p"], "6454"), 10) || 6454;
const HOST = argVal(["--host", "-h"], "0.0.0.0");
const CH = 512;

// ---- state ----
const buffers = Array.from({ length: UNIVERSES }, () => new Uint8Array(CH));
const lastSeen = new Array(UNIVERSES).fill(0);
const packets = new Array(UNIVERSES).fill(0);
let totalPackets = 0;

// ---- ANSI helpers ----
const ESC = "\x1b[";
const RESET = ESC + "0m";
const BG_A = ESC + "48;5;233m"; // near-black
const BG_B = ESC + "48;5;236m"; // dark grey
const HEAD_BG = ESC + "48;5;238m";
const DIM = ESC + "38;5;240m";

// foreground for a channel value: 0 recedes, higher = brighter green
function fg(v) {
  if (v === 0) return ESC + "38;5;238m";
  const g = 1 + Math.round((v / 255) * 4); // 1..5
  return ESC + "38;5;" + (16 + 6 * g) + "m"; // 22,28,34,40,46
}

function pad3(n) {
  return n < 10 ? "00" + n : n < 100 ? "0" + n : "" + n;
}

// ---- render ----
function render() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const perRow = Math.max(1, Math.floor(cols / 5)); // each cell is "[000]" = 5 chars
  const blockW = perRow * 5;
  const now = Date.now();
  const lines = [];

  lines.push(
    `${DIM}Art-Net monitor · ${UNIVERSES} universe${UNIVERSES === 1 ? "" : "s"} · ${HOST}:${PORT} · ${totalPackets} pkts · Ctrl-C to quit${RESET}`
  );

  for (let u = 0; u < UNIVERSES; u++) {
    const bg = u % 2 === 0 ? BG_A : BG_B;
    const live = now - lastSeen[u] < 1500;
    const dot = live ? "● live" : "○ idle";
    const dotCol = live ? ESC + "38;5;46m" : ESC + "38;5;244m";
    // Full-width header block: bold label + status + packet count.
    const plain = ` Universe ${u}   ${dot}   ${packets[u]} pkts`;
    const coloured =
      `${ESC}1m${ESC}38;5;255m Universe ${u}${RESET}${HEAD_BG}   ${dotCol}${dot}${ESC}38;5;250m   ${packets[u]} pkts`;
    lines.push(HEAD_BG + coloured + HEAD_BG + " ".repeat(Math.max(0, blockW - plain.length)) + RESET);

    const buf = buffers[u];
    for (let start = 0; start < CH; start += perRow) {
      let row = "";
      const end = Math.min(CH, start + perRow);
      for (let c = start; c < end; c++) row += bg + fg(buf[c]) + "[" + pad3(buf[c]) + "]";
      const usedCells = end - start;
      const padCells = perRow - usedCells;
      if (padCells > 0) row += bg + " ".repeat(padCells * 5);
      lines.push(row + RESET);
    }
  }

  // Fit to the screen; note if clipped.
  let out = ESC + "H"; // cursor home
  const maxLines = rows - 1;
  const clipped = lines.length > maxLines;
  const shown = clipped ? lines.slice(0, maxLines - 1) : lines;
  for (const ln of shown) out += ln + ESC + "K\n";
  if (clipped) out += `${DIM}… ${lines.length - shown.length} more rows — resize the terminal or use fewer --u${RESET}${ESC}K\n`;
  out += ESC + "J"; // clear anything below
  process.stdout.write(out);
}

// ---- Art-Net parsing ----
function onPacket(msg) {
  if (msg.length < 18) return;
  if (msg.toString("ascii", 0, 7) !== "Art-Net") return; // "Art-Net\0"
  if (msg.readUInt16LE(8) !== 0x5000) return; // OpDmx / ArtDMX
  const universe = msg.readUInt16LE(14) & 0x7fff;
  if (universe >= UNIVERSES) return;
  const len = Math.min(CH, msg.readUInt16BE(16)); // ArtDMX length is big-endian
  const data = msg.subarray(18, 18 + len);
  buffers[universe].fill(0);
  buffers[universe].set(data.subarray(0, CH));
  lastSeen[universe] = Date.now();
  packets[universe]++;
  totalPackets++;
}

// ---- socket ----
const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("message", onPacket);
sock.on("error", (err) => {
  cleanup();
  console.error("Socket error:", err.message);
  process.exit(1);
});
sock.bind(PORT, HOST, () => {
  try {
    sock.setBroadcast(true);
  } catch (_) {
    /* ignore */
  }
});

// ---- terminal lifecycle ----
process.stdout.write(ESC + "?1049h"); // alternate screen
process.stdout.write(ESC + "?25l"); // hide cursor
process.stdout.write(ESC + "2J");
const timer = setInterval(render, 50); // ~20 fps
render();

function cleanup() {
  clearInterval(timer);
  process.stdout.write(ESC + "?25h"); // show cursor
  process.stdout.write(ESC + "?1049l"); // leave alternate screen
  try {
    sock.close();
  } catch (_) {
    /* ignore */
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
