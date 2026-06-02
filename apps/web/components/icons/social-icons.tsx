import type { LucideIcon, LucideProps } from "lucide-react";
import { forwardRef } from "react";

export const InstagramIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(
  function InstagramIcon({ size = 24, ...props }, ref) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        aria-hidden="true"
        {...props}
      >
        <rect width="16" height="16" x="4" y="4" rx="4" />
        <circle cx="12" cy="12" r="3.25" />
        <circle cx="16.75" cy="7.25" r="0.75" fill="currentColor" stroke="none" />
      </svg>
    );
  },
);
