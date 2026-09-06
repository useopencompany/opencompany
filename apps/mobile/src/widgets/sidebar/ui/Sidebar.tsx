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
import { useDrawerProgress } from "expo-router/drawer";
import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import Reanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { until } from "until-async";
import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "@/widgets/chat/model/chat-coordinator";
import { listStoredConversations } from "@/widgets/chat/model/chat-store";
import {
  NativeSidebarHeader,
  SIDEBAR_HEADER_INITIAL_HEIGHT,
} from "../../../../modules/open-company-sidebar-header";

const SIDEBAR_SCROLL_VIEW_TEST_ID = "sidebar-scroll-view";
// The native bar items render between SwiftUI's regular and large control sizes.
// Scale the large visual treatment while preserving its full hit target.
const SIDEBAR_ACTION_CONTROL_SCALE = 0.875;
const SIDEBAR_ACTION_ICON_SCALE = 1.25;

function getConversationsError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return "Recent chats could not be loaded.";
}

export function Sidebar() {
  const coordinator = useChatCoordinator();
  const { showErrorToast } = useToast();
  const { chatId: activeChatId } = useGlobalSearchParams<{ chatId?: string }>();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(insets.top + SIDEBAR_HEADER_INITIAL_HEIGHT);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [searchValue, setSearchValue] = useState("");
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
        ) : (
          filteredConversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={{ pathname: "/chats/[chatId]", params: { chatId: conversation.id } }}
              asChild
            >
              <Pressable
                className={
                  conversation.id === activeChatId
                    ? "rounded-xl border-continuous bg-secondary px-3 py-2.5"
                    : "rounded-xl border-continuous px-3 py-2.5 active:bg-secondary"
                }
              >
                <Text numberOfLines={1} className="text-[15px] text-sidebar-foreground">
                  {conversation.title}
                </Text>
              </Pressable>
            </Link>
          ))
        )}
      </ScrollView>

      <NativeSidebarHeader
        className="absolute inset-x-0 top-0 z-10"
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
        onSearchActiveChange={setIsSearchActive}
        onSearchValueChange={setSearchValue}
        scrollViewTestID={SIDEBAR_SCROLL_VIEW_TEST_ID}
        topInset={insets.top}
      />
      <View className="absolute inset-x-0 z-10 pl-5 pr-2" style={{ bottom: insets.bottom + 8 }}>
        <Host matchContents={{ vertical: true }}>
          <HStack>
            <Button
              onPress={() => router.navigate("/")}
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
              onPress={() => router.navigate("/settings-sheet")}
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
