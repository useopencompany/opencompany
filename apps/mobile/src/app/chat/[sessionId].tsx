import { useChat } from "@ai-sdk/react";
import { LegendList } from "@legendapp/list/react-native";
import { DefaultChatTransport } from "ai";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "@/components/chat/Composer";
import { MessageItem } from "@/components/chat/MessageItem";
import { createAuthedFetch, fetchChat } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { GoatMobileUiMessage } from "@/lib/chat-types";
import { GOAT_API_URL } from "@/lib/config";
import { colors } from "@/lib/theme";

export default function ChatScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ sessionId: string }>();
  const initialSessionId = params.sessionId === "new" ? null : (params.sessionId ?? null);

  const { status: authStatus, getAccessToken } = useAuth();
  const sessionIdRef = useRef<string | null>(initialSessionId);
  const [title, setTitle] = useState(initialSessionId ? "" : "New chat");
  const [modelLabel, setModelLabel] = useState("Goat");
  const [historyLoaded, setHistoryLoaded] = useState(initialSessionId === null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  // The transport posts only the newest message plus the session id; the
  // server owns history. Mirrors the web client's prepareSendMessagesRequest.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<GoatMobileUiMessage>({
        api: `${GOAT_API_URL}/api/chat`,
        fetch: createAuthedFetch(getAccessToken),
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            sessionId: sessionIdRef.current,
            message: messages.at(-1),
          },
        }),
      }),
    [getAccessToken],
  );

  const { messages, setMessages, sendMessage, status, stop, error } = useChat<GoatMobileUiMessage>({
    transport,
    // Batch stream chunks into ~20fps UI updates instead of re-rendering on
    // every token (same value the Goat web client uses).
    experimental_throttle: 50,
    onFinish: ({ message }) => {
      // First message of a new chat: the server creates the session and
      // returns its id in the assistant message metadata.
      const sessionId = message.metadata?.sessionId;
      if (sessionId) sessionIdRef.current = sessionId;
    },
  });

  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const chat = await fetchChat(initialSessionId, getAccessToken);
        if (cancelled) return;
        setTitle(chat.title);
        setModelLabel(shortModelLabel(chat.model));
        setMessages(chat.messages);
      } catch (loadError) {
        if (!cancelled) {
          setHistoryError(
            loadError instanceof Error ? loadError.message : "Could not load this chat.",
          );
        }
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialSessionId, getAccessToken, setMessages]);

  const isGenerating = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const showThinking =
    status === "submitted" ||
    (status === "streaming" &&
      lastMessage?.role === "assistant" &&
      lastMessage.parts.every((part) => part.type !== "text" || !part.text));

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isGenerating) return;
    setInput("");
    void sendMessage({ text });
  }, [input, isGenerating, sendMessage]);

  // Fade the home-bar inset out as the keyboard slides in, so the composer
  // tracks the keyboard's animation frame-for-frame with no jump.
  const { progress } = useReanimatedKeyboardAnimation();
  const composerAnimatedStyle = useAnimatedStyle(
    () => ({
      paddingBottom: 8 + insets.bottom * (1 - progress.value),
    }),
    [insets.bottom],
  );

  if (authStatus === "signedOut") {
    return <Redirect href="/sign-in" />;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          hitSlop={12}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: 0.6 }]}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        >
          <SymbolView name="chevron.left" size={18} tintColor={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.headerButton} />
      </View>

      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        {!historyLoaded ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : messages.length === 0 && !historyError ? (
          <View style={styles.centered}>
            <Text style={styles.emptyTitle}>Ask anything</Text>
            <Text style={styles.emptySubtitle}>Goat knows your company brain.</Text>
          </View>
        ) : (
          <LegendList
            data={messages}
            keyExtractor={(message: GoatMobileUiMessage) => message.id}
            renderItem={({ item }) => <MessageItem message={item} />}
            style={styles.flex}
            contentContainerStyle={styles.listContent}
            alignItemsAtEnd
            maintainScrollAtEnd
            maintainScrollAtEndThreshold={0.2}
            maintainVisibleContentPosition
            initialScrollAtEnd
            estimatedItemSize={80}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={showThinking ? <ThinkingRow /> : null}
          />
        )}

        {historyError ? <Text style={styles.errorBanner}>{historyError}</Text> : null}
        {error ? <Text style={styles.errorBanner}>{error.message}</Text> : null}

        <Animated.View style={[styles.composerWrap, composerAnimatedStyle]}>
          <Composer
            value={input}
            onChangeText={setInput}
            onSend={handleSend}
            onStop={stop}
            isGenerating={isGenerating}
            modelLabel={modelLabel}
            autoFocus={initialSessionId === null}
          />
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ThinkingRow() {
  return (
    <View style={styles.thinkingRow}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
      <Text style={styles.thinkingLabel}>Thinking…</Text>
    </View>
  );
}

function shortModelLabel(model: string): string {
  const name = model.split("/").at(-1) ?? model;
  return name
    .replace(/-\d{8}$/, "")
    .split("-")
    .map((word) => (word.length > 0 ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  emptySubtitle: {
    fontSize: 15,
    color: colors.textSecondary,
  },
  errorBanner: {
    color: colors.destructive,
    fontSize: 13,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  composerWrap: {
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
  },
  thinkingLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
});
