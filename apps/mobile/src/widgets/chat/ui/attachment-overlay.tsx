import type { SFSymbol } from "expo-symbols";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, useWindowDimensions, View } from "react-native";
import { OverKeyboardView } from "react-native-keyboard-controller";
import Reanimated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { analytics } from "@/shared/lib/analytics";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useChatInputController } from "../model/chat-input-controller";
import { type AttachmentSource, useAttachmentSources } from "../model/use-attachment-sources";
import { COMPOSER_HORIZONTAL_MARGIN, type WindowFrame } from "./ChatComposer";
import { CameraPanel } from "./camera-panel";

const MENU_WIDTH = 216;
const MENU_ROW_HEIGHT = 50;
const MENU_PADDING = 6;
const MENU_HEIGHT = MENU_ROW_HEIGHT * 3 + MENU_PADDING * 2;
const CAMERA_HEIGHT_RATIO = 0.6;
const EDGE_GAP = 8;
const TIMING = { duration: 280, easing: Easing.bezier(0.22, 1, 0.36, 1) };

// Stages the one shell moves between: folded into the plus button, the menu, the camera panel.
const COLLAPSED = 0;
const MENU = 1;
const CAMERA = 2;

const MENU_ITEMS: { source: AttachmentSource; label: string; icon: SFSymbol }[] = [
  { source: "camera", label: "Camera", icon: "camera" },
  { source: "photos", label: "Photos", icon: "photo.on.rectangle" },
  { source: "files", label: "Files", icon: "paperclip" },
];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The add menu and camera, drawn over the keyboard so the composer keeps focus. The shell
 * animates its frame between stages while each stage's content keeps a fixed size and only fades,
 * so text and camera imagery never stretch.
 */
export function AttachmentOverlay({
  anchor,
  isScreenFocused,
  onClosed,
}: {
  anchor: WindowFrame | null;
  isScreenFocused: boolean;
  onClosed: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const input = useChatInputController();
  const sources = useAttachmentSources();
  const [presented, setPresented] = useState<WindowFrame | null>(null);
  const [mode, setMode] = useState<"menu" | "camera">("menu");
  const [cameraMounted, setCameraMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const stage = useSharedValue(COLLAPSED);

  const animateTo = (target: number, onFinish?: () => void) => {
    if (reducedMotion) {
      stage.set(target);
      onFinish?.();
      return;
    }
    stage.set(
      withTiming(target, TIMING, (finished) => {
        if (finished && onFinish) scheduleOnRN(onFinish);
      }),
    );
  };

  useEffect(() => {
    if (!anchor) return;
    setPresented(anchor);
    setMode("menu");
    setClosing(false);
    stage.set(COLLAPSED);
    animateTo(MENU);
  }, [anchor]);

  const finishClose = () => {
    setPresented(null);
    setCameraMounted(false);
    setClosing(false);
    onClosed();
  };
  const close = ({ immediate = false }: { immediate?: boolean } = {}) => {
    if (!presented) return;
    if (immediate) {
      stage.set(COLLAPSED);
      finishClose();
      return;
    }
    setClosing(true);
    animateTo(COLLAPSED, finishClose);
  };

  // The screen losing focus, such as the sidebar opening, takes the overlay with it.
  useEffect(() => {
    if (!isScreenFocused && presented) close({ immediate: true });
  }, [isScreenFocused]);

  const anchorFrame = presented ?? { x: 0, y: 0, width: 0, height: 0 };
  const menuFrame = {
    x: COMPOSER_HORIZONTAL_MARGIN,
    y: clamp(
      anchorFrame.y + anchorFrame.height / 2 - MENU_HEIGHT / 2,
      insets.top + EDGE_GAP,
      windowHeight - insets.bottom - EDGE_GAP - MENU_HEIGHT,
    ),
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
  };
  const cameraHeight = Math.min(
    Math.round(windowHeight * CAMERA_HEIGHT_RATIO),
    windowHeight - insets.top - insets.bottom - EDGE_GAP * 2,
  );
  const cameraFrame = {
    x: COMPOSER_HORIZONTAL_MARGIN,
    y: windowHeight - insets.bottom - cameraHeight,
    width: windowWidth - COMPOSER_HORIZONTAL_MARGIN * 2,
    height: cameraHeight,
  };

  const shellStyle = useAnimatedStyle(() => {
    const value = stage.get();
    const stops = [COLLAPSED, MENU, CAMERA];
    return {
      left: interpolate(value, stops, [anchorFrame.x, menuFrame.x, cameraFrame.x]),
      top: interpolate(value, stops, [anchorFrame.y, menuFrame.y, cameraFrame.y]),
      width: interpolate(value, stops, [anchorFrame.width, menuFrame.width, cameraFrame.width]),
      height: interpolate(value, stops, [anchorFrame.height, menuFrame.height, cameraFrame.height]),
      borderRadius: interpolate(value, stops, [anchorFrame.height / 2, 26, 34]),
      opacity: interpolate(value, [COLLAPSED, 0.35], [0, 1], "clamp"),
    };
  });
  const menuStyle = useAnimatedStyle(() => ({
    opacity: interpolate(stage.get(), [0.45, MENU, 1.45], [0, 1, 0], "clamp"),
  }));
  const cameraStyle = useAnimatedStyle(() => ({
    opacity: interpolate(stage.get(), [1.5, CAMERA], [0, 1], "clamp"),
  }));

  const choose = async (source: AttachmentSource) => {
    analytics.capture("attachment_source_selected", { source });
    if (source === "camera") {
      setMode("camera");
      setCameraMounted(true);
      animateTo(CAMERA);
      return;
    }
    // System pickers present over the app, so the overlay leaves first. The composer takes its
    // focus back once the picker finishes, whatever the outcome.
    input.holdComposerFocus();
    close({ immediate: true });
    const result = source === "photos" ? await sources.pickPhotos() : await sources.pickFiles();
    if (result.status === "failed") Alert.alert(result.title, result.message);
    if (input.takeHeldComposerFocus()) input.composerInputRef.current?.focus();
  };

  const backToMenu = () => {
    setMode("menu");
    animateTo(MENU, () => setCameraMounted(false));
  };

  const menuDisabled = sources.remaining === 0;

  return (
    <OverKeyboardView visible={presented !== null}>
      <View className="flex-1" pointerEvents={closing ? "none" : "auto"}>
        <Pressable
          accessibilityLabel="Close attachment options"
          accessibilityRole="button"
          className="absolute inset-0"
          onPress={() => close()}
        />
        {/* OverKeyboardView draws in its own window above the keyboard. Liquid Glass only samples
            its own window, so it would render clear here; the shell uses an opaque surface. */}
        <Reanimated.View
          className="absolute overflow-hidden border border-foreground/10 border-continuous bg-card dark:bg-secondary"
          style={shellStyle}
        >
          <Reanimated.View
            accessibilityViewIsModal={mode === "menu"}
            className="absolute top-0 left-0"
            pointerEvents={mode === "menu" ? "auto" : "none"}
            style={[{ width: MENU_WIDTH, height: MENU_HEIGHT, padding: MENU_PADDING }, menuStyle]}
          >
            {MENU_ITEMS.map((item) => (
              <Pressable
                accessibilityHint={
                  menuDisabled ? "A message holds up to five attachments." : undefined
                }
                accessibilityLabel={item.label}
                accessibilityRole="button"
                accessibilityState={{ disabled: menuDisabled }}
                className={
                  menuDisabled
                    ? "flex-row items-center gap-3 rounded-[20px] px-3.5 opacity-40"
                    : "flex-row items-center gap-3 rounded-[20px] px-3.5 active:bg-foreground/10"
                }
                disabled={menuDisabled}
                key={item.source}
                onPress={() => void choose(item.source)}
                style={{ height: MENU_ROW_HEIGHT }}
              >
                <StyledSymbolView
                  name={item.icon}
                  size={20}
                  style={{ width: 26, height: 26 }}
                  tintColorClassName="accent-foreground"
                  weight="medium"
                />
                <Text className="text-[17px] text-foreground">{item.label}</Text>
              </Pressable>
            ))}
          </Reanimated.View>
          {cameraMounted ? (
            <Reanimated.View
              accessibilityViewIsModal={mode === "camera"}
              className="absolute top-0 left-0"
              pointerEvents={mode === "camera" ? "auto" : "none"}
              style={[{ width: cameraFrame.width, height: cameraFrame.height }, cameraStyle]}
            >
              <CameraPanel
                active={mode === "camera" && isScreenFocused}
                onBack={backToMenu}
                onCaptured={() => close()}
                remaining={sources.remaining}
                takePhoto={sources.addCameraPhoto}
              />
            </Reanimated.View>
          ) : null}
        </Reanimated.View>
      </View>
    </OverKeyboardView>
  );
}
