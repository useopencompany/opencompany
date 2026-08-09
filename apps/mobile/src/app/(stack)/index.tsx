import {
  Button,
  Host,
  HStack,
  Image,
  RNHostView,
  TextField,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  foregroundStyle,
  frame,
  glassEffect,
  layoutPriority,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, Text, View } from "react-native";
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
        <KeyboardStickyView className="px-6 pb-2" offset={{ closed: -bottom }}>
          <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
            <HStack
              modifiers={[
                padding({ horizontal: 10, vertical: 6 }),
                frame({ maxWidth: Infinity }),
                glassEffect(),
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
              <RNHostView matchContents>
                <Pressable
                  accessibilityLabel="Send message"
                  accessibilityRole="button"
                  onPress={() => {}}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "#007AFF",
                  }}
                >
                  <SymbolView name="arrow.up" size={14} tintColor="white" weight="semibold" />
                </Pressable>
              </RNHostView>
            </HStack>
          </Host>
        </KeyboardStickyView>
      </View>
    </>
  );
}
