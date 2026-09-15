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
// Console failover (hold on fail):
//   - While the console sends Art-Net it owns the rig; the Pi stops outputting
//     (piOutputEnabled = false) but still captures the desk's levels — on every
//     universe it sends — so a record snapshots what's on stage.
//   - When the console falls silent past consoleTimeoutMs, the Pi takes over by
//     HOLDING the desk's last look (the __desk__ layer) — no change on stage. It
//     stays held until someone acts: any scene command (on/off/toggle/play, all
//     off) or an explicit hold release crossfades out of it over that command's
//     fade. The held look is persisted, so a restart mid-hold resumes the hold.
//   - Scene control is BLOCKED while the console is live. Recording IS allowed.
//
// Channel types (per patched channel):
//   - level  — normal: scales with a layer's fade level, or snaps if marked snap.
//   - switch — on/off (non-dim / hot power): always exactly 0 or 255 (≥128 = on).
//     Like a snap channel it comes on the instant its layer starts fading in and
//     only goes off once the layer has fully faded out, so power is never cut while
//     the lamps it feeds are still fading.
//
// Sequences (recorded chases/effects, see src/sequences/):
//   - Each running sequence is a layer keyed "seq:<id>" with its own fade and a
//     clock starting when it was switched on.
//   - Its still channels (a lit look, e.g. blue house lights) join the HTP merge
//     like a scene.
//   - Its moving channels override whatever scenes put there (LTP), blended by
//     the sequence's fade level. Where two sequences move the same channel, the one
//     started last wins.
//   - While any sequence runs, the render loop runs continuously.

const { compileModel, motionValue, describeModel } = require("./sequences/model");

const now = () => Date.now();

const SNAP = 1;
const SWITCH = 2;
const SWITCH_ON_AT = 128;
// Universes grow on demand (a desk sending a higher universe, a scene or output
// using one) up to this many — all of Art-Net Net 0. Bounded so one stray packet
// can't make every render frame walk thousands of empty universes.
const MAX_UNIVERSES = 256;
// Frame interval while a sequence is running (smooth movement needs more than fades do).
const SEQUENCE_FRAME_MS = 20;
// Layer-id prefix for sequences, so they share the layer machinery with scenes.
const SEQ = "seq:";
const isSeq = (id) => id.startsWith(SEQ);

function createEngine({ config, logger, db, output, sendOsc, sendRaw, recorder }) {
  let U = config.universes; // grows via ensureUniverses()
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

  // Recorded looks: scenes[id] = { label, favourite, data } where data is array(U) of
  // arrays(C), values 0..255.
  const scenes = db.loadScenes();

  function saveScene(id) {
    db.saveScene(id, scenes[id]);
  }

  // Recorded sequences: sequences[id] = { label, created, model, compiled }.
  const sequences = db.loadSequences();
  for (const id of Object.keys(sequences)) sequences[id].compiled = compileModel(sequences[id].model);

  // Patch — fixtures placed at addresses. Each entry carries resolved per-channel
  // `fade` and `types` arrays (from its personality + user overrides), so the engine
  // never needs the fixture library at runtime. Compiled into
  // snapMap[universe][channel] (0 = fade, SNAP, SWITCH) plus a list of switch channels.
  let patch = db.loadPatch();
  let snapMap = Array.from({ length: U }, () => new Uint8Array(C));
  let switchChannels = []; // [universe, 0-based channel]

  function compileSnapMap() {
    snapMap = Array.from({ length: U }, () => new Uint8Array(C));
    switchChannels = [];
    for (const fx of patch.fixtures) {
      const u = fx.universe | 0;
      if (u < 0 || u >= U) continue;
      const base = (fx.address | 0) - 1; // 0-based start channel
      const fade = Array.isArray(fx.fade) ? fx.fade : [];
      const types = Array.isArray(fx.types) ? fx.types : [];
      for (let ch = 0; ch < (fx.channels | 0); ch++) {
        const abs = base + ch;
        if (abs < 0 || abs >= C) continue;
        if (types[ch] === "switch") {
          snapMap[u][abs] = SWITCH;
          switchChannels.push([u, abs]);
        } else if (fade[ch] === false) {
          snapMap[u][abs] = SNAP;
        }
      }
    }
  }
  compileSnapMap();

  // Force switch channels to exactly off/on in the output buffer.
  function applySwitches() {
    for (const [u, ch] of switchChannels) current[u][ch] = current[u][ch] >= SWITCH_ON_AT ? 255 : 0;
  }

  // Scene editor / live programmer.
  const editor = {
    active: false,
    sceneId: null,
    buf: Array.from({ length: U }, () => new Uint8Array(C)),
    restore: null, // scene ids that were live before editing, restored on exit
  };

  // Programmer: ad-hoc live control (Fixtures page). Touched channels override the
  // scene/layer output (LTP), leaving everything else playing underneath.
  const programmer = {
    active: false,
    buf: Array.from({ length: U }, () => new Uint8Array(C)),
    touched: Array.from({ length: U }, () => new Uint8Array(C)),
    restore: null, // scene ids that were live before the programmer took over
    source: null, // scene id being edited, when loaded from a scene
  };

  // Grow every per-universe buffer so universes 0..n-1 exist. Returns false (and
  // logs once) past MAX_UNIVERSES.
  let warnedMaxUniverses = false;
  function ensureUniverses(n) {
    if (n <= U) return true;
    if (n > MAX_UNIVERSES) {
      if (!warnedMaxUniverses) {
        warnedMaxUniverses = true;
        logger.warn(`Universe ${n - 1} ignored — only universes 0–${MAX_UNIVERSES - 1} are supported`);
      }
      return false;
    }
    for (let u = U; u < n; u++) {
      current.push(new Uint8Array(C));
      snapMap.push(new Uint8Array(C));
      editor.buf.push(new Uint8Array(C));
      programmer.buf.push(new Uint8Array(C));
      programmer.touched.push(new Uint8Array(C));
    }
    logger.info(`Universes: now handling 0–${n - 1}`);
    U = n;
    compileSnapMap(); // patch entries on the new universes now apply
    return true;
  }
  // Start with enough universes for everything already configured or stored.
  ensureUniverses(
    Math.max(
      U,
      ...Object.values(scenes).map((s) => (s.data || []).length),
      ...Object.values(sequences).map((s) => s.compiled.universes),
      ...(config.outputs || []).flatMap((o) => o.universes || []).map((u) => u + 1),
      ...patch.fixtures.map((f) => (f.universe | 0) + 1)
    )
  );

  // Runtime layer state per scene id:
  //   { level: 0..1, target: 0|1, fadeFrom: 0..1, fadeStart: ms, fadeDur: ms }
  const layers = {};

  // Persisted: which scene ids were on (restored on boot).
  const persistedActive = db.getActiveScenes();
  const persistedSequences = db.getActiveSequences();
  const state = {
    consoleActive: false, // effective state (override applied) — drives behaviour & feedback
    consoleDetected: false, // raw network detection (packets + watchdog)
    consoleOverride: "auto", // "auto" | "on" | "off" — not persisted (resets to auto on boot)
    piOutputEnabled: true,
    lastConsolePacket: 0,
    activeScenes: persistedActive.filter((id) => scenes[id]),
    activeSequences: persistedSequences.filter((id) => sequences[id]),
  };

  // Desk-traffic stats for the dashboard (updated on the DMX hot path: counters only).
  const desk = {
    packets: 0, // total ArtDMX from the console IP since start
    rate: 0, // packets/s over the last second
    rateCount: 0,
    universes: new Map(), // universe → last packet time
    firstSeen: 0,
  };

  let renderTimer = null;
  let lastFadeEmit = 0;
  const round1 = (x) => Math.round(x * 10) / 10;

  // Activity log — a ring buffer of user-relevant events, surfaced to the web UI
  // (and still written to the normal log so journald keeps a record).
  const activityLog = [];
  function event(type, message) {
    logger.info(message);
    activityLog.push({ t: now(), type, message });
    if (activityLog.length > 100) activityLog.shift();
  }

  // ---------------- LAYER STATE ----------------

  function cmpIds(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function ensureLayer(id) {
    if (!layers[id]) {
      layers[id] = { level: 0, target: 0, fadeFrom: 0, fadeStart: 0, fadeDur: 0, startedAt: now() };
    }
    return layers[id];
  }

  // Internal layer holding the desk's last output after the desk goes away (hold on
  // fail). Not a real scene, so it never appears in scene feedback / active scenes.
  const DESK_LAYER = "__desk__";

  // Hold a look (default: the desk's last frame) at full, instantly. Persisted so a
  // restart mid-hold comes back holding the same look.
  function holdLook(values) {
    const L = ensureLayer(DESK_LAYER);
    L.values = values || current.map((u) => Uint8Array.from(u));
    L.level = 1;
    L.target = 1;
    L.fadeFrom = 1;
    L.fadeStart = now();
    L.fadeDur = 0;
    db.setHeldLook(L.values);
  }

  function isHolding() {
    return !!layers[DESK_LAYER] && layers[DESK_LAYER].target === 1;
  }

  // Crossfade out of the held look. No-op when nothing is held.
  function releaseHold(fadeSeconds) {
    if (!isHolding()) return false;
    setLayer(DESK_LAYER, false, fadeSeconds);
    db.setHeldLook(null);
    event("console", `Released held desk look${Number(fadeSeconds) ? ` (${Number(fadeSeconds)}s)` : ""}`);
    return true;
  }

  // Begin moving a layer toward a target over fadeSeconds. `on` is true/false
  // (full / off) or a number 0..1 for a partial level (the dashboard faders).
  // Any target above 0 counts as "on" for intent, feedback and persistence.
  function setLayer(id, on, fadeSeconds, fromLevel) {
    const L = ensureLayer(id);
    if (fromLevel !== undefined) L.level = fromLevel;
    L.target = typeof on === "number" ? Math.min(1, Math.max(0, on)) : on ? 1 : 0;
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

  // Scene ids that are on by intent (target = 1), sorted. Excludes the held desk look.
  function onIds() {
    return Object.keys(layers)
      .filter((id) => id !== DESK_LAYER && !isSeq(id) && layers[id].target > 0)
      .sort(cmpIds);
  }

  // Sequence ids that are on by intent, sorted.
  function seqOnIds() {
    return Object.keys(layers)
      .filter((id) => isSeq(id) && layers[id].target > 0)
      .map((id) => id.slice(SEQ.length))
      .sort(cmpIds);
  }

  // Every scene and sequence layer that's on — what the editor/programmer stash
  // and bring back.
  function liveLayerIds() {
    return Object.keys(layers).filter((id) => id !== DESK_LAYER && layers[id].target > 0);
  }

  // Bring stashed layers back on instantly (sequences restart from their top).
  function restoreLayers(ids) {
    for (const id of ids) {
      if (isSeq(id) ? !sequences[id.slice(SEQ.length)] : !scenes[id]) continue;
      if (isSeq(id) && layers[id] && layers[id].level === 0) layers[id].startedAt = now();
      setLayer(id, true, 0);
    }
  }

  // A sequence layer is contributing (fading in, running, or fading out).
  function sequenceRunning() {
    return Object.keys(layers).some((id) => isSeq(id) && (layers[id].level > 0 || layers[id].target > 0));
  }

  // ---------------- RENDER (HTP) ----------------

  function renderToCurrent() {
    for (let u = 0; u < U; u++) current[u].fill(0);
    for (const id of Object.keys(layers)) {
      if (isSeq(id)) continue; // applied after the scenes, below
      const L = layers[id];
      // A layer fading in (target on) counts as on for snap/switch channels from
      // its very first frame, even while its level is still exactly 0.
      const on = L.level > 0 || L.target > 0;
      if (!on) continue;
      const vals = L.values || (scenes[id] && scenes[id].data); // desk layer carries its own snapshot
      if (!vals) continue;
      const lvl = L.level;
      for (let u = 0; u < U; u++) {
        const src = vals[u];
        if (!src) continue;
        const dst = current[u];
        const snapU = snapMap[u];
        const n = Math.min(C, src.length);
        for (let ch = 0; ch < n; ch++) {
          const raw = src[ch];
          // Snap and switch channels (shutters, control, hot power…) jump to value
          // while the layer is on at all, rather than scaling with the fade level.
          const v = snapU[ch] ? raw : lvl >= 1 ? raw : Math.round(raw * lvl);
          if (v > dst[ch]) dst[ch] = v;
        }
      }
    }
    applySequences(now());
  }

  // Sequences on top of the scene merge: stills HTP, then movement LTP in start order.
  function applySequences(t) {
    const running = Object.keys(layers)
      .filter((id) => isSeq(id) && (layers[id].level > 0 || layers[id].target > 0) && sequences[id.slice(SEQ.length)])
      .map((id) => ({ L: layers[id], seq: sequences[id.slice(SEQ.length)].compiled }))
      .sort((a, b) => a.L.startedAt - b.L.startedAt);
    if (!running.length) return;
    for (const { L, seq } of running) {
      const lvl = L.level;
      for (let i = 0; i < seq.stillV.length; i++) {
        const u = seq.stillU[i];
        const ch = seq.stillCh[i];
        if (u >= U || ch >= C) continue;
        const raw = seq.stillV[i];
        const v = snapMap[u][ch] ? raw : lvl >= 1 ? raw : Math.round(raw * lvl);
        if (v > current[u][ch]) current[u][ch] = v;
      }
    }
    for (const { L, seq } of running) {
      const lvl = L.level;
      const at = (t - L.startedAt) / 1000;
      for (const m of seq.motion) {
        if (m.u >= U) continue;
        const dst = current[m.u];
        const v = motionValue(m, at);
        if (m.wide) {
          if (m.ch + 1 >= C) continue;
          const cur = dst[m.ch] * 256 + dst[m.ch + 1];
          const out = lvl >= 1 ? v : Math.round(cur + (v - cur) * lvl);
          dst[m.ch] = out >> 8;
          dst[m.ch + 1] = out & 255;
        } else {
          if (m.ch >= C) continue;
          // Snap channels (colour wheels, gobos…) take the sequence value outright.
          dst[m.ch] = lvl >= 1 || snapMap[m.u][m.ch] ? v : Math.round(dst[m.ch] + (v - dst[m.ch]) * lvl);
        }
      }
    }
  }

  function outputAll() {
    if (!state.piOutputEnabled) return;
    for (const node of config.outputs) {
      const port = node.port || config.artnetPort;
      const ip = (node.ip || "").trim() || "255.255.255.255"; // no IP → broadcast
      for (const universe of node.universes) {
        if (universe >= U) continue;
        output.sendUniverse(ip, port, universe, current[universe], (node.source || "").trim() || undefined);
      }
    }
  }

  // Render the current instant and push it out.
  function renderAndOutput() {
    if (editor.active) {
      // Programmer mode: output the editor buffer verbatim (WYSIWYG of the scene
      // being built), bypassing the layer/HTP render.
      for (let u = 0; u < U; u++) current[u].set(editor.buf[u]);
      applySwitches();
      outputAll();
      return;
    }
    advanceLayers(now());
    renderToCurrent();
    if (programmer.active) {
      for (let u = 0; u < U; u++) {
        const t = programmer.touched[u];
        const b = programmer.buf[u];
        const dst = current[u];
        for (let ch = 0; ch < C; ch++) if (t[ch]) dst[ch] = b[ch];
      }
    }
    applySwitches();
    outputAll();
  }

  // Run a frame loop while something is fading or a sequence is running.
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
        const emit = isSeq(id) ? (sequences[id.slice(SEQ.length)] ? () => emitSequence(id.slice(SEQ.length)) : null) : scenes[id] ? () => emitScene(id) : null;
        if (!emit) continue;
        const L = layers[id];
        if (L.level !== L.target) {
          L.wasFading = true;
          if (throttle) emit();
        } else if (L.wasFading) {
          L.wasFading = false;
          emit();
        }
      }
      if (anyFading() || sequenceRunning()) {
        renderTimer = setTimeout(tick, frameMs());
      } else {
        renderTimer = null;
        cleanupLayers();
        emitFade();
        broadcastScenes();
      }
    };
    renderTimer = setTimeout(tick, frameMs());
  }

  function frameMs() {
    return sequenceRunning() ? Math.min(SEQUENCE_FRAME_MS, config.fadeFrameMs) : config.fadeFrameMs;
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
    if (anyFading() || sequenceRunning()) scheduleRender();
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
    sendOsc("/scene-setter/active-sequences", [{ type: "s", value: seqOnIds().join(",") }]);
    pushVar("active_sequences", seqOnIds().join(","), "s");
    pushVar("console_active", state.consoleActive ? 1 : 0, "i");
    pushVar("active_scenes", onIds().join(","), "s");
    // Editor lock: which scene is being live-edited ("" = none). While set, OSC
    // control commands are ignored so the edited scene can't be toggled remotely.
    sendOsc("/scene-setter/editing", [{ type: "s", value: editor.active ? String(editor.sceneId) : "" }]);
    pushVar("editing", editor.active ? String(editor.sceneId) : "", "s");
    sendOsc("/scene-setter/programmer", [{ type: "i", value: programmer.active ? 1 : 0 }]);
    pushVar("programmer", programmer.active ? 1 : 0, "i");
    // Holding the desk's last look after the desk went away (1) — press a scene to take over.
    const holding = !state.consoleActive && isHolding();
    sendOsc("/scene-setter/holding", [{ type: "i", value: holding ? 1 : 0 }]);
    pushVar("holding", holding ? 1 : 0, "i");
  }

  // Tri-state per scene: 0 = off, 1 = on (settled), 2 = fading (in or out).
  // Always 0 while the desk is in control or Pi output is disabled.
  function sceneState(id) {
    if (state.consoleActive || !state.piOutputEnabled) return 0;
    const L = layers[id];
    if (!L) return 0;
    if (L.level !== L.target) return 2;
    return L.target > 0 ? 1 : 0;
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
    for (const id of Object.keys(sequences)) emitSequence(id);
  }

  // Same tri-state as scenes, on /scene-setter/sequence/<id>/active.
  function emitSequence(id) {
    sendOsc(`/scene-setter/sequence/${id}/active`, [{ type: "i", value: sceneState(SEQ + id) }]);
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
    db.setActiveScenes(onIds());
    db.setActiveSequences(seqOnIds());
  }

  // ---------------- CONSOLE FAILOVER ----------------

  // Effective console state = override if forced, else the network detection.
  function effectiveConsole() {
    if (state.consoleOverride === "on") return true;
    if (state.consoleOverride === "off") return false;
    return state.consoleDetected;
  }

  // `reason` (optional) says why, for the activity log: "detected" | "lost".
  function recomputeConsole(reason) {
    const active = effectiveConsole();
    if (reason && state.consoleActive === active) {
      // Detection changed but the override pins the effective state: still worth a line.
      const pinned = state.consoleOverride === "off" ? "override is OFF, desk ignored" : "override is ON, desk stays in control";
      event("console", reason === "detected" ? `Desk detected at ${config.consoleIp} (${pinned})` : `Desk Art-Net stopped (${pinned})`);
    }
    applyConsoleActive(active, reason);
  }

  // mode: "on" (force live) | "off" (force ignore desk) | "auto" (network detection)
  function setConsoleOverride(mode) {
    if (!["on", "off", "auto"].includes(mode)) mode = "auto";
    state.consoleOverride = mode;
    event("override", `Console override → ${mode}`);
    recomputeConsole(); // apply any change to the effective state
    broadcastTop(); // always publish the override + effective state
  }

  function applyConsoleActive(active, reason) {
    if (state.consoleActive === active) return;
    state.consoleActive = active;

    if (active) {
      stopRender(); // desk takes over; stop controller rendering
      state.piOutputEnabled = false;
      // Whatever the Pi was holding or playing is superseded by the desk's look.
      db.setHeldLook(null);
      event(
        "console",
        reason === "detected"
          ? `Desk detected at ${config.consoleIp}: desk in control, Pi output off`
          : "Desk forced live: desk in control, Pi output off"
      );
      broadcastState();
    } else {
      state.piOutputEnabled = true;
      // Hold on fail: keep outputting exactly what the desk last sent. Any scenes
      // from before the desk took over are dropped so they can't mix into the hold;
      // the next scene command crossfades out of the held look.
      for (const id of Object.keys(layers)) if (id !== DESK_LAYER) delete layers[id];
      holdLook();
      event(
        "console",
        reason === "lost"
          ? `Desk lost (no Art-Net for ${(config.consoleTimeoutMs / 1000).toFixed(1)}s): Pi took over, holding the desk's last look`
          : "Desk ignored: Pi took over, holding the desk's last look"
      );
      persist();
      commit();
    }
  }

  // Hot path: NO disk writes. While the console is live, current holds desk levels but
  // outputAll is suppressed (piOutputEnabled = false).
  function onDmx(universe, packet, length) {
    const t = now();
    state.lastConsolePacket = t;
    desk.packets++;
    desk.rateCount++;
    if (!desk.firstSeen) desk.firstSeen = t;
    desk.universes.set(universe, t);
    if (recorder) recorder.onFrame(universe, packet, length); // sequence recording, whoever is in control
    if (!state.consoleDetected) {
      state.consoleDetected = true;
      recomputeConsole("detected");
    }
    // If the effective console state is off (e.g. forced off), ignore the desk's data
    // entirely — don't let it corrupt the Pi's own render.
    if (!state.consoleActive) return;
    // Capture every universe the desk sends (growing the buffers on first sight).
    if (universe >= U && !ensureUniverses(universe + 1)) return;

    const n = Math.min(length, C, packet.length - 18);
    const buf = current[universe];
    for (let i = 0; i < n; i++) buf[i] = packet[18 + i];
  }

  // ---------------- SCENE COMMANDS ----------------

  function consoleBlocked(action) {
    logger.warn(`${action} ignored — console is live`);
    sendOsc("/scene-setter/error", [{ type: "s", value: "Console active — scene control disabled" }]);
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
    const label = scenes[id] ? scenes[id].label : "";
    const favourite = scenes[id] ? !!scenes[id].favourite : false;
    scenes[id] = { label, favourite, data: current.map((u) => Array.from(u)) };
    saveScene(id);
    event("record", `Recorded scene ${id}`);
    sendOsc("/scene-setter/recorded", [{ type: "s", value: String(id) }]);
    broadcastScenes(); // publish the new scene's feedback path
  }

  // Next free integer id (as a string).
  function nextSceneId() {
    let n = 1;
    while (scenes[String(n)]) n++;
    return String(n);
  }

  // Create an empty scene (no data until recorded) with a label. Returns its id.
  function createScene(label) {
    const id = nextSceneId();
    scenes[id] = { label: typeof label === "string" ? label : "", favourite: false, data: [] };
    saveScene(id);
    event("scene", `Created scene ${id}${scenes[id].label ? ` "${scenes[id].label}"` : ""}`);
    broadcastScenes();
    return id;
  }

  function setSceneLabel(id, label) {
    if (!scenes[id]) return false;
    scenes[id].label = typeof label === "string" ? label : "";
    db.setSceneLabel(id, scenes[id].label);
    broadcastScenes();
    return true;
  }

  // Favourites are pinned to the dashboard console.
  function setSceneFavourite(id, favourite) {
    if (!scenes[id]) return false;
    scenes[id].favourite = !!favourite;
    db.setSceneFavourite(id, scenes[id].favourite);
    return true;
  }

  function deleteScene(id) {
    if (!scenes[id]) return false;
    delete scenes[id];
    if (layers[id]) delete layers[id]; // drop any live contribution
    db.deleteScene(id);
    persist();
    event("scene", `Deleted scene ${id}`);
    commit(); // re-render without it + publish
    return true;
  }

  // The raw stored object for the editor: { label, data }.
  function getSceneRaw(id) {
    return scenes[id] ? { label: scenes[id].label, data: scenes[id].data } : null;
  }

  // Replace a scene from a raw object (validated). Throws on invalid input.
  function setSceneRaw(id, obj) {
    if (!scenes[id]) throw new Error(`Scene ${id} not found`);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("Expected an object { label, data }");
    }
    const label = typeof obj.label === "string" ? obj.label : "";
    if (!Array.isArray(obj.data)) throw new Error("`data` must be an array of universes");
    if (obj.data.length > MAX_UNIVERSES) throw new Error(`Too many universes (max ${MAX_UNIVERSES})`);
    const data = obj.data.map((row, u) => {
      if (!Array.isArray(row)) throw new Error(`data[${u}] must be an array of channel values`);
      if (row.length > C) throw new Error(`data[${u}] has too many channels (max ${C})`);
      return row.map((v, ch) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 255) {
          throw new Error(`data[${u}][${ch}] must be an integer 0–255`);
        }
        return n;
      });
    });
    ensureUniverses(data.length);
    scenes[id] = { label, favourite: !!scenes[id].favourite, data };
    saveScene(id);
    if (layers[id]) commit(); // re-render if live
    else broadcastScenes();
    return true;
  }

  function setSceneState(id, on, fade) {
    if (state.consoleActive) return void consoleBlocked(`Scene ${id} ${on ? "on" : "off"}`);
    if (!scenes[id]) return void sceneMissing(id);
    if (on) state.piOutputEnabled = true;
    releaseHold(fade); // taking control: crossfade out of any held desk look
    setLayer(id, on, fade);
    event("scene", `Scene ${id} ${on ? "on" : "off"}${Number(fade) ? ` (${Number(fade)}s)` : ""}`);
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
    const isOn = !!L && L.target > 0;
    setSceneState(id, !isOn, fade);
  }

  // Set a scene's level directly (0..1) — the dashboard faders. 0 turns it off,
  // anything above 0 turns it on at that level. Only logs when the on/off intent
  // changes, so dragging a fader doesn't flood the activity log.
  function sceneSetLevel(id, level, fade) {
    if (state.consoleActive) return void consoleBlocked(`Scene ${id} level`);
    if (!scenes[id]) return void sceneMissing(id);
    const lvl = Math.min(1, Math.max(0, Number(level) || 0));
    const wasOn = !!layers[id] && layers[id].target > 0;
    if (lvl > 0) state.piOutputEnabled = true;
    releaseHold(fade);
    setLayer(id, lvl, fade);
    if (wasOn !== lvl > 0) {
      event("scene", `Scene ${id} ${lvl > 0 ? `on at ${Math.round(lvl * 100)}%` : "off"} (fader)`);
    }
    persist();
    commit();
  }

  // Exclusive recall ("full look"): this scene on, all others off.
  function sceneSolo(id, fade) {
    if (state.consoleActive) return void consoleBlocked(`Solo scene ${id}`);
    if (!scenes[id]) return void sceneMissing(id);
    state.piOutputEnabled = true;
    releaseHold(fade);
    for (const other of Object.keys(layers)) {
      if (other !== String(id)) setLayer(other, false, fade);
    }
    setLayer(id, true, fade);
    event("scene", `Solo scene ${id}${Number(fade) ? ` (${Number(fade)}s)` : ""}`);
    persist();
    commit();
  }

  function scenesOff(fade) {
    if (state.consoleActive) return void consoleBlocked("All scenes off");
    releaseHold(fade);
    for (const id of Object.keys(layers)) setLayer(id, false, fade);
    event("scenes", `All scenes and sequences off${Number(fade) ? ` (${Number(fade)}s)` : ""}`);
    persist();
    commit();
  }

  // ---------------- SEQUENCE COMMANDS ----------------

  function sequenceMissing(id) {
    logger.warn(`Sequence ${id} does not exist`);
    sendOsc("/scene-setter/error", [{ type: "s", value: `Sequence ${id} does not exist` }]);
  }

  function setSequenceState(id, on, fade) {
    id = String(id);
    if (state.consoleActive) return void consoleBlocked(`Sequence ${id} ${on ? "on" : "off"}`);
    if (!sequences[id]) return void sequenceMissing(id);
    const key = SEQ + id;
    if (on) {
      state.piOutputEnabled = true;
      // From the top, unless it's still visible (e.g. re-fired mid fade-out).
      const L = layers[key];
      if (!L || L.level === 0) ensureLayer(key).startedAt = now();
    }
    releaseHold(fade);
    setLayer(key, on, fade);
    event("sequence", `Sequence ${id} ${on ? "on" : "off"}${Number(fade) ? ` (${Number(fade)}s)` : ""}`);
    persist();
    commit();
  }

  function sequenceToggle(id, fade) {
    const L = layers[SEQ + id];
    setSequenceState(id, !(L && L.target > 0), fade);
  }

  function sequencesOff(fade) {
    if (state.consoleActive) return void consoleBlocked("All sequences off");
    for (const id of Object.keys(layers)) if (isSeq(id)) setLayer(id, false, fade);
    event("sequence", `All sequences off${Number(fade) ? ` (${Number(fade)}s)` : ""}`);
    persist();
    commit();
  }

  function nextSequenceId() {
    let n = 1;
    while (sequences[String(n)]) n++;
    return String(n);
  }

  // Save a stored model (from the recorder's reviewed draft) as a new sequence.
  function createSequence(label, model) {
    const id = nextSequenceId();
    const created = now();
    const compiled = compileModel(model);
    ensureUniverses(compiled.universes);
    db.insertSequence(id, { label, created, model });
    sequences[id] = { label: label || "", created, model, compiled };
    event("sequence", `Saved sequence ${id}${label ? ` "${label}"` : ""}`);
    broadcastScenes();
    return id;
  }

  function setSequenceLabel(id, label) {
    if (!sequences[id]) return false;
    sequences[id].label = typeof label === "string" ? label : "";
    db.setSequenceLabel(id, sequences[id].label);
    return true;
  }

  function deleteSequence(id) {
    if (!sequences[id]) return false;
    delete layers[SEQ + id];
    delete sequences[id];
    db.deleteSequence(id);
    persist();
    event("sequence", `Deleted sequence ${id}`);
    commit();
    return true;
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

    // While the scene editor OR the programmer is live, lock out control commands
    // so nothing can toggle/override remotely. State requests still answered.
    if (editor.active || programmer.active) {
      if (cmd === "state") return void broadcastState();
      const what = editor.active ? `editing scene ${editor.sceneId}` : "programmer live";
      sendOsc("/scene-setter/error", [{ type: "s", value: `${what} — controls locked` }]);
      return;
    }

    if (cmd === "scene") {
      const id = parts[1];
      const verb = parts[2];
      if (verb === "rec") return void recordScene(id);
      const fade = resolveFade(msg, parts[3]);
      if (verb === "on") return void sceneOn(id, fade);
      if (verb === "off") return void sceneOff(id, fade);
      if (verb === "toggle") return void sceneToggle(id, fade);
      if (verb === "play") return void sceneSolo(id, fade); // exclusive recall
      // /scene/<id>/level <0..1 | 0..100> [fade]
      if (verb === "level") {
        const args = (msg.args || []).map((a) => (a && typeof a === "object" ? a.value : a));
        let lvl = Number(args[0]);
        if (!Number.isFinite(lvl)) lvl = Number(parts[3]);
        if (!Number.isFinite(lvl)) return;
        if (lvl > 1) lvl /= 100; // accept percent too
        const f = Number(args[1]);
        return void sceneSetLevel(id, lvl, Number.isFinite(f) ? f : 0);
      }
    }

    // /sequence/<id>/on|off|toggle [fade]
    if (cmd === "sequence") {
      const id = parts[1];
      const verb = parts[2];
      const fade = resolveFade(msg, parts[3]);
      if (verb === "on") return void setSequenceState(id, true, fade);
      if (verb === "off") return void setSequenceState(id, false, fade);
      if (verb === "toggle") return void sequenceToggle(id, fade);
    }

    // /sequences/off [fade] → every sequence off, scenes untouched
    if (cmd === "sequences" && parts[1] === "off") {
      return void sequencesOff(resolveFade(msg, parts[2]));
    }

    // /scenes/off [fade]  → all layers off (scenes and sequences)
    if (cmd === "scenes" && parts[1] === "off") {
      return void scenesOff(resolveFade(msg, parts[2]));
    }

    // /hold/release [fade] → crossfade out of the held desk look to whatever scenes are on
    if (cmd === "hold" && parts[1] === "release") {
      if (state.consoleActive) return void consoleBlocked("Hold release");
      if (releaseHold(resolveFade(msg, parts[2]))) commit();
      return;
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
        recomputeConsole("lost");
      }
    }, 100);

    const keepAlive = setInterval(outputAll, config.keepAliveMs);

    // Desk packet rate, sampled once a second.
    const deskRate = setInterval(() => {
      desk.rate = desk.rateCount;
      desk.rateCount = 0;
    }, 1000);

    const feedbackHeartbeat = setInterval(broadcastState, config.feedbackHeartbeatMs);

    // On boot, wait briefly for the console to announce itself before lighting up.
    const startupTimer = setTimeout(() => {
      if (state.consoleActive) {
        event("console", "Started: desk already sending, desk in control");
        return;
      }
      // Restarted while holding the desk's last look → keep holding it.
      const held = db.getHeldLook();
      if (held) {
        const unis = held.length;
        if (unis > U) ensureUniverses(Math.min(unis, MAX_UNIVERSES));
        event("console", "Started: no desk, Pi in control, resuming the held desk look");
        holdLook(held);
        commit();
        return;
      }
      const restore = state.activeScenes.filter((id) => scenes[id]);
      const restoreSeq = state.activeSequences.filter((id) => sequences[id]);
      if (restore.length || restoreSeq.length) {
        const what = [restore.length && `scenes ${restore.join(", ")}`, restoreSeq.length && `sequences ${restoreSeq.join(", ")}`].filter(Boolean).join(" and ");
        event("console", `Started: no desk, Pi in control, restoring ${what}`);
        for (const id of restore) setLayer(id, true, config.defaultFadeOnConsoleLost, 0);
        for (const id of restoreSeq) setLayer(SEQ + id, true, config.defaultFadeOnConsoleLost, 0);
        commit();
      } else if (scenes[config.defaultSceneOnConsoleLost]) {
        event("console", `Started: no desk, Pi in control, recalling default scene ${config.defaultSceneOnConsoleLost}`);
        setLayer(config.defaultSceneOnConsoleLost, true, config.defaultFadeOnConsoleLost, 0);
        commit();
      } else {
        event("console", "Started: no desk, Pi in control (no scene to recall yet)");
      }
    }, config.startupGraceMs);

    broadcastState();

    return function stop() {
      clearInterval(watchdog);
      clearInterval(keepAlive);
      clearInterval(deskRate);
      clearInterval(feedbackHeartbeat);
      clearTimeout(startupTimer);
      stopRender();
    };
  }

  // Snapshot for the web API / WS feed.
  // Live display level (0..1) for a scene — what the controller is actually
  // outputting for it (0 while the desk is in control or output is disabled).
  function sceneLevel(id) {
    if (state.consoleActive || !state.piOutputEnabled) return 0;
    const L = layers[id];
    return L ? L.level : 0;
  }

  function getState() {
    const f = fadeStatus();
    const ids = onIds();
    const onSet = new Set(ids);
    return {
      universes: U,
      channels: C,
      editing: editor.active ? editor.sceneId : null,
      programmerActive: programmer.active,
      programmerFrom: programmer.active
        ? [...new Set([programmer.source, ...(programmer.restore || [])].filter(Boolean))].filter((x) => scenes[x])
        : [],
      consoleActive: state.consoleActive,
      consoleOverride: state.consoleOverride,
      controllerOutput: state.piOutputEnabled,
      holding: !state.consoleActive && isHolding(),
      desk: {
        ip: config.consoleIp,
        timeoutMs: config.consoleTimeoutMs,
        detected: state.consoleDetected, // packets arriving (override not applied)
        lastPacketAgoMs: state.lastConsolePacket ? now() - state.lastConsolePacket : null,
        packetsPerSec: desk.rate,
        packets: desk.packets,
        // Universes heard from the desk, with how long since each last arrived.
        universes: [...desk.universes.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([u, t]) => ({ universe: u, agoMs: now() - t })),
      },
      activeScenes: ids,
      scenes: Object.keys(scenes)
        .sort(cmpIds)
        .map((id) => ({
          id,
          label: scenes[id].label,
          favourite: !!scenes[id].favourite,
          on: onSet.has(id), // intent (target > 0) — drives the Activate/Deactivate label
          state: sceneState(id), // 0 off / 1 on / 2 fading
          level: Math.round(sceneLevel(id) * 100) / 100,
          target: layers[id] ? Math.round(layers[id].target * 100) / 100 : 0, // where the fader is heading
          fadeRemaining: round1(sceneFadeRemaining(id)),
        })),
      activeSequences: seqOnIds(),
      sequences: Object.keys(sequences)
        .sort(cmpIds)
        .map((id) => {
          const key = SEQ + id;
          return {
            id,
            label: sequences[id].label,
            created: sequences[id].created,
            on: !!layers[key] && layers[key].target > 0,
            state: sceneState(key),
            level: Math.round(sceneLevel(key) * 100) / 100,
            fadeRemaining: round1(sceneFadeRemaining(key)),
            // Where it is in its loops: ms since it started (null when not playing).
            elapsedMs: layers[key] && (layers[key].level > 0 || layers[key].target > 0) ? now() - layers[key].startedAt : null,
            ...describeModel(sequences[id].model),
          };
        }),
      recording: recorder ? recorder.status() : null,
      fade: { active: f.active, remaining: round1(f.remaining), total: round1(f.total) },
      log: activityLog.slice(-60),
    };
  }

  // Live computed output buffer (array of Uint8Array) for the universe grid.
  function getDmx() {
    return current;
  }

  function getPatch() {
    return patch;
  }

  // ---- Scene editor (live programmer) ----
  function editBegin(sceneId) {
    if (!scenes[sceneId]) return false;
    // Stash whatever was live so we can restore it on exit. Only on first entry —
    // a "revert" re-calls editBegin while already editing and must not clobber it.
    if (!editor.active) editor.restore = liveLayerIds();
    stopRender();
    const data = scenes[sceneId].data || [];
    for (let u = 0; u < U; u++) {
      editor.buf[u].fill(0);
      const row = data[u];
      if (row) for (let ch = 0; ch < Math.min(C, row.length); ch++) editor.buf[u][ch] = row[ch] | 0;
    }
    editor.active = true;
    editor.sceneId = String(sceneId);
    state.piOutputEnabled = true;
    // Entering the editor takes over live output: stop every other scene and make
    // the edited scene the only live one, so OSC/Companion feedback matches what
    // the editor is outputting.
    for (const other of Object.keys(layers)) {
      if (other !== DESK_LAYER) setLayer(other, false, 0);
    }
    setLayer(editor.sceneId, true, 0);
    persist();
    event("scene", `Editing scene ${sceneId} — live, other scenes off, OSC locked`);
    renderAndOutput();
    broadcastState();
    return true;
  }

  function editSet(updates) {
    if (!editor.active) return false;
    for (const x of updates || []) {
      const u = x.universe | 0;
      const ch = (x.channel | 0) - 1;
      const v = Math.max(0, Math.min(255, x.value | 0));
      if (u >= 0 && u < U && ch >= 0 && ch < C) editor.buf[u][ch] = v;
    }
    renderAndOutput();
    return true;
  }

  function editSave() {
    if (!editor.active || !scenes[editor.sceneId]) return false;
    scenes[editor.sceneId] = {
      label: scenes[editor.sceneId].label,
      favourite: !!scenes[editor.sceneId].favourite,
      data: editor.buf.map((u) => Array.from(u)),
    };
    saveScene(editor.sceneId);
    event("record", `Edited scene ${editor.sceneId}`);
    broadcastScenes();
    return true;
  }

  function editEnd() {
    // No auto-save: unsaved edits are discarded (the scene's saved data is
    // unchanged, so the live layer falls back to it on exit).
    const restore = editor.restore || [];
    editor.active = false;
    editor.sceneId = null;
    editor.restore = null;
    // Restore whatever scenes were live before editing: stop the edited scene
    // (and anything else), bring the stashed scenes back on.
    for (const id of Object.keys(layers)) if (id !== DESK_LAYER) setLayer(id, false, 0);
    restoreLayers(restore);
    persist();
    commit();
    return true;
  }

  // ---- Programmer (live ad-hoc control) ----
  function programmerSet(updates) {
    const wasActive = programmer.active;
    if (!wasActive) {
      // Capture whatever is live right now into the programmer so editing
      // continues from the current look, THEN stash & stop the scenes.
      advanceLayers(now());
      renderToCurrent();
      for (let u = 0; u < U; u++) {
        programmer.buf[u].set(current[u]);
        programmer.touched[u].fill(1);
      }
      programmer.restore = liveLayerIds();
      for (const id of Object.keys(layers)) if (id !== DESK_LAYER) setLayer(id, false, 0);
      programmer.active = true;
      if (!state.consoleActive) state.piOutputEnabled = true;
      persist();
      event("scene", "Programmer live — captured current look, scenes off, OSC locked");
    }
    for (const x of updates || []) {
      const u = x.universe | 0;
      const ch = (x.channel | 0) - 1;
      const v = Math.max(0, Math.min(255, x.value | 0));
      if (u >= 0 && u < U && ch >= 0 && ch < C) {
        programmer.buf[u][ch] = v;
        programmer.touched[u][ch] = 1;
      }
    }
    renderAndOutput();
    if (!wasActive) broadcastState(); // publish the scenes-off + lock state once
    return true;
  }
  // Load a scene's stored look into the programmer for editing.
  function programmerLoadScene(id) {
    id = String(id);
    if (!scenes[id]) return false;
    if (!programmer.active) {
      programmer.restore = liveLayerIds();
      for (const l of Object.keys(layers)) if (l !== DESK_LAYER) setLayer(l, false, 0);
      programmer.active = true;
      if (!state.consoleActive) state.piOutputEnabled = true;
    }
    const data = scenes[id].data || [];
    for (let u = 0; u < U; u++) {
      programmer.buf[u].fill(0);
      const row = data[u];
      if (row) for (let ch = 0; ch < Math.min(C, row.length); ch++) programmer.buf[u][ch] = row[ch] | 0;
      programmer.touched[u].fill(1);
    }
    programmer.source = id;
    persist();
    event("scene", `Editing scene ${id} in the programmer`);
    renderAndOutput();
    broadcastState();
    return true;
  }

  function programmerClear() {
    if (!programmer.active) return true;
    const restore = programmer.restore || [];
    programmer.active = false;
    programmer.restore = null;
    programmer.source = null;
    for (let u = 0; u < U; u++) {
      programmer.buf[u].fill(0);
      programmer.touched[u].fill(0);
    }
    // Restore whatever scenes were live before the programmer took over.
    for (const id of Object.keys(layers)) if (id !== DESK_LAYER) setLayer(id, false, 0);
    restoreLayers(restore);
    persist();
    commit();
    return true;
  }
  // Save the current programmer look into a scene (existing id, or a new one).
  function programmerSaveToScene(opts) {
    if (!programmer.active) return null;
    let id = opts && opts.sceneId != null && opts.sceneId !== "" ? String(opts.sceneId) : null;
    if (id) {
      if (!scenes[id]) return null;
    } else {
      id = createScene((opts && opts.label) || "");
    }
    recordScene(id); // snapshots current live output (= the programmer look)
    programmerClear(); // release the programmer and revert to whatever was live
    return id;
  }

  // Fixture map — UI-only layout of fixtures/heads onto the Fixtures grid.
  function getFixtureMap() {
    return db.getFixtureMap();
  }
  function setFixtureMap(next) {
    const map = {
      cols: Math.max(1, (next && next.cols) | 0 || 25),
      rows: Math.max(1, (next && next.rows) | 0 || 25),
      cells: next && next.cells && typeof next.cells === "object" ? next.cells : {},
    };
    db.setFixtureMap(map);
    return map;
  }

  // Replace the patch, persist, recompile the snap map, and re-render.
  function setPatch(next) {
    try {
      db.savePatch(next && Array.isArray(next.fixtures) ? next : { fixtures: [] });
    } finally {
      // Always reload: normalised on success (e.g. switch channels never fade), and
      // on failure it discards any in-place edits the caller made to the old object.
      patch = db.loadPatch();
    }
    compileSnapMap();
    renderAndOutput();
    return patch;
  }

  return {
    start,
    handleOsc,
    onDmx,
    state,
    getState,
    getDmx,
    getPatch,
    setPatch,
    getFixtureMap,
    setFixtureMap,
    programmerSet,
    programmerClear,
    programmerLoadScene,
    programmerSaveToScene,
    editBegin,
    editSet,
    editSave,
    editEnd,
    createScene,
    setSceneLabel,
    setSceneFavourite,
    deleteScene,
    getSceneRaw,
    setSceneRaw,
    createSequence,
    setSequenceLabel,
    deleteSequence,
    getSequenceModel: (id) => (sequences[id] ? sequences[id].model : null),
  };
}

module.exports = { createEngine };
