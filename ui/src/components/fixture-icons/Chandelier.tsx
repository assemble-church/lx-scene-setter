import type { SVGProps } from "react";

// Chandelier — ceiling drop, central stem and three candle arms with bulbs.
export function Chandelier(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* ceiling drop + mount ring */}
      <path d="M12 2v2" />
      <circle cx="12" cy="5.5" r="1.2" />
      {/* stem */}
      <path d="M12 6.7V10" />
      {/* arms */}
      <path d="M12 10C7 10 6 12.5 7 13" />
      <path d="M12 10c5 0 6 2.5 5 3" />
      <path d="M12 10v3" />
      {/* bulbs */}
      <circle cx="7" cy="14.2" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14.2" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="17" cy="14.2" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
