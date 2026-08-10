import { Host } from "@expo/ui";
import { Button, HStack, Image, TextField, useNativeState } from "@expo/ui/swift-ui";
import {
  Animation,
  accessibilityLabel,
  animation,
  background,
  buttonStyle,
  disabled as disabledModifier,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  layoutPriority,
  lineLimit,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { router } from "expo-router";
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
import { scheduleOnRN } from "react-native-worklets";
import { useCSSVariable } from "uniwind";

const COMPOSER_INSET_CLOSED = 40;
const COMPOSER_INSET_OPEN = 24;

export function ChatComposer({
  bottomInset,
  disabled,
  onChangeText,
  onComposerLayout,
  onPillHeightChange,
  onSend,
  value,
  wrapperRef,
}: {
  bottomInset: number;
  disabled: boolean;
  onChangeText: (value: string) => void;
  onComposerLayout: (event: LayoutChangeEvent) => void;
  onPillHeightChange: (height: number) => void;
  onSend: () => void;
  value: string;
  wrapperRef: RefObject<View | null>;
}) {
  const text = useNativeState(value);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(() => KeyboardController.isVisible());
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const sendDisabled = disabled || value.trim().length === 0;

  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        scheduleOnRN(setIsKeyboardVisible, event.progress === 1);
      },
    },
    [],
  );

  useEffect(() => {
    if (text.get() !== value) {
      text.set(value);
    }
  }, [text, value]);

  return (
    <View
      className="px-6 pt-2"
      onLayout={onComposerLayout}
      ref={wrapperRef}
      style={{ paddingBottom: bottomInset + 8 }}
    >
      <Host
        matchContents={{ vertical: true }}
        onLayoutContent={(event) => onPillHeightChange(event.nativeEvent.height)}
        seedColor={accent}
        style={{ width: "100%" }}
      >
        <HStack
          alignment="center"
          modifiers={[
            padding({ horizontal: 10, vertical: 6 }),
            frame({ maxWidth: Number.POSITIVE_INFINITY, minHeight: 52 }),
            glassEffect({
              glass: { variant: "regular", interactive: true },
            }),
            padding({
              horizontal: isKeyboardVisible ? 0 : COMPOSER_INSET_CLOSED - COMPOSER_INSET_OPEN,
            }),
            animation(Animation.spring({ bounce: 0, duration: 0.3 }), isKeyboardVisible),
          ]}
        >
          <Button
            onPress={() => router.push("/attachment-sheet")}
            modifiers={[
              accessibilityLabel("Open attachments"),
              buttonStyle("plain"),
              frame({ width: 36, height: 36 }),
            ]}
          >
            <Image
              systemName="plus"
              modifiers={[
                font({ size: 20, weight: "medium" }),
                foregroundStyle({ type: "hierarchical", style: "primary" }),
              ]}
            />
          </Button>

          <TextField
            axis="vertical"
            onTextChange={onChangeText}
            placeholder="Ask opencompany"
            text={text}
            modifiers={[
              accessibilityLabel("Message"),
              layoutPriority(1),
              frame({ maxWidth: Number.POSITIVE_INFINITY }),
              lineLimit({ min: 1, max: 5 }),
              fixedSize({ horizontal: false, vertical: true }),
            ]}
          />

          <Button
            onPress={onSend}
            modifiers={[
              accessibilityLabel("Send message"),
              buttonStyle("plain"),
              disabledModifier(sendDisabled),
              frame({ width: 36, height: 36 }),
            ]}
          >
            <Image
              systemName="arrow.up"
              modifiers={[
                font({ size: 14, weight: "bold" }),
                foregroundStyle(accentForeground),
                frame({ width: 30, height: 30 }),
                background(accent, shapes.circle()),
              ]}
            />
          </Button>
        </HStack>
      </Host>
    </View>
  );
}
