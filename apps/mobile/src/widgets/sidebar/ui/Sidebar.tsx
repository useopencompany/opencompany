import { Host } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { type Href, router } from "expo-router";
import { Drawer, useDrawerProgress } from "expo-router/drawer";
import type { SFSymbol } from "expo-symbols";
import { Pressable, ScrollView, Text, View } from "react-native";
import Reanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";

const NAV_ITEMS: { label: string; icon: SFSymbol; href?: Href }[] = [
  { label: "Composer Playground", icon: "slider.horizontal.3", href: "/composer-playground" },
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

  // 0 while closed, 1 while fully open, tracking the gesture in between. Driven
  // by the same value that translates the screen content, so the sidebar eases
  // in as the content slides away — and reverses on close for free.
  const progress = useDrawerProgress();
  const revealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.3, 1]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.95, 1]) }],
  }));

  return (
    <Reanimated.View
      className="flex-1 bg-sidebar"
      style={[revealStyle, { paddingTop: insets.top }]}
    >
      {/* Sticky header */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text className="text-[20px] font-bold text-sidebar-foreground">Open Company</Text>
        <Host matchContents>
          <Button
            label="Search"
            systemImage="magnifyingglass"
            onPress={() => {}}
            modifiers={[
              buttonStyle("glass"),
              labelStyle("iconOnly"),
              controlSize("large"),
              buttonBorderShape("circle"),
            ]}
          />
        </Host>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}
      >
        {NAV_ITEMS.map((item) => (
          <Pressable
            key={item.label}
            onPress={() => {
              if (item.href) {
                router.push(item.href);
              }
            }}
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
    </Reanimated.View>
  );
}
