import { Stack, useLocalSearchParams } from "expo-router";
import { useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { StreamdownText } from "react-native-streamdown";
import { useUniwind } from "uniwind";
import { useChatPart } from "../../model/use-chat-part";
import { useChatMarkdownStyle } from "../use-chat-markdown-style";
import { SheetLoading, SheetUnavailable } from "./sheet-states";

// How close to the end counts as reading the newest text.
const FOLLOW_THRESHOLD = 24;

export default function ReasoningSheet() {
  const params = useLocalSearchParams<{
    conversationId: string;
    messageId: string;
    partId: string;
  }>();
  const { part, isLoading, isOffline, reload, isReloading } = useChatPart("reasoning", params);
  const markdownStyle = useChatMarkdownStyle();
  const { theme } = useUniwind();
  const scrollRef = useRef<ScrollView>(null);
  const atEndRef = useRef(true);

  if (!part) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen options={{ title: "Reasoning" }} />
        {isLoading ? (
          <SheetLoading />
        ) : (
          <SheetUnavailable
            isOffline={isOffline}
            isReloading={isReloading}
            message="This reasoning is not on this device."
            onReload={reload}
            title="Reasoning unavailable"
          />
        )}
      </View>
    );
  }

  // The scroll view must be the screen's root view: a form sheet only tracks a scroll view it
  // finds there, and one wrapped in another view stops painting when the sheet changes detent.
  return (
    <>
      <Stack.Screen options={{ title: "Reasoning" }} />
      <ScrollView
        contentContainerClassName="gap-3 px-5 pt-2 pb-10"
        contentInsetAdjustmentBehavior="automatic"
        onContentSizeChange={() => {
          if (part.streaming && atEndRef.current)
            scrollRef.current?.scrollToEnd({ animated: false });
        }}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          atEndRef.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_THRESHOLD;
        }}
        ref={scrollRef}
        scrollEventThrottle={32}
      >
        {part.streaming ? (
          <Text className="text-[13px] font-medium text-muted-foreground">Thinking…</Text>
        ) : null}
        <StreamdownText
          flavor="github"
          key={theme}
          markdown={part.text}
          markdownStyle={markdownStyle}
        />
      </ScrollView>
    </>
  );
}
