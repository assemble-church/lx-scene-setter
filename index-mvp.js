const dgram = require("dgram");
const fs = require("fs");
const osc = require("osc");

// ---------------- CONFIG ----------------

const CONFIG = {
  universes: 6,
  channels: 512,

  avoIp: "10.10.21.5",
  avoTimeoutMs: 1000,

  defaultSceneOnAvoLost: "1",
  defaultFadeOnAvoLost: 3,

  oscPort: 9000,
  artnetPort: 6454,

  // Companion machines to notify when state changes
  oscFeedbackTargets: [
    { ip: "10.10.21.10", port: 9001 } // change to Companion IP/port
  ],

  outputs: [
    { name: "Chauvet Net-X II", ip: "10.10.21.2", universes: [0, 1, 2, 3, 4, 5] },
    { name: "Botex Dimmer", ip: "10.10.21.3", universes: [0] }
  ],

  scenesFile: "./scenes.json",
  stateFile: "./state.json"
};

// ---------------- STATE ----------------

let current = Array.from({ length: CONFIG.universes }, () =>
  new Uint8Array(CONFIG.channels)
);

let scenes = fs.existsSync(CONFIG.scenesFile)
  ? JSON.parse(fs.readFileSync(CONFIG.scenesFile, "utf8"))
  : {};

let state = fs.existsSync(CONFIG.stateFile)
  ? JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"))
  : {
      avoActive: false,
      piOutputEnabled: true,
      lastAvoPacket: 0,
      activeScene: null
    };

let fadeTimer = null;

// ---------------- FILE HELPERS ----------------

function saveScenes() {
  fs.writeFileSync(CONFIG.scenesFile, JSON.stringify(scenes, null, 2));
}

function saveState() {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ---------------- ART-NET OUTPUT ----------------

const artnetOut = dgram.createSocket("udp4");

function sendUniverseToIp(ip, universe, values) {
  const packet = Buffer.alloc(18 + CONFIG.channels);

  packet.write("Art-Net\0", 0, "ascii");
  packet.writeUInt16LE(0x5000, 8);       // OpDmx
  packet.writeUInt16BE(14, 10);          // protocol version
  packet[12] = 0;                        // sequence
  packet[13] = 0;                        // physical
  packet.writeUInt16LE(universe, 14);    // universe
  packet.writeUInt16BE(CONFIG.channels, 16);

  Buffer.from(values).copy(packet, 18);

  artnetOut.send(packet, CONFIG.artnetPort, ip);
}

function outputAll() {
  if (!state.piOutputEnabled) return;

  for (const node of CONFIG.outputs) {
    for (const universe of node.universes) {
      sendUniverseToIp(node.ip, universe, current[universe]);
    }
  }
}

// ---------------- OSC FEEDBACK ----------------

const oscOut = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 0
});

oscOut.open();

function sendOsc(address, args = []) {
  for (const target of CONFIG.oscFeedbackTargets) {
    oscOut.send(
      { address, args },
      target.ip,
      target.port
    );
  }
}

function broadcastState() {
  sendOsc("/scene-setter/avo-active", [
    { type: "i", value: state.avoActive ? 1 : 0 }
  ]);

  sendOsc("/scene-setter/pi-output", [
    { type: "i", value: state.piOutputEnabled ? 1 : 0 }
  ]);

  sendOsc("/scene-setter/active-scene", [
    { type: "s", value: state.activeScene || "" }
  ]);

  sendOsc("/scene-setter/status", [
    {
      type: "s",
      value: state.avoActive
        ? "PRODUCTION_CONSOLE_ACTIVE"
        : "BUILDING_CONTROL_ACTIVE"
    }
  ]);
}

function setAvoActive(active) {
  if (state.avoActive === active) return;

  state.avoActive = active;

  if (active) {
    state.piOutputEnabled = false;
    console.log("Avo active: Pi output disabled");
  } else {
    state.piOutputEnabled = true;
    console.log("Avo lost: Pi output enabled, recalling scene 1");

    playScene(
      CONFIG.defaultSceneOnAvoLost,
      CONFIG.defaultFadeOnAvoLost
    );
  }

  saveState();
  broadcastState();
}

// ---------------- SCENES ----------------

function recordScene(sceneId) {
  scenes[sceneId] = current.map(u => Array.from(u));
  saveScenes();

  console.log(`Recorded scene ${sceneId}`);
  sendOsc("/scene-setter/recorded", [{ type: "s", value: sceneId }]);
}

function playScene(sceneId, fadeSeconds = 0) {
  const target = scenes[sceneId];

  if (!target) {
    console.log(`Scene ${sceneId} does not exist`);
    sendOsc("/scene-setter/error", [
      { type: "s", value: `Scene ${sceneId} does not exist` }
    ]);
    return;
  }

  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }

  state.piOutputEnabled = true;
  state.activeScene = sceneId;
  saveState();
  broadcastState();

  const start = current.map(u => Uint8Array.from(u));
  const duration = Math.max(0, Number(fadeSeconds)) * 1000;
  const startTime = Date.now();

  function step() {
    const progress = duration === 0
      ? 1
      : Math.min((Date.now() - startTime) / duration, 1);

    for (let u = 0; u < CONFIG.universes; u++) {
      for (let ch = 0; ch < CONFIG.channels; ch++) {
        const from = start[u][ch];
        const to = target[u]?.[ch] ?? 0;
        current[u][ch] = Math.round(from + (to - from) * progress);
      }
    }

    outputAll();

    if (progress < 1) {
      fadeTimer = setTimeout(step, 40);
    } else {
      fadeTimer = null;
      console.log(`Played scene ${sceneId} over ${fadeSeconds}s`);
      sendOsc("/scene-setter/played", [{ type: "s", value: sceneId }]);
    }
  }

  step();
}

// ---------------- ART-NET INPUT FROM AVO ----------------

const artnetIn = dgram.createSocket("udp4");

artnetIn.on("message", (packet, rinfo) => {
  if (rinfo.address !== CONFIG.avoIp) return;
  if (packet.toString("ascii", 0, 8) !== "Art-Net\0") return;

  const opcode = packet.readUInt16LE(8);
  if (opcode !== 0x5000) return; // ArtDMX only

  const universe = packet.readUInt16LE(14);
  const length = packet.readUInt16BE(16);

  if (universe >= CONFIG.universes) return;

  state.lastAvoPacket = Date.now();
  setAvoActive(true);

  // Store Avo levels so record captures the desk output
  for (let i = 0; i < Math.min(length, CONFIG.channels); i++) {
    current[universe][i] = packet[18 + i];
  }

  saveState();
});

artnetIn.bind(CONFIG.artnetPort, "0.0.0.0", () => {
  console.log(`Listening for Avo Art-Net from ${CONFIG.avoIp}`);
});

// ---------------- AVO WATCHDOG ----------------

setInterval(() => {
  if (!state.avoActive) return;

  const silenceMs = Date.now() - state.lastAvoPacket;

  if (silenceMs >= CONFIG.avoTimeoutMs) {
    setAvoActive(false);
  }
}, 100);

// ---------------- OSC INPUT ----------------

const oscServer = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: CONFIG.oscPort
});

oscServer.on("message", msg => {
  const parts = msg.address.split("/").filter(Boolean);

  // /scene/2/rec
  if (parts[0] === "scene" && parts[2] === "rec") {
    recordScene(parts[1]);
    return;
  }

  // /scene/2/play/3
  if (parts[0] === "scene" && parts[2] === "play") {
    state.avoActive = false;
    state.piOutputEnabled = true;
    saveState();

    playScene(parts[1], parts[3] ?? 0);
    return;
  }

  // /state
  if (parts[0] === "state") {
    broadcastState();
    return;
  }

  // /output/on
  if (parts[0] === "output" && parts[1] === "on") {
    state.avoActive = false;
    state.piOutputEnabled = true;
    saveState();
    outputAll();
    broadcastState();
    return;
  }

  // /output/off
  if (parts[0] === "output" && parts[1] === "off") {
    state.piOutputEnabled = false;
    saveState();
    broadcastState();
    return;
  }
});

oscServer.open();

// ---------------- KEEP OUTPUT ALIVE ----------------

setInterval(() => {
  outputAll();
}, 1000);

// ---------------- STARTUP ----------------

console.log(`Scene Setter running`);
console.log(`OSC in: ${CONFIG.oscPort}`);
console.log(`Art-Net in/out: ${CONFIG.artnetPort}`);
console.log(`Universes: ${CONFIG.universes}`);
console.log(`Avo timeout: ${CONFIG.avoTimeoutMs}ms`);

broadcastState();