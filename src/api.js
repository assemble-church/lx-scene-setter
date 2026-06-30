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
const path = require("path");
const { WebSocketServer } = require("ws");
const store = require("./store");
const { buildFromText, buildConfig, loadGrouped, serializeConfig } = require("./config");

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
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/api/health") return sendJson(res, { ok: true });
    if (url === "/api/state") return sendJson(res, engine.getState());

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
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  }

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    const push = () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(engine.getState()));
    };
    push(); // immediate snapshot
    const interval = setInterval(push, 100); // ~10 Hz — smooth enough for the level bars
    ws.on("close", () => clearInterval(interval));
    ws.on("error", () => clearInterval(interval));
  });
  wss.on("error", (err) => logger.error("WS server error:", err.message));

  server.on("error", (err) => logger.error("HTTP server error:", err.message));
  server.listen(config.webPort, () => logger.info(`Web UI/API on :${config.webPort}`));

  function close() {
    try {
      wss.close();
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
