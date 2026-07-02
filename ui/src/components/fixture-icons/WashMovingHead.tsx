import type { SVGProps } from "react";

// Wash moving head — base, yoke, head with emitters and a wide cone.
export function WashMovingHead(props: SVGProps<SVGSVGElement>) {
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
      {/* head */}
      <rect x="9" y="7" width="6" height="7" rx="1.5" />
      {/* emitters */}
      <circle cx="10.6" cy="9.4" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="9.4" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.4" r="0.7" fill="currentColor" stroke="none" />
      {/* wide cone */}
      <path d="M10 7 L6 2.4" />
      <path d="M14 7 L18 2.4" />
    </svg>
  );
}
