// HTTP + WebSocket API for the web UI.
//
// - Serves the built UI from ui/dist (SPA fallback to index.html).
// - GET /api/health, GET /api/state — JSON snapshots.
// - WS /ws — pushes engine.getState() to each client a few times a second.
//
// One process: this shares the engine's event loop, so the realtime DMX work and
// the web server coexist in the single systemd service.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const store = require("./store");
const { buildFromText, buildConfig, loadGrouped, serializeConfig } = require("./config");
const lib = require("./fixtures/library");
const { importLibraryInWorker, sevenZipStatus } = require("./fixtures/import");
const { CHANNEL_TYPES } = require("./db");
const { buildModel, previewModel } = require("./sequences/model");

// Coerce the numeric fields of a grouped config object (the form sends some as
// strings). Mutates and returns the object.
function coerceConfigNumbers(g) {
  const num = (v) => (v === "" || v === null || v === undefined ? v : Number(v));
  if (g.console) {
    g.console.timeoutMs = num(g.console.timeoutMs);
    g.console.defaultFade = num(g.console.defaultFade);
  }
  if (g.artnet) {
    g.artnet.port = num(g.artnet.port);
    g.artnet.universes = num(g.artnet.universes);
    g.artnet.channels = num(g.artnet.channels);
    if (Array.isArray(g.artnet.outputs)) {
      for (const o of g.artnet.outputs) {
        if (o.port !== undefined && o.port !== "") o.port = num(o.port);
        if (Array.isArray(o.universes)) o.universes = o.universes.map(num);
      }
    }
  }
  if (g.companion) {
    g.companion.listenPort = num(g.companion.listenPort);
    if (Array.isArray(g.companion.feedbackTargets)) {
      for (const t of g.companion.feedbackTargets) t.port = num(t.port);
    }
    if (g.companion.customVariables) g.companion.customVariables.port = num(g.companion.customVariables.port);
  }
  if (g.timing) {
    for (const k of Object.keys(g.timing)) g.timing[k] = num(g.timing[k]);
  }
  if (g.web) g.web.port = num(g.web.port);
  return g;
}

const ROOT = path.resolve(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui", "dist");
// The Companion module package, built by `npm run build` (scripts/build-companion.js).
const COMPANION_DIR = path.join(ROOT, "companion");
const COMPANION_PKG = path.join(COMPANION_DIR, "lightit.tgz");

// Module version + whether a package is available to download.
function companionModuleInfo() {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(COMPANION_DIR, "package.json"), "utf8")).version;
  } catch (_) {
    /* not shipped */
  }
  const available = fs.existsSync(COMPANION_PKG);
  return { version, available, size: available ? fs.statSync(COMPANION_PKG).size : 0, file: `companion-module-lightit-${version || "latest"}.tgz` };
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function createApi(config, logger, engine, artnetIn, recorder) {
  // Lazily-opened fixture library (only if a fixtures.db exists).
  let db = null;
  let libCount = 0;
  function library() {
    if (db) return db;
    if (fs.existsSync(config.fixturesDb)) {
      try {
        db = lib.openLibrary(config.fixturesDb);
        libCount = lib.count(db);
        relinkPatch(db);
      } catch (err) {
        logger.error("Open fixtures.db failed:", err.message);
      }
    }
    return db;
  }

  // Library row ids change on every import (and differ between machines), so each
  // time a library is opened, re-point patched fixtures at their personality by
  // manufacturer + name + mode. Fixtures this library doesn't contain are unlinked
  // (libId null) rather than left pointing at whatever now has their old id; their
  // channels still work from the patch, and a later import that has them relinks.
  function relinkPatch(l) {
    const patch = engine.getPatch();
    let changed = 0;
    let missing = 0;
    for (const fx of patch.fixtures) {
      if (fx.libId == null && fx.manufacturer === "Generic" && fx.name === "Dimmer pack") continue; // built-in
      const id = lib.findMatch(l, { manufacturer: fx.manufacturer, name: fx.name, mode: fx.mode, idHint: fx.libId });
      if (id === null) missing++;
      if (id !== fx.libId) {
        fx.libId = id;
        changed++;
      }
    }
    if (changed) {
      engine.setPatch(patch);
      logger.info(`Fixture library: relinked ${changed} patched fixture(s)${missing ? `, ${missing} not in this library` : ""}`);
    }
  }

  library(); // open at startup if present

  let importState = { running: false, phase: null, done: 0, total: 0, error: null };

  function fixturesStatus() {
    const z = sevenZipStatus();
    return {
      sevenZip: z.available,
      sevenZipHint: z.hint,
      libraryCount: libCount,
      import: importState,
    };
  }

  // The full snapshot pushed to clients = engine state + fixtures/import status.
  function snapshot() {
    return { ...engine.getState(), fixtures: fixturesStatus(), artnetSenders: artnetIn ? artnetIn.getSenders() : [] };
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/api/health") return sendJson(res, { ok: true });
    if (url === "/api/state") return sendJson(res, snapshot());

    // ---- Companion ----
    // GET /api/companion/state — the compact snapshot the Companion module polls.
    if (url === "/api/companion/state" && req.method === "GET") {
      const s = engine.getState();
      const pick = (x) => ({ id: x.id, label: x.label, on: x.on, state: x.state, level: x.level, fadeRemaining: x.fadeRemaining });
      return sendJson(res, {
        app: "Light It",
        desk: { live: s.consoleActive, holding: s.holding, override: s.consoleOverride, detected: s.desk.detected, ip: s.desk.ip },
        output: s.controllerOutput,
        locked: s.consoleActive || !!s.editing || !!s.programmerActive,
        fade: s.fade,
        scenes: s.scenes.map(pick),
        sequences: s.sequences.map(pick),
      });
    }
    // GET /api/companion/module — module version / download availability.
    if (url === "/api/companion/module" && req.method === "GET") {
      return sendJson(res, companionModuleInfo());
    }
    // GET /companion/lightit.tgz — the module package, for Companion's "Import module".
    if (url === "/companion/lightit.tgz" && (req.method === "GET" || req.method === "HEAD")) {
      const info = companionModuleInfo();
      if (!info.available) return badRequest(res, "Companion module not built — run npm run build", 404);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${info.file}"`,
        "Content-Length": info.size,
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") return void res.end();
      return void fs.createReadStream(COMPANION_PKG).pipe(res);
    }

    // POST /api/command { address, args } — routed through the same handler as OSC,
    // so the UI drives scenes exactly like a Companion button does.
    if (url === "/api/command" && req.method === "POST") {
      return readBody(req, res, (b) => {
        if (typeof b.address !== "string") return badRequest(res, "address required");
        engine.handleOsc({ address: b.address, args: Array.isArray(b.args) ? b.args : [] });
        sendJson(res, { ok: true });
      });
    }

    // POST /api/scenes { label } — create an empty scene, returns its id.
    if (url === "/api/scenes" && req.method === "POST") {
      return readBody(req, res, (b) => {
        const id = engine.createScene(typeof b.label === "string" ? b.label : "");
        sendJson(res, { ok: true, id });
      });
    }

    // POST /api/scenes/<id>/label { label } — rename a scene.
    const labelMatch = url.match(/^\/api\/scenes\/([^/]+)\/label$/);
    if (labelMatch && req.method === "POST") {
      const id = decodeURIComponent(labelMatch[1]);
      return readBody(req, res, (b) => {
        const ok = engine.setSceneLabel(id, typeof b.label === "string" ? b.label : "");
        if (!ok) return badRequest(res, `scene ${id} not found`, 404);
        sendJson(res, { ok: true });
      });
    }

    // POST /api/scenes/<id>/favourite { favourite } — pin/unpin on the dashboard.
    const favMatch = url.match(/^\/api\/scenes\/([^/]+)\/favourite$/);
    if (favMatch && req.method === "POST") {
      const id = decodeURIComponent(favMatch[1]);
      return readBody(req, res, (b) => {
        const ok = engine.setSceneFavourite(id, !!b.favourite);
        if (!ok) return badRequest(res, `scene ${id} not found`, 404);
        sendJson(res, { ok: true });
      });
    }

    // ---- Sequences ----
    // POST /api/sequences/record/start { autoStop? } — begin capturing the desk.
    if (url === "/api/sequences/record/start" && req.method === "POST") {
      return readBody(req, res, (b) => {
        try {
          recorder.start({ autoStop: b.autoStop !== false });
          sendJson(res, { ok: true });
        } catch (err) {
          badRequest(res, err.message);
        }
      });
    }
    // POST /api/sequences/record/stop — stop and analyse; resolves with the draft summary.
    if (url === "/api/sequences/record/stop" && req.method === "POST") {
      recorder
        .stop()
        .then((draft) => sendJson(res, { ok: true, draft }))
        .catch((err) => badRequest(res, err.message));
      return;
    }
    // POST /api/sequences/record/auto-stop { autoStop }
    if (url === "/api/sequences/record/auto-stop" && req.method === "POST") {
      return readBody(req, res, (b) => {
        recorder.setAutoStop(!!b.autoStop);
        sendJson(res, { ok: true });
      });
    }
    // POST /api/sequences/record/discard — throw away the take / draft.
    if (url === "/api/sequences/record/discard" && req.method === "POST") {
      recorder.discard();
      return sendJson(res, { ok: true });
    }
    // POST /api/sequences { label, groups?: string[], includeStill? } — save the reviewed draft.
    if (url === "/api/sequences" && req.method === "POST") {
      return readBody(req, res, (b) => {
        const draft = recorder.getDraft();
        if (!draft) return badRequest(res, "No recorded sequence to save");
        const model = buildModel(draft, {
          groups: Array.isArray(b.groups) ? b.groups.map(String) : undefined,
          includeStill: b.includeStill !== false,
        });
        if (!model.motion.length && !model.still.length) return badRequest(res, "Nothing selected to save");
        const id = engine.createSequence(typeof b.label === "string" ? b.label.trim() : "", model);
        recorder.discard();
        sendJson(res, { ok: true, id });
      });
    }
    const seqLabel = url.match(/^\/api\/sequences\/([^/]+)\/label$/);
    if (seqLabel && req.method === "POST") {
      const id = decodeURIComponent(seqLabel[1]);
      return readBody(req, res, (b) => {
        if (!engine.setSequenceLabel(id, typeof b.label === "string" ? b.label : "")) {
          return badRequest(res, `sequence ${id} not found`, 404);
        }
        sendJson(res, { ok: true });
      });
    }
    // GET /api/sequences/<id>/preview — effect shapes for the loop dials.
    const seqPreview = url.match(/^\/api\/sequences\/([^/]+)\/preview$/);
    if (seqPreview && req.method === "GET") {
      const model = engine.getSequenceModel(decodeURIComponent(seqPreview[1]));
      if (!model) return badRequest(res, "sequence not found", 404);
      return sendJson(res, previewModel(model));
    }
    const seqOne = url.match(/^\/api\/sequences\/([^/]+)$/);
    if (seqOne && req.method === "DELETE") {
      const id = decodeURIComponent(seqOne[1]);
      if (!engine.deleteSequence(id)) return badRequest(res, `sequence ${id} not found`, 404);
      return sendJson(res, { ok: true });
    }

    // GET/POST /api/scenes/<id>/raw — read or replace the stored { label, data }.
    const rawMatch = url.match(/^\/api\/scenes\/([^/]+)\/raw$/);
    if (rawMatch) {
      const id = decodeURIComponent(rawMatch[1]);
      if (req.method === "GET") {
        const raw = engine.getSceneRaw(id);
        if (!raw) return badRequest(res, `scene ${id} not found`, 404);
        return sendJson(res, raw);
      }
      if (req.method === "POST") {
        return readBody(req, res, (b) => {
          let obj;
          try {
            obj = typeof b.raw === "string" ? JSON.parse(b.raw) : b.raw;
          } catch (err) {
            return badRequest(res, `Invalid JSON: ${err.message}`);
          }
          try {
            engine.setSceneRaw(id, obj);
            sendJson(res, { ok: true });
          } catch (err) {
            badRequest(res, err.message);
          }
        });
      }
    }

    // DELETE /api/scenes/<id>
    const idMatch = url.match(/^\/api\/scenes\/([^/]+)$/);
    if (idMatch && req.method === "DELETE") {
      const id = decodeURIComponent(idMatch[1]);
      const ok = engine.deleteScene(id);
      if (!ok) return badRequest(res, `scene ${id} not found`, 404);
      return sendJson(res, { ok: true });
    }

    // GET /api/config — raw config text. POST /api/config { text } — validate + save.
    if (url === "/api/config" && req.method === "GET") {
      const text = fs.existsSync(config.configPath)
        ? fs.readFileSync(config.configPath, "utf8")
        : "";
      return sendJson(res, { text, path: config.configPath });
    }
    if (url === "/api/config" && req.method === "POST") {
      return readBody(req, res, (b) => {
        if (typeof b.text !== "string") return badRequest(res, "text required");
        try {
          buildFromText(b.text); // throws on parse/validation error
        } catch (err) {
          return badRequest(res, err.message);
        }
        store.writeTextAtomic(config.configPath, b.text);
        logger.info("Config saved via web UI (raw)");
        sendJson(res, { ok: true });
      });
    }

    // GET /api/config/form — grouped object for the form editor.
    if (url === "/api/config/form" && req.method === "GET") {
      return sendJson(res, loadGrouped());
    }
    // POST /api/config/form { config } — validate, serialise to JSONC, save.
    if (url === "/api/config/form" && req.method === "POST") {
      return readBody(req, res, (b) => {
        if (!b.config || typeof b.config !== "object") return badRequest(res, "config required");
        const g = coerceConfigNumbers(b.config);
        let text;
        try {
          buildConfig(g); // validate the object
          text = serializeConfig(g);
          buildFromText(text); // belt-and-braces: validate the rendered text too
        } catch (err) {
          return badRequest(res, err.message);
        }
        store.writeTextAtomic(config.configPath, text);
        logger.info("Config saved via web UI (form)");
        sendJson(res, { ok: true });
      });
    }

    // POST /api/restart — in production, exit so the service manager (systemd,
    // NODE_ENV=production) restarts us with the new config. In dev we must NOT
    // exit: `node --watch` only restarts on file changes, so exiting would leave
    // the dev server down — restart `npm run dev` manually instead.
    if (url === "/api/restart" && req.method === "POST") {
      const isProd = process.env.NODE_ENV === "production";
      sendJson(res, { ok: true, restarting: isProd });
      if (isProd) {
        logger.info("Restart requested via web UI — exiting for the service manager");
        setTimeout(() => process.exit(0), 150);
      }
      return;
    }

    // ---- Art-Net network ----
    // GET /api/artnet/nodes — discovered nodes, current ArtDMX senders, our interfaces.
    if (url === "/api/artnet/nodes" && req.method === "GET") {
      return sendJson(res, artnetIn.getNodes());
    }
    // POST /api/artnet/discover — broadcast ArtPoll, collect replies for ~3s, return them.
    if (url === "/api/artnet/discover" && req.method === "POST") {
      const targets = artnetIn.poll();
      setTimeout(() => sendJson(res, { ...artnetIn.getNodes(), polled: targets }), 3000);
      return;
    }

    // ---- Fixture library ----
    if (url === "/api/fixtures/status" && req.method === "GET") {
      return sendJson(res, fixturesStatus());
    }

    if (url === "/api/fixtures/search" && req.method === "GET") {
      const l = library();
      if (!l) return sendJson(res, { results: [] });
      let q = "";
      try {
        q = new URL(req.url, "http://x").searchParams.get("q") || "";
      } catch (_) {
        /* ignore */
      }
      return sendJson(res, { results: lib.search(l, q, 100) });
    }

    const fxMatch = url.match(/^\/api\/fixtures\/(\d+)$/);
    if (fxMatch && req.method === "GET") {
      const l = library();
      const fx = l && lib.get(l, Number(fxMatch[1]));
      if (!fx) return badRequest(res, "fixture not found", 404);
      return sendJson(res, fx);
    }

    // POST /api/fixtures/import — stream the uploaded .exe to disk, then import.
    if (url === "/api/fixtures/import" && req.method === "POST") {
      if (importState.running) return badRequest(res, "An import is already running");
      const z = sevenZipStatus();
      if (!z.available) return badRequest(res, z.hint || "7-Zip not available");
      const tmpExe = path.join(os.tmpdir(), `fixlib-upload-${Date.now()}.exe`);
      // Marked running from the start of the upload, so a second one can't begin mid-transfer.
      importState = { running: true, phase: "uploading", done: 0, total: 0, error: null };
      const failUpload = (message) => {
        importState = { running: false, phase: "error", done: 0, total: 0, error: message };
        fs.rmSync(tmpExe, { force: true });
      };
      const out = fs.createWriteStream(tmpExe);
      req.pipe(out);
      req.on("error", () => {
        try {
          out.destroy();
        } catch (_) {
          /* ignore */
        }
        failUpload("Upload interrupted");
      });
      req.on("aborted", () => failUpload("Upload interrupted"));
      out.on("error", (e) => {
        failUpload(e.message);
        badRequest(res, e.message);
      });
      out.on("finish", async () => {
        if (req.aborted) return;
        importState = { running: true, phase: "starting", done: 0, total: 0, error: null };
        if (db) {
          try {
            db.close();
          } catch (_) {
            /* ignore */
          }
          db = null;
        }
        try {
          const result = await importLibraryInWorker(tmpExe, config.fixturesDb, (p) => {
            importState = { running: true, phase: p.phase, done: p.done || 0, total: p.total || 0, error: null };
          });
          library();
          libCount = db ? lib.count(db) : 0;
          importState = { running: false, phase: "done", done: result.count, total: result.total, error: null };
          logger.info(`Fixture library imported: ${result.count} fixtures (${result.failed} skipped)`);
          sendJson(res, { ok: true, result });
        } catch (e) {
          importState = { running: false, phase: "error", done: 0, total: 0, error: e.message };
          badRequest(res, e.message);
        } finally {
          fs.rmSync(tmpExe, { force: true });
        }
      });
      return;
    }

    // ---- Patch ----
    if (url === "/api/patch" && req.method === "GET") {
      return sendJson(res, engine.getPatch());
    }

    if (url === "/api/fixture-map" && req.method === "GET") {
      return sendJson(res, engine.getFixtureMap());
    }
    if (url === "/api/fixture-map" && req.method === "POST") {
      return readBody(req, res, (b) => sendJson(res, engine.setFixtureMap(b)));
    }

    if (url === "/api/programmer/set" && req.method === "POST") {
      return readBody(req, res, (b) => {
        engine.programmerSet(Array.isArray(b.updates) ? b.updates : []);
        sendJson(res, { ok: true });
      });
    }
    if (url === "/api/programmer/clear" && req.method === "POST") {
      engine.programmerClear();
      return sendJson(res, { ok: true });
    }
    if (url === "/api/programmer/load" && req.method === "POST") {
      return readBody(req, res, (b) => {
        const ok = engine.programmerLoadScene(String(b.sceneId));
        if (!ok) return badRequest(res, "scene not found", 404);
        sendJson(res, { ok: true });
      });
    }
    if (url === "/api/programmer/save" && req.method === "POST") {
      return readBody(req, res, (b) => {
        const id = engine.programmerSaveToScene(b || {});
        if (!id) return badRequest(res, "nothing in the programmer, or scene not found");
        sendJson(res, { ok: true, id });
      });
    }

    // POST /api/patch/add — either { libId, mode } from the fixture library, or
    // { builtin: "dimmer", channels, switched? } for a generic dimmer pack (no library
    // needed; the last `switched` channels are hot power). Both take
    // { universe, address, label?, count? }.
    if (url === "/api/patch/add" && req.method === "POST") {
      return readBody(req, res, (b) => {
        let template;
        if (b.builtin === "dimmer") {
          template = dimmerPackTemplate(b.channels, b.switched);
          if (!template) return badRequest(res, `channels must be 1–${config.channels}, switched 0–channels`);
        } else {
          const l = library();
          if (!l) return badRequest(res, "No fixture library imported");
          const fx = lib.get(l, Number(b.libId));
          if (!fx) return badRequest(res, "fixture not found", 404);
          const mode = (fx.modes || []).find((m) => m.name === b.mode) || (fx.modes || [])[0];
          if (!mode) return badRequest(res, "fixture has no modes");
          const fade = lib.channelFade(mode);
          const channels = mode.channels || fade.length || 1;
          template = {
            libId: fx.id,
            manufacturer: fx.manufacturer,
            name: fx.name,
            mode: mode.name,
            channels,
            fade,
            letters: lib.channelLetters(mode),
            names: lib.channelNames(mode),
            types: new Array(channels).fill("level"),
            icon: guessIcon(fx),
            heads: computeHeads(mode), // null unless it's a multi-dimmer
          };
        }
        const { channels, heads } = template;
        const baseLabel = typeof b.label === "string" && b.label ? b.label : template.name;
        const count = Math.max(1, Math.min(512, b.count | 0 || 1));

        if (channels > config.channels) return badRequest(res, "Fixture is larger than one universe");

        const patch = engine.getPatch();
        let u = b.universe | 0;
        let addr = Math.max(1, b.address | 0);
        let added = 0;
        for (let i = 0; i < count; i++) {
          if (addr + channels - 1 > config.channels) {
            u++;
            addr = 1;
          }
          if (u >= config.universes) break; // out of universes
          patch.fixtures.push({
            ...template,
            id: crypto.randomUUID(),
            label: count > 1 ? `${baseLabel} ${i + 1}` : baseLabel,
            universe: u,
            address: addr,
            // own copies so per-channel overrides are independent
            fade: [...template.fade],
            types: [...template.types],
            heads: heads ? heads.map((h) => ({ ...h })) : undefined,
          });
          addr += channels;
          added++;
        }
        engine.setPatch(patch);
        sendJson(res, { ...engine.getPatch(), added });
      });
    }

    const patchOne = url.match(/^\/api\/patch\/([^/]+)$/);
    if (patchOne && req.method === "POST") {
      const id = decodeURIComponent(patchOne[1]);
      return readBody(req, res, (b) => {
        const patch = engine.getPatch();
        const fx = patch.fixtures.find((f) => f.id === id);
        if (!fx) return badRequest(res, "patched fixture not found", 404);
        if (b.universe !== undefined) fx.universe = b.universe | 0;
        if (b.address !== undefined) fx.address = Math.max(1, b.address | 0);
        if (typeof b.label === "string") fx.label = b.label;
        if (Array.isArray(b.fade)) fx.fade = b.fade.map((x) => x !== false);
        // channels: [{ type, fade, name? }] per channel, in offset order.
        if (Array.isArray(b.channels)) {
          const bad = b.channels.findIndex((c) => c && c.type !== undefined && !CHANNEL_TYPES.includes(c.type));
          if (bad >= 0) return badRequest(res, `channel ${bad + 1}: type must be one of ${CHANNEL_TYPES.join(", ")}`);
          for (let i = 0; i < fx.channels; i++) {
            const c = b.channels[i];
            if (!c) continue;
            const was = fx.types[i];
            if (c.type) fx.types[i] = c.type;
            if (typeof c.fade === "boolean") fx.fade[i] = c.fade;
            if (typeof c.name === "string") fx.names[i] = c.name;
            // Keep default names and a head's icon in step with the channel type
            // (anything the user has customised is left alone).
            const head = (fx.heads || []).find((h) => h.offset === i + 1 && h.span === 1);
            if (was !== fx.types[i]) {
              const toSwitch = fx.types[i] === "switch";
              const [from, to] = toSwitch ? ["Dimmer", "Power"] : ["Power", "Dimmer"];
              const renamed = (s) => (s === `${from} ${i + 1}` ? `${to} ${i + 1}` : s);
              if (typeof c.name !== "string") fx.names[i] = renamed(fx.names[i]);
              if (head) {
                head.label = renamed(head.label);
                if (toSwitch && head.icon === "par") head.icon = "power";
                else if (!toSwitch && head.icon === "power") head.icon = "par";
              }
            }
            if (was !== fx.types[i]) {
              if (fx.types[i] === "switch") fx.letters[i] = "⏻";
              else if (fx.letters[i] === "⏻") fx.letters[i] = "D";
            }
          }
        }
        if (typeof b.icon === "string") fx.icon = b.icon;
        if (b.heads === null) fx.heads = undefined; // merge back to a single head
        else if (Array.isArray(b.heads)) {
          fx.heads = b.heads.map((h) => ({
            offset: Math.max(1, h.offset | 0),
            span: Math.max(1, h.span | 0 || 1),
            label: typeof h.label === "string" ? h.label : "",
            icon: typeof h.icon === "string" ? h.icon : "par",
          }));
        }
        engine.setPatch(patch);
        sendJson(res, engine.getPatch());
      });
    }
    if (patchOne && req.method === "DELETE") {
      const id = decodeURIComponent(patchOne[1]);
      const patch = engine.getPatch();
      patch.fixtures = patch.fixtures.filter((f) => f.id !== id);
      engine.setPatch(patch);
      return sendJson(res, engine.getPatch());
    }

    // ---- Scene editor (live programmer) ----
    if (url === "/api/scene-edit/begin" && req.method === "POST") {
      return readBody(req, res, (b) => {
        const ok = engine.editBegin(String(b.sceneId));
        if (!ok) return badRequest(res, "scene not found", 404);
        sendJson(res, { ok: true });
      });
    }
    if (url === "/api/scene-edit/set" && req.method === "POST") {
      return readBody(req, res, (b) => {
        engine.editSet(Array.isArray(b.updates) ? b.updates : []);
        sendJson(res, { ok: true });
      });
    }
    if (url === "/api/scene-edit/save" && req.method === "POST") {
      const ok = engine.editSave();
      return ok ? sendJson(res, { ok: true }) : badRequest(res, "not editing");
    }
    if (url === "/api/scene-edit/end" && req.method === "POST") {
      engine.editEnd();
      return sendJson(res, { ok: true });
    }

    serveStatic(url, res);
  });

  // Best-guess default icon from the fixture name (user can override in Patch).
  function guessIcon(fx) {
    const s = `${fx.manufacturer || ""} ${fx.name || ""}`.toLowerCase();
    if (/chandelier/.test(s)) return "chandelier";
    if (/\bbeam\b/.test(s)) return "beam";
    if (/wash/.test(s) && /(moving|head|zoom|yoke)/.test(s)) return "wash";
    if (/(moving\s*head|spot|profile|hybrid|yoke)/.test(s)) return "beam";
    if (/(tape|strip|pixel|batten|\bbar\b)/.test(s)) return "led-tape";
    if (/(panel|blinder|flood|matrix|\bpar\b|wash)/.test(s)) return /par/.test(s) ? "par" : "led-panel";
    return "par";
  }

  // A generic N-channel dimmer pack, split into one head per channel. The last
  // `switched` channels are on/off hot power; the rest are dimmed. Any channel can
  // be changed later in the patch's channel editor.
  function dimmerPackTemplate(n, switched = 0) {
    const channels = Number(n);
    const nSwitched = Number(switched) || 0;
    if (!Number.isInteger(channels) || channels < 1 || channels > config.channels) return null;
    if (!Number.isInteger(nSwitched) || nSwitched < 0 || nSwitched > channels) return null;
    const offsets = Array.from({ length: channels }, (_, i) => i + 1);
    const isSwitch = (o) => o > channels - nSwitched;
    const nameOf = (o) => `${isSwitch(o) ? "Power" : "Dimmer"} ${o}`;
    return {
      libId: null,
      manufacturer: "Generic",
      name: "Dimmer pack",
      mode: `${channels} ch`,
      channels,
      fade: offsets.map((o) => !isSwitch(o)),
      letters: offsets.map((o) => (isSwitch(o) ? "⏻" : "D")),
      names: offsets.map(nameOf),
      types: offsets.map((o) => (isSwitch(o) ? "switch" : "level")),
      icon: "par",
      heads: offsets.map((o) => ({ offset: o, span: 1, label: nameOf(o), icon: isSwitch(o) ? "power" : "par" })),
    };
  }

  // If every channel of a mode is an independent single-channel dimmer (a dimmer
  // pack / multi-dimmer), return one head per channel; otherwise null.
  function computeHeads(mode) {
    const attrs = (mode.attrs || []).filter((a) => a.offsets && a.offsets.length);
    const seen = new Set();
    const uniq = [];
    for (const a of attrs) {
      const k = a.offsets.join(",");
      if (!seen.has(k)) {
        seen.add(k);
        uniq.push(a);
      }
    }
    const dimmers = uniq.filter(
      (a) => !a.functions && a.offsets.length === 1 && (a.group === "I" || /dim/i.test(a.name))
    );
    const chans = mode.channels || uniq.length;
    if (dimmers.length > 1 && dimmers.length === chans) {
      return dimmers
        .slice()
        .sort((a, b) => a.offsets[0] - b.offsets[0])
        .map((a, i) => ({ offset: a.offsets[0], span: 1, label: `Dimmer ${i + 1}`, icon: "par" }));
    }
    return null;
  }

  function badRequest(res, error, code = 400) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error }));
  }

  function readBody(req, res, handler) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        handler(JSON.parse(body || "{}"));
      } catch (err) {
        badRequest(res, err.message);
      }
    });
  }

  function sendJson(res, obj) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  function serveStatic(url, res) {
    if (!fs.existsSync(UI_DIR)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(
        "<h1>Light It</h1><p>UI not built. Run <code>npm run ui:build</code>.</p>"
      );
    }
    const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    let file = path.join(UI_DIR, rel);
    // Block path traversal; fall back to index.html for SPA routes / missing files.
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(UI_DIR, "index.html");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      const headers = { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" };
      // Hashed assets are immutable; index.html must always be revalidated so a
      // new build's bundle is picked up immediately (no stale cached HTML).
      if (file.endsWith("index.html")) headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      else if (file.includes(`${path.sep}assets${path.sep}`)) headers["Cache-Control"] = "public, max-age=31536000, immutable";
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    const push = () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshot()));
    };
    push(); // immediate snapshot
    const interval = setInterval(push, 100); // ~10 Hz — smooth enough for the level bars
    ws.on("close", () => clearInterval(interval));
    ws.on("error", () => clearInterval(interval));
  });
  wss.on("error", (err) => logger.error("WS server error:", err.message));

  // Binary DMX feed for the universe grid — only streamed while a client (the
  // Universes page) is connected. One frame = all universes concatenated, raw bytes.
  const wssDmx = new WebSocketServer({ noServer: true });
  wssDmx.on("connection", (ws) => {
    const push = () => {
      if (ws.readyState !== ws.OPEN) return;
      const dmx = engine.getDmx();
      const u = dmx.length;
      const c = u ? dmx[0].length : 0;
      const buf = Buffer.allocUnsafe(u * c);
      for (let i = 0; i < u; i++) {
        Buffer.from(dmx[i].buffer, dmx[i].byteOffset, dmx[i].length).copy(buf, i * c);
      }
      ws.send(buf);
    };
    push();
    const interval = setInterval(push, 50); // ~20 Hz
    ws.on("close", () => clearInterval(interval));
    ws.on("error", () => clearInterval(interval));
  });
  wssDmx.on("error", (err) => logger.error("DMX WS server error:", err.message));

  // Route WebSocket upgrades by path (two servers can't share one HTTP server via
  // the `path` option — only the first would handle the upgrade).
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch (_) {
      return socket.destroy();
    }
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else if (pathname === "/ws/dmx") {
      wssDmx.handleUpgrade(req, socket, head, (ws) => wssDmx.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  server.on("error", (err) => logger.error("HTTP server error:", err.message));
  server.listen(config.webPort, () => logger.info(`Web UI/API on :${config.webPort}`));

  function close() {
    try {
      wss.close();
    } catch (_) {
      /* ignore */
    }
    try {
      wssDmx.close();
    } catch (_) {
      /* ignore */
    }
    try {
      server.close();
    } catch (_) {
      /* ignore */
    }
  }

  return { close };
}

module.exports = { createApi };
