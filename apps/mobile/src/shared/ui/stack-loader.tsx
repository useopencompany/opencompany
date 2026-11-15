import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

// Adapted from Strobe Stack (dotmatrix `dotm-square-8`) without its blink. Each column stacks
// upward one row per step, delayed by its index, then the columns drain with the same stagger,
// so the motion sweeps left to right. 10 fill steps + 10 drain steps = 20 per cycle.
const SIZE = 5;
const FILL_LAST = SIZE * 2 - 1;
const SEQUENCE_LENGTH = (FILL_LAST + 1) * 2;
// The reference runs 24 steps in 2000ms at speed 1.4. Keeping its step length keeps its pace.
const CYCLE_MS = (2000 / 1.4 / 24) * SEQUENCE_LENGTH;

const BASE_OPACITY = 0.08;
const SETTLED_OPACITY = 0.52;
const CAP_OPACITY = 1;

const INDEXES = Array.from({ length: SIZE }, (_, index) => index);

const dotOpacity = (step: number, row: number, col: number): number => {
  "worklet";
  const height =
    step <= FILL_LAST
      ? Math.max(0, Math.min(SIZE, step - col))
      : Math.max(0, Math.min(SIZE, SIZE - Math.max(0, step - (FILL_LAST + 1) - col)));
  const topLitRow = SIZE - height;
  if (height === 0 || row < topLitRow) return BASE_OPACITY;
  return row === topLitRow && height < SIZE ? CAP_OPACITY : SETTLED_OPACITY;
};

function Dot({
  clock,
  row,
  col,
  animated,
}: {
  clock: SharedValue<number>;
  row: number;
  col: number;
  animated: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (!animated) return { opacity: SETTLED_OPACITY };
    const step = Math.min(SEQUENCE_LENGTH - 1, Math.floor(clock.get() * SEQUENCE_LENGTH));
    return { opacity: dotOpacity(step, row, col) };
  });
  return <Reanimated.View className="size-[3.6px] rounded-full bg-foreground" style={style} />;
}

/**
 * The agent's working indicator: a 24pt dot matrix in the foreground color. One UI-thread clock
 * drives every dot, and it stops while the app is in the background. Under Reduce Motion the
 * matrix holds still and fully lit.
 */
export function StackLoader() {
  const reducedMotion = useReducedMotion();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const clock = useSharedValue(0);
  const animated = !reducedMotion && foreground;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!animated) return;
    clock.set(0);
    clock.set(
      withRepeat(
        withTiming(1, {
          duration: CYCLE_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(clock);
  }, [animated]);

  return (
    <View
      accessible
      accessibilityLabel="Agent working"
      accessibilityRole="progressbar"
      className="size-6 justify-between"
    >
      {INDEXES.map((row) => (
        <View
          accessibilityElementsHidden
          className="flex-row justify-between"
          importantForAccessibility="no-hide-descendants"
          key={row}
        >
          {INDEXES.map((col) => (
            <Dot animated={!reducedMotion} clock={clock} col={col} key={col} row={row} />
          ))}
        </View>
      ))}
    </View>
  );
}
