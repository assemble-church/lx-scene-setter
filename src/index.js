#!/usr/bin/env node
// Entry point: load config, wire the transports to the engine, start, and
// shut down cleanly.

const logger = require("./logger");
const store = require("./store");
const { loadConfig } = require("./config");
const { createArtnetOutput, createArtnetInput } = require("./artnet");
const { createOsc } = require("./osc");
const { createEngine } = require("./engine");
const { createApi } = require("./api");

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

const output = createArtnetOutput(config, logger);

// engine and osc reference each other, so create osc with a late-bound handler.
let engine;
const oscPort = createOsc(config, logger, (msg) => engine.handleOsc(msg));

engine = createEngine({
  config,
  logger,
  store,
  output,
  sendOsc: oscPort.send,
  sendRaw: oscPort.sendRaw,
});

const artnetIn = createArtnetInput(config, logger, (u, p, l) => engine.onDmx(u, p, l));

const api = createApi(config, logger, engine);

const stop = engine.start();

logger.info("Scene Setter running");
logger.info(`Config:       ${config.configPath}`);
logger.info(`OSC in:       ${config.oscPort}`);
logger.info(`Art-Net in/out: ${config.artnetPort}`);
logger.info(`Web UI:       ${config.webPort}`);
logger.info(`Universes:    ${config.universes}`);
logger.info(`Console IP:   ${config.consoleIp} (timeout ${config.consoleTimeoutMs}ms)`);

// ---------------- SHUTDOWN ----------------
// We intentionally do NOT blackout on exit — leave the rig at its last look so a
// service restart never goes dark on a live venue.

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down`);
  try {
    stop();
  } catch (_) {
    /* ignore */
  }
  try {
    artnetIn.close();
  } catch (_) {
    /* ignore */
  }
  try {
    oscPort.close();
  } catch (_) {
    /* ignore */
  }
  try {
    output.close();
  } catch (_) {
    /* ignore */
  }
  try {
    api.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Crash loudly and let systemd restart us, rather than limp on in a bad state.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  logger.error("Unhandled rejection:", err);
  process.exit(1);
});
