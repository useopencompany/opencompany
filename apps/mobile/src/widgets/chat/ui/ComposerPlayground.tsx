import { Host } from "@expo/ui";
import {
  Button,
  HStack,
  Image,
  RNHostView,
  Spacer,
  Text as SwiftText,
  TextField,
  useNativeState,
  ZStack,
} from "@expo/ui/swift-ui";
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
import { NativeChatComposerView } from "@opencompany/native-chat-composer";
import { GlassView } from "expo-glass-effect";
import { router } from "expo-router";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Pressable,
  Text,
  TextInput,
  type TextInputContentSizeChangeEventData,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import {
  KeyboardController,
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Reanimated, {
  interpolate,
  LinearTransition,
  useAnimatedStyle,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useCSSVariable, useUniwind } from "uniwind";

import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { ChatComposer } from "./ChatComposer";
import { StreamingChat } from "./StreamingChat";

const COMPOSER_WRAPPER_HORIZONTAL_PADDING = 24;
const COMPOSER_INSET_CLOSED = 40;
const COMPOSER_INSET_OPEN = 24;
const COMPOSER_KEYBOARD_HORIZONTAL_INSET = COMPOSER_INSET_CLOSED - COMPOSER_INSET_OPEN;
const COMPOSER_CONTENT_HORIZONTAL_PADDING = 10;
const COMPOSER_CONTENT_VERTICAL_PADDING = 6;
const COMPOSER_EXPANDED_VERTICAL_PADDING = 10;
const COMPOSER_MIN_HEIGHT = 52;
const COMPOSER_CONTROL_SIZE = 36;
const COMPOSER_CONTROL_SPACING = 8;
const COMPOSER_TEXT_HORIZONTAL_INSET = COMPOSER_CONTROL_SIZE + COMPOSER_CONTROL_SPACING;
const COMPOSER_EXPANDED_ACTION_GAP = 12;
const COMPOSER_EXPANDED_CORNER_RADIUS = 24;
const COMPOSER_INPUT_LINE_HEIGHT = 22;
const COMPOSER_INPUT_MIN_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT;
const COMPOSER_INPUT_MAX_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT * 5;
const NATIVE_MODULE_CANVAS_PILL_HEIGHT =
  COMPOSER_EXPANDED_VERTICAL_PADDING * 2 +
  COMPOSER_INPUT_MAX_HEIGHT +
  COMPOSER_EXPANDED_ACTION_GAP +
  COMPOSER_CONTROL_SIZE;
const NATIVE_MODULE_OUTER_VERTICAL_PADDING = 16;
const NATIVE_MODULE_PILL_HEIGHT_SETTLE_DELAY = 60;
const COMPOSER_LAYOUT_ANIMATION_DURATION = 180;
const COMPOSER_LAYOUT_TRANSITION = LinearTransition.duration(COMPOSER_LAYOUT_ANIMATION_DURATION);
const SWIFTUI_LAYOUT_ANIMATION = Animation.spring({ bounce: 0, duration: 0.2 });
const HIDDEN_MEASUREMENT_STYLE = {
  opacity: 0,
  position: "absolute",
  width: "100%",
} satisfies ViewStyle;

type PlaygroundComposerProps = ComponentProps<typeof ChatComposer>;

export const COMPOSER_PLAYGROUND_VARIANTS = [
  {
    description: "UIKit glass and RN input with immediate composer and list resizing.",
    href: "/composer-native-instant",
    id: "native-instant",
    title: "RN Instant",
  },
  {
    description: "UIKit glass and RN input with matched 180ms composer and list resizing.",
    href: "/composer-native-timed",
    id: "native-timed",
    title: "RN Synchronized",
  },
  {
    description: "SwiftUI glass and controls with an intrinsic RNHostView input.",
    href: "/composer-swiftui-hosted",
    id: "swiftui-hosted",
    title: "SwiftUI + Hosted Input",
  },
  {
    description: "The RN input lives in its own Host, isolated from SwiftUI chrome updates.",
    href: "/composer-isolated-host",
    id: "isolated-host",
    title: "Isolated Input Host",
  },
  {
    description: "Pure SwiftUI baseline with native TextField and spring layout changes.",
    href: "/composer-swiftui-native",
    id: "swiftui-native",
    title: "Full SwiftUI",
  },
  {
    description: "A Fabric-native, auto-sizing SwiftUI composer from a custom Expo module.",
    href: "/composer-native-module",
    id: "native-module",
    title: "Native SwiftUI Module",
  },
] as const;

export type ComposerPlaygroundVariant = (typeof COMPOSER_PLAYGROUND_VARIANTS)[number]["id"];

function useKeyboardVisibility() {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(() => KeyboardController.isVisible());

  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        scheduleOnRN(setIsKeyboardVisible, event.progress === 1);
      },
    },
    [],
  );

  return isKeyboardVisible;
}

function useAnimatedComposerHorizontalInset() {
  const { progress } = useReanimatedKeyboardAnimation();

  return useAnimatedStyle(() => ({
    paddingHorizontal: interpolate(
      progress.value,
      [0, 1],
      [COMPOSER_INSET_CLOSED, COMPOSER_INSET_OPEN],
    ),
  }));
}

function useComposerInputHeight(value: string) {
  const [inputHeight, setInputHeight] = useState(COMPOSER_INPUT_MIN_HEIGHT);

  const handleContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const nextHeight = Math.min(
      COMPOSER_INPUT_MAX_HEIGHT,
      Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height)),
    );
    setInputHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
  };

  useEffect(() => {
    if (value.length === 0) {
      setInputHeight(COMPOSER_INPUT_MIN_HEIGHT);
    }
  }, [value]);

  return { handleContentSizeChange, inputHeight };
}

function ComposerLineProbe({
  horizontalInset,
  onMultilineChange,
  text,
}: {
  horizontalInset: number;
  onMultilineChange: (isMultiline: boolean) => void;
  text: string;
}) {
  return (
    <Text
      className="absolute top-0 text-[17px] leading-[22px] text-foreground opacity-0"
      onTextLayout={(event) => onMultilineChange(event.nativeEvent.lines.length > 1)}
      pointerEvents="none"
      style={{ left: horizontalInset, right: horizontalInset }}
    >
      {text.length === 0 ? "M" : `${text}\u200B`}
    </Text>
  );
}

function SwiftUILineProbe({
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
      style={HIDDEN_MEASUREMENT_STYLE}
    >
      <SwiftText
        modifiers={[
          accessibilityHidden(),
          frame({ maxWidth: Number.POSITIVE_INFINITY }),
          lineLimit(2),
          fixedSize({ horizontal: false, vertical: true }),
          padding({ horizontal: horizontalInset }),
        ]}
      >
        {text}
      </SwiftText>
    </Host>
  );
}

function PlaygroundTextInput({
  height,
  onChangeText,
  onContentSizeChange,
  value,
  width,
}: {
  height: number;
  onChangeText: (value: string) => void;
  onContentSizeChange: (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
  value: string;
  width?: number;
}) {
  return (
    <TextInput
      accessibilityLabel="Message"
      className="p-0 text-[17px] leading-[22px] text-foreground"
      cursorColorClassName="accent-accent"
      multiline
      nativeID="chat-composer"
      onChange={(event) => onChangeText(event.nativeEvent.text)}
      onContentSizeChange={onContentSizeChange}
      placeholder="Ask opencompany"
      placeholderTextColorClassName="accent-muted-foreground"
      scrollEnabled={height >= COMPOSER_INPUT_MAX_HEIGHT}
      selectionColorClassName="accent-accent"
      style={{ height, width: width ?? "100%" }}
      textAlignVertical="top"
      value={value}
    />
  );
}

function NativeComposer({
  animateLayout,
  bottomInset,
  disabled,
  onChangeText,
  onComposerLayout,
  onPillHeightChange,
  onSend,
  value,
  wrapperRef,
}: PlaygroundComposerProps & { animateLayout: boolean }) {
  const { theme } = useUniwind();
  const [foreground, accent, accentForeground] = useCSSVariable([
    "--color-foreground",
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string, string];
  const [isMultiline, setIsMultiline] = useState(false);
  const { handleContentSizeChange, inputHeight } = useComposerInputHeight(value);
  const keyboardInsetStyle = useAnimatedComposerHorizontalInset();
  const isExpanded = value.length > 0 && isMultiline;
  const sendDisabled = disabled || value.trim().length === 0;
  const bodyHeight = isExpanded
    ? COMPOSER_EXPANDED_VERTICAL_PADDING +
      inputHeight +
      COMPOSER_EXPANDED_ACTION_GAP +
      COMPOSER_CONTROL_SIZE +
      COMPOSER_EXPANDED_VERTICAL_PADDING
    : COMPOSER_MIN_HEIGHT;
  const inputTop = isExpanded
    ? COMPOSER_EXPANDED_VERTICAL_PADDING
    : (COMPOSER_MIN_HEIGHT - inputHeight) / 2;
  const inputHorizontalInset = isExpanded
    ? COMPOSER_CONTENT_HORIZONTAL_PADDING
    : COMPOSER_CONTENT_HORIZONTAL_PADDING + COMPOSER_TEXT_HORIZONTAL_INSET;

  return (
    <View
      className="pt-2"
      onLayout={onComposerLayout}
      ref={wrapperRef}
      style={{ paddingBottom: bottomInset + 8 }}
    >
      <Reanimated.View style={keyboardInsetStyle}>
        <Reanimated.View
          layout={animateLayout ? COMPOSER_LAYOUT_TRANSITION : undefined}
          onLayout={(event) => onPillHeightChange(event.nativeEvent.layout.height)}
          style={{ height: bodyHeight }}
        >
          <GlassView
            colorScheme={theme === "dark" ? "dark" : "light"}
            glassEffectStyle="regular"
            isInteractive
            style={{
              borderCurve: "continuous",
              borderRadius: isExpanded ? COMPOSER_EXPANDED_CORNER_RADIUS : COMPOSER_MIN_HEIGHT / 2,
              height: bodyHeight,
              overflow: "hidden",
              width: "100%",
            }}
          >
            <View className="flex-1">
              <View
                className="absolute right-2.5 left-2.5 flex-row items-center justify-between"
                style={{
                  bottom: isExpanded
                    ? COMPOSER_EXPANDED_VERTICAL_PADDING
                    : COMPOSER_CONTENT_VERTICAL_PADDING + 2,
                  height: COMPOSER_CONTROL_SIZE,
                }}
              >
                <Pressable
                  accessibilityLabel="Open attachments"
                  accessibilityRole="button"
                  className="h-9 w-9 items-center justify-center rounded-full active:opacity-55"
                  hitSlop={8}
                  onPress={() => router.push("/attachment-sheet")}
                >
                  <StyledSymbolView name="plus" size={20} tintColor={foreground} weight="medium" />
                </Pressable>

                <Pressable
                  accessibilityLabel="Send message"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: sendDisabled }}
                  className="h-9 w-9 items-center justify-center rounded-full active:opacity-55"
                  disabled={sendDisabled}
                  hitSlop={8}
                  onPress={onSend}
                  style={{ backgroundColor: accent, opacity: sendDisabled ? 0.4 : 1 }}
                >
                  <StyledSymbolView
                    name="arrow.up"
                    size={14}
                    tintColor={accentForeground}
                    weight="bold"
                  />
                </Pressable>
              </View>

              <View
                className="absolute"
                style={{
                  height: inputHeight,
                  left: inputHorizontalInset,
                  right: inputHorizontalInset,
                  top: inputTop,
                }}
              >
                <PlaygroundTextInput
                  height={inputHeight}
                  onChangeText={onChangeText}
                  onContentSizeChange={handleContentSizeChange}
                  value={value}
                />
              </View>

              <ComposerLineProbe
                horizontalInset={
                  COMPOSER_CONTENT_HORIZONTAL_PADDING + COMPOSER_TEXT_HORIZONTAL_INSET
                }
                onMultilineChange={setIsMultiline}
                text={value}
              />
            </View>
          </GlassView>
        </Reanimated.View>
      </Reanimated.View>
    </View>
  );
}

function NativeInstantComposer(props: PlaygroundComposerProps) {
  return <NativeComposer {...props} animateLayout={false} />;
}

function NativeTimedComposer(props: PlaygroundComposerProps) {
  return <NativeComposer {...props} animateLayout />;
}

function SwiftUIHostedComposer({
  bottomInset,
  disabled,
  onChangeText,
  onComposerLayout,
  onPillHeightChange,
  onSend,
  value,
  wrapperRef,
}: PlaygroundComposerProps) {
  const { width: windowWidth } = useWindowDimensions();
  const isKeyboardVisible = useKeyboardVisibility();
  const [isMultiline, setIsMultiline] = useState(false);
  const { handleContentSizeChange, inputHeight } = useComposerInputHeight(value);
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const isExpanded = value.length > 0 && isMultiline;
  const sendDisabled = disabled || value.trim().length === 0;
  const keyboardHorizontalInset = isKeyboardVisible ? 0 : COMPOSER_KEYBOARD_HORIZONTAL_INSET;
  const hostWidth = windowWidth - COMPOSER_WRAPPER_HORIZONTAL_PADDING * 2;
  const inputWidth = Math.max(
    1,
    hostWidth -
      keyboardHorizontalInset * 2 -
      COMPOSER_CONTENT_HORIZONTAL_PADDING * 2 -
      (isExpanded ? 0 : COMPOSER_TEXT_HORIZONTAL_INSET * 2),
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
        onLayoutContent={(event) => onPillHeightChange(event.nativeEvent.height)}
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
            animation(SWIFTUI_LAYOUT_ANIMATION, isExpanded),
          ]}
        >
          <ZStack
            modifiers={[
              layoutPriority(1),
              padding({
                horizontal: isExpanded ? 0 : COMPOSER_TEXT_HORIZONTAL_INSET,
                bottom: isExpanded ? COMPOSER_CONTROL_SIZE + COMPOSER_EXPANDED_ACTION_GAP : 0,
              }),
            ]}
          >
            <RNHostView matchContents>
              <PlaygroundTextInput
                height={inputHeight}
                onChangeText={onChangeText}
                onContentSizeChange={handleContentSizeChange}
                value={value}
                width={inputWidth}
              />
            </RNHostView>
          </ZStack>

          <SwiftUIActionRow
            accent={accent}
            accentForeground={accentForeground}
            onSend={onSend}
            sendDisabled={sendDisabled}
          />
        </ZStack>
      </Host>

      <ComposerLineProbe
        horizontalInset={
          keyboardHorizontalInset +
          COMPOSER_CONTENT_HORIZONTAL_PADDING +
          COMPOSER_TEXT_HORIZONTAL_INSET
        }
        onMultilineChange={setIsMultiline}
        text={value}
      />
    </View>
  );
}

function SwiftUIActionRow({
  accent,
  accentForeground,
  onSend,
  sendDisabled,
}: {
  accent: string;
  accentForeground: string;
  onSend: () => void;
  sendDisabled: boolean;
}) {
  return (
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
  );
}

function IsolatedHostComposer({
  bottomInset,
  disabled,
  onChangeText,
  onComposerLayout,
  onPillHeightChange,
  onSend,
  value,
  wrapperRef,
}: PlaygroundComposerProps) {
  const [isMultiline, setIsMultiline] = useState(false);
  const { handleContentSizeChange, inputHeight } = useComposerInputHeight(value);
  const keyboardInsetStyle = useAnimatedComposerHorizontalInset();
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const isExpanded = value.length > 0 && isMultiline;
  const sendDisabled = disabled || value.trim().length === 0;
  const bodyHeight = isExpanded
    ? COMPOSER_EXPANDED_VERTICAL_PADDING +
      inputHeight +
      COMPOSER_EXPANDED_ACTION_GAP +
      COMPOSER_CONTROL_SIZE +
      COMPOSER_EXPANDED_VERTICAL_PADDING
    : COMPOSER_MIN_HEIGHT;
  const inputTop = isExpanded
    ? COMPOSER_EXPANDED_VERTICAL_PADDING
    : (COMPOSER_MIN_HEIGHT - inputHeight) / 2;
  const inputHorizontalInset = isExpanded
    ? COMPOSER_CONTENT_HORIZONTAL_PADDING
    : COMPOSER_CONTENT_HORIZONTAL_PADDING + COMPOSER_TEXT_HORIZONTAL_INSET;

  return (
    <View
      className="pt-2"
      onLayout={onComposerLayout}
      ref={wrapperRef}
      style={{ paddingBottom: bottomInset + 8 }}
    >
      <Reanimated.View style={keyboardInsetStyle}>
        <View
          onLayout={(event) => onPillHeightChange(event.nativeEvent.layout.height)}
          style={{ height: bodyHeight }}
        >
          <Host
            seedColor={accent}
            ignoreSafeArea="all"
            style={{ height: bodyHeight, width: "100%" }}
          >
            <ZStack
              alignment="bottom"
              modifiers={[
                padding({
                  horizontal: COMPOSER_CONTENT_HORIZONTAL_PADDING,
                  vertical: isExpanded
                    ? COMPOSER_EXPANDED_VERTICAL_PADDING
                    : COMPOSER_CONTENT_VERTICAL_PADDING,
                }),
                frame({
                  maxHeight: Number.POSITIVE_INFINITY,
                  maxWidth: Number.POSITIVE_INFINITY,
                  minHeight: bodyHeight,
                }),
                glassEffect({
                  glass: { variant: "regular", interactive: true },
                  shape: isExpanded ? "roundedRectangle" : "capsule",
                  cornerRadius: isExpanded ? COMPOSER_EXPANDED_CORNER_RADIUS : undefined,
                }),
              ]}
            >
              <SwiftUIActionRow
                accent={accent}
                accentForeground={accentForeground}
                onSend={onSend}
                sendDisabled={sendDisabled}
              />
            </ZStack>
          </Host>

          <Host
            ignoreSafeArea="all"
            style={{
              height: inputHeight,
              left: inputHorizontalInset,
              position: "absolute",
              right: inputHorizontalInset,
              top: inputTop,
              zIndex: 1,
            }}
          >
            <ZStack
              modifiers={[
                frame({
                  maxHeight: Number.POSITIVE_INFINITY,
                  maxWidth: Number.POSITIVE_INFINITY,
                }),
              ]}
            >
              <RNHostView>
                <PlaygroundTextInput
                  height={inputHeight}
                  onChangeText={onChangeText}
                  onContentSizeChange={handleContentSizeChange}
                  value={value}
                />
              </RNHostView>
            </ZStack>
          </Host>

          <ComposerLineProbe
            horizontalInset={COMPOSER_CONTENT_HORIZONTAL_PADDING + COMPOSER_TEXT_HORIZONTAL_INSET}
            onMultilineChange={setIsMultiline}
            text={value}
          />
        </View>
      </Reanimated.View>
    </View>
  );
}

function FullSwiftUIComposer({
  bottomInset,
  disabled,
  onChangeText,
  onComposerLayout,
  onPillHeightChange,
  onSend,
  value,
  wrapperRef,
}: PlaygroundComposerProps) {
  const text = useNativeState(value);
  const isKeyboardVisible = useKeyboardVisibility();
  const [isMultiline, setIsMultiline] = useState(false);
  const singleLineHeightRef = useRef<number | null>(null);
  const contentHeightRef = useRef<number | null>(null);
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const isExpanded = value.length > 0 && isMultiline;
  const sendDisabled = disabled || value.trim().length === 0;
  const keyboardHorizontalInset = isKeyboardVisible ? 0 : COMPOSER_KEYBOARD_HORIZONTAL_INSET;
  const measurementHorizontalInset =
    keyboardHorizontalInset + COMPOSER_CONTENT_HORIZONTAL_PADDING + COMPOSER_TEXT_HORIZONTAL_INSET;
  const measurementText = value.length === 0 ? "M" : `${value}\u200B`;

  const updateMultilineState = () => {
    const singleLineHeight = singleLineHeightRef.current;
    const contentHeight = contentHeightRef.current;
    if (singleLineHeight === null || contentHeight === null) {
      return;
    }
    setIsMultiline(contentHeight > singleLineHeight + 1);
  };

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
            animation(SWIFTUI_LAYOUT_ANIMATION, isExpanded),
          ]}
        >
          <ZStack
            modifiers={[
              layoutPriority(1),
              frame({ maxWidth: Number.POSITIVE_INFINITY }),
              padding({
                horizontal: isExpanded ? 0 : COMPOSER_TEXT_HORIZONTAL_INSET,
                bottom: isExpanded ? COMPOSER_CONTROL_SIZE + COMPOSER_EXPANDED_ACTION_GAP : 0,
              }),
            ]}
          >
            <TextField
              axis="vertical"
              onTextChange={onChangeText}
              placeholder="Ask opencompany"
              text={text}
              modifiers={[
                accessibilityLabel("Message"),
                frame({ maxWidth: Number.POSITIVE_INFINITY }),
                lineLimit({ min: 1, max: 5 }),
                fixedSize({ horizontal: false, vertical: true }),
              ]}
            />
          </ZStack>

          <SwiftUIActionRow
            accent={accent}
            accentForeground={accentForeground}
            onSend={onSend}
            sendDisabled={sendDisabled}
          />
        </ZStack>
      </Host>

      <SwiftUILineProbe
        horizontalInset={measurementHorizontalInset}
        onHeightChange={(height) => {
          singleLineHeightRef.current = height;
          updateMultilineState();
        }}
        text="M"
      />
      <SwiftUILineProbe
        horizontalInset={measurementHorizontalInset}
        onHeightChange={(height) => {
          contentHeightRef.current = height;
          updateMultilineState();
        }}
        text={measurementText}
      />
    </View>
  );
}

function NativeModuleComposer({
  bottomInset,
  disabled,
  onComposerHeightChange,
  onPillHeightChange,
  onSendText,
  value,
}: PlaygroundComposerProps) {
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const pillHeightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasHeight =
    NATIVE_MODULE_CANVAS_PILL_HEIGHT + NATIVE_MODULE_OUTER_VERTICAL_PADDING + bottomInset;

  useEffect(
    () => () => {
      if (pillHeightTimeoutRef.current !== null) {
        clearTimeout(pillHeightTimeoutRef.current);
      }
    },
    [],
  );

  const handleComposerHeightChange = (pillHeight: number) => {
    onComposerHeightChange(pillHeight + NATIVE_MODULE_OUTER_VERTICAL_PADDING + bottomInset);

    if (pillHeightTimeoutRef.current !== null) {
      clearTimeout(pillHeightTimeoutRef.current);
    }

    pillHeightTimeoutRef.current = setTimeout(() => {
      pillHeightTimeoutRef.current = null;
      onPillHeightChange(pillHeight);
    }, NATIVE_MODULE_PILL_HEIGHT_SETTLE_DELAY);
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
          nativeID="chat-composer"
          onAttachmentPress={() => router.push("/attachment-sheet")}
          onComposerHeightChange={(event) => handleComposerHeightChange(event.nativeEvent.height)}
          onSend={(event) => onSendText(event.nativeEvent.value)}
          style={{ height: "100%", width: "100%" }}
          value={value}
        />
      </Host>
    </View>
  );
}

const VARIANT_CONFIG = {
  "isolated-host": {
    composer: IsolatedHostComposer,
    insetBehavior: "timing",
  },
  "native-instant": {
    composer: NativeInstantComposer,
    insetBehavior: "immediate",
  },
  "native-module": {
    composer: NativeModuleComposer,
    insetBehavior: "immediate",
  },
  "native-timed": {
    composer: NativeTimedComposer,
    insetBehavior: "timing",
  },
  "swiftui-hosted": {
    composer: SwiftUIHostedComposer,
    insetBehavior: "spring",
  },
  "swiftui-native": {
    composer: FullSwiftUIComposer,
    insetBehavior: "spring",
  },
} as const;

export function ComposerPlaygroundChat({ variant }: { variant: ComposerPlaygroundVariant }) {
  const config = VARIANT_CONFIG[variant];
  return <StreamingChat composer={config.composer} composerInsetBehavior={config.insetBehavior} />;
}
