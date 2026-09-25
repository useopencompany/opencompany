import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Share, View } from "react-native";
import Reanimated, {
  Easing,
  Keyframe,
  ReduceMotion,
  useReducedMotion,
} from "react-native-reanimated";
import { until } from "until-async";
import { captureError } from "@/shared/lib/analytics";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";

const COPY_CONFIRMATION_DURATION_MS = 2000;
const actionEntrance = (delay: number, reducedMotion: boolean) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: reducedMotion ? 0 : 3 }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: Easing.bezier(0.23, 1, 0.32, 1) },
  })
    .duration(140)
    .delay(delay)
    .reduceMotion(reducedMotion ? ReduceMotion.Never : ReduceMotion.System);
const COPY_ENTERING = actionEntrance(0, false);
const SHARE_ENTERING = actionEntrance(60, false);
const REDUCED_ENTERING = actionEntrance(0, true);

const pressHaptic = () => {
  void until(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)).then(([error]) => {
    if (error) captureError("chat_action_haptic_failed", error);
  });
};

export function AssistantMessageActions({
  animateOnMount,
  text,
}: {
  animateOnMount: boolean;
  text: string;
}) {
  const { showErrorToast, showToast } = useToast();
  const reducedMotion = useReducedMotion();
  const copyEntering = reducedMotion ? REDUCED_ENTERING : COPY_ENTERING;
  const shareEntering = reducedMotion ? REDUCED_ENTERING : SHARE_ENTERING;
  const [copied, setCopied] = useState(false);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyMutation = useMutation({
    mutationFn: () => Clipboard.setStringAsync(text),
    onSuccess: () => {
      setCopied(true);
      showToast("Copied to clipboard", { duration: COPY_CONFIRMATION_DURATION_MS });
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = setTimeout(() => {
        copyResetTimeoutRef.current = null;
        setCopied(false);
      }, COPY_CONFIRMATION_DURATION_MS);
    },
    onError: (error) => showErrorToast("The response could not be copied.", error, "chat.copy"),
  });
  const shareMutation = useMutation({
    mutationFn: () => Share.share({ message: text }),
    onError: (error) => showErrorToast("The response could not be shared.", error, "chat.share"),
  });

  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
    },
    [],
  );

  return (
    <View className="flex-row items-center">
      <Reanimated.View entering={animateOnMount ? copyEntering : undefined}>
        <Pressable
          accessibilityLabel="Copy response"
          accessibilityRole="button"
          className="size-11 items-start justify-center active:opacity-50"
          disabled={copyMutation.isPending}
          onPress={() => {
            pressHaptic();
            copyMutation.mutate();
          }}
        >
          <StyledSymbolView
            name={copied ? "checkmark" : "doc.on.doc"}
            size={17}
            weight="medium"
            tintColorClassName="accent-muted-foreground"
          />
        </Pressable>
      </Reanimated.View>
      <Reanimated.View entering={animateOnMount ? shareEntering : undefined}>
        <Pressable
          accessibilityLabel="Share response"
          accessibilityRole="button"
          className="size-11 items-start justify-center active:opacity-50"
          disabled={shareMutation.isPending}
          onPress={() => {
            pressHaptic();
            shareMutation.mutate();
          }}
        >
          {shareMutation.isPending ? (
            <ActivityIndicator
              size="small"
              className="size-[17px] scale-75"
              colorClassName="accent-muted-foreground"
            />
          ) : (
            <StyledSymbolView
              name="square.and.arrow.up"
              size={17}
              weight="medium"
              tintColorClassName="accent-muted-foreground"
            />
          )}
        </Pressable>
      </Reanimated.View>
    </View>
  );
}
