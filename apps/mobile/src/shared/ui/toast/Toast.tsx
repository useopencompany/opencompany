import { Button, Host, HStack, Image, Spacer, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  layoutPriority,
  lineLimit,
  padding,
  truncationMode,
} from "@expo/ui/swift-ui/modifiers";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Pressable } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Screen, ScreenContainer } from "react-native-screens";
import { scheduleOnRN } from "react-native-worklets";

const ENTRANCE_SPRING = {
  dampingRatio: 1,
  duration: 300,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

const EXIT_SPRING = {
  dampingRatio: 1,
  duration: 180,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

export function Toast({
  duration,
  message,
  onExitComplete,
}: {
  duration: number;
  message: string;
  onExitComplete: () => void;
}) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.97);
  const translateY = useSharedValue(-30);
  const isExiting = useSharedValue(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerStartedAtRef = useRef<number | null>(null);
  const remainingDurationRef = useRef(duration);
  const hasEnteredRef = useRef(false);
  const isTouchingRef = useRef(false);
  const hasStartedExitRef = useRef(false);
  const hasCompletedExitRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    timerStartedAtRef.current = null;
  };

  const completeExit = () => {
    if (hasCompletedExitRef.current) return;

    hasCompletedExitRef.current = true;
    onExitComplete();
  };

  const beginExit = () => {
    if (hasStartedExitRef.current) return;

    hasStartedExitRef.current = true;
    isExiting.value = true;
    clearTimer();
    cancelAnimation(opacity);
    cancelAnimation(scale);
    cancelAnimation(translateY);

    opacity.value = withSpring(0, EXIT_SPRING, (finished) => {
      if (finished) {
        scheduleOnRN(completeExit);
      }
    });
    scale.value = withSpring(0.97, EXIT_SPRING);
    translateY.value = withSpring(-30, EXIT_SPRING);
  };

  const startTimer = () => {
    if (
      duration === 0 ||
      !hasEnteredRef.current ||
      isTouchingRef.current ||
      hasStartedExitRef.current ||
      timerRef.current
    ) {
      return;
    }

    if (remainingDurationRef.current <= 0) {
      beginExit();
      return;
    }

    timerStartedAtRef.current = Date.now();
    timerRef.current = setTimeout(beginExit, remainingDurationRef.current);
  };

  const handleEntranceComplete = () => {
    hasEnteredRef.current = true;
    startTimer();
  };

  const pauseTimer = () => {
    isTouchingRef.current = true;

    if (!timerRef.current || timerStartedAtRef.current === null) return;

    remainingDurationRef.current = Math.max(
      0,
      remainingDurationRef.current - (Date.now() - timerStartedAtRef.current),
    );
    clearTimer();
  };

  const resumeTimer = () => {
    isTouchingRef.current = false;
    startTimer();
  };

  useEffect(() => {
    void AccessibilityInfo.announceForAccessibility(message);

    opacity.value = withSpring(1, ENTRANCE_SPRING, (finished) => {
      if (finished) {
        scheduleOnRN(handleEntranceComplete);
      }
    });
    scale.value = withSpring(1, ENTRANCE_SPRING);
    translateY.value = withSpring(0, ENTRANCE_SPRING);

    return clearTimer;
  }, [message, opacity, scale, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }));

  const panGesture = Gesture.Pan()
    .cancelsTouchesInView(false)
    .onBegin(() => {
      scheduleOnRN(pauseTimer);
    })
    .onUpdate((event) => {
      if (!isExiting.value) {
        translateY.value = Math.min(0, event.translationY);
      }
    })
    .onEnd((event) => {
      if (isExiting.value) return;

      if (translateY.value <= -24 || event.velocityY <= -500) {
        isExiting.value = true;
        scheduleOnRN(beginExit);
        return;
      }

      translateY.value = withSpring(0, ENTRANCE_SPRING);
    })
    .onFinalize(() => {
      if (!isExiting.value) {
        translateY.value = withSpring(0, ENTRANCE_SPRING);
        scheduleOnRN(resumeTimer);
      }
    });

  const dismissGesture = Gesture.Tap().onEnd((_event, success) => {
    if (success) {
      scheduleOnRN(beginExit);
    }
  });

  return (
    // FullWindowOverlay reparents its contents outside the React view-controller hierarchy.
    <ScreenContainer className="min-h-14 w-full">
      <Screen activityState={2} className="flex-1">
        <GestureDetector gesture={panGesture}>
          <Reanimated.View className="min-h-14 w-full" style={animatedStyle}>
            <Host
              matchContents={{ horizontal: false, vertical: true }}
              style={{ minHeight: 56, width: "100%" }}
            >
              <HStack
                alignment="center"
                spacing={8}
                modifiers={[
                  padding({ leading: 18, trailing: 6, vertical: 6 }),
                  frame({ minHeight: 56, maxWidth: Infinity }),
                  glassEffect({
                    glass: { variant: "clear", interactive: true },
                    shape: "capsule",
                  }),
                ]}
              >
                <Text
                  modifiers={[
                    font({ textStyle: "body", weight: "semibold" }),
                    foregroundStyle({ type: "hierarchical", style: "primary" }),
                    lineLimit(2),
                    truncationMode("tail"),
                    layoutPriority(1),
                  ]}
                >
                  {message}
                </Text>
                <Spacer minLength={0} />
                <Button
                  onPress={beginExit}
                  modifiers={[
                    buttonStyle("plain"),
                    frame({ width: 44, height: 44 }),
                    accessibilityLabel("Dismiss notification"),
                  ]}
                >
                  <Image
                    systemName="xmark.circle.fill"
                    modifiers={[
                      font({ textStyle: "title2" }),
                      foregroundStyle({ type: "hierarchical", style: "secondary" }),
                    ]}
                  />
                </Button>
              </HStack>
            </Host>
            <GestureDetector gesture={dismissGesture}>
              <Pressable
                accessible={false}
                className="absolute right-1.5 top-1.5 size-11"
                onPress={beginExit}
              />
            </GestureDetector>
          </Reanimated.View>
        </GestureDetector>
      </Screen>
    </ScreenContainer>
  );
}
