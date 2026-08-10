import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import Animated, { FadeIn } from "react-native-reanimated";
import { StreamdownText } from "react-native-streamdown";

import type { ChatMessage as ChatMessageModel } from "../model/chat";

type ChatMessageProps = {
  isDark: boolean;
  message: ChatMessageModel;
  markdownStyle: MarkdownStyle;
  onLinkPress: (url: string) => void;
};

function ChatMessageComponent({ isDark, message, markdownStyle, onLinkPress }: ChatMessageProps) {
  if (message.role === "user") {
    return (
      <Animated.View
        entering={message.isNew ? FadeIn.duration(300) : undefined}
        style={styles.userMessage}
      >
        <Text selectable style={styles.userMessageText}>
          {message.content}
        </Text>
      </Animated.View>
    );
  }

  if (message.status === "thinking") {
    return (
      <View accessibilityLabel="Assistant is thinking" style={styles.assistantMessage}>
        <View style={styles.thinkingRow}>
          <View style={styles.thinkingDot} />
          <Text style={styles.thinkingText}>Thinking…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantMessage}>
      <StreamdownText
        flavor="github"
        key={isDark ? "dark" : "light"}
        markdown={message.content}
        markdownStyle={markdownStyle}
        onLinkPress={(event) => onLinkPress(event.url)}
      />
    </View>
  );
}

export const ChatMessage = memo(ChatMessageComponent);

const styles = StyleSheet.create({
  assistantMessage: {
    alignSelf: "stretch",
    marginBottom: 22,
    minWidth: "100%",
  },
  thinkingDot: {
    backgroundColor: "#737373",
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  thinkingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 30,
  },
  thinkingText: {
    color: "#737373",
    fontSize: 15,
    fontStyle: "italic",
  },
  userMessage: {
    alignSelf: "flex-end",
    backgroundColor: "#007AFF",
    borderRadius: 20,
    marginBottom: 22,
    maxWidth: "82%",
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  userMessageText: {
    color: "#FFFFFF",
    fontSize: 16,
    lineHeight: 22,
  },
});
