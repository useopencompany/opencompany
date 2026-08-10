import { Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import Reanimated, { FadeIn } from "react-native-reanimated";
import { StreamdownText } from "react-native-streamdown";

import type { ChatMessage as ChatMessageModel } from "../model/chat";

export function ChatMessage({
  message,
  markdownStyle,
  onLinkPress,
  themeKey,
}: {
  message: ChatMessageModel;
  markdownStyle: MarkdownStyle;
  onLinkPress: (url: string) => void;
  themeKey: string;
}) {
  if (message.role === "user") {
    return (
      <Reanimated.View
        className="mb-[22px] max-w-[82%] self-end rounded-[20px] border-continuous bg-primary px-4 py-[11px]"
        entering={message.isNew ? FadeIn.duration(300) : undefined}
      >
        <Text selectable className="text-[16px] text-primary-foreground leading-[22px]">
          {message.content}
        </Text>
      </Reanimated.View>
    );
  }

  if (message.status === "thinking") {
    return (
      <View
        accessibilityLabel="Assistant is thinking"
        className="mb-[22px] min-w-full self-stretch"
      >
        <View className="min-h-[30px] flex-row items-center gap-2">
          <View className="h-2 w-2 rounded-full bg-muted-foreground" />
          <Text className="text-[15px] text-muted-foreground italic">Thinking…</Text>
        </View>
      </View>
    );
  }

  return (
    <View className="mb-[22px] min-w-full self-stretch">
      <StreamdownText
        flavor="github"
        key={themeKey}
        markdown={message.content}
        markdownStyle={markdownStyle}
        onLinkPress={(event) => onLinkPress(event.url)}
      />
    </View>
  );
}
