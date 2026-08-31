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
import type { ConversationDto } from "@opencompany/protocol/schemas";
import { type Href, Link, router } from "expo-router";
import { useDrawerProgress } from "expo-router/drawer";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import Reanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { until } from "until-async";
import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { useAuth } from "@/features/auth";
import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import {
  NativeSidebarHeader,
  SIDEBAR_HEADER_INITIAL_HEIGHT,
} from "../../../../modules/open-company-sidebar-header";

const SIDEBAR_SCROLL_VIEW_TEST_ID = "sidebar-scroll-view";
// The native bar items render between SwiftUI's regular and large control sizes.
// Scale the large visual treatment while preserving its full hit target.
const SIDEBAR_ACTION_CONTROL_SCALE = 0.875;
const SIDEBAR_ACTION_ICON_SCALE = 1.25;

const NAV_ITEMS: { label: string; icon: SFSymbol; href: Href }[] = [
  { label: "Tasks", icon: "checklist", href: "/tasks" },
  { label: "Brains", icon: "brain", href: "/brains" },
];

export function Sidebar() {
  const { api, workspace } = useAuth();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(insets.top + SIDEBAR_HEADER_INITIAL_HEIGHT);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsInitialLoading(true);
    setConversations([]);
    setConversationsError(null);

    void until(api.listConversations).then(([error, data]) => {
      if (cancelled) return;
      if (error) {
        setConversationsError(
          error instanceof Error ? error.message : "Recent chats could not be loaded.",
        );
      } else {
        setConversations(data);
      }
      setIsInitialLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [api, workspace?.id]);

  const refreshConversations = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const [error, data] = await until(api.listConversations);
    if (error) {
      setConversationsError(
        error instanceof Error ? error.message : "Recent chats could not be refreshed.",
      );
    } else {
      setConversations(data);
      setConversationsError(null);
    }
    setIsRefreshing(false);
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
        {NAV_ITEMS.map((item) => (
          <Link key={item.label} href={item.href} asChild>
            <Pressable className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl active:bg-secondary border-continuous">
              <StyledSymbolView
                name={item.icon}
                size={20}
                tintColorClassName="accent-sidebar-foreground"
              />
              <Text className="text-[16px] font-medium text-sidebar-foreground">{item.label}</Text>
            </Pressable>
          </Link>
        ))}

        <Text className="px-3 pt-6 pb-2 text-[13px] font-semibold text-muted-foreground">
          Recents
        </Text>

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

        {isInitialLoading ? (
          <View className="flex-row items-center gap-2 px-3 py-3">
            <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
            <Text className="text-[14px] text-muted-foreground">Loading recent chats...</Text>
          </View>
        ) : conversations.length === 0 && !conversationsError ? (
          <Text className="px-3 py-3 text-[14px] leading-5 text-muted-foreground">
            No recent chats yet.
          </Text>
        ) : (
          conversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={{ pathname: "/chats/[chatId]", params: { chatId: conversation.id } }}
              asChild
            >
              <Pressable className="px-3 py-2.5 active:bg-secondary rounded-xl border-continuous">
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
        onSearchPress={() => {}}
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
