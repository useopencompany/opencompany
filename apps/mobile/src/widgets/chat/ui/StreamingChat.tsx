import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef, LegendListRenderItemProps } from "@legendapp/list/react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, StyleSheet, useColorScheme, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { KeyboardGestureArea, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type ChatMessage as ChatMessageModel,
  createMessageIdentity,
  seedMessages,
} from "../model/chat";
import { useMarkdownStream } from "../model/use-markdown-stream";
import { ChatComposer } from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";

const CHAT_TOP_CLEARANCE = 70;
const LIGHT_COMPOSER_GRADIENT = ["rgba(250, 250, 249, 0)", "#FAFAF9"] as const;
const DARK_COMPOSER_GRADIENT = ["rgba(17, 17, 17, 0)", "#111111"] as const;

const LIGHT_MARKDOWN_STYLE: MarkdownStyle = {
  paragraph: { color: "#171717", fontSize: 16, lineHeight: 24, marginBottom: 12 },
  h1: { color: "#0A0A0A", fontSize: 28, lineHeight: 34, marginBottom: 12 },
  h2: { color: "#0A0A0A", fontSize: 23, lineHeight: 29, marginBottom: 10, marginTop: 8 },
  h3: { color: "#171717", fontSize: 19, lineHeight: 25, marginBottom: 8, marginTop: 6 },
  strong: { color: "#0A0A0A", fontWeight: "bold" },
  em: { color: "#262626", fontStyle: "italic" },
  link: { color: "#0066CC", underline: true },
  code: {
    backgroundColor: "#EDEDED",
    borderColor: "#D4D4D4",
    color: "#9F1239",
    fontFamily: "Menlo",
    fontSize: 14,
  },
  codeBlock: {
    backgroundColor: "#F5F5F5",
    borderColor: "#D4D4D4",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    color: "#171717",
    fontFamily: "Menlo",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
    padding: 12,
  },
  list: {
    bulletColor: "#404040",
    color: "#171717",
    fontSize: 16,
    gapWidth: 8,
    lineHeight: 24,
    marginBottom: 12,
    markerColor: "#404040",
  },
  blockquote: {
    backgroundColor: "#F5F5F5",
    borderColor: "#A3A3A3",
    borderWidth: 3,
    color: "#525252",
    fontSize: 16,
    gapWidth: 12,
    lineHeight: 24,
    marginBottom: 12,
  },
  image: { borderRadius: 12, height: 220, marginBottom: 14, marginTop: 4 },
  thematicBreak: { color: "#D4D4D4", height: 1, marginBottom: 18, marginTop: 10 },
};

const DARK_MARKDOWN_STYLE: MarkdownStyle = {
  paragraph: { color: "#F5F5F5", fontSize: 16, lineHeight: 24, marginBottom: 12 },
  h1: { color: "#FFFFFF", fontSize: 28, lineHeight: 34, marginBottom: 12 },
  h2: { color: "#FFFFFF", fontSize: 23, lineHeight: 29, marginBottom: 10, marginTop: 8 },
  h3: { color: "#FAFAFA", fontSize: 19, lineHeight: 25, marginBottom: 8, marginTop: 6 },
  strong: { color: "#FFFFFF", fontWeight: "bold" },
  em: { color: "#E5E5E5", fontStyle: "italic" },
  link: { color: "#66B3FF", underline: true },
  code: {
    backgroundColor: "#262626",
    borderColor: "#525252",
    color: "#FDA4AF",
    fontFamily: "Menlo",
    fontSize: 14,
  },
  codeBlock: {
    backgroundColor: "#1F1F1F",
    borderColor: "#525252",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    color: "#F5F5F5",
    fontFamily: "Menlo",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
    padding: 12,
  },
  list: {
    bulletColor: "#D4D4D4",
    color: "#F5F5F5",
    fontSize: 16,
    gapWidth: 8,
    lineHeight: 24,
    marginBottom: 12,
    markerColor: "#D4D4D4",
  },
  blockquote: {
    backgroundColor: "#1F1F1F",
    borderColor: "#737373",
    borderWidth: 3,
    color: "#D4D4D4",
    fontSize: 16,
    gapWidth: 12,
    lineHeight: 24,
    marginBottom: 12,
  },
  image: { borderRadius: 12, height: 220, marginBottom: 14, marginTop: 4 },
  thematicBreak: { color: "#525252", height: 1, marginBottom: 18, marginTop: 10 },
};

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
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const [messages, setMessages] = useState<ChatMessageModel[]>(seedMessages);
  const [input, setInput] = useState("");
  const [isResponseActive, setIsResponseActive] = useState(false);
  const [anchorIndex, setAnchorIndex] = useState<number>();
  const [composerPillHeight, setComposerPillHeight] = useState(52);
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<View>(null);
  const responseActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const animationFrameRef = useRef<number | null>(null);
  const markdownStyle = useMemo(
    () => (isDark ? DARK_MARKDOWN_STYLE : LIGHT_MARKDOWN_STYLE),
    [isDark],
  );
  const anchoredEndSpace = useMemo(
    () =>
      anchorIndex === undefined
        ? undefined
        : { anchorIndex, anchorOffset: insets.top + CHAT_TOP_CLEARANCE },
    [anchorIndex, insets.top],
  );
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerRef,
    insets.bottom + 68,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const { start: startMarkdownStream } = useMarkdownStream();

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      responseActiveRef.current = false;

      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const handleLinkPress = useCallback((url: string) => {
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
  }, []);

  const startResponse = useCallback(
    (assistantId: string) => {
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
          responseActiveRef.current = false;
        },
      });

      if (!didStart) {
        setAnchorIndex(undefined);
        setIsResponseActive(false);
        responseActiveRef.current = false;
      }
    },
    [startMarkdownStream],
  );

  const handleSend = useCallback(() => {
    const trimmedInput = input.trim();

    if (trimmedInput.length === 0 || responseActiveRef.current) {
      return;
    }

    responseActiveRef.current = true;
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
    setInput("");

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;

      void scrollMessageToEnd({ animated: true, closeKeyboard: true })
        .catch(() => {
          freeze.set(false);
          console.warn("Unable to coordinate the chat scroll before streaming.");
        })
        .then(() => {
          if (isMountedRef.current) {
            startResponse(assistantIdentity.id);
          }
        });
    });
  }, [freeze, input, messages.length, scrollMessageToEnd, startResponse]);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<ChatMessageModel>) => (
      <ChatMessage
        isDark={isDark}
        message={item}
        markdownStyle={markdownStyle}
        onLinkPress={handleLinkPress}
      />
    ),
    [handleLinkPress, isDark, markdownStyle],
  );

  return (
    <View style={[styles.container, isDark ? styles.containerDark : null]}>
      <KeyboardGestureArea
        interpolator="ios"
        offset={composerPillHeight}
        style={[styles.container, isDark ? styles.containerDark : null]}
        textInputNativeID="chat-composer"
      >
        <KeyboardAwareLegendList
          alignItemsAtEnd
          anchoredEndSpace={anchoredEndSpace}
          applyWorkaroundForContentInsetHitTestBug
          contentContainerStyle={{
            paddingHorizontal: 18,
            paddingTop: insets.top + CHAT_TOP_CLEARANCE,
          }}
          contentInsetAdjustmentBehavior="never"
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          data={messages}
          extraData={isDark}
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
          style={styles.list}
        />
      </KeyboardGestureArea>

      <KeyboardStickyView
        offset={{ closed: 0, opened: insets.bottom }}
        style={styles.composerWrapper}
      >
        <LinearGradient
          colors={isDark ? DARK_COMPOSER_GRADIENT : LIGHT_COMPOSER_GRADIENT}
          pointerEvents="none"
          style={styles.composerGradient}
        />
        <ChatComposer
          bottomInset={insets.bottom}
          disabled={isResponseActive}
          isDark={isDark}
          onChangeText={setInput}
          onComposerLayout={onComposerLayout}
          onPillHeightChange={setComposerPillHeight}
          onSend={handleSend}
          value={input}
          wrapperRef={composerRef}
        />
      </KeyboardStickyView>
    </View>
  );
}

const styles = StyleSheet.create({
  composerWrapper: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
  },
  composerGradient: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: -52,
  },
  container: {
    backgroundColor: "#FAFAF9",
    flex: 1,
  },
  containerDark: {
    backgroundColor: "#111111",
  },
  list: {
    flex: 1,
  },
});
