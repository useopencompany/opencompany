import { KeyboardAwareLegendList, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import type { LegendListRef, LegendListRenderItemProps } from "@legendapp/list/react-native";
import { type RefObject, useRef, useState } from "react";
import { Alert, Linking, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable, useResolveClassNames, useUniwind } from "uniwind";

import { StyledKeyboardGestureArea } from "@/shared/ui/styled-keyboard-gesture-area";
import { StyledKeyboardStickyView } from "@/shared/ui/styled-keyboard-sticky-view";
import { StyledLinearGradient } from "@/shared/ui/styled-linear-gradient";
import {
  type ChatMessage as ChatMessageModel,
  createMessageIdentity,
  seedMessages,
} from "../model/chat";
import { useMarkdownStream } from "../model/use-markdown-stream";
import { ChatComposer } from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";
import { useChatMarkdownStyle } from "./use-chat-markdown-style";

const CHAT_TOP_CLEARANCE = 70;

function useChatComposerInset(listRef: RefObject<LegendListRef | null>, initialHeight: number) {
  const contentInsetEndAdjustment = useSharedValue(initialHeight);
  const lastHeightRef = useRef<number | null>(null);

  const reportHeight = (height: number) => {
    if (!Number.isFinite(height) || height === lastHeightRef.current) {
      return;
    }

    lastHeightRef.current = height;
    contentInsetEndAdjustment.value = height;
    listRef.current?.reportContentInset({ bottom: height });
  };

  return { contentInsetEndAdjustment, onComposerHeightChange: reportHeight };
}

function replaceAssistantMessage(
  messages: ChatMessageModel[],
  assistantId: string,
  update: Partial<Pick<ChatMessageModel, "content" | "status">>,
) {
  return messages.map((message) =>
    message.id === assistantId ? { ...message, ...update } : message,
  );
}

export function StreamingChat() {
  const insets = useSafeAreaInsets();
  const { theme } = useUniwind();
  const [gradientStart, gradientEnd] = useCSSVariable([
    "--color-background-transparent",
    "--color-background-deep",
  ]) as [string, string];
  const listStyle = useResolveClassNames("flex-1");
  const listContentStyle = useResolveClassNames("px-[18px] pb-5");
  const [messages, setMessages] = useState<ChatMessageModel[]>(seedMessages);
  const [isResponseActive, setIsResponseActive] = useState(false);
  const [anchorIndex, setAnchorIndex] = useState<number>();
  const [composerPillHeight, setComposerPillHeight] = useState(52);
  const listRef = useRef<LegendListRef>(null);
  const markdownStyle = useChatMarkdownStyle();
  const anchoredEndSpace =
    anchorIndex === undefined
      ? undefined
      : { anchorIndex, anchorOffset: insets.top + CHAT_TOP_CLEARANCE };
  const { contentInsetEndAdjustment, onComposerHeightChange } = useChatComposerInset(
    listRef,
    insets.bottom + 68,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const { start: startMarkdownStream } = useMarkdownStream();

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
          void Linking.openURL(url).catch(() => {
            Alert.alert("Unable to Open Link", "The link could not be opened on this device.");
          });
        },
      },
    ]);
  };

  const startResponse = (assistantId: string) => {
    const didStart = startMarkdownStream({
      onStreamingStart: () => {
        setMessages((currentMessages) =>
          replaceAssistantMessage(currentMessages, assistantId, { status: "streaming" }),
        );
      },
      onChunk: (content) => {
        setMessages((currentMessages) =>
          replaceAssistantMessage(currentMessages, assistantId, { content }),
        );
      },
      onComplete: () => {
        setMessages((currentMessages) =>
          replaceAssistantMessage(currentMessages, assistantId, { status: "complete" }),
        );
        setAnchorIndex(undefined);
        setIsResponseActive(false);
      },
    });

    if (!didStart) {
      setAnchorIndex(undefined);
      setIsResponseActive(false);
    }
  };

  const sendDraft = (draft: string) => {
    const trimmedInput = draft.trim();

    if (trimmedInput.length === 0 || isResponseActive) {
      return;
    }

    setIsResponseActive(true);

    const userMessageIndex = messages.length;
    const userIdentity = createMessageIdentity();
    const assistantIdentity = createMessageIdentity();

    setAnchorIndex(userMessageIndex);
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        ...userIdentity,
        role: "user",
        content: trimmedInput,
        status: "complete",
        isNew: true,
      },
      {
        ...assistantIdentity,
        role: "assistant",
        content: "",
        status: "thinking",
      },
    ]);
    requestAnimationFrame(() => {
      void scrollMessageToEnd({ animated: true, closeKeyboard: true }).then(() =>
        startResponse(assistantIdentity.id),
      );
    });
  };

  const renderItem = ({ item }: LegendListRenderItemProps<ChatMessageModel>) => (
    <ChatMessage
      message={item}
      markdownStyle={markdownStyle}
      onLinkPress={handleLinkPress}
      themeKey={theme}
    />
  );

  return (
    <View className="flex-1 bg-background">
      <StyledKeyboardGestureArea
        className="flex-1 bg-background"
        interpolator="ios"
        offset={composerPillHeight}
        textInputNativeID="chat-composer"
      >
        <KeyboardAwareLegendList
          alignItemsAtEnd
          anchoredEndSpace={anchoredEndSpace}
          applyWorkaroundForContentInsetHitTestBug
          contentContainerStyle={[
            listContentStyle,
            { paddingTop: insets.top + CHAT_TOP_CLEARANCE },
          ]}
          contentInsetAdjustmentBehavior="never"
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          data={messages}
          extraData={theme}
          freeze={freeze}
          initialScrollAtEnd
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
      </StyledKeyboardGestureArea>

      <StyledKeyboardStickyView
        className="absolute right-0 bottom-0 left-0"
        offset={{ closed: 0, opened: insets.bottom }}
      >
        <StyledLinearGradient
          className="absolute right-0 top-0 bottom-0 left-0"
          colors={[gradientStart, gradientEnd]}
          pointerEvents="none"
        />
        <ChatComposer
          bottomInset={insets.bottom}
          disabled={isResponseActive}
          onComposerHeightChange={onComposerHeightChange}
          onPillHeightChange={setComposerPillHeight}
          onSend={sendDraft}
        />
      </StyledKeyboardStickyView>
    </View>
  );
}
