import type { SVGProps } from "react";

// Beam moving head — base, yoke arms, head and a tight parallel beam.
export function BeamMovingHead(props: SVGProps<SVGSVGElement>) {
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
      {/* base */}
      <rect x="7" y="19" width="10" height="2.6" rx="1" />
      {/* yoke arms */}
      <path d="M8.5 19V12" />
      <path d="M15.5 19V12" />
      {/* head + lens face */}
      <rect x="9" y="7" width="6" height="7" rx="1.5" />
      <path d="M9.6 8.1H14.4" />
      {/* tight beam */}
      <path d="M10.7 7 L10.2 2.6" />
      <path d="M13.3 7 L13.8 2.6" />
    </svg>
  );
}
