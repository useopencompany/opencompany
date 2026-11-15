import { GlassContainer, GlassView } from "expo-glass-effect";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { withUniwind } from "uniwind";

// Map classNames by hand. Uniwind's automatic mode treats every prop ending in "Style" as a style
// prop, so it would wrap `glassEffectStyle` in an array and the native view would drop the glass.
export const StyledGlassView: (
  props: ComponentPropsWithRef<typeof GlassView> & {
    className?: string;
    tintColorClassName?: string;
  },
) => ReactNode = withUniwind(GlassView, {
  style: { fromClassName: "className" },
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});

export const StyledGlassContainer: (
  props: ComponentPropsWithRef<typeof GlassContainer> & { className?: string },
) => ReactNode = withUniwind(GlassContainer, { style: { fromClassName: "className" } });
