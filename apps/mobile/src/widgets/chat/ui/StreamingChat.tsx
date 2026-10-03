import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef, LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Text, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Reanimated, {
  FadeIn,
  FadeOut,
  Keyframe,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable, useResolveClassNames, useUniwind } from "uniwind";
import { until } from "until-async";
import { throwIfAborted } from "@/shared/lib/abort";
import { analytics } from "@/shared/lib/analytics";
import { StyledKeyboardGestureArea } from "@/shared/ui/styled-keyboard-gesture-area";
import { StyledLinearGradient } from "@/shared/ui/styled-linear-gradient";
import { useToast } from "@/shared/ui/toast";
import type { ChatMessage as ChatMessageModel, ConnectivityState } from "../model/chat";
import { useChatComposer } from "../model/chat-composer-context";
import { chatQueryKeys, useChatCoordinator } from "../model/chat-coordinator";
import { useChatInputController } from "../model/chat-input-controller";
import { runStateQueryOptions } from "../model/chat-queries";
import {
  getPendingMessageCommand,
  listStoredConversations,
  listStoredMessages,
  markConversationViewed,
  NEW_CHAT_ID,
  type OutgoingDraft,
} from "../model/chat-store";
import { useMarkConversationSeen } from "../model/conversation-actions";
import {
  type QuickActionItem,
  useQuickActionMenu,
} from "../model/quick-actions/quick-action-catalog";
import type { QuickActionTrigger } from "../native/native-composer-input";
import { AttachmentOverlay } from "./attachment-overlay";
import {
  type AttachmentAnchor,
  ChatComposer,
  COMPOSER_ESTIMATED_HEIGHT,
  COMPOSER_OUTER_PADDING_TOP,
  type ComposerQuickActions,
  type SentMessageIdentity,
  TOP_CLEARANCE,
} from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";
import { QuickActionMenu } from "./quick-action-menu";
import { useChatMarkdownStyle } from "./use-chat-markdown-style";

const CHAT_TOP_CLEARANCE = 70;
// The space between the quick action menu and the composer's glass.
const QUICK_ACTION_MENU_GAP = 8;
const ANCHOR_MAX_SIZE = 76;
const STATUS_ENTERING = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 4 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
})
  .duration(160)
  .reduceMotion(ReduceMotion.System);
const STATUS_EXITING = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: 4 }] },
})
  .duration(140)
  .reduceMotion(ReduceMotion.System);

function getStatusMessage(isStopping: boolean, connectivity: ConnectivityState): string | null {
  if (isStopping) {
    return connectivity === "offline" ? "Will stop when connected" : "Stopping...";
  }
  if (connectivity === "offline") return "Offline";
  if (connectivity === "reconnecting") return "Reconnecting...";
  return null;
}

export function StreamingChat({
  chatId,
  pendingAnchorMessageId,
}: {
  chatId: string;
  pendingAnchorMessageId?: string;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const isFocused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const { showErrorToast } = useToast();
  const { theme } = useUniwind();
  const [gradientStart, gradientEnd] = useCSSVariable([
    "--color-background-transparent",
    "--color-background-deep",
  ]) as [string, string];
  const listStyle = useResolveClassNames("flex-1");
  const listContentStyle = useResolveClassNames("px-[18px] pb-5");
  const [composerHeight, setComposerHeight] = useState(insets.bottom + COMPOSER_ESTIMATED_HEIGHT);
  const [attachmentAnchor, setAttachmentAnchor] = useState<AttachmentAnchor | null>(null);
  const [initialAnchorMessageId] = useState(pendingAnchorMessageId);
  const [hasSent, setHasSent] = useState(false);
  const [anchorMessageId, setAnchorMessageId] = useState<string | undefined>(
    pendingAnchorMessageId,
  );
  const [following, setFollowing] = useState(!pendingAnchorMessageId);
  const anchorOverflowedRef = useRef(false);
  const followResponseRef = useRef(true);
  const listRef = useRef<LegendListRef>(null);
  const composerContainerRef = useRef<View>(null);
  const quickActionsRef = useRef<ComposerQuickActions>(null);
  const [quickActionTrigger, setQuickActionTrigger] = useState<QuickActionTrigger | null>(null);
  const keyboardStateHeight = useKeyboardState((state) => state.height);
  const markdownStyle = useChatMarkdownStyle();
  const coordinator = useChatCoordinator();
  const composer = useChatComposer();
  const input = useChatInputController();
  const { foreignKeyboard, keyboardHeight, keyboardProgress, keyboardOwner } = input;
  const bottomInset = insets.bottom;
  const composerKeyboardStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          keyboardOwner === "composer" && !foreignKeyboard.get()
            ? Math.min(
                0,
                -keyboardHeight.get() +
                  bottomInset * Math.min(1, Math.max(0, keyboardProgress.get())),
              )
            : 0,
      },
    ],
  }));
  const messagesQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.messages(coordinator.partition, chatId)
      : ["chat", "messages", "signed-out"],
    queryFn: async ({ signal }) => {
      const messages = await listStoredMessages(coordinator.partition!, chatId);
      throwIfAborted(signal);
      return messages;
    },
    enabled: Boolean(coordinator.partition),
  });
  const runQuery = useQuery(runStateQueryOptions(coordinator.partition, chatId));
  const conversationQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.conversations(coordinator.partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(coordinator.partition!),
    enabled: Boolean(coordinator.partition) && chatId !== NEW_CHAT_ID,
    select: (items) => items.find((item) => item.id === chatId),
  });
  const conversation = conversationQuery.data;
  const isTask = conversation?.kind === "task";
  const markSeen = useMarkConversationSeen();
  const pendingMessageQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.pendingMessage(coordinator.partition, chatId)
      : ["chat", "pending-message", "signed-out"],
    queryFn: async ({ signal }) => {
      const pending = await getPendingMessageCommand(coordinator.partition!, chatId);
      throwIfAborted(signal);
      return pending;
    },
    enabled: Boolean(coordinator.partition),
  });
  const pendingSend = coordinator.pendingSends[chatId];
  const storedMessages = messagesQuery.data ?? [];
  const userMessages =
    pendingSend && !storedMessages.some((message) => message.id === pendingSend.message.id)
      ? [...storedMessages, pendingSend.message]
      : storedMessages;
  const pendingUserMessage = userMessages.findLast(
    (message) => message.role === "user" && message.delivery !== "accepted",
  );
  const sendingMessage: ChatMessageModel | undefined = pendingUserMessage
    ? {
        id: `sending:${pendingUserMessage.id}`,
        role: "assistant",
        content: "",
        parts: [],
        createdAt: pendingUserMessage.createdAt + 1,
        delivery: "sending",
      }
    : undefined;
  const messages = sendingMessage ? [...userMessages, sendingMessage] : userMessages;
  const run = runQuery.data?.active;
  const queuedRunMessageIds = new Set(runQuery.data?.queuedMessageIds);
  const isGenerating = Boolean(
    pendingUserMessage || (run && ["queued", "running", "paused"].includes(run.status)),
  );
  const isStopping = Boolean(
    coordinator.stoppingConversations.has(chatId) ||
      pendingMessageQuery.data?.isStopping ||
      run?.isStopping,
  );
  const activeAnchorMessageId = pendingSend?.message.id ?? anchorMessageId;
  const anchorIndex = activeAnchorMessageId
    ? messages.findIndex((message) => message.id === activeAnchorMessageId)
    : -1;
  const initialAnchorIndex = initialAnchorMessageId
    ? messages.findIndex((message) => message.id === initialAnchorMessageId)
    : -1;
  const anchorHasAttachments =
    anchorIndex >= 0 && messages[anchorIndex].parts.some((part) => part.type === "attachment");
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerContainerRef,
    insets.bottom + COMPOSER_ESTIMATED_HEIGHT,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  // Hold keyboard-driven list insets and scrolling while an unrelated keyboard comes and goes.
  const listFreeze = useDerivedValue(() => freeze.get() || foreignKeyboard.get());
  const hasDraft =
    composer.conversationId === chatId &&
    (Boolean(composer.value.trim()) || composer.attachments.length > 0);
  // A Task queues replies behind its working Run: a written reply shows Send, an empty one Stop.
  const composerIsGenerating = isGenerating && !(isTask && hasDraft);

  const quickActions = useQuickActionMenu({
    partition: coordinator.partition,
    trigger: quickActionTrigger,
    mentions: composer.conversationId === chatId ? composer.mentions : [],
  });
  // The menu gives way to anything that takes over the screen or the keyboard.
  const quickActionMenuOpen =
    Boolean(quickActionTrigger) &&
    isFocused &&
    !input.drawerOpen &&
    !attachmentAnchor &&
    (quickActions.items.length > 0 || Boolean(quickActions.error));
  const quickActionTriggerCharacter = quickActionTrigger?.trigger;
  useEffect(() => {
    if (quickActionMenuOpen && quickActionTriggerCharacter)
      analytics.capture("quick_action_menu_opened", { trigger: quickActionTriggerCharacter });
  }, [quickActionMenuOpen, quickActionTriggerCharacter]);
  const pickQuickAction = (item: QuickActionItem) => {
    void Haptics.selectionAsync();
    analytics.capture("quick_action_selected", {
      trigger: quickActionTriggerCharacter ?? null,
      kind: item.token.kind,
    });
    quickActionsRef.current?.insertToken(item.token);
  };
  // The menu floats above the composer's glass. It sits outside the measured composer, so the
  // transcript's inset never changes and opening it scrolls nothing.
  const composerKeyboardLift =
    input.keyboardOwner === "composer" ? Math.max(0, keyboardStateHeight - insets.bottom) : 0;
  const quickActionMenuBottom = composerHeight - COMPOSER_OUTER_PADDING_TOP + QUICK_ACTION_MENU_GAP;
  const quickActionMenuMaxHeight =
    windowHeight - insets.top - TOP_CLEARANCE - quickActionMenuBottom - composerKeyboardLift;

  useLayoutEffect(() => {
    if (!pendingSend) return;
    anchorOverflowedRef.current = false;
    setFollowing(false);
    setAnchorMessageId(pendingSend.message.id);
  }, [pendingSend?.message.id]);

  useLayoutEffect(() => {
    if (!isFocused) return;
    composer.activateConversation(chatId);
    coordinator.setVisibleConversation(chatId);
    if (coordinator.partition) void markConversationViewed(coordinator.partition, chatId);
    return () => coordinator.setVisibleConversation(null);
  }, [chatId, isFocused]);

  // Opening a conversation acknowledges its unread result. Sidebar previews never take focus, so
  // peeking at a row leaves it unread.
  useEffect(() => {
    if (isFocused && conversation?.hasUnseen) markSeen(conversation);
  }, [isFocused, conversation?.hasUnseen]);

  const handleLinkPress = (url: string) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      Alert.alert("Link Not Supported", "This link is not a valid web address.");
      return;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      Alert.alert("Link Not Supported", "Only HTTP and HTTPS links can be opened.");
      return;
    }
    Alert.alert("Open Link?", url, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Open",
        onPress: () => {
          analytics.capture("chat_link_opened", { protocol: parsedUrl.protocol });
          void Linking.openURL(url);
        },
      },
    ]);
  };

  const renderItem = ({ item }: LegendListRenderItemProps<ChatMessageModel>) => (
    <ChatMessage
      isTerminal={
        item.role === "assistant" &&
        item.id !== sendingMessage?.id &&
        !queuedRunMessageIds.has(item.id) &&
        (run?.assistantMessageId !== item.id ||
          !["queued", "running", "paused"].includes(run.status))
      }
      isSending={
        item.id === sendingMessage?.id ||
        queuedRunMessageIds.has(item.id) ||
        (run?.assistantMessageId === item.id && run.status === "queued")
      }
      message={item}
      markdownStyle={markdownStyle}
      onApproval={(approvalId, body) =>
        run ? coordinator.resolveApproval(chatId, run.runId, approvalId, body) : Promise.resolve()
      }
      onLinkPress={handleLinkPress}
      themeKey={theme}
    />
  );

  const handleSend = (draft: OutgoingDraft): Promise<SentMessageIdentity> => {
    const isFirstMessage = messages.length === 0;
    anchorOverflowedRef.current = false;
    followResponseRef.current = true;
    setFollowing(false);
    setHasSent(true);
    return coordinator.sendDraft(draft, async () => {
      // Match Margelo's send sequence: publish, then let the library coordinate
      // keyboard dismissal and one end scroll using its measured reply space.
      const [error] = await until(async () => {
        const scrolling = scrollMessageToEnd({
          animated: !isFirstMessage && !reducedMotion,
          closeKeyboard: true,
        });
        input.composerInputRef.current?.blur();
        await scrolling;
      });
      if (error) {
        freeze.set(false);
        showErrorToast("The message could not be brought into view.", error, "chat.send.scroll");
      }
    });
  };

  const statusMessage = getStatusMessage(isStopping, coordinator.connectivity);
  const statusEntering = reducedMotion ? FadeIn.duration(160) : STATUS_ENTERING;
  const statusExiting = reducedMotion ? FadeOut.duration(140) : STATUS_EXITING;

  return (
    <View className="flex-1 bg-background">
      <StyledKeyboardGestureArea
        className="flex-1 bg-background"
        interpolator="ios"
        offset={Math.max(52, composerHeight - insets.bottom - 16)}
        textInputNativeID="chat-composer"
      >
        {messagesQuery.isLoading && !messagesQuery.data && !pendingSend ? (
          <View className="flex-1" />
        ) : (
          <KeyboardAwareLegendList
            // Measure the sent message even when the user was reading older history.
            alwaysRender={
              pendingSend && anchorIndex >= 0
                ? { keys: messages.slice(anchorIndex).map((message) => message.id) }
                : undefined
            }
            anchoredEndSpace={
              anchorIndex >= 0
                ? {
                    anchorIndex,
                    anchorMaxSize: anchorHasAttachments ? undefined : ANCHOR_MAX_SIZE,
                    anchorOffset: insets.top + CHAT_TOP_CLEARANCE,
                    onSizeChanged: (size) => {
                      if (size <= 0 && !anchorOverflowedRef.current) {
                        anchorOverflowedRef.current = true;
                        if (followResponseRef.current) setFollowing(true);
                      }
                    },
                  }
                : undefined
            }
            applyWorkaroundForContentInsetHitTestBug
            contentContainerStyle={[
              listContentStyle,
              { paddingTop: insets.top + CHAT_TOP_CLEARANCE },
            ]}
            contentInsetAdjustmentBehavior="never"
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            data={messages}
            dataKey={chatId}
            estimatedItemSize={80}
            estimatedListSize={{ width: windowWidth, height: windowHeight }}
            extraData={[
              theme,
              run,
              runQuery.data?.queuedMessageIds,
              coordinator.connectivity,
              sendingMessage?.id,
            ]}
            freeze={listFreeze}
            initialScrollAtEnd={chatId !== NEW_CHAT_ID && !initialAnchorMessageId && !hasSent}
            initialScrollIndex={
              initialAnchorIndex >= 0
                ? { index: initialAnchorIndex, viewOffset: insets.top + CHAT_TOP_CLEARANCE }
                : undefined
            }
            keyboardDismissMode="interactive"
            keyboardLiftBehavior="whenAtEnd"
            keyboardOffset={insets.bottom}
            keyExtractor={(message) => message.id}
            maintainScrollAtEnd={
              following && !pendingSend ? { on: { dataChange: true, itemLayout: true } } : undefined
            }
            maintainScrollAtEndThreshold={1}
            onLoad={() => {
              if (!initialAnchorMessageId) return;
              router.setParams({ anchorMessageId: undefined });
            }}
            onEndVisible={(visible) => {
              if (visible && anchorOverflowedRef.current) {
                followResponseRef.current = true;
                setFollowing(true);
              }
            }}
            onScrollBeginDrag={() => {
              followResponseRef.current = false;
              setFollowing(false);
            }}
            recycleItems={false}
            ref={listRef}
            renderItem={renderItem}
            scrollIndicatorInsets={{ bottom: -insets.bottom }}
            style={listStyle}
          />
        )}
      </StyledKeyboardGestureArea>

      <Reanimated.View
        className="absolute right-0 bottom-0 left-0"
        pointerEvents="box-none"
        style={composerKeyboardStyle}
      >
        {statusMessage && !quickActionMenuOpen ? (
          <Reanimated.View
            className="absolute inset-x-0 items-center"
            entering={statusEntering}
            exiting={statusExiting}
            pointerEvents="none"
            style={{ bottom: composerHeight + 6 }}
          >
            <View className="flex-row items-center gap-2 rounded-full bg-secondary px-3 py-1.5">
              {coordinator.connectivity !== "offline" ? (
                <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
              ) : null}
              <Text className="text-[13px] text-muted-foreground">{statusMessage}</Text>
            </View>
          </Reanimated.View>
        ) : null}
        <StyledLinearGradient
          className="absolute inset-0"
          colors={[gradientStart, gradientEnd]}
          pointerEvents="none"
          start={{ x: 0.5, y: 0.5 }}
        />
        <ChatComposer
          autoFocus={chatId === NEW_CHAT_ID && isFocused && Boolean(coordinator.partition)}
          bottomInset={insets.bottom}
          containerRef={composerContainerRef}
          conversationId={chatId}
          disabled={!coordinator.partition}
          isScreenFocused={isFocused}
          isGenerating={composerIsGenerating}
          isStopping={isStopping}
          onAttachmentPress={setAttachmentAnchor}
          onLayout={(event) => {
            setComposerHeight(event.nativeEvent.layout.height);
            onComposerLayout(event);
          }}
          onQuickActionTriggerChange={setQuickActionTrigger}
          onSend={handleSend}
          onStop={() => coordinator.stopRun(chatId)}
          onSubmitHighlighted={() => {
            const first = quickActions.items[0];
            if (quickActionMenuOpen && first) pickQuickAction(first);
          }}
          quickActionsRef={quickActionsRef}
          submitsHighlighted={quickActionMenuOpen && quickActions.items.length > 0}
        />
        <QuickActionMenu
          bottom={quickActionMenuBottom}
          error={quickActions.error}
          header={quickActions.header}
          items={quickActions.items}
          maxHeight={quickActionMenuMaxHeight}
          onPick={pickQuickAction}
          onRetry={quickActions.retry}
          open={quickActionMenuOpen}
        />
      </Reanimated.View>
      <AttachmentOverlay
        anchor={attachmentAnchor}
        isScreenFocused={isFocused}
        onClosed={() => setAttachmentAnchor(null)}
      />
    </View>
  );
}
