const assert = require("assert");
const { analyse, valueAt } = require("../src/sequences/analyse");
const synth = require("./sequence-synth");

const t0 = Date.now();
const rec = synth.record(60);
const result = analyse(rec);
const ms = Date.now() - t0;

const find = (u, ch) => result.channels.find((c) => c.universe === u && c.channel === ch);
console.log(`analysed 60s × 3 universes in ${ms}ms`);
for (const g of result.groups) console.log(`  group ${g.key}: period ${g.period ? g.period.toFixed(4) + "s" : "—"} · ${g.channels} ch (${g.wide} 16-bit, ${g.layered} layered) · U${g.universes} · score ${(g.score * 100).toFixed(1)}% · ${g.passes} passes`);
console.log(`  stills: ${result.stillCount} (${result.stillLit} lit) · ready=${result.ready}`);

// Periods found precisely.
const colour = result.groups.find((g) => g.period && Math.abs(g.period - synth.COLOUR_PERIOD) < 0.05);
const circle = result.groups.find((g) => g.period && Math.abs(g.period - synth.CIRCLE_PERIOD) < 0.05);
assert.ok(colour, "colour chase group found");
assert.ok(circle, "circle group found");
console.log(`  period error: colour ${((colour.period / synth.COLOUR_PERIOD - 1) * 1e6).toFixed(0)} ppm, circle ${((circle.period / synth.CIRCLE_PERIOD - 1) * 1e6).toFixed(0)} ppm`);
assert.ok(Math.abs(colour.period / synth.COLOUR_PERIOD - 1) < 0.001, "colour period within 0.1%");
assert.ok(Math.abs(circle.period / synth.CIRCLE_PERIOD - 1) < 0.001, "circle period within 0.1%");

// Stills: blue house lights kept as still values.
assert.strictEqual(find(0, 15).kind, "static");
assert.strictEqual(find(0, 15).value, 255);
assert.strictEqual(find(0, 13).value, 0);

// Layered pan on mover 4 (U1 ch16) has two components.
const layered = find(1, 16);
assert.strictEqual(find(1, 17).kind, "fine", "pan fine detected as the low byte");
assert.strictEqual(layered.wide, true, "pan modelled as 16-bit");
console.log(`  mover 4 pan components: ${layered.components.map((c) => c.period.toFixed(3) + "s").join(" + ")}`);
assert.ok(layered.components.length >= 2, "layered shape separated into components");

// The random channel is flagged irregular.
assert.strictEqual(find(2, 1).irregular, true, "random channel flagged irregular");
// A snap colour chase must never be mistaken for a 16-bit pair.
assert.ok(!result.channels.some((c) => c.universe === 0 && c.kind === "fine"), "no false 16-bit pairs in the colour chase");

// Playback far beyond the recording (10 minutes later) still matches the rig.
function errorAt(from, to) {
  const errs = {};
  const add = (k, e) => (errs[k] = errs[k] || []).push(e);
  for (let t = from; t < to; t += 0.137) {
    const truth = synth.rigAt(rec.startT + t);
    for (let ch = 1; ch <= 9; ch++) add("colour", Math.abs(valueAt(find(0, ch), t) - truth[0][ch - 1]));
    for (let f = 0; f < 4; f++) {
      const b = f * 5;
      for (const [k, off] of [["pan", 0], ["tilt", 2]]) {
        const coarse = find(1, b + off + 1);
        const model16 = valueAt(coarse, t) * 256 + valueAt(find(1, b + off + 2), t, coarse);
        const truth16 = truth[1][b + off] * 256 + truth[1][b + off + 1];
        add(f === 3 && k === "pan" ? "layered pan (16-bit, in coarse steps)" : `${k} (16-bit, in coarse steps)`, Math.abs(model16 - truth16) / 256);
      }
    }
  }
  return Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
}
const soon = errorAt(60, 90);
const later = errorAt(600, 630);
console.log("  mean error just after recording:", JSON.stringify(soon, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)));
console.log("  mean error 10 minutes later:    ", JSON.stringify(later, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)));
assert.ok(later.colour < 8, "colour chase still in step after 10 min");
assert.ok(later["pan (16-bit, in coarse steps)"] < 3, "circle still in step after 10 min");
assert.ok(later["layered pan (16-bit, in coarse steps)"] < 6, "layered shape still in step after 10 min");
console.log("SEQUENCE ANALYSIS TESTS OK");
