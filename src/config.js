// Loads and validates configuration.
//
// The config FILE (config.jsonc) is grouped by concern and may contain // and
// /* */ comments (JSONC). This loader strips comments, deep-merges over the
// defaults, then NORMALISES the grouped shape into the flat property names the
// rest of the codebase already uses (config.consoleIp, config.oscPort, …). So the
// file stays human-friendly while the internal contract stays stable.
//
// File path: $SCENE_SETTER_CONFIG, else config.jsonc (preferred) or config.json
// at the project root.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function resolveConfigPath() {
  if (process.env.SCENE_SETTER_CONFIG) return process.env.SCENE_SETTER_CONFIG;
  const jsonc = path.join(ROOT, "config.jsonc");
  const json = path.join(ROOT, "config.json");
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc; // default target if neither exists (defaults are used)
}

const CONFIG_PATH = resolveConfigPath();

// ---- Defaults, in the grouped FILE shape ----
const FILE_DEFAULTS = {
  // The lighting console we fail over from.
  console: {
    ip: "10.10.20.10", // desk's IP — also the source filter for recording
    timeoutMs: 1000, // silence before the desk is considered "lost"
    defaultScene: "1", // scene to recall on handoff when nothing else is on
    defaultFade: 3, // crossfade time (seconds) on console handoff / startup
  },

  // Art-Net (DMX) network.
  artnet: {
    port: 6454, // port we listen on (desk + ArtPoll) and send to nodes by default
    localIp: "", // IP advertised in ArtPollReply; blank = auto-detect the NIC facing the desk
    universes: 6, // universe count (valid universe numbers are 0..universes-1)
    channels: 512, // DMX channels per universe
    outputs: [
      // Nodes we drive on failover. `port` is optional (defaults to artnet.port).
      { name: "Chauvet Net-X II", ip: "10.10.20.1", port: 6454, universes: [2, 3, 4, 5] },
      { name: "Botex Dimmer", ip: "10.10.20.2", port: 6454, universes: [1] },
    ],
  },

  // OSC control surface (Companion / Stream Deck).
  companion: {
    listenPort: 9000, // we listen here for OSC commands (Companion "send" target)
    feedbackTargets: [
      { ip: "10.10.20.50", port: 9001 }, // where we push /scene-setter/* feedback
    ],
    customVariables: {
      // Optionally set Companion custom variables via its OSC API.
      enabled: false,
      ip: "10.10.20.50",
      port: 12321, // Companion's OSC listener
      prefix: "lx_house_scenes_", // prepended to variable names
    },
  },

  // Web UI / API.
  web: {
    port: 8080, // HTTP + WebSocket port for the control-panel UI
  },

  // Engine timing — rarely needs changing.
  timing: {
    fadeFrameMs: 40, // ~25 fps fade refresh
    keepAliveMs: 1000, // periodic Art-Net re-send so nodes hold their levels
    startupGraceMs: 1500, // wait for the desk to announce itself on boot before lighting up
    feedbackHeartbeatMs: 5000, // re-broadcast OSC feedback this often so Companion stays in sync
  },

  dataDir: "./data", // where scenes.json / state.json live
};

// Strip // line and /* */ block comments, leaving string contents intact.
function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const key of Object.keys(over)) {
    out[key] =
      isObject(base[key]) && isObject(over[key]) ? deepMerge(base[key], over[key]) : over[key];
  }
  return out;
}

// Build the normalised, validated config from a parsed file object. Throws if
// the result is invalid.
function buildConfig(fileConfig) {
  const f = deepMerge(FILE_DEFAULTS, fileConfig);

  // Normalise the grouped file shape → the flat shape the modules consume.
  const config = {
    universes: f.artnet.universes,
    channels: f.artnet.channels,
    outputs: f.artnet.outputs,
    artnetPort: f.artnet.port,
    artnetIp: f.artnet.localIp,

    consoleIp: f.console.ip,
    consoleTimeoutMs: f.console.timeoutMs,
    defaultSceneOnConsoleLost: f.console.defaultScene,
    defaultFadeOnConsoleLost: f.console.defaultFade,

    oscPort: f.companion.listenPort,
    oscFeedbackTargets: f.companion.feedbackTargets,
    companion: {
      customVariables: f.companion.customVariables.enabled,
      ip: f.companion.customVariables.ip,
      port: f.companion.customVariables.port,
      variablePrefix: f.companion.customVariables.prefix,
    },

    fadeFrameMs: f.timing.fadeFrameMs,
    keepAliveMs: f.timing.keepAliveMs,
    startupGraceMs: f.timing.startupGraceMs,
    feedbackHeartbeatMs: f.timing.feedbackHeartbeatMs,

    webPort: f.web.port,

    dataDir: f.dataDir,
  };

  config.dataDir = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.join(ROOT, config.dataDir);
  config.scenesFile = path.join(config.dataDir, "scenes.json");
  config.stateFile = path.join(config.dataDir, "state.json");
  config.configPath = CONFIG_PATH;

  validate(config);
  return config;
}

// Parse + validate raw JSONC text (used to validate edits before saving them).
// Throws with a helpful message on parse or validation failure.
function buildFromText(text) {
  let fileConfig = {};
  if (text && text.trim()) {
    fileConfig = JSON.parse(stripJsonComments(text));
  }
  return buildConfig(fileConfig);
}

function loadConfig() {
  const text = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : "";
  try {
    return buildFromText(text);
  } catch (err) {
    throw new Error(`Failed to load config at ${CONFIG_PATH}: ${err.message}`);
  }
}

// The grouped file object (defaults merged in) — what the form UI edits.
function loadGrouped() {
  const text = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : "";
  const fileConfig = text && text.trim() ? JSON.parse(stripJsonComments(text)) : {};
  return deepMerge(FILE_DEFAULTS, fileConfig);
}

// Render a grouped config object back to annotated JSONC (so form saves keep the
// file readable). Values are taken as-is — validate (buildConfig) before calling.
function serializeConfig(g) {
  const j = (v) => JSON.stringify(v);
  const outputs = (g.artnet.outputs || [])
    .map(
      (o) =>
        `    { "name": ${j(o.name || "")}, "ip": ${j(o.ip || "")}, "port": ${
          o.port ?? g.artnet.port
        }, "universes": ${j(o.universes || [])} }`
    )
    .join(",\n");
  const targets = (g.companion.feedbackTargets || [])
    .map((t) => `    { "ip": ${j(t.ip || "")}, "port": ${t.port} }`)
    .join(",\n");

  return `{
  // ── Lighting console (the desk we fail over from) ─────────────────────────
  "console": {
    "ip": ${j(g.console.ip)},                 // desk's IP — also the source filter for recording
    "timeoutMs": ${g.console.timeoutMs},      // silence before the desk is considered "lost"
    "defaultScene": ${j(g.console.defaultScene)},  // recalled on handoff if nothing else is on
    "defaultFade": ${g.console.defaultFade}   // crossfade seconds on handoff / startup
  },

  // ── Art-Net / DMX network ─────────────────────────────────────────────────
  "artnet": {
    "port": ${g.artnet.port},
    "localIp": ${j(g.artnet.localIp)},        // advertised in ArtPollReply; blank = auto-detect
    "universes": ${g.artnet.universes},
    "channels": ${g.artnet.channels},
    "outputs": [
${outputs}
    ]
  },

  // ── Companion / OSC control surface ───────────────────────────────────────
  "companion": {
    "listenPort": ${g.companion.listenPort},
    "feedbackTargets": [
${targets}
    ],
    "customVariables": {
      "enabled": ${g.companion.customVariables.enabled},
      "ip": ${j(g.companion.customVariables.ip)},
      "port": ${g.companion.customVariables.port},
      "prefix": ${j(g.companion.customVariables.prefix)}
    }
  },

  // ── Web UI / API ──────────────────────────────────────────────────────────
  "web": {
    "port": ${g.web.port}
  },

  // ── Engine timing (rarely changed) ────────────────────────────────────────
  "timing": {
    "fadeFrameMs": ${g.timing.fadeFrameMs},
    "keepAliveMs": ${g.timing.keepAliveMs},
    "startupGraceMs": ${g.timing.startupGraceMs},
    "feedbackHeartbeatMs": ${g.timing.feedbackHeartbeatMs}
  },

  "dataDir": ${j(g.dataDir)}
}
`;
}

function validate(config) {
  const errors = [];

  if (!Number.isInteger(config.universes) || config.universes < 1) {
    errors.push("artnet.universes must be a positive integer");
  }
  if (!Number.isInteger(config.channels) || config.channels < 1 || config.channels > 512) {
    errors.push("artnet.channels must be an integer between 1 and 512");
  }
  if (typeof config.consoleIp !== "string") {
    errors.push("console.ip must be a string");
  }
  if (!Array.isArray(config.outputs) || config.outputs.length === 0) {
    errors.push("artnet.outputs must be a non-empty array");
  } else {
    config.outputs.forEach((o, i) => {
      if (typeof o.ip !== "string") errors.push(`artnet.outputs[${i}].ip must be a string`);
      if (!Array.isArray(o.universes)) errors.push(`artnet.outputs[${i}].universes must be an array`);
    });
  }
  if (!Array.isArray(config.oscFeedbackTargets)) {
    errors.push("companion.feedbackTargets must be an array");
  }

  if (errors.length) {
    throw new Error("Invalid config:\n - " + errors.join("\n - "));
  }
}

module.exports = {
  loadConfig,
  buildFromText,
  buildConfig,
  loadGrouped,
  serializeConfig,
  FILE_DEFAULTS,
};
