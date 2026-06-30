// The fixture library — a SQLite database of parsed personalities.
// One file (fixtures.db); only created/opened when a library exists.

const Database = require("better-sqlite3");

function openLibrary(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixtures (
      id INTEGER PRIMARY KEY,
      manufacturer TEXT NOT NULL,
      name TEXT NOT NULL,
      short TEXT,
      modes TEXT NOT NULL,            -- JSON: [{ name, channels, attrs:[...] }]
      search TEXT NOT NULL            -- lowercase "manufacturer name" for matching
    );
    CREATE INDEX IF NOT EXISTS idx_fixtures_search ON fixtures(search);
    CREATE INDEX IF NOT EXISTS idx_fixtures_sort ON fixtures(manufacturer, name);
  `);
  return db;
}

// Replace the whole library from an iterable of parsed fixtures, in one
// transaction. Returns the row count.
function replaceAll(db, fixturesIterable) {
  const insert = db.prepare(
    "INSERT INTO fixtures (manufacturer, name, short, modes, search) VALUES (?, ?, ?, ?, ?)"
  );
  let n = 0;
  const tx = db.transaction((items) => {
    db.exec("DELETE FROM fixtures");
    for (const f of items) {
      insert.run(
        f.manufacturer || "",
        f.name || "",
        f.short || "",
        JSON.stringify(f.modes || []),
        `${f.manufacturer || ""} ${f.name || ""}`.toLowerCase()
      );
      n++;
    }
  });
  tx(fixturesIterable);
  return n;
}

function count(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM fixtures").get().n;
}

// Search by manufacturer/name. Returns light rows (no modes) for the list.
function search(db, query, limit = 100) {
  const q = String(query || "").trim().toLowerCase();
  const rows = q
    ? db
        .prepare(
          `SELECT id, manufacturer, name, short FROM fixtures
           WHERE search LIKE ? ORDER BY manufacturer, name LIMIT ?`
        )
        .all(`%${q}%`, limit)
    : db
        .prepare(
          `SELECT id, manufacturer, name, short FROM fixtures
           ORDER BY manufacturer, name LIMIT ?`
        )
        .all(limit);
  return rows;
}

// Full fixture incl. parsed modes.
function get(db, id) {
  const row = db.prepare("SELECT id, manufacturer, name, short, modes FROM fixtures WHERE id = ?").get(id);
  if (!row) return null;
  row.modes = JSON.parse(row.modes);
  return row;
}

function manufacturers(db) {
  return db
    .prepare("SELECT DISTINCT manufacturer FROM fixtures ORDER BY manufacturer")
    .all()
    .map((r) => r.manufacturer);
}

// Resolve a mode's per-channel fade flags (default fade=true for unmapped channels).
function channelFade(mode) {
  const fade = new Array(mode.channels || 0).fill(true);
  for (const a of mode.attrs || []) {
    for (const off of a.offsets || []) {
      if (off >= 1 && off <= fade.length) fade[off - 1] = a.fade !== false;
    }
  }
  return fade;
}

// A single-letter hint for what a channel controls (for the patch grid).
const LETTER_BY_NAME = [
  ["dimmer", "D"], ["intensity", "D"], ["master", "D"],
  ["red", "R"], ["green", "G"], ["blue", "B"], ["white", "W"], ["amber", "A"],
  ["cyan", "C"], ["magenta", "M"], ["yellow", "Y"], ["lime", "L"], ["uv", "U"],
  ["pan", "P"], ["tilt", "T"],
  ["shutter", "S"], ["strobe", "S"],
  ["zoom", "Z"], ["focus", "F"], ["iris", "I"], ["gobo", "G"], ["prism", "P"],
  ["colour", "C"], ["color", "C"], ["temperature", "K"], ["cto", "K"], ["ctb", "K"],
];
const LETTER_BY_GROUP = { I: "D", C: "C", P: "P", B: "B", E: "E", G: "G", F: "F", S: "·" };

function attrLetter(attr) {
  const n = (attr.name || "").toLowerCase();
  for (const [k, l] of LETTER_BY_NAME) if (n.includes(k)) return l;
  return LETTER_BY_GROUP[attr.group] || (attr.name || "?").charAt(0).toUpperCase() || "·";
}

function channelLetters(mode) {
  const out = new Array(mode.channels || 0).fill("");
  for (const a of mode.attrs || []) {
    const l = attrLetter(a);
    for (const off of a.offsets || []) {
      if (off >= 1 && off <= out.length) out[off - 1] = l;
    }
  }
  return out;
}

module.exports = {
  openLibrary,
  replaceAll,
  count,
  search,
  get,
  manufacturers,
  channelFade,
  channelLetters,
};
