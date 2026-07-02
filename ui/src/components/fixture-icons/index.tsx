import type { FC, SVGProps } from "react";
import { ParCan } from "./ParCan";
import { Chandelier } from "./Chandelier";
import { BeamMovingHead } from "./BeamMovingHead";
import { WashMovingHead } from "./WashMovingHead";
import { LedTape } from "./LedTape";
import { FlatLedWash } from "./FlatLedWash";

export { ParCan, Chandelier, BeamMovingHead, WashMovingHead, LedTape, FlatLedWash };

// Stable keys for storing a fixture's icon choice (e.g. in the patch).
export type FixtureKind = "par" | "chandelier" | "beam" | "wash" | "led-tape" | "led-panel";

export const FIXTURE_ICONS: Record<FixtureKind, FC<SVGProps<SVGSVGElement>>> = {
  par: ParCan,
  chandelier: Chandelier,
  beam: BeamMovingHead,
  wash: WashMovingHead,
  "led-tape": LedTape,
  "led-panel": FlatLedWash,
};

// Ordered list with display labels, for pickers.
export const FIXTURE_KINDS: { key: FixtureKind; label: string }[] = [
  { key: "par", label: "Par Can" },
  { key: "chandelier", label: "Chandelier" },
  { key: "beam", label: "Beam Moving Head" },
  { key: "wash", label: "Wash Moving Head" },
  { key: "led-tape", label: "LED Tape" },
  { key: "led-panel", label: "LED Wash Panel" },
];

// Render an icon by kind. Colour it via `color`/`className` (uses currentColor).
export function FixtureIcon({ kind, ...props }: { kind: FixtureKind } & SVGProps<SVGSVGElement>) {
  const Icon = FIXTURE_ICONS[kind];
  return Icon ? <Icon {...props} /> : null;
}
