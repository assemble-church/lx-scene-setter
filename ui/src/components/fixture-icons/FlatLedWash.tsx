import type { SVGProps } from "react";

// Flat LED wash — a yoke-mounted panel with a grid of emitters.
export function FlatLedWash(props: SVGProps<SVGSVGElement>) {
  const xs = [8.5, 12, 15.5];
  const ys = [9.5, 13, 16.5];
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* mounting bracket */}
      <path d="M9 6V4h6v2" />
      <path d="M12 4V2.5" />
      {/* panel */}
      <rect x="5" y="6" width="14" height="14" rx="2" />
      {/* emitter grid */}
      {ys.flatMap((y) =>
        xs.map((x) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" stroke="none" />
        ))
      )}
    </svg>
  );
}
