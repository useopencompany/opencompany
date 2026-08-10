import { Host } from "@expo/ui";
import { Button, HStack, Image, RNHostView, Spacer, Text, ZStack } from "@expo/ui/swift-ui";
import {
  Animation,
  accessibilityHidden,
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
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  TextInput,
  type TextInputContentSizeChangeEventData,
  View,
  type ViewStyle,
} from "react-native";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
import { scheduleOnRN } from "react-native-worklets";
import { useCSSVariable } from "uniwind";

const COMPOSER_INSET_CLOSED = 40;
const COMPOSER_INSET_OPEN = 24;
const COMPOSER_CONTENT_HORIZONTAL_PADDING = 10;
const COMPOSER_CONTENT_VERTICAL_PADDING = 6;
const COMPOSER_EXPANDED_VERTICAL_PADDING = 10;
const COMPOSER_MIN_HEIGHT = 52;
const COMPOSER_CONTROL_SIZE = 36;
const COMPOSER_CONTROL_SPACING = 8;
const COMPOSER_TEXT_HORIZONTAL_INSET = COMPOSER_CONTROL_SIZE + COMPOSER_CONTROL_SPACING;
const COMPOSER_EXPANDED_ACTION_GAP = 12;
const COMPOSER_EXPANDED_CORNER_RADIUS = 24;
const COMPOSER_LINE_HEIGHT_EPSILON = 1;
const COMPOSER_INPUT_MIN_HEIGHT = 22;
const COMPOSER_INPUT_MAX_HEIGHT = COMPOSER_INPUT_MIN_HEIGHT * 5;
const PILL_HEIGHT_SETTLE_DELAY = 50;
const COMPOSER_LAYOUT_ANIMATION = Animation.spring({ bounce: 0, duration: 0.22 });
const MEASUREMENT_HOST_STYLE = {
  opacity: 0,
  position: "absolute",
  width: "100%",
} satisfies ViewStyle;

function ComposerLineMeasurement({
  horizontalInset,
  onHeightChange,
  text,
}: {
  horizontalInset: number;
  onHeightChange: (height: number) => void;
  text: string;
}) {
  return (
    <Host
      matchContents={{ vertical: true }}
      onLayoutContent={(event) => onHeightChange(event.nativeEvent.height)}
      ignoreSafeArea="all"
      pointerEvents="none"
      style={MEASUREMENT_HOST_STYLE}
    >
      <Text
        modifiers={[
          accessibilityHidden(),
          frame({ maxWidth: Number.POSITIVE_INFINITY }),
          lineLimit(2),
          fixedSize({ horizontal: false, vertical: true }),
          padding({ horizontal: horizontalInset }),
        ]}
      >
        {text}
      </Text>
    </Host>
  );
}

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
  onComposerHeightChange: (height: number) => void;
  onComposerLayout: (event: LayoutChangeEvent) => void;
  onPillHeightChange: (height: number) => void;
  onSend: () => void;
  onSendText: (value: string) => void;
  value: string;
  wrapperRef: RefObject<View | null>;
}) {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(() => KeyboardController.isVisible());
  const [isMultiline, setIsMultiline] = useState(false);
  const [inputHeight, setInputHeight] = useState(COMPOSER_INPUT_MIN_HEIGHT);
  const singleLineHeightRef = useRef<number | null>(null);
  const contentHeightRef = useRef<number | null>(null);
  const pillHeightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const sendDisabled = disabled || value.trim().length === 0;
  const isExpanded = value.length > 0 && isMultiline;
  const keyboardHorizontalInset = isKeyboardVisible
    ? 0
    : COMPOSER_INSET_CLOSED - COMPOSER_INSET_OPEN;
  const measurementHorizontalInset =
    keyboardHorizontalInset + COMPOSER_CONTENT_HORIZONTAL_PADDING + COMPOSER_TEXT_HORIZONTAL_INSET;
  // Keep a trailing empty line measurable when the draft ends with a newline.
  const measurementText = value.length === 0 ? "M" : `${value}\u200B`;

  const updateMultilineState = () => {
    const singleLineHeight = singleLineHeightRef.current;
    const contentHeight = contentHeightRef.current;

    if (singleLineHeight === null || contentHeight === null) {
      return;
    }

    const nextIsMultiline = contentHeight > singleLineHeight + COMPOSER_LINE_HEIGHT_EPSILON;
    setIsMultiline((currentIsMultiline) =>
      currentIsMultiline === nextIsMultiline ? currentIsMultiline : nextIsMultiline,
    );
  };

  const handleSingleLineHeightChange = (height: number) => {
    singleLineHeightRef.current = height;
    updateMultilineState();
  };

  const handleContentHeightChange = (height: number) => {
    contentHeightRef.current = height;
    updateMultilineState();
  };

  const handleInputContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const nextHeight = Math.min(
      COMPOSER_INPUT_MAX_HEIGHT,
      Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height)),
    );
    setInputHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
  };

  const handlePillHeightChange = (height: number) => {
    if (pillHeightTimeoutRef.current !== null) {
      clearTimeout(pillHeightTimeoutRef.current);
    }

    pillHeightTimeoutRef.current = setTimeout(() => {
      pillHeightTimeoutRef.current = null;
      onPillHeightChange(height);
    }, PILL_HEIGHT_SETTLE_DELAY);
  };

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
    if (value.length === 0) {
      setInputHeight(COMPOSER_INPUT_MIN_HEIGHT);
    }
  }, [value]);

  useEffect(
    () => () => {
      if (pillHeightTimeoutRef.current !== null) {
        clearTimeout(pillHeightTimeoutRef.current);
      }
    },
    [],
  );

  return (
    <View
      className="px-6 pt-2"
      onLayout={onComposerLayout}
      ref={wrapperRef}
      style={{ paddingBottom: bottomInset + 8 }}
    >
      <Host
        matchContents={{ vertical: true }}
        onLayoutContent={(event) => handlePillHeightChange(event.nativeEvent.height)}
        seedColor={accent}
        ignoreSafeArea="all"
        style={{ width: "100%" }}
      >
        <ZStack
          alignment={isExpanded ? "bottom" : "center"}
          modifiers={[
            padding({
              horizontal: COMPOSER_CONTENT_HORIZONTAL_PADDING,
              vertical: isExpanded
                ? COMPOSER_EXPANDED_VERTICAL_PADDING
                : COMPOSER_CONTENT_VERTICAL_PADDING,
            }),
            frame({ maxWidth: Number.POSITIVE_INFINITY, minHeight: COMPOSER_MIN_HEIGHT }),
            glassEffect({
              glass: { variant: "regular", interactive: true },
              shape: isExpanded ? "roundedRectangle" : "capsule",
              cornerRadius: isExpanded ? COMPOSER_EXPANDED_CORNER_RADIUS : undefined,
            }),
            padding({ horizontal: keyboardHorizontalInset }),
            animation(Animation.spring({ bounce: 0, duration: 0.3 }), isKeyboardVisible),
            // animation(COMPOSER_LAYOUT_ANIMATION, isExpanded),
          ]}
        >
          <ZStack
            modifiers={[
              layoutPriority(1),
              frame({ maxWidth: Number.POSITIVE_INFINITY, height: inputHeight }),
              padding({
                horizontal: isExpanded ? 0 : COMPOSER_TEXT_HORIZONTAL_INSET,
                bottom: isExpanded ? COMPOSER_CONTROL_SIZE + COMPOSER_EXPANDED_ACTION_GAP : 0,
              }),
            ]}
          >
            <RNHostView>
              <TextInput
                accessibilityLabel="Message"
                className="w-full p-0 text-[17px] leading-[22px] text-foreground"
                cursorColorClassName="accent-accent"
                multiline
                nativeID="chat-composer"
                onChange={(event) => onChangeText(event.nativeEvent.text)}
                onContentSizeChange={handleInputContentSizeChange}
                placeholder="Ask opencompany"
                placeholderTextColorClassName="accent-muted-foreground"
                scrollEnabled={inputHeight >= COMPOSER_INPUT_MAX_HEIGHT}
                selectionColorClassName="accent-accent"
                style={{ height: inputHeight }}
                textAlignVertical="top"
                value={value}
              />
            </RNHostView>
          </ZStack>

          <HStack
            alignment="center"
            spacing={COMPOSER_CONTROL_SPACING}
            modifiers={[frame({ maxWidth: Number.POSITIVE_INFINITY })]}
          >
            <Button
              onPress={() => router.push("/attachment-sheet")}
              modifiers={[
                accessibilityLabel("Open attachments"),
                buttonStyle("plain"),
                frame({ width: COMPOSER_CONTROL_SIZE, height: COMPOSER_CONTROL_SIZE }),
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

            <Spacer minLength={0} />

            <Button
              onPress={onSend}
              modifiers={[
                accessibilityLabel("Send message"),
                buttonStyle("plain"),
                disabledModifier(sendDisabled),
                frame({ width: COMPOSER_CONTROL_SIZE, height: COMPOSER_CONTROL_SIZE }),
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
        </ZStack>
      </Host>

      <ComposerLineMeasurement
        horizontalInset={measurementHorizontalInset}
        onHeightChange={handleSingleLineHeightChange}
        text="M"
      />
      <ComposerLineMeasurement
        horizontalInset={measurementHorizontalInset}
        onHeightChange={handleContentHeightChange}
        text={measurementText}
      />
    </View>
  );
}
