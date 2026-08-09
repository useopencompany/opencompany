import { Button, Host } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { Drawer, useDrawerProgress } from "expo-router/drawer";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { Pressable, ScrollView, Text, useColorScheme, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const isDark = scheme === "dark";
  const text = isDark ? "#F5F5F5" : "#1A1A1A";
  const muted = isDark ? "#8A8A8A" : "#7A7A7A";

  // 0 while closed, 1 while fully open, tracking the gesture in between. Driven
  // by the same value that translates the screen content, so the sidebar eases
  // in as the content slides away — and reverses on close for free.
  const progress = useDrawerProgress();
  const revealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.3, 1]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.95, 1]) }],
  }));

  return (
    <Animated.View style={[{ flex: 1, paddingTop: insets.top }, revealStyle]}>
      {/* Sticky header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
          paddingVertical: 12,
        }}
      >
        <Text style={{ fontSize: 20, fontWeight: "700", color: text }}>Open Company</Text>
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
            onPress={() => {}}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 20,
              paddingVertical: 10,
            }}
          >
            <SymbolView name={item.icon} size={20} tintColor={text} />
            <Text style={{ fontSize: 16, fontWeight: "600", color: text }}>{item.label}</Text>
          </Pressable>
        ))}

        <Text
          style={{
            fontSize: 13,
            fontWeight: "600",
            color: muted,
            paddingHorizontal: 20,
            paddingTop: 24,
            paddingBottom: 8,
          }}
        >
          Recents
        </Text>

        {RECENT_CHATS.map((chat) => (
          <Pressable
            key={chat}
            onPress={() => {}}
            style={{ paddingHorizontal: 20, paddingVertical: 10 }}
          >
            <Text numberOfLines={1} style={{ fontSize: 15, color: text }}>
              {chat}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </Animated.View>
  );
}
