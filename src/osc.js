// OSC transport.
//
// - An outbound port (ephemeral) pushes feedback to Companion / Stream Deck.
// - An inbound server receives control messages on config.oscPort.
//
// Incoming args arrive as raw values (metadata disabled); outgoing typed args
// like { type: "s", value: "..." } are still accepted by osc.js on send.

const osc = require("osc");

function createOsc(config, logger, onMessage) {
  const out = new osc.UDPPort({ localAddress: "0.0.0.0", localPort: 0 });
  out.on("error", (err) => logger.error("OSC out error:", err.message));
  out.open();

  function send(address, args = []) {
    for (const target of config.oscFeedbackTargets) {
      try {
        out.send({ address, args }, target.ip, target.port);
      } catch (err) {
        logger.error(`OSC send to ${target.ip}:${target.port} failed:`, err.message);
      }
    }
  }

  // Send to one specific host/port (used for Companion's OSC API).
  function sendRaw(ip, port, address, args = []) {
    try {
      out.send({ address, args }, ip, port);
    } catch (err) {
      logger.error(`OSC sendRaw to ${ip}:${port} failed:`, err.message);
    }
  }

  const server = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: config.oscPort,
  });
  server.on("error", (err) => logger.error("OSC in error:", err.message));
  server.on("message", (msg) => {
    try {
      onMessage(msg);
    } catch (err) {
      logger.error("OSC handler error:", err.message);
    }
  });
  server.on("ready", () => logger.info(`OSC listening on :${config.oscPort}`));
  server.open();

  function close() {
    try {
      out.close();
    } catch (_) {
      /* already closed */
    }
    try {
      server.close();
    } catch (_) {
      /* already closed */
    }
  }

  return { send, sendRaw, close };
}

module.exports = { createOsc };
