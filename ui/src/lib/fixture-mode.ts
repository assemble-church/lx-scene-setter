// Resolve the controllable attributes of a patched fixture.
//
// Library fixtures start from their personality's mode; built-in fixtures (no
// libId, e.g. a generic dimmer pack) are described entirely by the patch. In both
// cases the patch's channel types win: any channel marked "switch" becomes its own
// on/off attribute, replacing whatever the personality said about it.

import { getFixture, type FixtureAttr, type FixtureMode, type PatchFixture } from "@/lib/api";

function patchAttr(fx: PatchFixture, offset: number, fallbackName: string): FixtureAttr {
  const i = offset - 1;
  const isSwitch = fx.types?.[i] === "switch";
  return {
    id: `ch${offset}`,
    name: fx.names?.[i] || fallbackName,
    group: isSwitch ? "S" : "I",
    size: 1,
    fade: !isSwitch && fx.fade?.[i] !== false,
    offsets: [offset],
    ...(isSwitch ? { switch: true } : {}),
  };
}

export function applyPatchChannels(fx: PatchFixture, base: FixtureMode | null): FixtureMode {
  const offsets = Array.from({ length: fx.channels }, (_, i) => i + 1);
  if (!base) {
    return {
      name: fx.mode,
      channels: fx.channels,
      attrs: offsets.map((o) => patchAttr(fx, o, fx.types?.[o - 1] === "switch" ? `Power ${o}` : `Ch ${o}`)),
    };
  }
  const switches = offsets.filter((o) => fx.types?.[o - 1] === "switch");
  if (!switches.length) return base;
  const nameAt = (o: number) => base.attrs.find((a) => a.offsets.includes(o))?.name || `Power ${o}`;
  return {
    ...base,
    attrs: [
      ...base.attrs.filter((a) => !a.offsets.some((o) => switches.includes(o))),
      ...switches.map((o) => patchAttr(fx, o, nameAt(o))),
    ],
  };
}

export async function resolveMode(fx: PatchFixture): Promise<FixtureMode | null> {
  if (fx.libId == null) return applyPatchChannels(fx, null);
  const f = await getFixture(fx.libId).catch(() => null);
  const m = f?.modes.find((x) => x.name === fx.mode) || f?.modes[0] || null;
  // Library unavailable (e.g. not imported on this machine): fall back to the patch.
  return applyPatchChannels(fx, m);
}
