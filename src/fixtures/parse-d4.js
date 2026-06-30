// Parse an Avolites Titan ".d4" personality (XML) into our compact shape:
//   { manufacturer, name, short, modes: [{ name, channels, attrs: [...] }] }
// where each attr is { id, name, group, size, fade, offsets:[1-based channels] }.
//
// Two library eras are handled:
//   - old:  <Mode><Include><Attribute ChannelOffset=…></Include></Mode>
//   - new:  <Mode><Cells><Master><Attribute ChannelOffset=…></Master>
//                        <Cell ChannelOffset=base ModeLink="Cell">…</Cell></Cells></Mode>
//           (per-cell channels come from the linked, hidden "Cell" mode, offset by base)

const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["Attribute", "Function", "Mode", "Cell"].includes(name),
});

// Continuous single-function intensity/colour/position channels fade; everything
// else (discrete multi-function selections, control/special groups) snaps.
function deriveFade(group, functionCount) {
  if (functionCount > 1) return false;
  return group === "I" || group === "C" || group === "P";
}

// A discrete function/slot, e.g. { name: "Gobo 3", min: 40, max: 49 }.
function parseFn(fn) {
  const [a, b] = String(fn["@_Dmx"] || "").split("~").map((s) => parseInt(s, 10));
  if (!Number.isFinite(a)) return null;
  return { name: fn["@_Name"] || "", min: a, max: Number.isFinite(b) ? b : a };
}

function parseOffsets(raw, base) {
  return String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => n + base);
}

// Recursively gather channel-mapped attributes within a mode node, expanding
// cells via their ModeLink. `base` is added to every ChannelOffset.
function collectAttrs(node, base, ctx, out, prefix, depth) {
  if (!node || typeof node !== "object" || depth > 8) return;

  if (Array.isArray(node.Attribute)) {
    for (const a of node.Attribute) {
      const co = a["@_ChannelOffset"];
      if (co === undefined) continue; // e.g. cell-template attrs in <Master> carry no offset
      const id = a["@_ID"];
      const def = ctx.control[id];
      const offsets = parseOffsets(co, base);
      if (!offsets.length) continue;
      out.push({
        id,
        name: (prefix ? prefix + " " : "") + (def ? def.name : id),
        group: def ? def.group : "",
        size: def ? def.size : 1,
        fade: def ? def.fade : true,
        offsets,
        ...(def && def.functions ? { functions: def.functions } : {}),
      });
    }
  }

  if (Array.isArray(node.Cell)) {
    for (const c of node.Cell) {
      const cbase = (Number(c["@_ChannelOffset"]) || 1) - 1 + base;
      const linked = c["@_ModeLink"] && ctx.modes[c["@_ModeLink"]];
      if (linked) {
        collectAttrs(linked, cbase, ctx, out, c["@_Name"] || c["@_ID"] || "Cell", depth + 1);
      }
    }
  }

  // Descend into structural containers (Include, Cells, Master, …) but not into
  // Attribute/Cell (already handled) to find nested attribute lists.
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_") || k === "Attribute" || k === "Cell" || k === "#text") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => collectAttrs(x, base, ctx, out, prefix, depth + 1));
    else if (v && typeof v === "object") collectAttrs(v, base, ctx, out, prefix, depth + 1);
  }
}

function parseD4(xml) {
  const doc = parser.parse(xml);
  const f = doc.Fixture;
  if (!f) throw new Error("no <Fixture> element");

  // Control: attribute definitions (group, size, fade).
  const control = {};
  const ctrlAttrs = (f.Control && f.Control.Attribute) || [];
  for (const a of ctrlAttrs) {
    const id = a["@_ID"];
    const group = a["@_Group"] || "";
    const fns = a.Function || [];
    control[id] = {
      name: a["@_Name"] || id,
      group,
      size: Number(a["@_Size"]) || 1,
      fade: deriveFade(group, fns.length),
      // Keep discrete slots (gobo/colour-wheel/shutter modes); skip continuous.
      functions: fns.length > 1 ? fns.map(parseFn).filter(Boolean) : undefined,
    };
  }

  const allModes = f.Mode || [];
  const modesByName = {};
  for (const m of allModes) modesByName[m["@_Name"]] = m;
  const ctx = { control, modes: modesByName };

  const modes = allModes
    .filter((m) => m["@_Hidden"] !== "True") // skip hidden cell templates
    .map((m) => {
      const attrs = [];
      collectAttrs(m, 0, ctx, attrs, "", 0);
      // de-dupe by id+offsets (defensive against odd nesting)
      const seen = new Set();
      const unique = attrs.filter((a) => {
        const key = a.id + ":" + a.offsets.join(",");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        name: m["@_Name"] || "",
        channels: Number(m["@_Channels"]) || 0,
        attrs: unique,
      };
    });

  return {
    manufacturer: f["@_Company"] || "",
    name: f["@_Name"] || "",
    short: f["@_ShortName"] || "",
    modes,
  };
}

module.exports = { parseD4, deriveFade };
