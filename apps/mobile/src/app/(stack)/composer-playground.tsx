import { type Href, Link, Stack } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { COMPOSER_PLAYGROUND_VARIANTS } from "@/widgets/chat";

export default function ComposerPlaygroundScreen() {
  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: "Composer Playground",
          headerTransparent: true,
        }}
      />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="gap-3 px-5 pb-10"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View className="gap-1 pb-2">
          <Text className="text-[24px] font-bold text-foreground">Composer experiments</Text>
          <Text className="text-[15px] leading-5 text-muted-foreground">
            Each option runs the same streaming chat. Test wrapping, manual newlines, five-line
            growth, keyboard width changes, focus, and list movement.
          </Text>
        </View>

        {COMPOSER_PLAYGROUND_VARIANTS.map((variant) => (
          <Link key={variant.id} href={variant.href as Href} asChild>
            <Pressable className="gap-1 rounded-2xl border border-border bg-card px-4 py-3 active:bg-secondary">
              <Text className="text-[17px] font-semibold text-card-foreground">
                {variant.title}
              </Text>
              <Text className="text-[14px] leading-5 text-muted-foreground">
                {variant.description}
              </Text>
            </Pressable>
          </Link>
        ))}
      </ScrollView>
    </>
  );
}
