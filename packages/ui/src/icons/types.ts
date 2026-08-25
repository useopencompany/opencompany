import type { ComponentType, SVGProps } from "react";

/**
 * Shared icon types for the design system.
 *
 * Kept under the historical `Lucide*` names so existing call sites
 * (`type LucideIcon`) compile unchanged. The shape is broad enough to hold
 * Central icons (`@central-icons-react`) and the project-owned brand/provider
 * marks alike — all of which accept `size` plus any SVG prop and inherit
 * `currentColor`.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "mode"> & {
  size?: string | number;
  ariaHidden?: boolean;
  mode?: "masked" | "raw";
  maskId?: string;
};
export type LucideProps = IconProps;
export type LucideIcon = ComponentType<IconProps>;
