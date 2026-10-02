import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import type { Ref } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { until } from "until-async";
import { analytics } from "@/shared/lib/analytics";
import { useReducedTransparency } from "@/shared/lib/use-reduced-transparency";
import { StyledAnimatedSymbol } from "@/shared/ui/animated-symbol";
import { StyledGlassView } from "@/shared/ui/styled-glass-view";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import { useChatComposer } from "../model/chat-composer-context";
import { type ComposerInputHandle, useChatInputController } from "../model/chat-input-controller";
import type { OutgoingDraft } from "../model/chat-store";
import {
  EFFORT_LABELS,
  ENGINE_LABELS,
  effectiveEffort,
  isGoalBlockingSend,
  modelLabel,
  selectedModelId,
} from "../model/composer-selection";
import { ComposerAttachments } from "./composer-attachments";
import { ModelLogo } from "./model-logo";

export interface SentMessageIdentity {
  conversationId: string;
  userMessageId: string;
}

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Horizontal margin shared with the attachment menu and camera panel, so they line up.
export const COMPOSER_HORIZONTAL_MARGIN = 12;
// A first-frame estimate of the single-line composer, replaced by the measured height on layout.
export const COMPOSER_ESTIMATED_HEIGHT = 110;
const MAX_VISIBLE_LINES = 8;
// The system font's own line height at 17pt. The input keeps it: a fixed lineHeight puts the caret
// of an empty line out of place until the first character lands.
const LINE_HEIGHT = 20.5;
const INPUT_VERTICAL_PADDING = 16;
const CONTROLS_HEIGHT = 48;
// The pill label grows with Dynamic Type up to this factor, so it cannot crowd out the buttons.
const PILL_MAX_FONT_SCALE = 1.6;
const ATTACHMENTS_HEIGHT = 120;
// The navigation bar and the space the transcript keeps below it.
const TOP_CLEARANCE = 64;

export function ChatComposer({
  autoFocus,
  bottomInset,
  conversationId,
  containerRef,
  disabled,
  isScreenFocused,
  isGenerating,
  isStopping,
  onAttachmentPress,
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
  onAttachmentPress: (anchor: WindowFrame) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onSend: (draft: OutgoingDraft) => Promise<SentMessageIdentity>;
  onStop: () => Promise<void>;
}) {
  const { showErrorToast } = useToast();
  const composer = useChatComposer();
  const input = useChatInputController();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const reducedTransparency = useReducedTransparency();
  const inputRef = useRef<TextInput>(null);
  const plusRef = useRef<View>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const didHandleInitialFocusRef = useRef(false);
  const isActiveConversation = composer.conversationId === conversationId;
  const attachments = isActiveConversation ? composer.attachments : [];
  const value = isActiveConversation ? composer.value : "";
  // The input owns its text while the user types: echoing keystrokes back through React drops
  // characters under fast input, and a render can briefly carry an older value. So text only flows
  // into the native view while the input is blurred, which is when conversations switch and failed
  // sends restore. The input mounts once the draft has loaded, so hydration never remounts it and
  // new-chat focus lands on the input that stays. Sending clears the input directly.
  const inputMounted = composer.isReady;
  const typedTextRef = useRef(value);
  const inputWasMountedRef = useRef(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputRevision, setInputRevision] = useState(0);
  // The input scrolls only once its text fills the last visible line. While it still grows, a
  // scrolling text view jumps to the caret for a frame before the new height lands. At the cap it
  // no longer grows, and scrolling lets the text view keep the caret in sight.
  const [inputScrolls, setInputScrolls] = useState(false);
  useLayoutEffect(() => {
    const justMounted = inputMounted && !inputWasMountedRef.current;
    inputWasMountedRef.current = inputMounted;
    if (!inputMounted || justMounted) {
      typedTextRef.current = value;
      return;
    }
    if (inputFocused || value === typedTextRef.current) return;
    typedTextRef.current = value;
    if (value) setInputRevision((revision) => revision + 1);
    else inputRef.current?.clear();
  }, [value, inputFocused, inputMounted]);
  const { selection, locks } = composer;

  const focusInput = () => {
    input.setKeyboardOwner("composer");
    inputRef.current?.focus();
  };
  useLayoutEffect(() => {
    if (!isScreenFocused || !isActiveConversation) return;
    const handle: ComposerInputHandle = {
      blur: () => inputRef.current?.blur(),
      focus: focusInput,
      isFocused: () => inputRef.current?.isFocused() ?? false,
    };
    input.composerInputRef.current = handle;
    return () => {
      if (input.composerInputRef.current === handle) input.composerInputRef.current = null;
    };
  }, [isScreenFocused, isActiveConversation]);

  const sendMutation = useMutation({
    mutationFn: (draft: OutgoingDraft) => {
      analytics.capture("message_send_started", {
        attachment_count: draft.attachments.length,
        has_text: Boolean(draft.text.trim()),
        is_new_chat: draft.conversationId === "new",
        engine: draft.selection.engine,
        model_id: selectedModelId(draft.selection),
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
      !layoutReady ||
      input.drawerOpen
    )
      return;
    // Closing the model sheet returns focus to where it was before the sheet opened.
    if (input.takeHeldComposerFocus()) {
      focusInput();
      return;
    }
    const shouldHandleInitialFocus = autoFocus && !didHandleInitialFocusRef.current;
    const shouldHandleRequestedFocus =
      autoFocus && input.consumeComposerFocusRequest(input.focusRequestId);
    if (!shouldHandleInitialFocus && !shouldHandleRequestedFocus) return;
    if (shouldHandleInitialFocus) didHandleInitialFocusRef.current = true;
    focusInput();
  }, [
    autoFocus,
    composer.isReady,
    layoutReady,
    input.drawerOpen,
    input.focusRequestId,
    isActiveConversation,
    isScreenFocused,
  ]);

  useEffect(() => {
    if ((!isActiveConversation || !isScreenFocused) && inputRef.current?.isFocused())
      inputRef.current.blur();
  }, [isActiveConversation, isScreenFocused]);

  const goalBlocksSend = !locks.isTask && isGoalBlockingSend(selection);
  const hasContent = Boolean(value.trim()) || attachments.length > 0;
  const sendDisabled =
    disabled || !isActiveConversation || sendMutation.isPending || !hasContent || goalBlocksSend;

  const send = () => {
    if (sendDisabled) return;
    // Clear in the tap itself. The request carries its own copy of the text and selection.
    typedTextRef.current = "";
    inputRef.current?.clear();
    composer.setValue("");
    sendMutation.mutate({ conversationId, text: value, selection, attachments });
  };

  // Grow through eight lines, then scroll inside the input. Large Dynamic Type sizes and a raised
  // keyboard leave less room, so the input never pushes the controls under the navigation bar.
  const lineHeight = LINE_HEIGHT * fontScale;
  const reservedHeight =
    insets.top +
    TOP_CLEARANCE +
    CONTROLS_HEIGHT * Math.min(fontScale, PILL_MAX_FONT_SCALE) +
    (attachments.length > 0 ? ATTACHMENTS_HEIGHT : 0) +
    Math.max(keyboardHeight, bottomInset) +
    16;
  const maxInputHeight = Math.max(
    lineHeight + INPUT_VERTICAL_PADDING,
    Math.min(MAX_VISIBLE_LINES * lineHeight, windowHeight - reservedHeight) +
      INPUT_VERTICAL_PADDING,
  );

  const modelId = selectedModelId(selection);
  const effort = effectiveEffort(selection);
  const isCodingAgent = selection.engine !== "opencompany";
  const modelControlDisabled = disabled || locks.isTask;

  const content = (
    <>
      {attachments.length > 0 ? (
        <View className="px-2.5 pt-2.5">
          <ComposerAttachments attachments={attachments} onRemove={composer.removeAttachment} />
        </View>
      ) : null}
      {inputMounted ? (
        <TextInput
          accessibilityLabel="Message"
          className="px-4 pt-3 pb-1 text-[17px] text-foreground"
          editable={isActiveConversation && !disabled}
          multiline
          nativeID="chat-composer"
          defaultValue={value}
          key={inputRevision}
          onChangeText={(text) => {
            typedTextRef.current = text;
            if (isActiveConversation) composer.setValue(text);
          }}
          onBlur={() => setInputFocused(false)}
          onContentSizeChange={(event) =>
            setInputScrolls(event.nativeEvent.contentSize.height > maxInputHeight - lineHeight / 2)
          }
          onFocus={() => {
            setInputFocused(true);
            input.setKeyboardOwner("composer");
          }}
          placeholder="Ask opencompany"
          placeholderTextColorClassName="accent-muted-foreground"
          ref={inputRef}
          scrollEnabled={inputScrolls}
          selectionColorClassName="accent-accent"
          style={{ maxHeight: maxInputHeight }}
          // A chat message is never a credential or contact field, so keep iOS AutoFill away.
          textContentType="none"
        />
      ) : (
        <View style={{ height: lineHeight + INPUT_VERTICAL_PADDING }} />
      )}
      <View className="min-h-12 flex-row items-center gap-1.5 px-2 pb-1">
        <Pressable
          accessibilityLabel="Add attachment"
          accessibilityRole="button"
          className="size-9 shrink-0 items-center justify-center rounded-full active:opacity-60"
          disabled={disabled || !isActiveConversation}
          hitSlop={4}
          onPress={() => {
            plusRef.current?.measureInWindow((x, y, width, height) => {
              analytics.capture("attachment_picker_opened");
              onAttachmentPress({ x, y, width, height });
            });
          }}
          ref={plusRef}
        >
          <StyledSymbolView
            name="plus"
            size={20}
            tintColorClassName="accent-foreground"
            weight="medium"
          />
        </Pressable>
        <Pressable
          accessibilityHint={
            locks.isTask ? "Replies keep the Task's model." : "Opens model and agent settings."
          }
          accessibilityLabel={[
            `Model: ${modelLabel(modelId)}`,
            isCodingAgent ? ENGINE_LABELS[selection.engine] : null,
            effort ? `${EFFORT_LABELS[effort]} effort` : null,
          ]
            .filter(Boolean)
            .join(", ")}
          accessibilityRole="button"
          accessibilityState={{ disabled: modelControlDisabled }}
          className="min-h-8 min-w-0 shrink flex-row items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1 active:opacity-60 dark:bg-foreground/10"
          disabled={modelControlDisabled}
          onPress={() => {
            input.holdComposerFocus();
            void input.dismissComposer();
            router.push("/model-sheet");
          }}
        >
          {isCodingAgent ? (
            <StyledSymbolView
              name="chevron.left.forwardslash.chevron.right"
              size={13}
              tintColorClassName="accent-muted-foreground"
              weight="semibold"
            />
          ) : (
            <ModelLogo modelId={modelId} size={15} />
          )}
          <Text
            className="shrink font-medium text-[15px] text-foreground"
            ellipsizeMode="tail"
            maxFontSizeMultiplier={PILL_MAX_FONT_SCALE}
            numberOfLines={1}
          >
            {modelLabel(modelId)}
            {effort ? (
              <Text className="font-normal text-muted-foreground"> {EFFORT_LABELS[effort]}</Text>
            ) : null}
          </Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable
          accessibilityHint={
            !isGenerating && goalBlocksSend
              ? "Finish the Goal settings in the model sheet to send."
              : undefined
          }
          accessibilityLabel={isGenerating ? (isStopping ? "Stopping" : "Stop") : "Send message"}
          accessibilityRole="button"
          accessibilityState={{ disabled: isGenerating ? isStopping : sendDisabled }}
          className={
            (isGenerating ? isStopping : sendDisabled)
              ? "size-9 shrink-0 items-center justify-center rounded-full bg-accent opacity-50"
              : "size-9 shrink-0 items-center justify-center rounded-full bg-accent active:opacity-70"
          }
          disabled={isGenerating ? isStopping : sendDisabled}
          onPress={() => {
            if (!isGenerating) {
              send();
              return;
            }
            void until(onStop).then(([error]) => {
              if (error)
                showErrorToast("The stop request could not be saved.", error, "chat.run.stop");
            });
          }}
        >
          <StyledAnimatedSymbol
            name={isGenerating ? "stop.fill" : "arrow.up"}
            size={15}
            tintColorClassName="accent-accent-foreground"
            weight="bold"
          />
        </Pressable>
      </View>
    </>
  );

  return (
    <View
      onLayout={(event) => {
        setLayoutReady(true);
        onLayout(event);
      }}
      pointerEvents="box-none"
      ref={containerRef}
      style={{
        paddingBottom: bottomInset,
        paddingHorizontal: COMPOSER_HORIZONTAL_MARGIN,
      }}
    >
      <View className="py-2">
        {reducedTransparency ? (
          <View className="overflow-hidden rounded-[26px] border border-border border-continuous bg-card">
            {content}
          </View>
        ) : (
          <StyledGlassView
            className="rounded-[26px] border-continuous"
            glassEffectStyle="regular"
            isInteractive
          >
            {content}
          </StyledGlassView>
        )}
      </View>
    </View>
  );
}
