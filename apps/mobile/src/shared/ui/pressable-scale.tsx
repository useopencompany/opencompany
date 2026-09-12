import type { ComponentProps } from "react";
import { Pressable, type PressableProps } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const EASING = Easing.bezier(0.4, 0, 0.2, 1);
const DURATION_MS = 150;
const DEFAULT_TARGET_SCALE = 0.97;

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);
type AnimatedPressableProps = ComponentProps<typeof AnimatedPressable>;

export function PressableScale({
  targetScale = DEFAULT_TARGET_SCALE,
  style,
  onPressIn,
  onPressOut,
  ...props
}: {
  targetScale?: number;
  style?: AnimatedPressableProps["style"];
} & Omit<PressableProps, "style"> &
  Pick<ComponentProps<typeof AnimatedPressable>, "entering" | "exiting">) {
  const reducedMotion = useReducedMotion();

  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      accessibilityRole="button"
      onPressIn={(e) => {
        "worklet";
        if (onPressIn) {
          scheduleOnRN(onPressIn, e);
        }
        cancelAnimation(scale);
        scale.value = withTiming(targetScale, {
          duration: DURATION_MS,
          easing: EASING,
        });
      }}
      onPressOut={(e) => {
        "worklet";
        if (onPressOut) {
          scheduleOnRN(onPressOut, e);
        }
        cancelAnimation(scale);
        scale.value = withTiming(1, { duration: DURATION_MS, easing: EASING });
      }}
      style={[!reducedMotion && animatedStyle, style]}
      {...props}
    />
  );
}
