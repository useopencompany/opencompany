import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Pressable,
  TextInput,
  type TextInputContentSizeChangeEventData,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import { until } from "until-async";
import { StyledGlassView } from "@/shared/ui/styled-glass-view";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import { useChatComposer } from "../model/chat-composer-context";
import { useChatInputController } from "../model/chat-input-controller";
import { ComposerAttachments } from "./composer-attachments";

const COMPOSER_MINIMUM_HEIGHT = 52;
const COMPOSER_INPUT_LINE_HEIGHT = 22;
const COMPOSER_INPUT_MAX_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT * 5;
const COMPOSER_CLOSED_HORIZONTAL_INSET = 40;
const COMPOSER_OPEN_HORIZONTAL_INSET = 12;

function sendButtonOpacity(input: {
  canSend: boolean;
  disabled: boolean;
  isGenerating: boolean;
  isSending: boolean;
  isStopping: boolean;
}): number {
  if (input.isGenerating) return input.isStopping ? 0.6 : 1;
  return input.disabled || input.isSending || !input.canSend ? 0.45 : 1;
}

export interface ChatComposerHandle {
  blur: () => void;
  focus: () => void;
  isFocused: () => boolean;
}

export interface SentMessageIdentity {
  conversationId: string;
  userMessageId: string;
}

export function ChatComposer({
  autoFocus,
  bottomInset,
  conversationId,
  containerRef,
  disabled,
  isGenerating,
  isStopping,
  onLayout,
  onSend,
  onStop,
  ref,
}: {
  autoFocus: boolean;
  bottomInset: number;
  conversationId: string;
  containerRef: Ref<View>;
  disabled: boolean;
  isGenerating: boolean;
  isStopping: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  onSend: () => Promise<SentMessageIdentity>;
  onStop: () => Promise<void>;
  ref?: Ref<ChatComposerHandle>;
}) {
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const { showErrorToast } = useToast();
  const composer = useChatComposer();
  const input = useChatInputController();
  const [contentHeight, setContentHeight] = useState(COMPOSER_INPUT_LINE_HEIGHT);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const didHandleInitialFocusRef = useRef(false);
  const isActiveConversation = composer.conversationId === conversationId;
  const attachments = isActiveConversation ? composer.attachments : [];
  const value = isActiveConversation ? composer.value : "";
  const hasMultipleLines = contentHeight > COMPOSER_INPUT_LINE_HEIGHT + 1;
  const expanded = hasMultipleLines || attachments.length > 0;
  const canSend = Boolean(value.trim() || attachments.length > 0);
  const horizontalInset =
    focused || expanded ? COMPOSER_OPEN_HORIZONTAL_INSET : COMPOSER_CLOSED_HORIZONTAL_INSET;

  useImperativeHandle(ref, () => ({
    blur: () => input.composerInputRef.current?.blur(),
    focus: () => input.composerInputRef.current?.focus(),
    isFocused: () => focusedRef.current,
  }));

  const sendMutation = useMutation({
    mutationFn: async () => {
      await composer.flushDraft();
      return onSend();
    },
    onSuccess: () => composer.clearAfterSend(),
    onError: (error) =>
      showErrorToast(
        error instanceof Error ? error.message : "The message could not be sent.",
        error,
        "chat.message.send",
      ),
  });

  useLayoutEffect(() => {
    if (!isActiveConversation || !composer.isReady || input.drawerOpen) {
      return;
    }
    const shouldHandleInitialFocus = autoFocus && !didHandleInitialFocusRef.current;
    const shouldHandleRequestedFocus = input.consumeComposerFocusRequest(input.focusRequestId);
    if (!shouldHandleInitialFocus && !shouldHandleRequestedFocus) return;
    if (shouldHandleInitialFocus) didHandleInitialFocusRef.current = true;
    input.composerInputRef.current?.focus();
  }, [autoFocus, composer.isReady, input.drawerOpen, input.focusRequestId, isActiveConversation]);

  useEffect(() => {
    if (!isActiveConversation && focusedRef.current) input.composerInputRef.current?.blur();
  }, [isActiveConversation]);

  const handleContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const nextHeight = Math.min(
      COMPOSER_INPUT_MAX_HEIGHT,
      Math.max(COMPOSER_INPUT_LINE_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height)),
    );
    setContentHeight((current) => (Math.abs(current - nextHeight) <= 1 ? current : nextHeight));
  };

  return (
    <View
      className="pt-2"
      onLayout={onLayout}
      pointerEvents="box-none"
      ref={containerRef}
      style={{ paddingBottom: bottomInset + 8, paddingHorizontal: horizontalInset }}
    >
      <StyledGlassView
        className="w-full overflow-hidden px-2.5"
        glassEffectStyle="regular"
        isInteractive
        style={{
          borderRadius: expanded ? 24 : COMPOSER_MINIMUM_HEIGHT / 2,
          minHeight: COMPOSER_MINIMUM_HEIGHT,
        }}
      >
        <ComposerAttachments attachments={attachments} onRemove={composer.removeAttachment} />
        <View className="relative min-h-[40px] justify-center">
          <TextInput
            accessibilityLabel="Message"
            blurOnSubmit={false}
            className="text-[17px] text-foreground leading-[22px]"
            editable={!disabled && isActiveConversation}
            multiline
            nativeID="chat-composer"
            onBlur={() => {
              focusedRef.current = false;
              setFocused(false);
            }}
            onChangeText={composer.setValue}
            onContentSizeChange={handleContentSizeChange}
            onFocus={() => {
              focusedRef.current = true;
              setFocused(true);
              input.setKeyboardOwner("composer");
            }}
            placeholder="Ask opencompany"
            placeholderTextColorClassName="accent-muted-foreground"
            ref={input.composerInputRef}
            scrollEnabled={contentHeight >= COMPOSER_INPUT_MAX_HEIGHT}
            selectionColor={accent}
            style={{
              height: contentHeight + (expanded ? 48 : 0),
              maxHeight: COMPOSER_INPUT_MAX_HEIGHT + (expanded ? 48 : 0),
              minHeight: COMPOSER_INPUT_LINE_HEIGHT,
              paddingBottom: expanded ? 48 : 0,
              paddingHorizontal: expanded ? 0 : 44,
              paddingTop: 0,
              textAlignVertical: "top",
            }}
            value={value}
          />
          <Pressable
            accessibilityLabel="Open attachments"
            accessibilityRole="button"
            className="absolute bottom-0 left-0 size-9 items-center justify-center rounded-full active:bg-secondary"
            disabled={disabled}
            hitSlop={4}
            onPress={() => {
              void input.dismissComposer();
              router.push("/attachment-sheet");
            }}
          >
            <StyledSymbolView
              name="plus"
              size={20}
              tintColorClassName="accent-foreground"
              weight="medium"
            />
          </Pressable>
          <Pressable
            accessibilityLabel={isGenerating ? (isStopping ? "Stopping" : "Stop") : "Send message"}
            accessibilityRole="button"
            className="absolute right-0 bottom-0 size-9 items-center justify-center rounded-full active:opacity-70"
            disabled={isGenerating ? isStopping : disabled || sendMutation.isPending || !canSend}
            hitSlop={4}
            onPress={() => {
              if (isGenerating) {
                void until(onStop).then(([error]) => {
                  if (error) {
                    showErrorToast("The stop request could not be saved.", error, "chat.run.stop");
                  }
                });
                return;
              }
              sendMutation.mutate();
            }}
            style={{
              backgroundColor: accent,
              opacity: sendButtonOpacity({
                canSend,
                disabled,
                isGenerating,
                isSending: sendMutation.isPending,
                isStopping,
              }),
            }}
          >
            <StyledSymbolView
              name={isGenerating ? "stop.fill" : "arrow.up"}
              size={isGenerating ? 13 : 15}
              tintColor={accentForeground}
              weight="bold"
            />
          </Pressable>
        </View>
      </StyledGlassView>
    </View>
  );
}
