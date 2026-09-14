// Crash-safe file writes (used for config.jsonc; app data lives in SQLite — see db.js).
//
// Writes are atomic: data is written to a temp file, fsync'd, then renamed over
// the target. rename(2) is atomic on the same filesystem, so a reader never sees
// a half-written file.

const fs = require("fs");
const path = require("path");

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

module.exports = { writeTextAtomic };
