import { Button, Host, HStack, Image, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  background,
  bold,
  buttonStyle,
  clipShape,
  font,
  foregroundStyle,
  frame,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { router, Stack } from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { PlatformColor, View } from "react-native";

const primaryLabelColor = PlatformColor("label");
const secondaryLabelColor = PlatformColor("secondaryLabel");
const iconBackgroundColor = PlatformColor("secondarySystemFill");

const attachmentActions: { label: string; icon: SFSymbol }[] = [
  { label: "Camera", icon: "camera" },
  { label: "Photos", icon: "photo.on.rectangle.angled" },
  { label: "Files", icon: "paperclip" },
  { label: "Plugins", icon: "puzzlepiece.extension" },
  { label: "Think harder", icon: "brain" },
];

export default function AttachmentSheet() {
  return (
    <>
      <View className="flex-1 px-4 pt-5">
        <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
          <VStack
            alignment="leading"
            spacing={16}
            modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
          >
            <VStack alignment="leading" spacing={4}>
              <Text
                modifiers={[
                  font({ textStyle: "title2" }),
                  bold(),
                  foregroundStyle(primaryLabelColor),
                ]}
              >
                Add to message
              </Text>
              <Text
                modifiers={[
                  font({ textStyle: "subheadline" }),
                  foregroundStyle(secondaryLabelColor),
                ]}
              >
                Choose what you want to include.
              </Text>
            </VStack>

            <VStack
              alignment="leading"
              spacing={2}
              modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
            >
              {attachmentActions.map((action) => (
                <Button
                  key={action.label}
                  onPress={() => {
                    console.log(action.label);
                    router.back();
                  }}
                  modifiers={[buttonStyle("plain"), accessibilityLabel(action.label)]}
                >
                  <HStack
                    spacing={14}
                    modifiers={[
                      padding({ horizontal: 8, vertical: 6 }),
                      frame({ maxWidth: Infinity, alignment: "leading" }),
                    ]}
                  >
                    <Image
                      systemName={action.icon}
                      size={22}
                      modifiers={[
                        foregroundStyle(primaryLabelColor),
                        frame({ width: 44, height: 44 }),
                        background(iconBackgroundColor),
                        clipShape("circle"),
                      ]}
                    />
                    <Text
                      modifiers={[font({ textStyle: "body" }), foregroundStyle(primaryLabelColor)]}
                    >
                      {action.label}
                    </Text>
                  </HStack>
                </Button>
              ))}
            </VStack>
          </VStack>
        </Host>
      </View>
    </>
  );
}
