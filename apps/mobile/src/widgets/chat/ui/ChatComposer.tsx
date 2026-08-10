import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputContentSizeChangeEventData,
  View,
} from "react-native";

const MIN_INPUT_HEIGHT = 24;
const MAX_INPUT_HEIGHT = 120;
const liquidGlassAvailable = isLiquidGlassAvailable();

type ChatComposerProps = {
  bottomInset: number;
  disabled: boolean;
  isDark: boolean;
  onChangeText: (value: string) => void;
  onComposerLayout: (event: LayoutChangeEvent) => void;
  onPillHeightChange: (height: number) => void;
  onSend: () => void;
  value: string;
  wrapperRef: RefObject<View | null>;
};

export function ChatComposer({
  bottomInset,
  disabled,
  isDark,
  onChangeText,
  onComposerLayout,
  onPillHeightChange,
  onSend,
  value,
  wrapperRef,
}: ChatComposerProps) {
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const sendDisabled = disabled || value.trim().length === 0;

  useEffect(() => {
    if (value.length === 0) {
      setInputHeight(MIN_INPUT_HEIGHT);
    }
  }, [value]);

  const handleContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    setInputHeight(
      Math.min(MAX_INPUT_HEIGHT, Math.max(MIN_INPUT_HEIGHT, event.nativeEvent.contentSize.height)),
    );
  };

  const content = (
    <View style={styles.pillContent}>
      <Pressable
        accessibilityLabel="Open attachments"
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => router.push("/attachment-sheet")}
        style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
      >
        <SymbolView
          name="plus"
          size={20}
          tintColor={isDark ? "#F5F5F5" : "#171717"}
          weight="medium"
        />
      </Pressable>

      <TextInput
        accessibilityLabel="Message"
        accessibilityState={{ disabled }}
        editable={!disabled}
        focusable={!disabled}
        maxFontSizeMultiplier={1.5}
        multiline
        nativeID="chat-composer"
        onChangeText={onChangeText}
        onContentSizeChange={handleContentSizeChange}
        placeholder="Ask opencompany"
        placeholderTextColor={isDark ? "#A3A3A3" : "#737373"}
        scrollEnabled={inputHeight >= MAX_INPUT_HEIGHT}
        style={[styles.input, isDark ? styles.inputDark : null, { height: inputHeight }]}
        value={value}
      />

      <Pressable
        accessibilityLabel="Send message"
        accessibilityRole="button"
        accessibilityState={{ disabled: sendDisabled }}
        disabled={sendDisabled}
        hitSlop={8}
        onPress={onSend}
        style={({ pressed }) => [
          styles.sendButton,
          pressed && !sendDisabled ? styles.pressed : null,
          sendDisabled ? styles.sendButtonDisabled : null,
        ]}
      >
        <SymbolView name="arrow.up" size={15} tintColor="#FFFFFF" weight="bold" />
      </Pressable>
    </View>
  );

  return (
    <View
      onLayout={onComposerLayout}
      ref={wrapperRef}
      style={[styles.wrapper, { paddingBottom: bottomInset + 8 }]}
    >
      {liquidGlassAvailable ? (
        <GlassView
          glassEffectStyle="regular"
          colorScheme={isDark ? "dark" : "light"}
          isInteractive
          onLayout={(event) => onPillHeightChange(event.nativeEvent.layout.height)}
          style={styles.pill}
        >
          {content}
        </GlassView>
      ) : (
        <View
          onLayout={(event) => onPillHeightChange(event.nativeEvent.layout.height)}
          style={[styles.pill, styles.fallbackPill, isDark ? styles.fallbackPillDark : null]}
        >
          {content}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fallbackPill: {
    backgroundColor: "rgba(250, 250, 250, 0.96)",
    borderColor: "rgba(0, 0, 0, 0.1)",
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000000",
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
  },
  fallbackPillDark: {
    backgroundColor: "rgba(38, 38, 38, 0.96)",
    borderColor: "rgba(255, 255, 255, 0.14)",
  },
  iconButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  input: {
    color: "#171717",
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    marginHorizontal: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  inputDark: {
    color: "#F5F5F5",
  },
  pill: {
    borderRadius: 28,
    overflow: "hidden",
  },
  pillContent: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 52,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  pressed: {
    opacity: 0.55,
  },
  sendButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "#007AFF",
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  sendButtonDisabled: {
    backgroundColor: "#A3A3A3",
  },
  wrapper: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
});
