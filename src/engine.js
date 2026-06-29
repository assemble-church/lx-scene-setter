// The scene-setter engine: DMX buffer, console failover, and an HTP scene-layer
// playback model.
//
// Playback model (HTP — Highest Takes Precedence):
//   - Each scene is a stored snapshot of all channels and acts as a LAYER with an
//     independent on/off state and a 0..1 level (animated during a fade).
//   - The output of every channel is the MAX across all active layers:
//         output[ch] = max( sceneA[ch]*levelA , sceneB[ch]*levelB , ... )
//   - So scenes stack: turning one layer off only lowers the channels it alone was
//     holding up; channels still held by another layer stay up. A channel stored
//     as 0 in a layer never pulls anything down (max ignores it).
//
// console failover:
//   - While the console console broadcasts Art-Net it owns the rig; the Pi stops
//     outputting (piOutputEnabled = false) but still captures the desk's levels so
//     a record snapshots what's on stage.
//   - When the console falls silent past consoleTimeoutMs, the Pi takes over: it restores
//     the layers that were on (fading them up), or the default scene if none.
//   - Scene control is BLOCKED while the console is live. Recording IS allowed.

const now = () => Date.now();

function createEngine({ config, logger, store, output, sendOsc, sendRaw }) {
  const U = config.universes;
  const C = config.channels;
  const companion = config.companion || { customVariables: false };

  // Push a value into a Companion custom variable via its OSC API. No-op unless
  // enabled; harmless if the named variable doesn't exist in Companion.
  function pushVar(name, value, type) {
    if (!companion.customVariables || !sendRaw) return;
    const varName = `${companion.variablePrefix || ""}${name}`;
    sendRaw(companion.ip, companion.port, `/custom-variable/${varName}/value`, [
      { type, value },
    ]);
  }

  // Computed output buffer (HTP merge of active layers). In memory only.
  const current = Array.from({ length: U }, () => new Uint8Array(C));

  // Recorded looks: scenes[id] = array(U) of arrays(C), values 0..255.
  const scenes = store.readJSON(config.scenesFile, {});

  // Runtime layer state per scene id:
  //   { level: 0..1, target: 0|1, fadeFrom: 0..1, fadeStart: ms, fadeDur: ms }
  const layers = {};

  // Persisted: which scene ids were on (restored on boot).
  const persisted = store.readJSON(config.stateFile, {});
  const state = {
    consoleActive: false, // effective state (override applied) — drives behaviour & feedback
    consoleDetected: false, // raw network detection (packets + watchdog)
    consoleOverride: "auto", // "auto" | "on" | "off" — not persisted (resets to auto on boot)
    piOutputEnabled: true,
    lastConsolePacket: 0,
    activeScenes: Array.isArray(persisted.activeScenes)
      ? persisted.activeScenes.filter((id) => scenes[id])
      : [],
  };

  let renderTimer = null;
  let lastFadeEmit = 0;
  const round1 = (x) => Math.round(x * 10) / 10;

  // ---------------- LAYER STATE ----------------

  function cmpIds(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function ensureLayer(id) {
    if (!layers[id]) {
      layers[id] = { level: 0, target: 0, fadeFrom: 0, fadeStart: 0, fadeDur: 0 };
    }
    return layers[id];
  }

  // Internal fade-out-only layer holding the desk's last output, used to crossfade
  // FROM the desk look INTO the building look on console handoff. Not a real scene, so
  // it never appears in scenes feedback / active-scenes / persistence.
  const DESK_LAYER = "__desk__";

  function captureDeskLayer(fadeSeconds) {
    const dur = Math.max(0, Number(fadeSeconds) || 0) * 1000;
    if (dur === 0) {
      delete layers[DESK_LAYER]; // instant handoff — nothing to crossfade from
      return;
    }
    const L = ensureLayer(DESK_LAYER);
    L.values = current.map((u) => Uint8Array.from(u)); // snapshot the desk's last frame
    L.level = 1;
    L.target = 0;
    L.fadeFrom = 1;
    L.fadeStart = now();
    L.fadeDur = dur;
  }

  // Begin moving a layer toward on (1) or off (0) over fadeSeconds.
  function setLayer(id, on, fadeSeconds, fromLevel) {
    const L = ensureLayer(id);
    if (fromLevel !== undefined) L.level = fromLevel;
    L.target = on ? 1 : 0;
    L.fadeFrom = L.level;
    L.fadeStart = now();
    L.fadeDur = Math.max(0, Number(fadeSeconds) || 0) * 1000;
    if (L.fadeDur === 0) L.level = L.target;
  }

  function advanceLayers(t) {
    for (const id of Object.keys(layers)) {
      const L = layers[id];
      if (L.level === L.target) continue;
      if (L.fadeDur === 0) {
        L.level = L.target;
        continue;
      }
      const p = Math.min((t - L.fadeStart) / L.fadeDur, 1);
      L.level = p >= 1 ? L.target : L.fadeFrom + (L.target - L.fadeFrom) * p;
    }
  }

  function anyFading() {
    return Object.keys(layers).some((id) => layers[id].level !== layers[id].target);
  }

  // Forget layers that are fully off so the map doesn't grow unbounded.
  function cleanupLayers() {
    for (const id of Object.keys(layers)) {
      if (layers[id].level <= 0 && layers[id].target === 0) delete layers[id];
    }
  }

  // Scene ids that are on by intent (target = 1), sorted.
  function onIds() {
    return Object.keys(layers)
      .filter((id) => layers[id].target === 1)
      .sort(cmpIds);
  }

  // ---------------- RENDER (HTP) ----------------

  function renderToCurrent() {
    for (let u = 0; u < U; u++) current[u].fill(0);
    for (const id of Object.keys(layers)) {
      const L = layers[id];
      if (L.level <= 0) continue;
      const vals = L.values || scenes[id]; // desk layer carries its own snapshot
      if (!vals) continue;
      const lvl = L.level;
      for (let u = 0; u < U; u++) {
        const src = vals[u];
        if (!src) continue;
        const dst = current[u];
        const n = Math.min(C, src.length);
        for (let ch = 0; ch < n; ch++) {
          const v = lvl >= 1 ? src[ch] : Math.round(src[ch] * lvl);
          if (v > dst[ch]) dst[ch] = v;
        }
      }
    }
  }

  function outputAll() {
    if (!state.piOutputEnabled) return;
    for (const node of config.outputs) {
      const port = node.port || config.artnetPort;
      for (const universe of node.universes) {
        if (universe >= U) continue;
        output.sendUniverse(node.ip, port, universe, current[universe]);
      }
    }
  }

  // Render the current instant and push it out.
  function renderAndOutput() {
    advanceLayers(now());
    renderToCurrent();
    outputAll();
  }

  // Run a frame loop only while something is fading.
  function scheduleRender() {
    if (renderTimer) return;
    const tick = () => {
      renderAndOutput();
      const throttle = now() - lastFadeEmit >= 100;
      if (throttle) {
        emitFade();
        lastFadeEmit = now();
      }
      // Per-scene: throttle the live countdown for fading layers, but emit the
      // settle transition (fading → on/off) the instant it happens so a scene
      // that finishes while another is still fading updates immediately.
      for (const id of Object.keys(layers)) {
        if (!scenes[id]) continue;
        const L = layers[id];
        if (L.level !== L.target) {
          L.wasFading = true;
          if (throttle) emitScene(id);
        } else if (L.wasFading) {
          L.wasFading = false;
          emitScene(id);
        }
      }
      if (anyFading()) {
        renderTimer = setTimeout(tick, config.fadeFrameMs);
      } else {
        renderTimer = null;
        cleanupLayers();
        emitFade();
        broadcastScenes();
      }
    };
    renderTimer = setTimeout(tick, config.fadeFrameMs);
  }

  function stopRender() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
  }

  // Apply a layer change: render now, publish, and start the loop if needed.
  function commit() {
    renderAndOutput();
    broadcastTop();
    broadcastScenes();
    if (anyFading()) scheduleRender();
    emitFade();
  }

  // ---------------- FEEDBACK ----------------

  function broadcastTop() {
    // console-active is the COMPUTED/effective state (override applied).
    sendOsc("/scene-setter/console-active", [{ type: "i", value: state.consoleActive ? 1 : 0 }]);
    sendOsc("/scene-setter/console-override", [{ type: "s", value: state.consoleOverride }]);
    pushVar("console_override", state.consoleOverride, "s");
    sendOsc("/scene-setter/pi-output", [{ type: "i", value: state.piOutputEnabled ? 1 : 0 }]);
    sendOsc("/scene-setter/status", [
      {
        type: "s",
        value: state.consoleActive ? "PRODUCTION_CONSOLE_ACTIVE" : "BUILDING_CONTROL_ACTIVE",
      },
    ]);
    sendOsc("/scene-setter/active-scenes", [{ type: "s", value: onIds().join(",") }]);
    pushVar("console_active", state.consoleActive ? 1 : 0, "i");
    pushVar("active_scenes", onIds().join(","), "s");
  }

  // Tri-state per scene: 0 = off, 1 = on (settled), 2 = fading (in or out).
  // Always 0 while the desk is in control or Pi output is disabled.
  function sceneState(id) {
    if (state.consoleActive || !state.piOutputEnabled) return 0;
    const L = layers[id];
    if (!L) return 0;
    if (L.level !== L.target) return 2;
    return L.target === 1 ? 1 : 0;
  }

  // Seconds left in this scene's own fade (0 if it isn't fading).
  function sceneFadeRemaining(id) {
    const L = layers[id];
    if (!L || L.level === L.target || L.fadeDur === 0) return 0;
    return Math.max(0, (L.fadeStart + L.fadeDur - now()) / 1000);
  }

  function emitScene(id) {
    sendOsc(`/scene-setter/scene/${id}/active`, [{ type: "i", value: sceneState(id) }]);
    const rem = sceneFadeRemaining(id);
    sendOsc(`/scene-setter/scene/${id}/fade-remaining`, [{ type: "f", value: round1(rem) }]);
    pushVar(`scene_${id}_fade_remaining`, rem.toFixed(1), "s");
  }

  function broadcastScenes() {
    for (const id of Object.keys(scenes)) emitScene(id);
  }

  // Aggregate fade status across all fading layers (longest wins for the counter).
  function fadeStatus() {
    let active = false;
    let remaining = 0;
    let total = 0;
    const t = now();
    for (const id of Object.keys(layers)) {
      const L = layers[id];
      if (L.level === L.target || L.fadeDur === 0) continue;
      active = true;
      remaining = Math.max(remaining, (L.fadeStart + L.fadeDur - t) / 1000);
      total = Math.max(total, L.fadeDur / 1000);
    }
    return { active, remaining: Math.max(0, remaining), total };
  }

  function emitFade() {
    const f = fadeStatus();
    sendOsc("/scene-setter/fade-active", [{ type: "i", value: f.active ? 1 : 0 }]);
    sendOsc("/scene-setter/fade-remaining", [{ type: "f", value: round1(f.remaining) }]);
    sendOsc("/scene-setter/fade-total", [{ type: "f", value: round1(f.total) }]);
    pushVar("fade_active", f.active ? 1 : 0, "i");
    // Send as a 1-dp STRING so Companion displays "3.0", "2.9" … "0.0" exactly,
    // rather than a 32-bit float's noisy expansion (e.g. 2.9000000953).
    pushVar("fade_remaining", f.remaining.toFixed(1), "s");
  }

  function broadcastState() {
    broadcastTop();
    broadcastScenes();
    emitFade();
  }

  function persist() {
    store.writeJSONAtomic(config.stateFile, { activeScenes: onIds() });
  }

  // ---------------- CONSOLE FAILOVER ----------------

  // Effective console state = override if forced, else the network detection.
  function effectiveConsole() {
    if (state.consoleOverride === "on") return true;
    if (state.consoleOverride === "off") return false;
    return state.consoleDetected;
  }

  function recomputeConsole() {
    applyConsoleActive(effectiveConsole());
  }

  // mode: "on" (force live) | "off" (force ignore desk) | "auto" (network detection)
  function setConsoleOverride(mode) {
    if (!["on", "off", "auto"].includes(mode)) mode = "auto";
    state.consoleOverride = mode;
    logger.info(`console override set to ${mode}`);
    recomputeConsole(); // apply any change to the effective state
    broadcastTop(); // always publish the override + effective state
  }

  function applyConsoleActive(active) {
    if (state.consoleActive === active) return;
    state.consoleActive = active;

    if (active) {
      stopRender(); // desk takes over; stop Pi rendering (levels/targets are kept)
      state.piOutputEnabled = false;
      logger.info("console active → Pi output disabled (desk in control)");
      broadcastState();
    } else {
      state.piOutputEnabled = true;
      // Crossfade FROM the desk's last look (captured) INTO the building look —
      // the building layers rise from 0 while the desk snapshot falls, so there's
      // no flash to black.
      captureDeskLayer(config.defaultFadeOnConsoleLost);
      const restore = onIds();
      if (restore.length === 0 && scenes[config.defaultSceneOnConsoleLost]) {
        logger.info(`console lost → crossfading to default scene ${config.defaultSceneOnConsoleLost}`);
        setLayer(config.defaultSceneOnConsoleLost, true, config.defaultFadeOnConsoleLost, 0);
      } else {
        logger.info(`console lost → crossfading to scenes [${restore.join(",")}]`);
        for (const id of restore) setLayer(id, true, config.defaultFadeOnConsoleLost, 0);
      }
      persist();
      commit();
    }
  }

  // Hot path: NO disk writes. While the console is live, current holds desk levels but
  // outputAll is suppressed (piOutputEnabled = false).
  function onDmx(universe, packet, length) {
    state.lastConsolePacket = now();
    if (!state.consoleDetected) {
      state.consoleDetected = true;
      recomputeConsole();
    }
    // If the effective console state is off (e.g. forced off), ignore the desk's data
    // entirely — don't let it corrupt the Pi's own render.
    if (!state.consoleActive) return;

    const n = Math.min(length, C, packet.length - 18);
    const buf = current[universe];
    for (let i = 0; i < n; i++) buf[i] = packet[18 + i];
  }

  // ---------------- SCENE COMMANDS ----------------

  function consoleBlocked(action) {
    logger.warn(`${action} ignored — console console is live`);
    sendOsc("/scene-setter/error", [{ type: "s", value: "console active — scene control disabled" }]);
  }

  function sceneMissing(id) {
    logger.warn(`Scene ${id} does not exist`);
    sendOsc("/scene-setter/error", [{ type: "s", value: `Scene ${id} does not exist` }]);
  }

  function recordScene(id) {
    if (id === undefined || id === null || id === "") {
      logger.warn("Record ignored: no scene id");
      return;
    }
    scenes[id] = current.map((u) => Array.from(u));
    store.writeJSONAtomic(config.scenesFile, scenes);
    logger.info(`Recorded scene ${id}`);
    sendOsc("/scene-setter/recorded", [{ type: "s", value: String(id) }]);
    broadcastScenes(); // publish the new scene's feedback path
  }

  function setSceneState(id, on, fade) {
    if (state.consoleActive) return void consoleBlocked(`Scene ${id} ${on ? "on" : "off"}`);
    if (!scenes[id]) return void sceneMissing(id);
    if (on) state.piOutputEnabled = true;
    setLayer(id, on, fade);
    logger.info(`Scene ${id} ${on ? "on" : "off"} over ${Number(fade) || 0}s`);
    persist();
    commit();
  }

  function sceneOn(id, fade) {
    setSceneState(id, true, fade);
  }

  function sceneOff(id, fade) {
    setSceneState(id, false, fade);
  }

  function sceneToggle(id, fade) {
    const L = layers[id];
    const isOn = !!L && L.target === 1;
    setSceneState(id, !isOn, fade);
  }

  // Exclusive recall ("full look"): this scene on, all others off.
  function sceneSolo(id, fade) {
    if (state.consoleActive) return void consoleBlocked(`Solo scene ${id}`);
    if (!scenes[id]) return void sceneMissing(id);
    state.piOutputEnabled = true;
    for (const other of Object.keys(layers)) {
      if (other !== String(id)) setLayer(other, false, fade);
    }
    setLayer(id, true, fade);
    logger.info(`Solo scene ${id} over ${Number(fade) || 0}s`);
    persist();
    commit();
  }

  function scenesOff(fade) {
    for (const id of Object.keys(layers)) setLayer(id, false, fade);
    logger.info(`All scenes off over ${Number(fade) || 0}s`);
    persist();
    commit();
  }

  // ---------------- OUTPUT MASTER ----------------

  function enableOutput() {
    if (state.consoleActive) {
      sendOsc("/scene-setter/error", [{ type: "s", value: "console active — output controlled by desk" }]);
      return;
    }
    state.piOutputEnabled = true;
    commit();
  }

  function disableOutput() {
    state.piOutputEnabled = false;
    stopRender();
    broadcastState();
  }

  // ---------------- OSC ROUTING ----------------

  function handleOsc(msg) {
    const parts = msg.address.split("/").filter(Boolean);
    const cmd = parts[0];

    if (cmd === "scene") {
      const id = parts[1];
      const verb = parts[2];
      if (verb === "rec") return void recordScene(id);
      const fade = resolveFade(msg, parts[3]);
      if (verb === "on") return void sceneOn(id, fade);
      if (verb === "off") return void sceneOff(id, fade);
      if (verb === "toggle") return void sceneToggle(id, fade);
      if (verb === "play") return void sceneSolo(id, fade); // exclusive recall
    }

    // /scenes/off [fade]  → all layers off
    if (cmd === "scenes" && parts[1] === "off") {
      return void scenesOff(resolveFade(msg, parts[2]));
    }

    // /scene-setter/console-override  arg 0=off, 1=on, 2/none=auto
    if (cmd === "scene-setter" && parts[1] === "console-override") {
      const raw = resolveNumber(msg, parts[2]);
      const mode = raw === 1 ? "on" : raw === 0 ? "off" : "auto";
      return void setConsoleOverride(mode);
    }

    if (cmd === "state") return void broadcastState();

    if (cmd === "output" && parts[1] === "on") return void enableOutput();
    if (cmd === "output" && parts[1] === "off") return void disableOutput();

    logger.warn(`Unhandled OSC address: ${msg.address}`);
  }

  // Prefer an explicit OSC argument; fall back to the address segment; then 0.
  function resolveFade(msg, addrSegment) {
    if (msg.args && msg.args.length) {
      const raw =
        msg.args[0] && typeof msg.args[0] === "object" ? msg.args[0].value : msg.args[0];
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    if (addrSegment !== undefined) {
      const n = Number(addrSegment);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  // Like resolveFade but with no default — returns NaN when no number is present.
  function resolveNumber(msg, addrSegment) {
    if (msg.args && msg.args.length) {
      const raw =
        msg.args[0] && typeof msg.args[0] === "object" ? msg.args[0].value : msg.args[0];
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    if (addrSegment !== undefined) {
      const n = Number(addrSegment);
      if (Number.isFinite(n)) return n;
    }
    return NaN;
  }

  // ---------------- LIFECYCLE ----------------

  function start() {
    const watchdog = setInterval(() => {
      if (!state.consoleDetected) return;
      if (now() - state.lastConsolePacket >= config.consoleTimeoutMs) {
        state.consoleDetected = false;
        recomputeConsole();
      }
    }, 100);

    const keepAlive = setInterval(outputAll, config.keepAliveMs);

    const feedbackHeartbeat = setInterval(broadcastState, config.feedbackHeartbeatMs);

    // On boot, wait briefly for the console to announce itself before lighting up.
    const startupTimer = setTimeout(() => {
      if (state.consoleActive) {
        logger.info("Startup: console detected, desk in control");
        return;
      }
      const restore = state.activeScenes.filter((id) => scenes[id]);
      if (restore.length) {
        logger.info(`Startup: no console, restoring scenes [${restore.join(",")}]`);
        for (const id of restore) setLayer(id, true, config.defaultFadeOnConsoleLost, 0);
        commit();
      } else if (scenes[config.defaultSceneOnConsoleLost]) {
        logger.info(`Startup: no console, recalling default scene ${config.defaultSceneOnConsoleLost}`);
        setLayer(config.defaultSceneOnConsoleLost, true, config.defaultFadeOnConsoleLost, 0);
        commit();
      } else {
        logger.info("Startup: no console, and no scene to recall yet");
      }
    }, config.startupGraceMs);

    broadcastState();

    return function stop() {
      clearInterval(watchdog);
      clearInterval(keepAlive);
      clearInterval(feedbackHeartbeat);
      clearTimeout(startupTimer);
      stopRender();
    };
  }

  return { start, handleOsc, onDmx, state };
}

module.exports = { createEngine };
