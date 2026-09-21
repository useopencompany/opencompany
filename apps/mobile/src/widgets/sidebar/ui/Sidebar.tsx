import { Host } from "@expo/ui";
import { Button, HStack, Image, Label, Spacer } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  font,
  labelStyle,
  scaleEffect,
} from "@expo/ui/swift-ui/modifiers";
import { useQuery } from "@tanstack/react-query";
import { Link, router, useGlobalSearchParams } from "expo-router";
import { useDrawerProgress, useDrawerStatus } from "expo-router/drawer";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import Reanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StreamdownText } from "react-native-streamdown";
import { useUniwind } from "uniwind";
import { until } from "until-async";
import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "@/widgets/chat/model/chat-coordinator";
import { useChatInputController } from "@/widgets/chat/model/chat-input-controller";
import {
  listStoredConversations,
  listStoredMessages,
  type StoredConversation,
} from "@/widgets/chat/model/chat-store";
import { useChatMarkdownStyle } from "@/widgets/chat/ui/use-chat-markdown-style";
import {
  NativeSidebarHeader,
  SIDEBAR_HEADER_INITIAL_HEIGHT,
} from "../../../../modules/open-company-sidebar-header";

const SIDEBAR_SCROLL_VIEW_TEST_ID = "sidebar-scroll-view";
// The native bar items render between SwiftUI's regular and large control sizes.
// Scale the large visual treatment while preserving its full hit target.
const SIDEBAR_ACTION_CONTROL_SCALE = 0.875;
const SIDEBAR_ACTION_ICON_SCALE = 1.25;

function SidebarConversationRow({
  active,
  conversation,
  markdownStyle,
  partition,
  themeKey,
}: {
  active: boolean;
  conversation: StoredConversation;
  markdownStyle: MarkdownStyle;
  partition: NonNullable<ReturnType<typeof useChatCoordinator>["partition"]>;
  themeKey: string;
}) {
  const input = useChatInputController();
  const previewQuery = useQuery({
    queryKey: [...chatQueryKeys.messages(partition, conversation.id), "sidebar-preview"],
    queryFn: () => listStoredMessages(partition, conversation.id),
    staleTime: Infinity,
  });
  const assistant = previewQuery.data?.findLast((message) => message.role === "assistant");
  const previewMarkdown = assistant
    ? assistant.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
      assistant.content
    : "";
  const noOp = () => {};

  return (
    <Link asChild href={{ pathname: "/chats/[chatId]", params: { chatId: conversation.id } }}>
      <Link.Trigger>
        <Pressable
          accessibilityState={{ selected: active }}
          collapsable={false}
          className={
            active
              ? "min-h-11 justify-center rounded-xl border-continuous bg-secondary px-4 py-3"
              : "min-h-11 justify-center rounded-xl border-continuous px-4 py-3 active:bg-secondary"
          }
          onPressIn={() => void input.dismissSearch()}
        >
          <Text numberOfLines={1} className="text-[17px] text-sidebar-foreground leading-[22px]">
            {conversation.title}
          </Text>
        </Pressable>
      </Link.Trigger>
      <Link.Preview style={{ width: 340, height: 300 }}>
        <View className="h-full w-full gap-4 bg-background p-5">
          <Text numberOfLines={2} className="text-[19px] font-semibold text-foreground">
            {conversation.title}
          </Text>
          {previewMarkdown ? (
            <StreamdownText
              flavor="github"
              key={themeKey}
              markdown={previewMarkdown}
              markdownStyle={markdownStyle}
            />
          ) : (
            <Text className="text-[15px] text-muted-foreground">Preview unavailable</Text>
          )}
        </View>
      </Link.Preview>
      <Link.Menu>
        <Link.MenuAction title="Pin" icon="pin" onPress={noOp} />
        <Link.MenuAction title="Rename" icon="pencil" onPress={noOp} />
        <Link.MenuAction title="Add to project" icon="folder.badge.plus" onPress={noOp} />
        <Link.MenuAction title="Archive" icon="archivebox" onPress={noOp} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={noOp} />
      </Link.Menu>
    </Link>
  );
}

function getConversationsError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return "Recent chats could not be loaded.";
}

export function Sidebar({ closeDrawer }: { closeDrawer: () => void }) {
  const coordinator = useChatCoordinator();
  const input = useChatInputController();
  const drawerStatus = useDrawerStatus();
  const previousDrawerStatus = useRef(drawerStatus);
  const { showErrorToast } = useToast();
  const { theme } = useUniwind();
  const { chatId: activeChatId } = useGlobalSearchParams<{ chatId?: string }>();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(insets.top + SIDEBAR_HEADER_INITIAL_HEIGHT);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const markdownStyle = useChatMarkdownStyle();
  const conversationsQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.conversations(coordinator.partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(coordinator.partition!),
    enabled: Boolean(coordinator.partition),
  });
  const conversations = conversationsQuery.data ?? [];
  const normalizedSearchValue = isSearchActive ? searchValue.trim().toLocaleLowerCase() : "";
  const filteredConversations = normalizedSearchValue
    ? conversations.filter((conversation) =>
        conversation.title.toLocaleLowerCase().includes(normalizedSearchValue),
      )
    : conversations;
  const conversationsError = getConversationsError(conversationsQuery.error);

  useEffect(() => {
    if (previousDrawerStatus.current === "open" && drawerStatus === "closed") {
      void input.dismissSearch();
    }
    previousDrawerStatus.current = drawerStatus;
  }, [drawerStatus, input]);

  const refreshConversations = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const [error] = await until(coordinator.refreshConversations);
    setIsRefreshing(false);
    if (error)
      showErrorToast("Recent chats could not be refreshed.", error, "chat.list.manual-refresh");
  };

  // 0 while closed, 1 while fully open, tracking the gesture in between. Driven
  // by the same value that translates the screen content, so the sidebar eases
  // in as the content slides away — and reverses on close for free.
  const progress = useDrawerProgress();
  const revealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.3, 1]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.95, 1]) }],
  }));

  return (
    <Reanimated.View className="flex-1 bg-sidebar px-2" style={revealStyle}>
      <ScrollView
        testID={SIDEBAR_SCROLL_VIEW_TEST_ID}
        className="flex-1"
        alwaysBounceVertical
        contentContainerStyle={{
          paddingTop: headerHeight,
          paddingBottom: insets.bottom + 24,
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void refreshConversations()}
            tintColorClassName="accent-sidebar-foreground"
          />
        }
        scrollIndicatorInsets={{ top: headerHeight }}
        showsVerticalScrollIndicator={false}
      >
        <Text className="px-3 pb-2 text-[13px] font-semibold text-muted-foreground">Recents</Text>

        {conversationsError ? (
          <View className="mx-3 mb-2 gap-2 rounded-xl bg-secondary px-3 py-3 border-continuous">
            <Text selectable className="text-[13px] leading-5 text-muted-foreground">
              {conversationsError}
            </Text>
            {conversations.length === 0 ? (
              <Pressable
                accessibilityRole="button"
                className="self-start rounded-lg px-2 py-1 active:bg-background border-continuous"
                onPress={() => void refreshConversations()}
              >
                <Text className="text-[14px] font-semibold text-link">Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {conversationsQuery.isLoading ? (
          <View className="flex-row items-center gap-2 px-3 py-3">
            <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
            <Text className="text-[14px] text-muted-foreground">Loading recent chats...</Text>
          </View>
        ) : conversations.length === 0 && !conversationsError ? (
          <Text className="px-3 py-3 text-[14px] leading-5 text-muted-foreground">
            No recent chats yet.
          </Text>
        ) : filteredConversations.length === 0 ? (
          <Text className="px-3 py-3 text-[14px] leading-5 text-muted-foreground">
            No chats found.
          </Text>
        ) : coordinator.partition ? (
          <View className="gap-1">
            {filteredConversations.map((conversation) => (
              <SidebarConversationRow
                active={conversation.id === activeChatId}
                conversation={conversation}
                key={conversation.id}
                markdownStyle={markdownStyle}
                partition={coordinator.partition!}
                themeKey={theme}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>

      <NativeSidebarHeader
        className="absolute inset-x-0 top-0 z-10"
        dismissSearchRequest={input.dismissSearchRequestId}
        leading={
          <View accessible accessibilityLabel="opencompany" className="h-6 w-[146px] -mt-2">
            <StyledImage
              accessible={false}
              className="absolute inset-0 h-full w-full dark:opacity-0"
              contentFit="contain"
              source={wordmark}
            />
            <StyledImage
              accessible={false}
              className="absolute inset-0 h-full w-full opacity-0 dark:opacity-100"
              contentFit="contain"
              source={wordmarkDark}
            />
          </View>
        }
        onHeightChange={setHeaderHeight}
        onSearchActiveChange={(active) => {
          setIsSearchActive(active);
          input.setKeyboardOwner(active ? "sidebar" : null);
        }}
        onSearchValueChange={setSearchValue}
        scrollViewTestID={SIDEBAR_SCROLL_VIEW_TEST_ID}
        topInset={insets.top}
      />
      <View className="absolute inset-x-0 z-10 pl-5 pr-2" style={{ bottom: insets.bottom + 8 }}>
        <Host matchContents={{ vertical: true }}>
          <HStack>
            <Button
              onPress={() => {
                void input.dismissSearch();
                input.requestComposerFocus();
                closeDrawer();
                router.navigate("/");
              }}
              modifiers={[
                buttonStyle("glassProminent"),
                controlSize("large"),
                font({ textStyle: "body", weight: "bold" }),
                scaleEffect(SIDEBAR_ACTION_CONTROL_SCALE),
              ]}
            >
              <Label
                title="Chat"
                icon={
                  <Image
                    systemName="square.and.pencil"
                    modifiers={[
                      font({ textStyle: "body", weight: "bold" }),
                      scaleEffect(SIDEBAR_ACTION_ICON_SCALE),
                    ]}
                  />
                }
              />
            </Button>
            <Spacer />
            <Button
              modifiers={[
                buttonStyle("glass"),
                controlSize("large"),
                buttonBorderShape("circle"),
                scaleEffect(SIDEBAR_ACTION_CONTROL_SCALE),
              ]}
              onPress={() => {
                void input.dismissSearch();
                router.navigate("/settings-sheet");
              }}
            >
              <Label
                title="Settings"
                icon={
                  <Image
                    systemName="gearshape"
                    modifiers={[
                      font({ textStyle: "body" }),
                      scaleEffect(SIDEBAR_ACTION_ICON_SCALE),
                    ]}
                  />
                }
                modifiers={[labelStyle("iconOnly")]}
              />
            </Button>
          </HStack>
        </Host>
      </View>
    </Reanimated.View>
  );
}
