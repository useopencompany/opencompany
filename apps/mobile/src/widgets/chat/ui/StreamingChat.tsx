import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef, LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router/react-navigation";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable, useResolveClassNames, useUniwind } from "uniwind";
import { useAuth } from "@/features/auth";
import { StyledKeyboardGestureArea } from "@/shared/ui/styled-keyboard-gesture-area";
import { StyledKeyboardStickyView } from "@/shared/ui/styled-keyboard-sticky-view";
import { StyledLinearGradient } from "@/shared/ui/styled-linear-gradient";
import type { ChatMessage as ChatMessageModel, ConnectivityState } from "../model/chat";
import { useChatComposer } from "../model/chat-composer-context";
import { chatQueryKeys, useChatCoordinator } from "../model/chat-coordinator";
import {
  getConversationRunCheckpoint,
  hasPendingMessageCommand,
  listStoredMessages,
  markConversationViewed,
  NEW_CHAT_ID,
  type RunCheckpoint,
} from "../model/chat-store";
import { ChatComposer } from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";
import { useChatMarkdownStyle } from "./use-chat-markdown-style";

const CHAT_TOP_CLEARANCE = 70;

function getStatusMessage(
  run: RunCheckpoint | null | undefined,
  connectivity: ConnectivityState,
): string | null {
  if (run?.isStopping) {
    return connectivity === "offline" ? "Will stop when connected" : "Stopping...";
  }
  if (connectivity === "waiting") return "Waiting for connection";
  if (connectivity === "reconnecting") return "Reconnecting...";
  return null;
}

function useChatComposerInset(listRef: RefObject<LegendListRef | null>, initialHeight: number) {
  const contentInsetEndAdjustment = useSharedValue(initialHeight);
  const lastHeightRef = useRef<number | null>(null);
  const reportHeight = (height: number) => {
    if (!Number.isFinite(height) || height === lastHeightRef.current) return;
    lastHeightRef.current = height;
    contentInsetEndAdjustment.value = height;
    listRef.current?.reportContentInset({ bottom: height });
  };
  return { contentInsetEndAdjustment, onComposerHeightChange: reportHeight };
}

export function StreamingChat({ chatId }: { chatId: string }) {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { user } = useAuth();
  const { theme } = useUniwind();
  const [gradientStart, gradientEnd] = useCSSVariable([
    "--color-background-transparent",
    "--color-background-deep",
  ]) as [string, string];
  const listStyle = useResolveClassNames("flex-1");
  const listContentStyle = useResolveClassNames("px-[18px] pb-5");
  const [composerPillHeight, setComposerPillHeight] = useState(52);
  const listRef = useRef<LegendListRef>(null);
  const markdownStyle = useChatMarkdownStyle();
  const coordinator = useChatCoordinator();
  const composer = useChatComposer();
  const messagesQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.messages(coordinator.partition, chatId)
      : ["chat", "messages", "signed-out"],
    queryFn: () => listStoredMessages(coordinator.partition!, chatId),
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
      ? [...chatQueryKeys.messages(coordinator.partition, chatId), "pending"]
      : ["chat", "pending-message", "signed-out"],
    queryFn: () => hasPendingMessageCommand(coordinator.partition!, chatId),
    enabled: Boolean(coordinator.partition),
  });
  const run = runQuery.data;
  const isGenerating = Boolean(run && ["queued", "running", "paused"].includes(run.status));
  const isHydratingUncachedConversation =
    chatId !== NEW_CHAT_ID &&
    messagesQuery.data?.length === 0 &&
    coordinator.connectivity === "reconnecting";
  const listKey = messagesQuery.data?.length ? `${chatId}:loaded` : `${chatId}:empty`;
  const { contentInsetEndAdjustment, onComposerHeightChange } = useChatComposerInset(
    listRef,
    insets.bottom + 68,
  );

  useLayoutEffect(() => {
    if (!isFocused) return;
    composer.activateConversation(chatId);
    coordinator.setVisibleConversation(chatId);
    if (coordinator.partition) void markConversationViewed(coordinator.partition, chatId);
    return () => coordinator.setVisibleConversation(null);
  }, [chatId, isFocused]);

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
      { text: "Open", onPress: () => void Linking.openURL(url) },
    ]);
  };

  const renderItem = ({ item }: LegendListRenderItemProps<ChatMessageModel>) => (
    <ChatMessage
      message={item}
      markdownStyle={markdownStyle}
      onApproval={(approvalId, body) =>
        run ? coordinator.resolveApproval(chatId, run.runId, approvalId, body) : Promise.resolve()
      }
      onLinkPress={handleLinkPress}
      themeKey={theme}
    />
  );

  const statusMessage = getStatusMessage(run, coordinator.connectivity);

  return (
    <View className="flex-1 bg-background">
      <StyledKeyboardGestureArea
        className="flex-1 bg-background"
        interpolator="ios"
        offset={composerPillHeight}
        textInputNativeID="chat-composer"
      >
        {(messagesQuery.isLoading && !messagesQuery.data) || isHydratingUncachedConversation ? (
          <View className="flex-1" />
        ) : (
          <KeyboardAwareLegendList
            alignItemsAtEnd
            applyWorkaroundForContentInsetHitTestBug
            contentContainerStyle={[
              listContentStyle,
              { paddingTop: insets.top + CHAT_TOP_CLEARANCE },
            ]}
            contentInsetAdjustmentBehavior="never"
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            data={messagesQuery.data ?? []}
            extraData={[theme, run, coordinator.connectivity]}
            initialScrollAtEnd
            key={listKey}
            keyboardDismissMode="interactive"
            keyboardLiftBehavior="whenAtEnd"
            keyboardOffset={insets.bottom}
            keyExtractor={(message) => message.id}
            maintainVisibleContentPosition
            recycleItems={false}
            ref={listRef}
            renderItem={renderItem}
            scrollIndicatorInsets={{ bottom: -insets.bottom }}
            style={listStyle}
          />
        )}
      </StyledKeyboardGestureArea>

      {statusMessage ? (
        <View
          className="absolute inset-x-0 items-center"
          style={{ bottom: composerPillHeight + insets.bottom + 22 }}
        >
          <Text className="rounded-full bg-secondary px-3 py-1.5 text-[13px] text-muted-foreground">
            {statusMessage}
          </Text>
        </View>
      ) : null}

      <StyledKeyboardStickyView
        className="absolute right-0 bottom-0 left-0"
        offset={{ closed: 0, opened: insets.bottom }}
      >
        <StyledLinearGradient
          className="absolute right-0 top-0 bottom-0 left-0"
          colors={[gradientStart, gradientEnd]}
          start={{ x: 0.5, y: 0.5 }}
          pointerEvents="none"
        />
        <ChatComposer
          autoFocus={chatId === NEW_CHAT_ID && isFocused && Boolean(user)}
          bottomInset={insets.bottom}
          conversationId={chatId}
          disabled={!coordinator.partition || Boolean(pendingMessageQuery.data)}
          isGenerating={isGenerating}
          isStopping={run?.isStopping ?? false}
          onComposerHeightChange={onComposerHeightChange}
          onPillHeightChange={setComposerPillHeight}
          onSend={() => coordinator.sendDraft(chatId).then(() => undefined)}
          onStop={() => (run ? coordinator.stopRun(chatId, run.runId) : Promise.resolve())}
        />
      </StyledKeyboardStickyView>
    </View>
  );
}
