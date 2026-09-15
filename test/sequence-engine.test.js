// End to end: a synthetic desk plays a colour chase and pan/tilt circles in real
// time; the recorder captures it and stops by itself; the draft is saved and played
// back through the engine, and the output is compared with what the desk would
// have been sending at the same moment.
//
//   node test/sequence-engine.test.js      (~20s)

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { openAppDb } = require("../src/db");
const { createEngine } = require("../src/engine");
const { createRecorder } = require("../src/sequences/recorder");
const { buildModel } = require("../src/sequences/model");
const { rigAt } = require("./sequence-synth");

const quiet = { info() {}, warn() {}, error: console.error };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seq-engine-"));
const db = openAppDb(path.join(dir, "test.db"), { dataDir: dir, logger: quiet });

const config = {
  universes: 2,
  channels: 512,
  outputs: [{ ip: "127.0.0.1", universes: [0, 1] }],
  artnetPort: 6454,
  fadeFrameMs: 40,
  keepAliveMs: 1000,
  feedbackHeartbeatMs: 60000,
  consoleTimeoutMs: 300,
  startupGraceMs: 0,
  defaultFadeOnConsoleLost: 0,
  consoleIp: "10.0.0.1",
};

const sent = { 0: new Uint8Array(512), 1: new Uint8Array(512) };
const output = { sendUniverse: (ip, port, u, data) => sent[u] && sent[u].set(data) };
const recorder = createRecorder({ logger: quiet, channels: 512 });
const engine = createEngine({ config, logger: quiet, db, output, sendOsc() {}, sendRaw() {}, recorder });
const stop = engine.start();

// Desk: universes 0 and 1 of the synthetic rig (no layered sway, no random channel
// — those need a minute or more before the loop can be trusted).
const T0 = 5.2;
function deskFrame(t) {
  const truth = rigAt(t);
  const u1 = truth[1];
  // Undo mover 4's sway so every shape repeats within a few seconds.
  const pan = 32768 + 12000 * Math.cos(2 * Math.PI * (t / 4.3 + 3 / 4));
  const n = Math.round(pan);
  u1[15] = n >> 8;
  u1[16] = n & 255;
  return truth;
}
function packet(data) {
  const p = Buffer.alloc(18 + 512);
  Buffer.from(data).copy(p, 18);
  return p;
}

(async () => {
  recorder.start();
  const recStart = performance.now();
  const desk = setInterval(() => {
    const t = T0 + (performance.now() - recStart) / 1000;
    const f = deskFrame(t);
    engine.onDmx(0, packet(f[0]), 512);
    engine.onDmx(1, packet(f[1]), 512);
  }, 23);

  // Wait for the auto stop and final analysis.
  const deadline = Date.now() + 60000;
  while (recorder.status().state !== "review") {
    assert(Date.now() < deadline, `no auto stop: ${JSON.stringify(recorder.status())}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  clearInterval(desk);
  const st = recorder.status();
  console.log(`auto stopped (${st.stoppedBy}) after ${(st.elapsedMs / 1000).toFixed(1)}s`);
  for (const g of st.draft.groups) console.log(`  group ${g.key}: ${g.period && g.period.toFixed(4)}s · ${g.channels} ch · score ${(g.score * 100).toFixed(1)}%`);
  assert.strictEqual(st.stoppedBy, "auto");
  assert(st.draft.locked);

  // Desk goes away → hold; then play the sequence (instant).
  await new Promise((r) => setTimeout(r, 600));
  assert(!engine.getState().consoleActive, "desk should have timed out");

  const model = buildModel(recorder.getDraft(), { includeStill: true });
  const id = engine.createSequence("test chase", model);
  recorder.discard();
  engine.handleOsc({ address: `/sequence/${id}/on`, args: [0] });
  const playStart = Date.now();
  const s = engine.getState().sequences.find((x) => x.id === id);
  assert(s.on && s.periods.length === 2, JSON.stringify(s));

  // Compare output with the desk at the same point in the loop, over a few seconds.
  let colourErr = 0;
  let panErr = 0;
  let n = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 97));
    const t = T0 + (Date.now() - playStart) / 1000;
    const truth = deskFrame(t);
    for (let ch = 0; ch < 9; ch++) colourErr += Math.abs(sent[0][ch] - truth[0][ch]);
    for (let f = 0; f < 4; f++) {
      const got = sent[1][f * 5] * 256 + sent[1][f * 5 + 1];
      const want = truth[1][f * 5] * 256 + truth[1][f * 5 + 1];
      panErr += Math.abs(got - want) / 256;
    }
    assert.strictEqual(sent[0][14], 255, "still blue house lights on");
    assert.strictEqual(sent[1][4], 255, "still mover dimmer on");
    n++;
  }
  colourErr /= n * 9;
  panErr /= n * 4;
  console.log(`playback error: colour ${colourErr.toFixed(2)}, pan ${panErr.toFixed(2)} coarse steps`);
  // Timer jitter (~±10ms here) alone is worth a few steps on a fast chase edge.
  assert(colourErr < 12, "colour chase follows the desk");
  assert(panErr < 4, "pan follows the desk");

  // Fade out, then gone.
  engine.handleOsc({ address: `/sequence/${id}/off`, args: [0.3] });
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(sent[0][14], 0, "sequence released");
  assert.deepStrictEqual(engine.getState().activeSequences, []);

  stop();
  recorder.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("SEQUENCE ENGINE TESTS OK");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
