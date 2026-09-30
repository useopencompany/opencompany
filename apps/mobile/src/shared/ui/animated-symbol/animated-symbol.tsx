import { requireNativeView } from "expo";
import type { SFSymbol } from "expo-symbols";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { withUniwind } from "uniwind";

export type AnimatedSymbolWeight =
  | "ultraLight"
  | "thin"
  | "light"
  | "regular"
  | "medium"
  | "semibold"
  | "bold"
  | "heavy"
  | "black";

interface NativeAnimatedSymbolProps extends ViewProps {
  name: SFSymbol;
  size: number;
  weight: AnimatedSymbolWeight;
  tintColor?: string;
  animated: boolean;
}

const NativeAnimatedSymbol = requireNativeView<NativeAnimatedSymbolProps>("NativeAnimatedSymbol");

/**
 * An SF Symbol that changes with native Magic Replace when `name` changes. It only draws the
 * symbol: wrap it in a Pressable for interaction and give that wrapper the accessibility label.
 */
function AnimatedSymbol({
  animated = true,
  name,
  size = 17,
  style,
  tintColor,
  weight = "regular",
}: {
  animated?: boolean;
  name: SFSymbol;
  size?: number;
  style?: ViewProps["style"];
  tintColor?: string;
  weight?: AnimatedSymbolWeight;
}) {
  return (
    <NativeAnimatedSymbol
      accessibilityElementsHidden
      animated={animated}
      importantForAccessibility="no-hide-descendants"
      name={name}
      pointerEvents="none"
      size={size}
      style={[{ width: Math.ceil(size * 1.4), height: Math.ceil(size * 1.4) }, style]}
      tintColor={tintColor}
      weight={weight}
    />
  );
}

export const StyledAnimatedSymbol: (
  props: Parameters<typeof AnimatedSymbol>[0] & { className?: string; tintColorClassName?: string },
) => ReactNode = withUniwind(AnimatedSymbol);
