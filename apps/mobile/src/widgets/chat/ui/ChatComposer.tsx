import { descriptionFromAdHocTaskPrompt } from "@opencompany/core/ad-hoc-task";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, Pressable, Text, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
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
import {
  type ComposerTokenSegment,
  serializeSegments,
} from "../model/quick-actions/composer-segments";
import {
  backgroundTaskSource,
  useStartBackgroundTask,
} from "../model/quick-actions/use-start-background-task";
import {
  NativeComposerInput,
  type NativeComposerInputRef,
  type QuickActionTrigger,
  type QuickActionTriggerCharacter,
} from "../native/native-composer-input";
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

export interface AttachmentAnchor {
  /** The plus button. The attachment menu grows out of it and folds back into it. */
  button: WindowFrame;
  /** Where the preview of the next attachment will sit once it lands in the composer. */
  nextAttachment: WindowFrame;
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
// The attachment row's inset inside the composer and its previews, matching ComposerAttachments.
const ATTACHMENTS_INSET = 10;
const ATTACHMENT_PREVIEW_SIZE = 112;
const ATTACHMENT_PREVIEW_GAP = 8;
// The navigation bar and the space the transcript keeps below it.
export const TOP_CLEARANCE = 64;
// The composer's vertical padding above the glass, shared with the quick action menu's anchor.
export const COMPOSER_OUTER_PADDING_TOP = 8;
const ALL_TRIGGERS: QuickActionTriggerCharacter[] = ["@", "/", "#"];
// A Task cannot start a Task, and its replies go through the comment endpoint, which takes no
// skill mentions. Web gates both the same way.
const TASK_TRIGGERS: QuickActionTriggerCharacter[] = ["@"];

/** What the quick action menu asks of the composer's input. */
export interface ComposerQuickActions {
  insertToken: (token: ComposerTokenSegment) => void;
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
  onAttachmentPress,
  onLayout,
  onSend,
  onStop,
  onQuickActionTriggerChange,
  onSubmitHighlighted,
  quickActionsRef,
  submitsHighlighted,
}: {
  autoFocus: boolean;
  bottomInset: number;
  conversationId: string;
  containerRef: Ref<View>;
  disabled: boolean;
  isScreenFocused: boolean;
  isGenerating: boolean;
  isStopping: boolean;
  onAttachmentPress: (anchor: AttachmentAnchor) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onSend: (draft: OutgoingDraft) => Promise<SentMessageIdentity>;
  onStop: () => Promise<void>;
  onQuickActionTriggerChange: (trigger: QuickActionTrigger | null) => void;
  /** Return was pressed while the menu shows a highlighted row. */
  onSubmitHighlighted: () => void;
  quickActionsRef: Ref<ComposerQuickActions>;
  submitsHighlighted: boolean;
}) {
  const { showToast, showErrorToast } = useToast();
  const composer = useChatComposer();
  const input = useChatInputController();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const reducedTransparency = useReducedTransparency();
  const inputRef = useRef<NativeComposerInputRef>(null);
  const plusRef = useRef<View>(null);
  const glassRef = useRef<View>(null);
  const [textColor, placeholderColor, accentColor] = useCSSVariable([
    "--color-foreground",
    "--color-muted-foreground",
    "--color-accent",
  ]) as [string, string, string];
  // The native input takes commands only once Fabric has mounted it, which its first layout
  // confirms. A command sent from the commit that creates it never arrives.
  const [inputReady, setInputReady] = useState(false);
  const didHandleInitialFocusRef = useRef(false);
  const isActiveConversation = composer.conversationId === conversationId;
  const attachments = isActiveConversation ? composer.attachments : [];
  const value = isActiveConversation ? composer.value : "";
  // The input owns its content while the user types: echoing keystrokes back through React drops
  // characters under fast input, and a render can briefly carry an older value. So content only
  // flows into the native view while it is blurred, which is when conversations switch and failed
  // sends restore. The input mounts once the draft has loaded, so new-chat focus lands on the
  // input that stays. Sending clears the input directly.
  const inputMounted = composer.isReady;
  const typedTextRef = useRef(value);
  const inputWasReadyRef = useRef(false);
  const inputFocusedRef = useRef(false);
  const [inputFocused, setInputFocused] = useState(false);
  const inputCommand = (command: (input: NativeComposerInputRef) => Promise<void>) => {
    const current = inputRef.current;
    if (!current) return;
    void until(() => command(current)).then(([error]) => {
      if (error) showErrorToast("The message field did not respond.", error, "chat.composer.input");
    });
  };
  if (!inputMounted && inputReady) setInputReady(false);
  useLayoutEffect(() => {
    if (!inputReady) {
      typedTextRef.current = value;
      inputWasReadyRef.current = false;
      return;
    }
    const justReady = !inputWasReadyRef.current;
    inputWasReadyRef.current = true;
    if (!justReady && (inputFocused || value === typedTextRef.current)) return;
    typedTextRef.current = value;
    const segments = isActiveConversation ? composer.segments : [];
    inputCommand((input) => input.setContent(segments));
  }, [value, inputFocused, inputReady]);
  useImperativeHandle(quickActionsRef, () => ({
    insertToken: (token) => inputCommand((input) => input.insertToken(token)),
  }));
  const { selection, locks } = composer;

  const focusInput = () => {
    input.setKeyboardOwner("composer");
    inputCommand((input) => input.focus());
  };
  useLayoutEffect(() => {
    if (!isScreenFocused || !isActiveConversation) return;
    const handle: ComposerInputHandle = {
      blur: () => inputCommand((input) => input.blur()),
      focus: focusInput,
      isFocused: () => inputFocusedRef.current,
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

  const startTaskMutation = useStartBackgroundTask();

  useLayoutEffect(() => {
    if (
      !isScreenFocused ||
      !isActiveConversation ||
      !composer.isReady ||
      !inputReady ||
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
    inputReady,
    input.drawerOpen,
    input.focusRequestId,
    isActiveConversation,
    isScreenFocused,
  ]);

  useEffect(() => {
    if ((!isActiveConversation || !isScreenFocused) && inputFocusedRef.current)
      inputCommand((input) => input.blur());
  }, [isActiveConversation, isScreenFocused]);

  const goalBlocksSend = !locks.isTask && isGoalBlockingSend(selection);
  const hasContent = Boolean(value.trim()) || attachments.length > 0;
  const sendDisabled =
    disabled ||
    !isActiveConversation ||
    sendMutation.isPending ||
    startTaskMutation.isPending ||
    !hasContent ||
    goalBlocksSend ||
    composer.hasPendingAttachments;

  const send = () => {
    if (sendDisabled) return;
    const draft = {
      conversationId,
      text: value,
      mentions: composer.mentions,
      selection,
      attachments,
    };
    const taskSource = backgroundTaskSource(draft);
    if (taskSource) {
      startTask(draft, taskSource.kind);
      return;
    }
    // Clear in the tap itself. The request carries its own copy of the text and selection.
    typedTextRef.current = "";
    inputCommand((input) => input.clear());
    composer.setContent([]);
    sendMutation.mutate(draft);
  };

  // `#task` and `#workflow` start a background Task instead of sending a message, as on web.
  const startTask = (draft: OutgoingDraft, kind: "task" | "workflow") => {
    if (kind === "task" && !descriptionFromAdHocTaskPrompt(draft.text)) {
      showToast("Describe the Task you want to start.");
      return;
    }
    if (kind === "task" && draft.attachments.length > 0) {
      showToast("Attachments are not supported when starting a background task yet.");
      return;
    }
    const segments = composer.segments;
    // Like a sent message, a started Task closes the keyboard: its chat opens next.
    void input.dismissComposer();
    typedTextRef.current = "";
    inputCommand((input) => input.clear());
    composer.setContent([]);
    startTaskMutation.mutate(draft, {
      onError: () => {
        // Bring the draft back unless the user has started a new one meanwhile.
        if (typedTextRef.current) return;
        typedTextRef.current = draft.text;
        inputCommand((input) => input.setContent(segments));
        composer.setContent(segments);
      },
    });
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
        <NativeComposerInput
          editable={isActiveConversation && !disabled}
          inputAccessibilityLabel="Message"
          maxHeight={maxInputHeight}
          // keyboard-controller finds the composer by this ID to extend the interactive
          // dismissal area up to the composer's top edge.
          nativeID="chat-composer"
          onBlur={() => {
            inputFocusedRef.current = false;
            setInputFocused(false);
          }}
          onLayout={() => setInputReady(true)}
          onChangeContent={(segments) => {
            typedTextRef.current = serializeSegments(segments).text;
            if (isActiveConversation) composer.setContent(segments);
          }}
          onFocus={() => {
            inputFocusedRef.current = true;
            setInputFocused(true);
            input.setKeyboardOwner("composer");
          }}
          onSubmitHighlighted={onSubmitHighlighted}
          onTriggerChange={onQuickActionTriggerChange}
          placeholder="Ask opencompany"
          placeholderColor={placeholderColor}
          ref={inputRef}
          selectionColor={accentColor}
          style={{ minHeight: lineHeight + INPUT_VERTICAL_PADDING }}
          submitsHighlighted={submitsHighlighted}
          textColor={textColor}
          tokenColor={accentColor}
          triggers={locks.isTask ? TASK_TRIGGERS : ALL_TRIGGERS}
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
              glassRef.current?.measureInWindow((glassX, glassY, glassWidth) => {
                analytics.capture("attachment_picker_opened");
                // The row scrolls to its newest preview, so a full row lands it at the right end.
                // Without attachments the row opens above the input and the composer grows up.
                const rowWidth = glassWidth - ATTACHMENTS_INSET * 2;
                const offset = Math.min(
                  attachments.length * (ATTACHMENT_PREVIEW_SIZE + ATTACHMENT_PREVIEW_GAP),
                  rowWidth - ATTACHMENT_PREVIEW_SIZE,
                );
                const top =
                  attachments.length > 0 ? glassY : glassY - ATTACHMENTS_HEIGHT - ATTACHMENTS_INSET;
                onAttachmentPress({
                  button: { x, y, width, height },
                  nextAttachment: {
                    x: glassX + ATTACHMENTS_INSET + offset,
                    y: top + ATTACHMENTS_INSET,
                    width: ATTACHMENT_PREVIEW_SIZE,
                    height: ATTACHMENT_PREVIEW_SIZE,
                  },
                });
              });
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
        onLayout(event);
      }}
      pointerEvents="box-none"
      ref={containerRef}
      style={{
        paddingBottom: bottomInset,
        paddingHorizontal: COMPOSER_HORIZONTAL_MARGIN,
      }}
    >
      <View style={{ paddingVertical: COMPOSER_OUTER_PADDING_TOP }}>
        <View ref={glassRef}>
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
    </View>
  );
}
