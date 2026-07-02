import type { SVGProps } from "react";

// LED tape — a strip of SMD chips with a lead wire.
export function LedTape(props: SVGProps<SVGSVGElement>) {
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
      {/* strip */}
      <rect x="2.5" y="9.4" width="17" height="5.2" rx="1.4" />
      {/* SMD chips */}
      <rect x="4.4" y="11" width="2" height="2" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="8" y="11" width="2" height="2" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="11.6" y="11" width="2" height="2" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="15.2" y="11" width="2" height="2" rx="0.4" fill="currentColor" stroke="none" />
      {/* lead wire */}
      <path d="M19.5 12H21.5" />
    </svg>
  );
}
