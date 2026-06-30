// Crash-safe JSON persistence.
//
// Reads tolerate missing/corrupt files (a power-loss on a Pi can truncate a
// file mid-write) and fall back to a default instead of crashing the process.
// Writes are atomic: data is written to a temp file, fsync'd, then renamed over
// the target. rename(2) is atomic on the same filesystem, so a reader never sees
// a half-written file.

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    logger.error(`Could not read/parse ${file}, using fallback:`, err.message);
    // Preserve the bad file for forensics rather than silently overwriting it.
    try {
      fs.renameSync(file, `${file}.corrupt`);
      logger.warn(`Moved corrupt file aside to ${file}.corrupt`);
    } catch (_) {
      /* best effort */
    }
    return fallback;
  }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd); // flush to disk before the rename
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeJSONAtomic(file, data) {
  writeTextAtomic(file, JSON.stringify(data, null, 2));
}

module.exports = { readJSON, writeJSONAtomic, writeTextAtomic };
