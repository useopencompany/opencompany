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
import { router, useGlobalSearchParams } from "expo-router";
import { useDrawerProgress, useDrawerStatus } from "expo-router/drawer";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import Reanimated, {
  FadeIn,
  FadeOut,
  interpolate,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwind } from "uniwind";
import { until } from "until-async";
import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { analytics, captureError } from "@/shared/lib/analytics";
import { StyledImage } from "@/shared/ui/styled-image";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "@/widgets/chat/model/chat-coordinator";
import { useChatInputController } from "@/widgets/chat/model/chat-input-controller";
import { listStoredConversations } from "@/widgets/chat/model/chat-store";
import { useConversationActions } from "@/widgets/chat/model/conversation-actions";
import { useChatMarkdownStyle } from "@/widgets/chat/ui/use-chat-markdown-style";
import {
  NativeSidebarHeader,
  SIDEBAR_HEADER_INITIAL_HEIGHT,
} from "@/widgets/sidebar/native/NativeSidebarHeaderView";
import { buildSidebarSections, type SidebarItem } from "../model/sidebar-items";
import { useSessionPullRequests } from "../model/use-session-pull-requests";
import { SidebarConversationRow } from "./SidebarConversationRow";

const SIDEBAR_SCROLL_VIEW_TEST_ID = "sidebar-scroll-view";
// The native bar items render between SwiftUI's regular and large control sizes.
// Scale the large visual treatment while preserving its full hit target.
const SIDEBAR_ACTION_CONTROL_SCALE = 0.875;
const SIDEBAR_ACTION_ICON_SCALE = 1.25;
// Rows glide to their new section when pinned or unpinned. Under Reduce Motion they reposition
// immediately and only fade.
const ROW_MOVE = LinearTransition.duration(240);
const ROW_ENTERING = FadeIn.duration(160);
const ROW_EXITING = FadeOut.duration(120);

function SectionHeading({
  animateMoves,
  children,
  spaced = false,
}: {
  animateMoves: boolean;
  children: ReactNode;
  spaced?: boolean;
}) {
  return (
    <Reanimated.View
      entering={ROW_ENTERING}
      exiting={ROW_EXITING}
      layout={animateMoves ? ROW_MOVE : undefined}
    >
      <Text
        accessibilityRole="header"
        className={
          spaced
            ? "px-3 pt-4 pb-1 text-[13px] font-semibold text-muted-foreground"
            : "px-3 pb-1 text-[13px] font-semibold text-muted-foreground"
        }
      >
        {children}
      </Text>
    </Reanimated.View>
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
  const reducedMotion = useReducedMotion();
  // Moves only animate on screen. While the drawer is closed, launch loads the list in several
  // passes, and the transitions interrupting each other leave rows a few points off.
  const animateMoves = !reducedMotion && drawerStatus === "open";
  const actions = useConversationActions();
  const pullRequests = useSessionPullRequests(drawerStatus === "open");
  const conversationsQuery = useQuery({
    queryKey: coordinator.partition
      ? chatQueryKeys.conversations(coordinator.partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(coordinator.partition!),
    enabled: Boolean(coordinator.partition),
  });
  const conversations = conversationsQuery.data ?? [];
  const sections = buildSidebarSections(conversations, {
    now: Date.now(),
    search: isSearchActive ? searchValue : "",
  });
  const hasAnyItem = sections.pinned.length > 0 || sections.recents.length > 0;
  const isSearching = Boolean(isSearchActive && searchValue.trim());
  const conversationsError = getConversationsError(conversationsQuery.error);
  const isOffline = coordinator.connectivity === "offline";

  useEffect(() => {
    if (previousDrawerStatus.current === "open" && drawerStatus === "closed") {
      void input.dismissSearch();
    }
    // Opening the sidebar shows current state, not the last snapshot this device happened to keep.
    if (previousDrawerStatus.current !== "open" && drawerStatus === "open" && !isOffline) {
      void until(coordinator.refreshConversations).then(([error]) => {
        if (error) captureError("conversation_list_refresh_failed", error);
      });
    }
    previousDrawerStatus.current = drawerStatus;
  }, [drawerStatus, input]);

  const renderRow = (item: SidebarItem) => (
    <Reanimated.View
      entering={ROW_ENTERING}
      exiting={ROW_EXITING}
      key={item.conversation.id}
      layout={animateMoves ? ROW_MOVE : undefined}
    >
      <SidebarConversationRow
        active={item.conversation.id === activeChatId}
        actions={actions}
        item={item}
        markdownStyle={markdownStyle}
        pullRequest={pullRequests.get(item.conversation.id)}
        themeKey={theme}
      />
    </Reanimated.View>
  );

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
          paddingBottom: insets.bottom + 96,
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void refreshConversations()}
            tintColorClassName="accent-sidebar-foreground"
          />
        }
        scrollIndicatorInsets={{ top: headerHeight, bottom: insets.bottom + 80 }}
        showsVerticalScrollIndicator={false}
      >
        {isOffline ? (
          <Text className="px-3 pb-2 text-[13px] leading-5 text-muted-foreground">
            You're offline. Showing chats saved on this device.
          </Text>
        ) : null}

        {conversationsError ? (
          <View className="mx-3 mb-2 gap-2 rounded-xl bg-secondary px-3 py-3 border-continuous">
            <Text selectable className="text-[13px] leading-5 text-muted-foreground">
              {conversationsError}
            </Text>
            <Pressable
              accessibilityRole="button"
              className="self-start rounded-lg px-2 py-1 active:bg-background border-continuous"
              onPress={() => void refreshConversations()}
            >
              <Text className="text-[14px] font-semibold text-link">Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {conversationsQuery.isLoading ? (
          <View className="flex-row items-center gap-2 px-3 py-3">
            <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
            <Text className="text-[14px] text-muted-foreground">Loading recent chats...</Text>
          </View>
        ) : !hasAnyItem && !conversationsError ? (
          <Text className="px-3 py-3 text-[14px] leading-5 text-muted-foreground">
            {isSearching ? "No chats found." : "No recent chats yet."}
          </Text>
        ) : coordinator.partition ? (
          // One keyed hierarchy for both sections, so a pinned row moves between them instead of
          // unmounting in one list and mounting in another.
          <View className="gap-1">
            {[
              ...(sections.pinned.length > 0
                ? [
                    <SectionHeading animateMoves={animateMoves} key="heading:pinned">
                      Pinned
                    </SectionHeading>,
                  ]
                : []),
              ...sections.pinned.map((item) => renderRow(item)),
              ...(sections.recents.length > 0
                ? [
                    <SectionHeading
                      animateMoves={animateMoves}
                      key="heading:recents"
                      spaced={sections.pinned.length > 0}
                    >
                      Recents
                    </SectionHeading>,
                  ]
                : []),
              ...sections.recents.map((item) => renderRow(item)),
            ]}
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
          analytics.capture(active ? "conversation_search_started" : "conversation_search_closed", {
            had_query: Boolean(searchValue.trim()),
          });
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
                analytics.capture("new_chat_started");
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
                analytics.capture("settings_opened");
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
