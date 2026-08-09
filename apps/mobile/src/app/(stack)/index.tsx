import { Button, Host, HStack, Image, TextField, useNativeState } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  background,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  layoutPriority,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { router, Stack } from "expo-router";
import { Text, View } from "react-native";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const messages = ["hello world"];

export default function FirstStackScreen() {
  const inputState = useNativeState("");
  const { bottom } = useSafeAreaInsets();

  return (
    <>
      <Stack.Screen options={{ headerTransparent: true, headerTitle: "" }} />

      <View className="flex-1">
        <KeyboardChatScrollView offset={bottom}>
          {messages.map((text, index) => (
            <Text key={index}>{text}</Text>
          ))}
        </KeyboardChatScrollView>
        <KeyboardStickyView className="px-6" offset={{ closed: -bottom }}>
          <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
            <HStack
              modifiers={[
                padding({ horizontal: 10, vertical: 6 }),
                frame({ maxWidth: Infinity }),
                glassEffect({
                  glass: {
                    variant: "regular",
                    interactive: true,
                  },
                }),
              ]}
            >
              <Button
                onPress={() => router.push("/attachment-sheet")}
                modifiers={[buttonStyle("plain"), accessibilityLabel("Open attachments")]}
              >
                <Image systemName="plus" size={18} modifiers={[foregroundStyle("black")]} />
              </Button>
              <TextField
                placeholder="Ask opencompany"
                text={inputState}
                modifiers={[layoutPriority(1), frame({ maxWidth: Infinity })]}
              />
              <Button
                onPress={() => {}}
                modifiers={[buttonStyle("plain"), accessibilityLabel("Send message")]}
              >
                <Image
                  systemName="arrow.up"
                  modifiers={[
                    font({ size: 14, weight: "bold" }),
                    foregroundStyle("white"),
                    frame({ width: 30, height: 30 }),
                    background("#007AFF", shapes.circle()),
                  ]}
                />
              </Button>
            </HStack>
          </Host>
        </KeyboardStickyView>
      </View>
    </>
  );
}
