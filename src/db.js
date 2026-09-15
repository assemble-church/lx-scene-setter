// App database — scenes, patch, fixture-grid layout and persisted playback state,
// in one SQLite file (data/scene-setter.db).
//
// The fixture LIBRARY stays in its own fixtures.db: it's large, re-importable and
// replaced wholesale on import, so it's kept apart from venue data.
//
// Schema changes are numbered migrations tracked in PRAGMA user_version; each runs
// once, in a transaction. Migration 1 also imports the legacy JSON files
// (scenes.json, state.json, patch.json, fixture-map.json) if present, then renames
// them to *.migrated so they're kept but never read again.
//
// Durability: WAL + synchronous=FULL. Writes only happen on user actions (never on
// the DMX hot path), so the fsync cost is irrelevant and a power cut can't lose a
// committed change.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const LEGACY_FILES = {
  scenes: "scenes.json",
  state: "state.json",
  patch: "patch.json",
  fixtureMap: "fixture-map.json",
};

const CHANNEL_TYPES = ["level", "switch"];

const MIGRATIONS = [
  // 1 — initial schema + import of the legacy JSON files.
  (db, ctx) => {
    db.exec(`
      CREATE TABLE scenes (
        id    TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT ''
      );
      -- One row per recorded universe; dmx is the raw channel bytes.
      CREATE TABLE scene_universes (
        scene_id TEXT    NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
        universe INTEGER NOT NULL,
        dmx      BLOB    NOT NULL,
        PRIMARY KEY (scene_id, universe)
      );

      CREATE TABLE patch_fixtures (
        id            TEXT PRIMARY KEY,
        position      INTEGER NOT NULL,          -- patch-list order
        lib_id        INTEGER,                   -- fixture library id; NULL for built-in fixtures
        manufacturer  TEXT    NOT NULL DEFAULT '',
        name          TEXT    NOT NULL DEFAULT '',
        label         TEXT    NOT NULL DEFAULT '',
        mode          TEXT    NOT NULL DEFAULT '',
        channel_count INTEGER NOT NULL,
        universe      INTEGER NOT NULL,
        address       INTEGER NOT NULL,          -- 1-based start channel
        icon          TEXT
      );
      CREATE TABLE patch_channels (
        fixture_id TEXT    NOT NULL REFERENCES patch_fixtures(id) ON DELETE CASCADE,
        offset     INTEGER NOT NULL,             -- 1-based within the fixture
        name       TEXT    NOT NULL DEFAULT '',
        letter     TEXT    NOT NULL DEFAULT '',
        type       TEXT    NOT NULL DEFAULT 'level' CHECK (type IN ('level', 'switch')),
        fade       INTEGER NOT NULL DEFAULT 1,   -- 1 = scales with fades, 0 = snaps
        PRIMARY KEY (fixture_id, offset)
      );
      -- Heads: separate lights within one patch entry (dimmer packs).
      CREATE TABLE patch_heads (
        fixture_id TEXT    NOT NULL REFERENCES patch_fixtures(id) ON DELETE CASCADE,
        offset     INTEGER NOT NULL,
        span       INTEGER NOT NULL DEFAULT 1,
        label      TEXT    NOT NULL DEFAULT '',
        icon       TEXT    NOT NULL DEFAULT 'par',
        PRIMARY KEY (fixture_id, offset)
      );

      -- Fixtures-page grid: item key ("<fixtureId>" or "<fixtureId>#<headOffset>") → cell.
      CREATE TABLE fixture_map_cells (
        item_key TEXT PRIMARY KEY,
        cell     INTEGER NOT NULL
      );

      -- Small JSON-encoded settings/state (active scenes, grid size).
      CREATE TABLE kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    importLegacyJson(db, ctx);
  },
  // 2 — scene favourites (pinned to the dashboard console).
  (db) => {
    db.exec("ALTER TABLE scenes ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0");
  },
  // 3 — sequences: recorded chases/effects, stored as a looping model (JSON, see
  // src/sequences/model.js).
  (db) => {
    db.exec(`
      CREATE TABLE sequences (
        id      TEXT PRIMARY KEY,
        label   TEXT    NOT NULL DEFAULT '',
        created INTEGER NOT NULL,          -- epoch ms
        model   TEXT    NOT NULL
      );
    `);
  },
];

function readLegacy(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")); // throws → migration rolls back
}

function importLegacyJson(db, ctx) {
  const { dataDir, logger } = ctx;
  const at = (k) => path.join(dataDir, LEGACY_FILES[k]);
  const api = queries(db);

  const scenes = readLegacy(at("scenes"));
  if (scenes) {
    for (const id of Object.keys(scenes)) {
      const v = scenes[id];
      // Oldest format stored just the data array.
      const scene = Array.isArray(v)
        ? { label: "", data: v }
        : { label: typeof v.label === "string" ? v.label : "", data: Array.isArray(v.data) ? v.data : [] };
      api.saveScene(id, scene);
    }
    logger.info(`Migrated ${Object.keys(scenes).length} scene(s) from ${LEGACY_FILES.scenes}`);
  }

  const state = readLegacy(at("state"));
  if (state && Array.isArray(state.activeScenes)) api.setActiveScenes(state.activeScenes.map(String));

  const patch = readLegacy(at("patch"));
  if (patch && Array.isArray(patch.fixtures)) {
    api.savePatch(patch);
    logger.info(`Migrated ${patch.fixtures.length} patched fixture(s) from ${LEGACY_FILES.patch}`);
  }

  const map = readLegacy(at("fixtureMap"));
  if (map) api.setFixtureMap(map);

  ctx.migratedFiles = Object.keys(LEGACY_FILES).map(at).filter((f) => fs.existsSync(f));
}

// Normalise a patch entry's per-channel arrays to exactly `channels` long.
function channelRows(fx) {
  const n = Math.max(0, fx.channels | 0);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const type = CHANNEL_TYPES.includes(fx.types && fx.types[i]) ? fx.types[i] : "level";
    rows.push({
      offset: i + 1,
      name: (fx.names && typeof fx.names[i] === "string" && fx.names[i]) || "",
      letter: (fx.letters && typeof fx.letters[i] === "string" && fx.letters[i]) || "",
      type,
      // A switch never fades — it's on or off.
      fade: type === "switch" ? 0 : fx.fade && fx.fade[i] === false ? 0 : 1,
    });
  }
  return rows;
}

function queries(db) {
  // Prepared on first use: the legacy import runs inside migration 1, before later
  // migrations have added the tables and columns some of these statements need.
  const sql = {
    scenes: "SELECT id, label, favourite FROM scenes",
    sceneUniverses: "SELECT scene_id, universe, dmx FROM scene_universes ORDER BY scene_id, universe",
    upsertScene: "INSERT INTO scenes (id, label) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label",
    clearSceneUniverses: "DELETE FROM scene_universes WHERE scene_id = ?",
    insertSceneUniverse: "INSERT INTO scene_universes (scene_id, universe, dmx) VALUES (?, ?, ?)",
    setLabel: "UPDATE scenes SET label = ? WHERE id = ?",
    setFavourite: "UPDATE scenes SET favourite = ? WHERE id = ?",
    deleteScene: "DELETE FROM scenes WHERE id = ?",

    kvGet: "SELECT value FROM kv WHERE key = ?",
    kvSet: "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",

    fixtures: "SELECT * FROM patch_fixtures ORDER BY position",
    channels: "SELECT * FROM patch_channels ORDER BY fixture_id, offset",
    heads: "SELECT * FROM patch_heads ORDER BY fixture_id, offset",
    clearFixtures: "DELETE FROM patch_fixtures",
    insertFixture: `
      INSERT INTO patch_fixtures
        (id, position, lib_id, manufacturer, name, label, mode, channel_count, universe, address, icon)
      VALUES (@id, @position, @libId, @manufacturer, @name, @label, @mode, @channels, @universe, @address, @icon)
    `,
    insertChannel: `
      INSERT INTO patch_channels (fixture_id, offset, name, letter, type, fade)
      VALUES (@fixtureId, @offset, @name, @letter, @type, @fade)
    `,
    insertHead: `
      INSERT INTO patch_heads (fixture_id, offset, span, label, icon)
      VALUES (@fixtureId, @offset, @span, @label, @icon)
    `,

    sequences: "SELECT id, label, created, model FROM sequences",
    insertSequence: "INSERT INTO sequences (id, label, created, model) VALUES (?, ?, ?, ?)",
    setSequenceLabel: "UPDATE sequences SET label = ? WHERE id = ?",
    deleteSequence: "DELETE FROM sequences WHERE id = ?",

    mapCells: "SELECT item_key, cell FROM fixture_map_cells",
    clearMapCells: "DELETE FROM fixture_map_cells",
    insertMapCell: "INSERT INTO fixture_map_cells (item_key, cell) VALUES (?, ?)",
  };
  const prepared = {};
  const q = new Proxy(prepared, { get: (cache, key) => (cache[key] ||= db.prepare(sql[key])) });

  const kvGet = (key, fallback) => {
    const row = q.kvGet.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch (_) {
      return fallback;
    }
  };
  const kvSet = (key, value) => q.kvSet.run(key, JSON.stringify(value));

  return {
    // scenes[id] = { label, favourite, data } — data is array(universe) of arrays(channel), as the engine uses.
    loadScenes() {
      const scenes = {};
      for (const r of q.scenes.all()) scenes[r.id] = { label: r.label, favourite: r.favourite === 1, data: [] };
      for (const r of q.sceneUniverses.all()) {
        const s = scenes[r.scene_id];
        if (s) s.data[r.universe] = Array.from(r.dmx);
      }
      // Fill any gaps (a universe never recorded) so data stays a dense array.
      for (const s of Object.values(scenes)) for (let u = 0; u < s.data.length; u++) s.data[u] ||= [];
      return scenes;
    },

    saveScene: db.transaction((id, scene) => {
      q.upsertScene.run(String(id), scene.label || "");
      q.clearSceneUniverses.run(String(id));
      (scene.data || []).forEach((row, u) => {
        if (Array.isArray(row) || ArrayBuffer.isView(row)) {
          q.insertSceneUniverse.run(String(id), u, Buffer.from(Uint8Array.from(row)));
        }
      });
    }),

    setSceneLabel(id, label) {
      q.setLabel.run(label || "", String(id));
    },

    setSceneFavourite(id, favourite) {
      q.setFavourite.run(favourite ? 1 : 0, String(id));
    },

    deleteScene(id) {
      q.deleteScene.run(String(id));
    },

    getActiveScenes() {
      const ids = kvGet("activeScenes", []);
      return Array.isArray(ids) ? ids.map(String) : [];
    },

    setActiveScenes(ids) {
      kvSet("activeScenes", ids);
    },

    // sequences[id] = { label, created, model } — model as stored (see src/sequences/model.js).
    loadSequences() {
      const out = {};
      for (const r of q.sequences.all()) {
        try {
          out[r.id] = { label: r.label, created: r.created, model: JSON.parse(r.model) };
        } catch (_) {
          /* unreadable row: skip it rather than fail to start */
        }
      }
      return out;
    },

    insertSequence(id, { label, created, model }) {
      q.insertSequence.run(String(id), label || "", created, JSON.stringify(model));
    },

    setSequenceLabel(id, label) {
      q.setSequenceLabel.run(label || "", String(id));
    },

    deleteSequence(id) {
      q.deleteSequence.run(String(id));
    },

    getActiveSequences() {
      const ids = kvGet("activeSequences", []);
      return Array.isArray(ids) ? ids.map(String) : [];
    },

    setActiveSequences(ids) {
      kvSet("activeSequences", ids);
    },

    // The desk look being held after the desk went away (array of per-universe
    // byte arrays), or null. Stored base64 per universe to keep the row small.
    getHeldLook() {
      const v = kvGet("heldLook", null);
      return Array.isArray(v) ? v.map((b64) => Uint8Array.from(Buffer.from(b64 || "", "base64"))) : null;
    },

    setHeldLook(universes) {
      if (!universes) return void kvSet("heldLook", null);
      kvSet("heldLook", universes.map((u) => Buffer.from(Uint8Array.from(u)).toString("base64")));
    },

    // Patch in the API shape: { fixtures: [{ id, libId, …, fade[], letters[], names[], types[], heads? }] }
    loadPatch() {
      const channels = {};
      for (const c of q.channels.all()) (channels[c.fixture_id] ||= []).push(c);
      const heads = {};
      for (const h of q.heads.all()) (heads[h.fixture_id] ||= []).push(h);

      const fixtures = q.fixtures.all().map((f) => {
        const chans = channels[f.id] || [];
        const byOffset = (key, fallback) =>
          Array.from({ length: f.channel_count }, (_, i) => {
            const c = chans.find((x) => x.offset === i + 1);
            return c ? key(c) : fallback;
          });
        const fx = {
          id: f.id,
          libId: f.lib_id,
          manufacturer: f.manufacturer,
          name: f.name,
          label: f.label,
          mode: f.mode,
          channels: f.channel_count,
          universe: f.universe,
          address: f.address,
          fade: byOffset((c) => c.fade === 1, true),
          letters: byOffset((c) => c.letter, ""),
          names: byOffset((c) => c.name, ""),
          types: byOffset((c) => c.type, "level"),
          icon: f.icon || undefined,
        };
        if (heads[f.id]) {
          fx.heads = heads[f.id].map((h) => ({ offset: h.offset, span: h.span, label: h.label, icon: h.icon }));
        }
        return fx;
      });
      return { fixtures };
    },

    // Replace the whole patch (it's small, and edits arrive as a full patch).
    savePatch: db.transaction((patch) => {
      q.clearFixtures.run(); // cascades to channels + heads
      (patch.fixtures || []).forEach((fx, position) => {
        q.insertFixture.run({
          id: String(fx.id),
          position,
          libId: Number.isInteger(fx.libId) ? fx.libId : null,
          manufacturer: fx.manufacturer || "",
          name: fx.name || "",
          label: fx.label || "",
          mode: fx.mode || "",
          channels: Math.max(0, fx.channels | 0),
          universe: fx.universe | 0,
          address: Math.max(1, fx.address | 0),
          icon: fx.icon || null,
        });
        for (const c of channelRows(fx)) q.insertChannel.run({ fixtureId: String(fx.id), ...c });
        const seen = new Set();
        for (const h of fx.heads || []) {
          const offset = Math.max(1, h.offset | 0);
          if (seen.has(offset)) continue;
          seen.add(offset);
          q.insertHead.run({
            fixtureId: String(fx.id),
            offset,
            span: Math.max(1, h.span | 0 || 1),
            label: h.label || "",
            icon: h.icon || "par",
          });
        }
      });
    }),

    getFixtureMap() {
      const size = kvGet("fixtureMapSize", { cols: 25, rows: 25 });
      const cells = {};
      for (const r of q.mapCells.all()) cells[r.item_key] = r.cell;
      return { cols: size.cols || 25, rows: size.rows || 25, cells };
    },

    setFixtureMap: db.transaction((map) => {
      kvSet("fixtureMapSize", { cols: map.cols || 25, rows: map.rows || 25 });
      q.clearMapCells.run();
      for (const [key, cell] of Object.entries(map.cells || {})) {
        if (Number.isInteger(cell)) q.insertMapCell.run(key, cell);
      }
    }),
  };
}

function openAppDb(file, { dataDir, logger }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");

  const ctx = { dataDir, logger, migratedFiles: [] };
  const from = db.pragma("user_version", { simple: true });
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db, ctx);
      db.pragma(`user_version = ${v + 1}`);
    })();
    logger.info(`Database migrated to v${v + 1} (${file})`);
  }
  // Only once the import has committed: keep the old files, but out of the way.
  for (const f of ctx.migratedFiles) {
    fs.renameSync(f, `${f}.migrated`);
    logger.info(`Legacy ${path.basename(f)} imported → renamed to ${path.basename(f)}.migrated`);
  }

  return { ...queries(db), close: () => db.close() };
}

module.exports = { openAppDb, CHANNEL_TYPES };
