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
const { importLibrary, sevenZipStatus } = require("./fixtures/import");

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

function createApi(config, logger, engine) {
  // Lazily-opened fixture library (only if a fixtures.db exists).
  let db = null;
  let libCount = 0;
  function library() {
    if (db) return db;
    if (fs.existsSync(config.fixturesDb)) {
      try {
        db = lib.openLibrary(config.fixturesDb);
        libCount = lib.count(db);
      } catch (err) {
        logger.error("Open fixtures.db failed:", err.message);
      }
    }
    return db;
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
    return { ...engine.getState(), fixtures: fixturesStatus() };
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/api/health") return sendJson(res, { ok: true });
    if (url === "/api/state") return sendJson(res, snapshot());

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
      const out = fs.createWriteStream(tmpExe);
      req.pipe(out);
      req.on("error", () => {
        try {
          out.destroy();
        } catch (_) {
          /* ignore */
        }
      });
      out.on("error", (e) => badRequest(res, e.message));
      out.on("finish", async () => {
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
          const result = await importLibrary(tmpExe, config.fixturesDb, (p) => {
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

    if (url === "/api/patch/add" && req.method === "POST") {
      return readBody(req, res, (b) => {
        const l = library();
        if (!l) return badRequest(res, "No fixture library imported");
        const fx = lib.get(l, Number(b.libId));
        if (!fx) return badRequest(res, "fixture not found", 404);
        const mode = (fx.modes || []).find((m) => m.name === b.mode) || (fx.modes || [])[0];
        if (!mode) return badRequest(res, "fixture has no modes");
        const fade = lib.channelFade(mode);
        const letters = lib.channelLetters(mode);
        const channels = mode.channels || fade.length || 1;
        const baseLabel = typeof b.label === "string" && b.label ? b.label : fx.name;
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
            id: crypto.randomUUID(),
            libId: fx.id,
            manufacturer: fx.manufacturer,
            name: fx.name,
            label: count > 1 ? `${baseLabel} ${i + 1}` : baseLabel,
            mode: mode.name,
            channels,
            universe: u,
            address: addr,
            fade: [...fade], // own copy so per-channel overrides are independent
            letters,
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
        "<h1>LX Scene Setter</h1><p>UI not built. Run <code>npm run ui:build</code>.</p>"
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
