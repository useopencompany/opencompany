import { Image as ExpoImage } from "expo-image";
import { Drawer, useDrawerProgress } from "expo-router/drawer";
import type { SFSymbol } from "expo-symbols";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Reanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

import wordmark from "@/assets/images/wordmark.png";
import wordmarkDark from "@/assets/images/wordmark-dark.png";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import {
  OpenCompanySidebarHeader,
  SIDEBAR_HEADER_INITIAL_HEIGHT,
} from "../../../../modules/open-company-sidebar-header";

const SIDEBAR_SCROLL_VIEW_TEST_ID = "sidebar-scroll-view";
const StyledImage = withUniwind(ExpoImage);

const NAV_ITEMS: { label: string; icon: SFSymbol }[] = [
  { label: "Images", icon: "photo" },
  { label: "Library", icon: "books.vertical" },
  { label: "Projects", icon: "folder" },
];

const RECENT_CHATS = [
  "Drawer layout polish",
  "Pricing page copy",
  "Runner auth at usage limit",
  "Sidebar background chats",
  "Onboarding email sequence",
  "Postgres index review",
  "Mobile app icon ideas",
  "Q3 hiring plan",
  "Refactor billing webhooks",
  "Landing page hero rewrite",
  "Support macros cleanup",
  "Analytics event naming",
];

export function Sidebar() {
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(insets.top + SIDEBAR_HEADER_INITIAL_HEIGHT);

  // 0 while closed, 1 while fully open, tracking the gesture in between. Driven
  // by the same value that translates the screen content, so the sidebar eases
  // in as the content slides away — and reverses on close for free.
  const progress = useDrawerProgress();
  const revealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.3, 1]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.95, 1]) }],
  }));

  return (
    <Reanimated.View className="flex-1 bg-sidebar" style={revealStyle}>
      <ScrollView
        testID={SIDEBAR_SCROLL_VIEW_TEST_ID}
        className="flex-1"
        contentContainerStyle={{
          paddingTop: headerHeight,
          paddingBottom: insets.bottom + 24,
        }}
        scrollIndicatorInsets={{ top: headerHeight }}
        showsVerticalScrollIndicator={false}
      >
        {NAV_ITEMS.map((item) => (
          <Pressable
            key={item.label}
            onPress={() => {}}
            className="flex-row items-center gap-3 px-5 py-2.5 active:bg-secondary"
          >
            <StyledSymbolView
              name={item.icon}
              size={20}
              tintColorClassName="accent-sidebar-foreground"
            />
            <Text className="text-[16px] font-semibold text-sidebar-foreground">{item.label}</Text>
          </Pressable>
        ))}

        <Text className="px-5 pt-6 pb-2 text-[13px] font-semibold text-muted-foreground">
          Recents
        </Text>

        {RECENT_CHATS.map((chat) => (
          <Pressable key={chat} onPress={() => {}} className="px-5 py-2.5 active:bg-secondary">
            <Text numberOfLines={1} className="text-[15px] text-sidebar-foreground">
              {chat}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <OpenCompanySidebarHeader
        className="absolute inset-x-0 top-0 z-10"
        leading={
          <View accessible accessibilityLabel="Open Company" className="h-6 w-[146px] -mt-2">
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
    </Reanimated.View>
  );
}
