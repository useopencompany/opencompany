import {
  Button,
  Host,
  HStack,
  Image,
  Overlay,
  RNHostView,
  Text as SwiftUIText,
  TextField,
  VStack,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  Animation,
  accessibilityLabel,
  accessibilityHidden,
  animation,
  background,
  buttonStyle,
  clipShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  glassEffect,
  layoutPriority,
  opacity,
  offset,
  padding,
  scaleEffect,
  zIndex,
} from "@expo/ui/swift-ui/modifiers";
import { Stack } from "expo-router";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { PlatformColor, Pressable, Text, View } from "react-native";
import {
  KeyboardChatScrollView,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const messages = ["hello world"];
const paletteAnimationDurationMs = 350;
const paletteAnimation = Animation.spring({ duration: 0.35, bounce: 0.12 });
const paletteHiddenKeyboardOffsetY = -183;
const primaryLabelColor = PlatformColor("label");
const iconBackgroundColor = PlatformColor("secondarySystemFill");

const attachmentActions: { label: string; icon: SFSymbol }[] = [
  { label: "Camera", icon: "camera" },
  { label: "Photos", icon: "photo.on.rectangle.angled" },
  { label: "Files", icon: "paperclip" },
  { label: "Plugins", icon: "puzzlepiece.extension" },
  { label: "Think harder", icon: "brain" },
];

export default function FirstStackScreen() {
  const inputState = useNativeState("");
  const [isAttachmentPaletteMounted, setIsAttachmentPaletteMounted] =
    useState(false);
  const [isAttachmentPaletteOpen, setIsAttachmentPaletteOpen] = useState(false);
  const paletteAnimationFrame = useRef<number | null>(null);
  const paletteUnmountTimeout = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const { bottom } = useSafeAreaInsets();

  useEffect(
    () => () => {
      if (paletteAnimationFrame.current !== null) {
        cancelAnimationFrame(paletteAnimationFrame.current);
      }
      if (paletteUnmountTimeout.current !== null) {
        clearTimeout(paletteUnmountTimeout.current);
      }
    },
    [],
  );

  const openAttachmentPalette = () => {
    if (paletteUnmountTimeout.current !== null) {
      clearTimeout(paletteUnmountTimeout.current);
      paletteUnmountTimeout.current = null;
    }

    setIsAttachmentPaletteMounted(true);
    paletteAnimationFrame.current = requestAnimationFrame(() => {
      paletteAnimationFrame.current = requestAnimationFrame(() => {
        setIsAttachmentPaletteOpen(true);
        paletteAnimationFrame.current = null;
      });
    });
  };

  const closeAttachmentPalette = () => {
    if (paletteAnimationFrame.current !== null) {
      cancelAnimationFrame(paletteAnimationFrame.current);
      paletteAnimationFrame.current = null;
    }

    setIsAttachmentPaletteOpen(false);
    paletteUnmountTimeout.current = setTimeout(() => {
      setIsAttachmentPaletteMounted(false);
      paletteUnmountTimeout.current = null;
    }, paletteAnimationDurationMs);
  };

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
            <Overlay
              alignment="leading"
              modifiers={[
                frame({ maxWidth: Infinity, alignment: "leading" }),
                animation(paletteAnimation, isAttachmentPaletteOpen),
              ]}
            >
              <HStack
                modifiers={[
                  padding({ horizontal: 10, vertical: 6 }),
                  frame({ maxWidth: Infinity }),
                  glassEffect(),
                  zIndex(0),
                ]}
              >
                <Button
                  onPress={
                    isAttachmentPaletteOpen
                      ? closeAttachmentPalette
                      : openAttachmentPalette
                  }
                  modifiers={[
                    buttonStyle("plain"),
                    accessibilityLabel(
                      isAttachmentPaletteOpen
                        ? "Close attachments"
                        : "Open attachments",
                    ),
                  ]}
                >
                  <Image
                    systemName="plus"
                    size={18}
                    modifiers={[foregroundStyle("black")]}
                  />
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
                    <SymbolView
                      name="arrow.up"
                      size={14}
                      tintColor="white"
                      weight="semibold"
                    />
                  </Pressable>
                </RNHostView>
              </HStack>
              {isAttachmentPaletteMounted ? (
                <Overlay.Content>
                  <VStack
                    alignment="leading"
                    spacing={2}
                    modifiers={[
                      padding({ all: 8 }),
                      frame({ width: 264, alignment: "leading" }),
                      glassEffect({
                        glass: { variant: "regular" },
                        shape: "roundedRectangle",
                        cornerRadius: 28,
                      }),
                      opacity(isAttachmentPaletteOpen ? 1 : 0),
                      scaleEffect(isAttachmentPaletteOpen ? 1 : 0.05),
                      offset({
                        x: isAttachmentPaletteOpen ? -19 : -113,
                        y:
                          isAttachmentPaletteOpen && !isKeyboardVisible
                            ? paletteHiddenKeyboardOffsetY
                            : 0,
                      }),
                      disabled(!isAttachmentPaletteOpen),
                      accessibilityHidden(!isAttachmentPaletteOpen),
                      zIndex(2),
                      animation(paletteAnimation, isAttachmentPaletteOpen),
                      animation(paletteAnimation, isKeyboardVisible),
                    ]}
                  >
                    {attachmentActions.map((action) => (
                      <Button
                        key={action.label}
                        onPress={() => {
                          closeAttachmentPalette();
                          console.log(action.label);
                        }}
                        modifiers={[
                          buttonStyle("plain"),
                          accessibilityLabel(action.label),
                        ]}
                      >
                        <HStack
                          spacing={14}
                          modifiers={[
                            padding({ horizontal: 8, vertical: 6 }),
                            frame({ width: 248, alignment: "leading" }),
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
                          <SwiftUIText
                            modifiers={[
                              font({ textStyle: "body" }),
                              foregroundStyle(primaryLabelColor),
                            ]}
                          >
                            {action.label}
                          </SwiftUIText>
                        </HStack>
                      </Button>
                    ))}
                  </VStack>
                </Overlay.Content>
              ) : null}
            </Overlay>
          </Host>
        </KeyboardStickyView>
      </View>
    </>
  );
}
