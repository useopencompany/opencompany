import { GlassContainer, GlassView } from "expo-glass-effect";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { withUniwind } from "uniwind";

export const StyledGlassView: (
  props: ComponentPropsWithRef<typeof GlassView> & { tintColorClassName?: string },
) => ReactNode = withUniwind(GlassView);

export const StyledGlassContainer: (
  props: ComponentPropsWithRef<typeof GlassContainer>,
) => ReactNode = withUniwind(GlassContainer);
