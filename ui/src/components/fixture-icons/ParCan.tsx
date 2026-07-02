import type { SVGProps } from "react";

// Par can — side view: cylindrical can, hanging clamp, beam out the front.
export function ParCan(props: SVGProps<SVGSVGElement>) {
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
      {/* can body (cylinder) */}
      <ellipse cx="4.5" cy="12" rx="1.5" ry="3.4" />
      <path d="M4.5 8.6H13" />
      <path d="M4.5 15.4H13" />
      {/* front lens */}
      <ellipse cx="13" cy="12" rx="1.7" ry="3.4" />
      {/* hanging clamp */}
      <path d="M8.5 8.7V6" />
      <circle cx="8.5" cy="5" r="1" />
      {/* beam */}
      <path d="M15.6 9.2 L20 7.2" />
      <path d="M15.8 12H21" />
      <path d="M15.6 14.8 L20 16.8" />
    </svg>
  );
}
