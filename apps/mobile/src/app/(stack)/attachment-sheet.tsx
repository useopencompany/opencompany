import { router } from "expo-router";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { Pressable, ScrollView, Text, View } from "react-native";
import { withUniwind } from "uniwind";

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

const StyledSymbolView = withUniwind(SymbolView, {
  tintColor: {
    fromClassName: "tintColorClassName",
    styleProperty: "color",
  },
});

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
            className="h-[84px] flex-1 items-center justify-center gap-2 rounded-[17px] bg-neutral-200 active:opacity-55 dark:bg-neutral-800"
            key={action.label}
            onPress={() => dismissWithAction(action.label)}
          >
            <StyledSymbolView
              name={action.icon}
              size={25}
              tintColorClassName="text-neutral-950 dark:text-neutral-50"
              weight="medium"
            />
            <Text className="font-medium text-[17px] text-neutral-950 leading-[21px] tracking-[-0.2px] dark:text-neutral-50">
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View className="mt-[25px] mb-[22px] h-px bg-neutral-200 dark:bg-neutral-800" />

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
                tintColorClassName="text-neutral-950 dark:text-neutral-50"
                weight="regular"
              />
            </View>
            <View className="flex-1">
              <Text className="font-semibold text-[17px] text-neutral-950 leading-[21px] tracking-[-0.25px] dark:text-neutral-50">
                {action.label}
              </Text>
              {action.description ? (
                <Text className="mt-0.5 text-[15px] text-neutral-500 leading-5 tracking-[-0.15px] dark:text-neutral-400">
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
