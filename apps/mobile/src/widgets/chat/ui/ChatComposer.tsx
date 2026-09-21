import { Host } from "@expo/ui";
import { RNHostView } from "@expo/ui/swift-ui";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { until } from "until-async";
import { analytics } from "@/shared/lib/analytics";
import { useToast } from "@/shared/ui/toast";
import { NativeChatComposerView } from "../../../../modules/native-chat-composer";
import { useChatComposer } from "../model/chat-composer-context";
import { type ComposerInputHandle, useChatInputController } from "../model/chat-input-controller";
import { ComposerAttachments } from "./composer-attachments";

export interface ChatComposerHandle extends ComposerInputHandle {}

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
  const { showErrorToast } = useToast();
  const composer = useChatComposer();
  const input = useChatInputController();
  const [accent, accentForeground] = useCSSVariable([
    "--color-accent",
    "--color-accent-foreground",
  ]) as [string, string];
  const [blurRequest, setBlurRequest] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusedRef = useRef(false);
  const didHandleInitialFocusRef = useRef(false);
  const isActiveConversation = composer.conversationId === conversationId;
  const attachments = isActiveConversation ? composer.attachments : [];
  const value = isActiveConversation ? composer.value : "";

  const focusHandle = () => setFocusRequest((request) => request + 1);
  const blurHandle = () => setBlurRequest((request) => request + 1);
  const createHandle = (): ChatComposerHandle => ({
    blur: blurHandle,
    focus: focusHandle,
    isFocused: () => focusedRef.current,
  });
  useImperativeHandle(ref, createHandle);
  useImperativeHandle(input.composerInputRef, createHandle);

  const sendMutation = useMutation({
    mutationFn: async () => {
      analytics.capture("message_send_started", {
        attachment_count: attachments.length,
        has_text: Boolean(value.trim()),
        is_new_chat: conversationId === "new",
        model_id: composer.selectedModelId,
      });
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
    if (!isActiveConversation || !composer.isReady || input.drawerOpen) return;
    const shouldHandleInitialFocus = autoFocus && !didHandleInitialFocusRef.current;
    const shouldHandleRequestedFocus = input.consumeComposerFocusRequest(input.focusRequestId);
    if (!shouldHandleInitialFocus && !shouldHandleRequestedFocus) return;
    if (shouldHandleInitialFocus) didHandleInitialFocusRef.current = true;
    focusHandle();
  }, [autoFocus, composer.isReady, input.drawerOpen, input.focusRequestId, isActiveConversation]);

  useEffect(() => {
    if (!isActiveConversation && focusedRef.current) blurHandle();
  }, [isActiveConversation]);

  return (
    <View onLayout={onLayout} pointerEvents="box-none" ref={containerRef}>
      <Host
        ignoreSafeArea="all"
        matchContents={{ horizontal: false, vertical: true }}
        pointerEvents="box-none"
        style={{ width: "100%" }}
      >
        <NativeChatComposerView
          accentColor={accent}
          accentForegroundColor={accentForeground}
          blurRequest={blurRequest}
          bottomInset={bottomInset}
          disabled={disabled || sendMutation.isPending || !isActiveConversation}
          focusRequest={focusRequest}
          hasAttachments={attachments.length > 0}
          isGenerating={isGenerating}
          isStopping={isStopping}
          nativeID="chat-composer"
          onAttachmentPress={() => {
            blurHandle();
            analytics.capture("attachment_picker_opened");
            router.push("/attachment-sheet");
          }}
          onChangeText={(event) => composer.setValue(event.nativeEvent.value)}
          onFocusChange={(event) => {
            focusedRef.current = event.nativeEvent.focused;
            if (event.nativeEvent.focused) input.setKeyboardOwner("composer");
          }}
          onSend={() => {
            if (!sendMutation.isPending) sendMutation.mutate();
          }}
          onStop={() => {
            void until(onStop).then(([error]) => {
              if (error)
                showErrorToast("The stop request could not be saved.", error, "chat.run.stop");
            });
          }}
          style={{ width: "100%" }}
          value={value}
        >
          {attachments.length > 0 ? (
            <RNHostView matchContents>
              <ComposerAttachments attachments={attachments} onRemove={composer.removeAttachment} />
            </RNHostView>
          ) : undefined}
        </NativeChatComposerView>
      </Host>
    </View>
  );
}
