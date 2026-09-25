import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef, LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Text, useWindowDimensions, View } from "react-native";
import Reanimated, {
  FadeIn,
  FadeOut,
  Keyframe,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable, useResolveClassNames, useUniwind } from "uniwind";
import { throwIfAborted } from "@/shared/lib/abort";
import { analytics } from "@/shared/lib/analytics";
import { StyledKeyboardGestureArea } from "@/shared/ui/styled-keyboard-gesture-area";
import { StyledLinearGradient } from "@/shared/ui/styled-linear-gradient";
import type { ChatMessage as ChatMessageModel, ConnectivityState } from "../model/chat";
import { useChatComposer } from "../model/chat-composer-context";
import { chatQueryKeys, useChatCoordinator } from "../model/chat-coordinator";
import { useChatInputController } from "../model/chat-input-controller";
import {
  getConversationRunCheckpoint,
  getPendingMessageCommand,
  listStoredMessages,
  markConversationViewed,
  NEW_CHAT_ID,
  type StoredDraft,
} from "../model/chat-store";
import { ChatComposer, type SentMessageIdentity } from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";
import { useChatMarkdownStyle } from "./use-chat-markdown-style";

const CHAT_TOP_CLEARANCE = 70;
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
  const { theme } = useUniwind();
  const [gradientStart, gradientEnd] = useCSSVariable([
    "--color-background-transparent",
    "--color-background-deep",
  ]) as [string, string];
  const listStyle = useResolveClassNames("flex-1");
  const listContentStyle = useResolveClassNames("px-[18px] pb-5");
  const [composerHeight, setComposerHeight] = useState(insets.bottom + 68);
  const [anchorMessageId, setAnchorMessageId] = useState<string | undefined>(
    pendingAnchorMessageId,
  );
  const [following, setFollowing] = useState(true);
  const [listLayoutReady, setListLayoutReady] = useState(false);
  const openedAtEndRef = useRef<string | null>(null);
  const anchorOverflowedRef = useRef(false);
  const listRef = useRef<LegendListRef>(null);
  const composerContainerRef = useRef<View>(null);
  const markdownStyle = useChatMarkdownStyle();
  const coordinator = useChatCoordinator();
  const composer = useChatComposer();
  const input = useChatInputController();
  const { keyboardHeight, keyboardProgress, keyboardOwner } = input;
  const bottomInset = insets.bottom;
  const composerKeyboardStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          keyboardOwner === "composer"
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
  const runQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.run(coordinator.partition, chatId)
      : ["chat", "run", "signed-out"],
    queryFn: () => getConversationRunCheckpoint(coordinator.partition!, chatId),
    enabled: Boolean(coordinator.partition),
  });
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
  const pendingUserMessage =
    pendingSend?.message ??
    userMessages.findLast((message) => message.role === "user" && message.delivery !== "accepted");
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
  const run = runQuery.data;
  const isGenerating = Boolean(
    pendingUserMessage || (run && ["queued", "running", "paused"].includes(run.status)),
  );
  const isStopping = Boolean(
    coordinator.stoppingConversations.has(chatId) ||
      pendingMessageQuery.data?.isStopping ||
      run?.isStopping,
  );
  const anchorIndex = anchorMessageId
    ? messages.findIndex((message) => message.id === anchorMessageId)
    : -1;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerContainerRef,
    insets.bottom + 68,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });

  useLayoutEffect(() => {
    if (!pendingSend) return;
    anchorOverflowedRef.current = false;
    setFollowing(false);
    setAnchorMessageId(pendingSend.message.id);
  }, [pendingSend?.message.id]);

  useLayoutEffect(() => {
    if (anchorIndex < 0 || !anchorMessageId || !listLayoutReady) return;
    void scrollMessageToEnd({ animated: storedMessages.length > 0, closeKeyboard: false });
  }, [anchorMessageId, anchorIndex, listLayoutReady]);

  useLayoutEffect(() => {
    if (!isFocused) return;
    composer.activateConversation(chatId);
    coordinator.setVisibleConversation(chatId);
    if (coordinator.partition) void markConversationViewed(coordinator.partition, chatId);
    return () => coordinator.setVisibleConversation(null);
  }, [chatId, isFocused]);

  useEffect(() => {
    openedAtEndRef.current = null;
    setListLayoutReady(false);
    setFollowing(true);
    if (pendingAnchorMessageId) setAnchorMessageId(pendingAnchorMessageId);
  }, [chatId]);

  useLayoutEffect(() => {
    if (
      !listLayoutReady ||
      messagesQuery.isLoading ||
      openedAtEndRef.current === chatId ||
      pendingAnchorMessageId
    ) {
      return;
    }
    openedAtEndRef.current = chatId;
    void listRef.current?.scrollToEnd({ animated: false });
  }, [chatId, listLayoutReady, messagesQuery.isLoading, pendingAnchorMessageId]);

  useEffect(() => {
    if (!pendingAnchorMessageId || anchorIndex < 0 || !listLayoutReady) return;
    openedAtEndRef.current = chatId;
    router.setParams({ anchorMessageId: undefined });
  }, [anchorIndex, chatId, listLayoutReady, pendingAnchorMessageId]);

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
        (run?.assistantMessageId !== item.id ||
          !["queued", "running", "paused"].includes(run.status))
      }
      isSending={
        item.id === sendingMessage?.id ||
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

  const handleSend = (draft: StoredDraft): Promise<SentMessageIdentity> => {
    const sent = coordinator.sendDraft(draft);
    void input.dismissComposer();
    return sent;
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
            alignItemsAtEnd
            anchoredEndSpace={
              anchorIndex >= 0
                ? {
                    anchorIndex,
                    anchorMaxSize: ANCHOR_MAX_SIZE,
                    anchorOffset: insets.top + CHAT_TOP_CLEARANCE,
                    onSizeChanged: (size) => {
                      if (size <= 0 && !anchorOverflowedRef.current) {
                        anchorOverflowedRef.current = true;
                        setFollowing(true);
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
            extraData={[theme, run, coordinator.connectivity, sendingMessage?.id]}
            freeze={freeze}
            initialScrollAtEnd
            keyboardDismissMode="interactive"
            keyboardLiftBehavior="whenAtEnd"
            keyboardOffset={insets.bottom}
            keyExtractor={(message) => message.id}
            maintainScrollAtEnd={
              following ? { on: { dataChange: true, itemLayout: true } } : undefined
            }
            maintainScrollAtEndThreshold={1}
            maintainVisibleContentPosition
            onLayout={() => setListLayoutReady(true)}
            onScrollBeginDrag={() => setFollowing(false)}
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
        {statusMessage ? (
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
          isGenerating={isGenerating}
          isStopping={isStopping}
          onLayout={(event) => {
            setComposerHeight(event.nativeEvent.layout.height);
            onComposerLayout(event);
          }}
          onSend={handleSend}
          onStop={() => coordinator.stopRun(chatId)}
        />
      </Reanimated.View>
    </View>
  );
}
