import { router } from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";

type AttachmentAction = {
  label: string;
  icon: SFSymbol;
};

type ToolAction = AttachmentAction & {
  description?: string;
};

const attachmentActions: AttachmentAction[] = [
  { label: "Camera", icon: "camera" },
  { label: "Photos", icon: "photo.on.rectangle" },
  { label: "Files", icon: "paperclip" },
];

const toolActions: ToolAction[] = [
  {
    label: "Create image",
    description: "Visualize anything",
    icon: "paintbrush.pointed",
  },
  {
    label: "Thinking",
    description: "Think longer for better answers",
    icon: "lightbulb",
  },
  {
    label: "Deep research",
    description: "Get a detailed report",
    icon: "binoculars",
  },
  {
    label: "Web search",
    description: "Find real-time news and info",
    icon: "globe",
  },
  { label: "Add files", icon: "paperclip" },
];

function dismissWithAction(label: string) {
  console.log(label);
  router.back();
}

export default function AttachmentSheet() {
  return (
    <ScrollView
      contentContainerClassName="px-7 pt-7"
      showsVerticalScrollIndicator={false}
      bounces={false}
    >
      <View className="flex-row gap-3">
        {attachmentActions.map((action) => (
          <Pressable
            accessibilityLabel={action.label}
            accessibilityRole="button"
            className="h-[84px] flex-1 items-center justify-center gap-2 rounded-[17px] border-continuous bg-secondary active:opacity-55"
            key={action.label}
            onPress={() => dismissWithAction(action.label)}
          >
            <StyledSymbolView
              name={action.icon}
              size={25}
              tintColorClassName="accent-secondary-foreground"
              weight="medium"
            />
            <Text className="font-medium text-[17px] text-secondary-foreground leading-[21px] tracking-[-0.2px]">
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View
        className="mt-[25px] mb-[22px] bg-border-subtle"
        style={{ height: StyleSheet.hairlineWidth }}
      />

      <View>
        {toolActions.map((action) => (
          <Pressable
            accessibilityLabel={action.label}
            accessibilityRole="button"
            className="h-[66px] flex-row items-center active:opacity-55"
            key={action.label}
            onPress={() => dismissWithAction(action.label)}
          >
            <View className="w-10 items-center justify-center">
              <StyledSymbolView
                name={action.icon}
                size={25}
                tintColorClassName="accent-foreground"
                weight="regular"
              />
            </View>
            <View className="flex-1">
              <Text className="font-semibold text-[17px] text-foreground leading-[21px] tracking-[-0.25px]">
                {action.label}
              </Text>
              {action.description ? (
                <Text className="mt-0.5 text-[15px] text-muted-foreground leading-5 tracking-[-0.15px]">
                  {action.description}
                </Text>
              ) : null}
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
