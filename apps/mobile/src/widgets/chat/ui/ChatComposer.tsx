import { Host } from "@expo/ui";
import { RNHostView } from "@expo/ui/swift-ui";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import type { Ref } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { until } from "until-async";
import { analytics } from "@/shared/lib/analytics";
import { useToast } from "@/shared/ui/toast";
import { NativeChatComposerView } from "../../../../modules/native-chat-composer";
import { useChatComposer } from "../model/chat-composer-context";
import { type ComposerInputHandle, useChatInputController } from "../model/chat-input-controller";
import type { StoredDraft } from "../model/chat-store";
import { ComposerAttachments } from "./composer-attachments";

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
  isScreenFocused,
  isGenerating,
  isStopping,
  onLayout,
  onSend,
  onStop,
}: {
  autoFocus: boolean;
  bottomInset: number;
  conversationId: string;
  containerRef: Ref<View>;
  disabled: boolean;
  isScreenFocused: boolean;
  isGenerating: boolean;
  isStopping: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  onSend: (draft: StoredDraft) => Promise<SentMessageIdentity>;
  onStop: () => Promise<void>;
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
  const [nativeLayoutReady, setNativeLayoutReady] = useState(false);
  const focusedRef = useRef(false);
  const didHandleInitialFocusRef = useRef(false);
  const isActiveConversation = composer.conversationId === conversationId;
  const attachments = isActiveConversation ? composer.attachments : [];
  const value = isActiveConversation ? composer.value : "";

  const focusHandle = () => {
    input.setKeyboardOwner("composer");
    setFocusRequest((request) => request + 1);
  };
  const blurHandle = () => setBlurRequest((request) => request + 1);
  useLayoutEffect(() => {
    if (!isScreenFocused || !isActiveConversation) return;
    const handle: ComposerInputHandle = {
      blur: blurHandle,
      focus: focusHandle,
      isFocused: () => focusedRef.current,
    };
    input.composerInputRef.current = handle;
    return () => {
      if (input.composerInputRef.current === handle) input.composerInputRef.current = null;
    };
  }, [isScreenFocused, isActiveConversation]);

  const sendMutation = useMutation({
    mutationFn: (draft: StoredDraft) => {
      analytics.capture("message_send_started", {
        attachment_count: draft.attachments.length,
        has_text: Boolean(draft.text.trim()),
        is_new_chat: draft.conversationId === "new",
        model_id: draft.modelId,
      });
      return onSend(draft);
    },
    onError: (error) =>
      showErrorToast(
        error instanceof Error ? error.message : "The message could not be sent.",
        error,
        "chat.message.send",
      ),
  });

  useLayoutEffect(() => {
    if (
      !isScreenFocused ||
      !isActiveConversation ||
      !composer.isReady ||
      !nativeLayoutReady ||
      input.drawerOpen
    )
      return;
    const shouldHandleInitialFocus = autoFocus && !didHandleInitialFocusRef.current;
    const shouldHandleRequestedFocus =
      autoFocus && input.consumeComposerFocusRequest(input.focusRequestId);
    if (!shouldHandleInitialFocus && !shouldHandleRequestedFocus) return;
    if (shouldHandleInitialFocus) didHandleInitialFocusRef.current = true;
    focusHandle();
  }, [
    autoFocus,
    composer.isReady,
    nativeLayoutReady,
    input.drawerOpen,
    input.focusRequestId,
    isActiveConversation,
    isScreenFocused,
  ]);

  useEffect(() => {
    if ((!isActiveConversation || !isScreenFocused) && focusedRef.current) blurHandle();
  }, [isActiveConversation, isScreenFocused]);

  return (
    <View
      onLayout={onLayout}
      pointerEvents="box-none"
      ref={containerRef}
      // Reserve space in both Yoga and the Host. A parent minimum alone still
      // lets the hosting view collapse during its first content measurement.
      style={{ minHeight: bottomInset + 68, paddingBottom: bottomInset }}
    >
      <Host
        ignoreSafeArea="all"
        matchContents={{ horizontal: false, vertical: true }}
        pointerEvents="box-none"
        style={{ width: "100%", minHeight: 68 }}
      >
        <NativeChatComposerView
          accentColor={accent}
          accentForegroundColor={accentForeground}
          blurRequest={blurRequest}
          bottomInset={0}
          disabled={disabled || sendMutation.isPending || !isActiveConversation}
          focusRequest={focusRequest}
          hasAttachments={attachments.length > 0}
          isGenerating={isGenerating}
          isStopping={isStopping}
          nativeID="chat-composer"
          mostRecentEventCount={isActiveConversation ? composer.nativeEventCount : 0}
          onAttachmentPress={() => {
            blurHandle();
            analytics.capture("attachment_picker_opened");
            router.push("/attachment-sheet");
          }}
          onChangeText={(event) => {
            if (isActiveConversation)
              composer.setValue(event.nativeEvent.value, event.nativeEvent.eventCount);
          }}
          onComposerHeightChange={(event) => {
            if (event.nativeEvent.height >= 68) setNativeLayoutReady(true);
          }}
          onFocusChange={(event) => {
            focusedRef.current = event.nativeEvent.focused;
            if (event.nativeEvent.focused) input.setKeyboardOwner("composer");
          }}
          onSend={(event) => {
            if (!sendMutation.isPending && isActiveConversation) {
              composer.setValue("", event.nativeEvent.eventCount);
              sendMutation.mutate({
                conversationId,
                text: event.nativeEvent.value,
                modelId: composer.selectedModelId,
                attachments,
              });
            }
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
