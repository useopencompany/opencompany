import { Host } from "@expo/ui";
import { RNHostView } from "@expo/ui/swift-ui";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useWindowDimensions, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { until } from "until-async";
import { useToast } from "@/shared/ui/toast";
import { NativeChatComposerView } from "../../../../modules/native-chat-composer";
import { useChatComposer } from "../model/chat-composer-context";
import { ComposerAttachments } from "./composer-attachments";

const COMPOSER_EXPANDED_VERTICAL_PADDING = 10;
const COMPOSER_INPUT_LINE_HEIGHT = 22;
const COMPOSER_MAXIMUM_LINE_COUNT = 5;
const COMPOSER_EXPANDED_ACTION_GAP = 12;
const COMPOSER_CONTROL_SIZE = 36;
const COMPOSER_OUTER_VERTICAL_PADDING = 16;
const COMPOSER_OPEN_HORIZONTAL_INSET = 12;
const COMPOSER_CONTENT_HORIZONTAL_PADDING = 10;
const COMPOSER_ATTACHMENTS_CANVAS_HEIGHT = 128;
const COMPOSER_PILL_HEIGHT_SETTLE_DELAY = 60;
const COMPOSER_CANVAS_PILL_HEIGHT =
  COMPOSER_EXPANDED_VERTICAL_PADDING * 2 +
  COMPOSER_INPUT_LINE_HEIGHT * COMPOSER_MAXIMUM_LINE_COUNT +
  COMPOSER_EXPANDED_ACTION_GAP +
  COMPOSER_CONTROL_SIZE;

export function ChatComposer({
  autoFocus,
  bottomInset,
  conversationId,
  disabled,
  isGenerating,
  isStopping,
  onComposerHeightChange,
  onPillHeightChange,
  onSend,
  onStop,
}: {
  autoFocus: boolean;
  bottomInset: number;
  conversationId: string;
  disabled: boolean;
  isGenerating: boolean;
  isStopping: boolean;
  onComposerHeightChange: (height: number) => void;
  onPillHeightChange: (height: number) => void;
  onSend: () => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const { width } = useWindowDimensions();
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const { showErrorToast } = useToast();
  const pillHeightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composer = useChatComposer();
  const sendMutation = useMutation({
    mutationFn: async () => {
      await composer.flushDraft();
      await onSend();
    },
    onSuccess: () => composer.clearAfterSend(),
    onError: (error) =>
      showErrorToast(
        error instanceof Error ? error.message : "The message could not be sent.",
        error,
        "chat.message.send",
      ),
  });
  const isActiveConversation = composer.conversationId === conversationId;
  const attachments = isActiveConversation ? composer.attachments : [];
  const value = isActiveConversation ? composer.value : "";
  const canvasHeight =
    COMPOSER_CANVAS_PILL_HEIGHT +
    COMPOSER_ATTACHMENTS_CANVAS_HEIGHT +
    COMPOSER_OUTER_VERTICAL_PADDING +
    bottomInset;
  const attachmentContentWidth = Math.max(
    0,
    width - 2 * (COMPOSER_OPEN_HORIZONTAL_INSET + COMPOSER_CONTENT_HORIZONTAL_PADDING),
  );

  useEffect(
    () => () => {
      if (pillHeightTimeoutRef.current !== null) {
        clearTimeout(pillHeightTimeoutRef.current);
      }
    },
    [],
  );

  const handleComposerHeightChange = (pillHeight: number) => {
    onComposerHeightChange(pillHeight + COMPOSER_OUTER_VERTICAL_PADDING + bottomInset);

    if (pillHeightTimeoutRef.current !== null) {
      clearTimeout(pillHeightTimeoutRef.current);
    }

    pillHeightTimeoutRef.current = setTimeout(() => {
      pillHeightTimeoutRef.current = null;
      onPillHeightChange(pillHeight);
    }, COMPOSER_PILL_HEIGHT_SETTLE_DELAY);
  };

  return (
    <View pointerEvents="box-none" style={{ height: canvasHeight }}>
      <Host
        ignoreSafeArea="all"
        pointerEvents="box-none"
        style={{ height: canvasHeight, width: "100%" }}
      >
        <NativeChatComposerView
          accentColor={accent}
          accentForegroundColor={accentForeground}
          autoFocus={autoFocus}
          bottomInset={bottomInset}
          disabled={disabled || sendMutation.isPending || !isActiveConversation}
          hasAttachments={attachments.length > 0}
          isGenerating={isGenerating}
          isStopping={isStopping}
          nativeID="chat-composer"
          onAttachmentPress={() => router.push("/attachment-sheet")}
          onComposerHeightChange={(event) => handleComposerHeightChange(event.nativeEvent.height)}
          onChangeText={(event) => composer.setValue(event.nativeEvent.value)}
          onSend={() => {
            if (!sendMutation.isPending) sendMutation.mutate();
          }}
          onStop={() => {
            void until(onStop).then(([error]) => {
              if (error)
                showErrorToast("The stop request could not be saved.", error, "chat.run.stop");
            });
          }}
          style={{ height: "100%", width: "100%" }}
          value={value}
        >
          <RNHostView matchContents>
            <ComposerAttachments
              attachments={attachments}
              contentWidth={attachmentContentWidth}
              onRemove={composer.removeAttachment}
            />
          </RNHostView>
        </NativeChatComposerView>
      </Host>
    </View>
  );
}
