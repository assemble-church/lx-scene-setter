import type { SVGProps } from "react";

// Hot power — a switched (non-dim) circuit: power symbol inside a socket outline.
export function HotPower(props: SVGProps<SVGSVGElement>) {
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
      {/* socket face */}
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      {/* power symbol */}
      <path d="M12 7.2V12" />
      <path d="M8.7 9.4a4.6 4.6 0 1 0 6.6 0" />
    </svg>
  );
}
