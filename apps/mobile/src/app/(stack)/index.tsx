import { Button, Host, HStack, Image, TextField, useNativeState } from "@expo/ui/swift-ui";
import {
  Animation,
  accessibilityLabel,
  animation,
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
import { useState } from "react";
import { Text, View } from "react-native";
import {
  KeyboardChatScrollView,
  KeyboardController,
  KeyboardStickyView,
  useKeyboardHandler,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

const messages = [
  "Can you help me plan a productive Saturday?\nI want to make progress on a side project,\nbut still leave time to relax.",
  "Absolutely. Start with a focused two-hour block\nfor your side project in the morning, then take\na proper break before deciding what comes next.",
  "That sounds manageable. Can you turn it\ninto a simple schedule with suggested times\nand a good lunch break?",
  "9:00–9:15 — Set up your workspace and choose one goal.\n9:15–11:15 — Work without notifications.\n12:30 — Have lunch away from your desk.",
  "What should I do if I finish the main task\nearlier than expected? I do not want to fill\nthe whole day with more work.",
  "Use the extra time for a small, clearly bounded task,\nlike writing notes or cleaning up one area of the project.\nThen stop while you still have energy.",
  "I also want to exercise, but I usually\nput it off when the day gets busy.\nWhere should I place it?",
  "Try scheduling a short walk or workout\nright after lunch. It creates a natural reset\nand is easier to keep than an evening plan.",
  "Could you summarize the plan in a checklist\nthat I can quickly look at tomorrow morning\nwithout rereading this whole conversation?",
  "Your Saturday checklist:\n☐ Pick one project goal\n☐ Work for two focused hours\n☐ Take a real lunch break and go for a walk",
];
const COMPOSER_INSET = { closed: 40, opened: 24 };

export default function FirstStackScreen() {
  const inputState = useNativeState("");
  const { bottom } = useSafeAreaInsets();
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(() => KeyboardController.isVisible());

  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        scheduleOnRN(setIsKeyboardVisible, event.progress === 1);
      },
    },
    [],
  );

  return (
    <>
      <Stack.Screen options={{ headerTransparent: true, headerTitle: "" }} />

      <KeyboardChatScrollView
        inverted
        contentContainerClassName="px-6 gap-y-6 pt-24 bg-red-500"
        contentInsetAdjustmentBehavior="never"
      >
        {messages.map((text, index) => (
          <View key={index} className="rounded-2xl bg-neutral-200">
            <Text>{text}</Text>
          </View>
        ))}
      </KeyboardChatScrollView>
      <KeyboardStickyView
        style={{ paddingHorizontal: COMPOSER_INSET.opened }}
        offset={{ closed: -bottom }}
      >
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
              padding({
                horizontal: isKeyboardVisible ? 0 : COMPOSER_INSET.closed - COMPOSER_INSET.opened,
              }),
              animation(Animation.spring({ bounce: 0, duration: 0.3 }), isKeyboardVisible),
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
    </>
  );
}
