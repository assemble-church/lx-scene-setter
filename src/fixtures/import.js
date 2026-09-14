// Import an Avolites Titan fixture library (.exe) into fixtures.db.
//
// The .exe is an NSIS self-extracting archive; we shell out to 7-Zip to extract
// the .d4 personality files, parse each, and bulk-insert. 7-Zip must be present
// (Pi: `apt install p7zip-full` → `7z`; macOS dev: `brew install sevenzip` → 7zz).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const { Worker } = require("worker_threads");
const { parseD4 } = require("./parse-d4");
const { openLibrary, replaceAll } = require("./library");

// Find an available 7-Zip binary (any of the common names across platforms).
// Probing spawns a process, and status is polled by every open UI, so a hit is
// cached for good and a miss is re-probed at most every 30s (e.g. after installing).
let sevenZip = { bin: null, checkedAt: 0 };
function find7z() {
  if (sevenZip.bin || Date.now() - sevenZip.checkedAt < 30000) return sevenZip.bin;
  let found = null;
  for (const bin of ["7zz", "7z", "7za"]) {
    const r = spawnSync(bin, ["--help"], { stdio: "ignore" });
    if (!r.error) {
      found = bin;
      break;
    }
  }
  sevenZip = { bin: found, checkedAt: Date.now() };
  return found;
}

// Per-OS instruction for installing 7-Zip when it's missing.
function sevenZipHint() {
  switch (process.platform) {
    case "darwin":
      return "Install 7-Zip with:  brew install sevenzip";
    case "linux":
      return "Install 7-Zip with:  sudo apt install -y 7zip   (or: sudo apt install -y p7zip-full)";
    case "win32":
      return "Install 7-Zip from https://www.7-zip.org and ensure 7z.exe is on PATH";
    default:
      return "Install 7-Zip and ensure 7z / 7zz is on your PATH";
  }
}

// Status for the UI: is the extractor available, and if not, what to do.
function sevenZipStatus() {
  const bin = find7z();
  return { available: !!bin, bin, platform: process.platform, hint: bin ? null : sevenZipHint() };
}

function extract(bin, exePath, destDir) {
  return new Promise((resolve, reject) => {
    // -tnsis: treat as NSIS; e: extract flat; only the .d4 personalities.
    const p = spawn(bin, ["e", "-tnsis", exePath, "$_3_/*.d4", `-o${destDir}`, "-y", "-bso0", "-bsp0"]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`7-Zip exit ${code}: ${err}`))));
  });
}

// onProgress({ phase, done, total })
async function importLibrary(exePath, dbPath, onProgress = () => {}) {
  const bin = find7z();
  if (!bin) {
    throw new Error(`7-Zip is required to read the fixture library but wasn't found. ${sevenZipHint()}`);
  }
  if (!fs.existsSync(exePath)) throw new Error(`File not found: ${exePath}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixlib-"));
  try {
    onProgress({ phase: "extracting", done: 0, total: 0 });
    await extract(bin, exePath, tmp);

    const files = fs.readdirSync(tmp).filter((f) => f.toLowerCase().endsWith(".d4"));
    const total = files.length;
    if (!total) throw new Error("No .d4 personalities found in the archive.");

    // Parse + insert in one transaction, streamed (don't hold all in memory).
    const db = openLibrary(dbPath);
    let done = 0;
    let failed = 0;
    function* parsed() {
      for (const file of files) {
        try {
          const xml = fs.readFileSync(path.join(tmp, file), "utf8");
          const fx = parseD4(xml);
          if (fx.name) yield fx;
          else failed++;
        } catch (_) {
          failed++;
        }
        done++;
        if (done % 500 === 0 || done === total) onProgress({ phase: "parsing", done, total });
      }
    }
    const count = replaceAll(db, parsed());
    db.close();

    return { count, total, failed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Run importLibrary on a worker thread (see import-worker.js). Same contract.
function importLibraryInWorker(exePath, dbPath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "import-worker.js"), { workerData: { exePath, dbPath } });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.on("message", (msg) => {
      if (msg.type === "progress") onProgress(msg.progress);
      else if (msg.type === "done") settle(resolve, msg.result);
      else if (msg.type === "error") settle(reject, new Error(msg.message));
    });
    worker.on("error", (err) => settle(reject, err));
    worker.on("exit", (code) => settle(reject, new Error(`Import worker exited unexpectedly (code ${code})`)));
  });
}

module.exports = { importLibrary, importLibraryInWorker, find7z, sevenZipStatus, sevenZipHint };
