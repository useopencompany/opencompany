import { Host } from "@expo/ui";
import { RNHostView } from "@expo/ui/swift-ui";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useWindowDimensions, View } from "react-native";
import { useCSSVariable } from "uniwind";

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
  bottomInset,
  disabled,
  onComposerHeightChange,
  onFocusChange,
  onPillHeightChange,
  onSend,
}: {
  bottomInset: number;
  disabled: boolean;
  onComposerHeightChange: (height: number) => void;
  onFocusChange: (focused: boolean) => void;
  onPillHeightChange: (height: number) => void;
  onSend: (value: string) => void;
}) {
  const { width } = useWindowDimensions();
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const pillHeightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { attachments, clearAttachments, removeAttachment } = useChatComposer();
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
          bottomInset={bottomInset}
          disabled={disabled}
          hasAttachments={attachments.length > 0}
          nativeID="chat-composer"
          onAttachmentPress={() => router.push("/attachment-sheet")}
          onComposerHeightChange={(event) => handleComposerHeightChange(event.nativeEvent.height)}
          onFocusChange={(event) => onFocusChange(event.nativeEvent.focused)}
          onSend={(event) => {
            clearAttachments();
            onSend(event.nativeEvent.value);
          }}
          style={{ height: "100%", width: "100%" }}
        >
          <RNHostView matchContents>
            <ComposerAttachments
              attachments={attachments}
              contentWidth={attachmentContentWidth}
              onRemove={removeAttachment}
            />
          </RNHostView>
        </NativeChatComposerView>
      </Host>
    </View>
  );
}
