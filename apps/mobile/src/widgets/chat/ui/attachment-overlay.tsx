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
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { until } from "until-async";
import { analytics, captureError } from "@/shared/lib/analytics";
import { useReducedTransparency } from "@/shared/lib/use-reduced-transparency";
import { StyledGlassView } from "@/shared/ui/styled-glass-view";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useChatInputController } from "../model/chat-input-controller";
import { type AttachmentSource, useAttachmentSources } from "../model/use-attachment-sources";
import { prewarmPhotoPicker } from "../native/photo-picker-prewarm";
import { type AttachmentAnchor, COMPOSER_HORIZONTAL_MARGIN } from "./ChatComposer";
import { CameraPanel, type CapturedPicture } from "./camera-panel";

const MENU_WIDTH = 216;
const MENU_ROW_HEIGHT = 50;
const MENU_PADDING = 6;
const MENU_HEIGHT = MENU_ROW_HEIGHT * 3 + MENU_PADDING * 2;
const CAMERA_HEIGHT_RATIO = 0.6;
const EDGE_GAP = 8;
const TIMING = { duration: 280, easing: Easing.bezier(0.22, 1, 0.36, 1) };
// Closing is shorter than opening: the user has already decided to leave. A gentle ease-out
// keeps the fold back into the plus button visible instead of snapping most of the way in the
// first frames.
const CLOSE_TIMING = { duration: 200, easing: Easing.bezier(0.25, 0.46, 0.45, 0.94) };
// The glass dissolves through the back half of the close and is gone just before the fold ends,
// so no glass is left sitting on the plus button.
const DISSOLVE_START = 80;
const DISSOLVE_DURATION = 100;
// A captured photo flies from the camera into its place in the composer.
const LANDING_SPRING = { duration: 460, dampingRatio: 0.92 };
const PREVIEW_RADIUS = 16;
const MENU_RADIUS = 26;
const CAMERA_RADIUS = 34;

// Stages the one shell moves between: folded into the plus button, the menu, the camera panel.
const COLLAPSED = 0;
const MENU = 1;
const CAMERA = 2;

const MENU_ITEMS: { source: AttachmentSource; label: string; icon: SFSymbol }[] = [
  { source: "camera", label: "Camera", icon: "camera" },
  { source: "photos", label: "Photos", icon: "photo.on.rectangle" },
  { source: "files", label: "Files", icon: "paperclip" },
];

const AnimatedGlassView = Reanimated.createAnimatedComponent(StyledGlassView);

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
  anchor: AttachmentAnchor | null;
  isScreenFocused: boolean;
  onClosed: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const reducedTransparency = useReducedTransparency();
  const input = useChatInputController();
  const sources = useAttachmentSources();
  const [presented, setPresented] = useState<AttachmentAnchor | null>(null);
  const [mode, setMode] = useState<"menu" | "camera">("menu");
  const [cameraMounted, setCameraMounted] = useState(false);
  // Leaving goes straight from the menu or camera to the plus button, or for a captured photo,
  // to its place in the composer.
  const [exit, setExit] = useState<{
    from: "menu" | "camera";
    to: "button" | "attachment";
  } | null>(null);
  const [dissolved, setDissolved] = useState(false);
  const stage = useSharedValue(COLLAPSED);
  const exitProgress = useSharedValue(0);

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
    if (sources.remaining > 0)
      void until(prewarmPhotoPicker).then(([error]) => {
        if (error) captureError("photo_picker_prewarm_failed", error);
      });
    setPresented(anchor);
    setMode("menu");
    setExit(null);
    setDissolved(false);
    stage.set(COLLAPSED);
    exitProgress.set(0);
    animateTo(MENU);
  }, [anchor]);

  const finishClose = () => {
    setPresented(null);
    setCameraMounted(false);
    setExit(null);
    setDissolved(false);
    onClosed();
  };
  const leave = (to: "button" | "attachment") => {
    if (!presented || exit) return;
    if (reducedMotion) {
      stage.set(COLLAPSED);
      finishClose();
      return;
    }
    setExit({ from: mode, to });
  };
  const close = ({ immediate = false }: { immediate?: boolean } = {}) => {
    if (immediate && presented) {
      stage.set(COLLAPSED);
      finishClose();
      return;
    }
    leave("button");
  };
  // Starts once the exit has rendered, so the shell's animated style already reads its frames.
  useEffect(() => {
    if (!exit) return;
    const onFinish = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(finishClose);
    };
    exitProgress.set(0);
    exitProgress.set(
      exit.to === "button"
        ? withTiming(1, CLOSE_TIMING, onFinish)
        : withSpring(1, LANDING_SPRING, onFinish),
    );
    if (exit.to !== "button") return;
    const timeout = setTimeout(() => setDissolved(true), DISSOLVE_START);
    return () => clearTimeout(timeout);
  }, [exit]);

  const landPhoto = (picture: CapturedPicture) => {
    void until(() => sources.addCameraPhoto(picture)).then(([error, result]) => {
      if (error) captureError("attachment_add_failed", error, { source: "camera" });
      else if (result.status === "failed") Alert.alert(result.title, result.message);
    });
    leave("attachment");
  };

  // The screen losing focus, such as the sidebar opening, takes the overlay with it.
  useEffect(() => {
    if (!isScreenFocused && presented) close({ immediate: true });
  }, [isScreenFocused]);

  const emptyFrame = { x: 0, y: 0, width: 0, height: 0 };
  const anchorFrame = presented?.button ?? emptyFrame;
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
  const exitFrom = exit?.from === "camera" ? cameraFrame : menuFrame;
  const exitFromRadius = exit?.from === "camera" ? CAMERA_RADIUS : MENU_RADIUS;
  const exitTo =
    exit?.to === "attachment" ? (presented?.nextAttachment ?? emptyFrame) : anchorFrame;
  const exitToRadius = exit?.to === "attachment" ? PREVIEW_RADIUS : anchorFrame.height / 2;
  const toButton = exit?.to === "button";
  const fromMenu = exit?.from === "menu";

  const shellStyle = useAnimatedStyle(() => {
    if (exit) {
      const progress = exitProgress.get();
      return {
        left: interpolate(progress, [0, 1], [exitFrom.x, exitTo.x]),
        top: interpolate(progress, [0, 1], [exitFrom.y, exitTo.y]),
        width: interpolate(progress, [0, 1], [exitFrom.width, exitTo.width]),
        height: interpolate(progress, [0, 1], [exitFrom.height, exitTo.height]),
        borderRadius: interpolate(progress, [0, 1], [exitFromRadius, exitToRadius]),
      };
    }
    const value = stage.get();
    const stops = [COLLAPSED, MENU, CAMERA];
    return {
      left: interpolate(value, stops, [anchorFrame.x, menuFrame.x, cameraFrame.x]),
      top: interpolate(value, stops, [anchorFrame.y, menuFrame.y, cameraFrame.y]),
      width: interpolate(value, stops, [anchorFrame.width, menuFrame.width, cameraFrame.width]),
      height: interpolate(value, stops, [anchorFrame.height, menuFrame.height, cameraFrame.height]),
      borderRadius: interpolate(value, stops, [anchorFrame.height / 2, MENU_RADIUS, CAMERA_RADIUS]),
    };
  });
  // The camera clips to the shell's corners in its own layer. Clipping the glass view itself
  // would mask its effect.
  const cornerStyle = useAnimatedStyle(() => ({
    borderRadius: exit
      ? interpolate(exitProgress.get(), [0, 1], [exitFromRadius, exitToRadius])
      : interpolate(
          stage.get(),
          [COLLAPSED, MENU, CAMERA],
          [anchorFrame.height / 2, MENU_RADIUS, CAMERA_RADIUS],
        ),
  }));
  // A landing photo's held camera frame scales down with the shell and stays centered, filling it
  // the way the attachment preview fills its square.
  const cameraContentStyle = useAnimatedStyle(() => {
    const progress = exit?.to === "attachment" ? exitProgress.get() : 0;
    const width = interpolate(progress, [0, 1], [cameraFrame.width, exitTo.width]);
    const height = interpolate(progress, [0, 1], [cameraFrame.height, exitTo.height]);
    return {
      transform: [
        { translateX: (width - cameraFrame.width) / 2 },
        { translateY: (height - cameraFrame.height) / 2 },
        { scale: Math.max(width / cameraFrame.width, height / cameraFrame.height) },
      ],
    };
  });
  // Content fades out over the first half of a close, while the empty glass folds into the button.
  const opaqueShellStyle = useAnimatedStyle(() => ({
    opacity: toButton
      ? interpolate(exitProgress.get(), [0.5, 1], [1, 0], "clamp")
      : interpolate(stage.get(), [COLLAPSED, 0.35], [0, 1], "clamp"),
  }));
  const menuStyle = useAnimatedStyle(() => {
    if (!exit) return { opacity: interpolate(stage.get(), [0.45, MENU, 1.45], [0, 1, 0], "clamp") };
    if (!fromMenu) return { opacity: 0 };
    return { opacity: interpolate(exitProgress.get(), [0, 0.5], [1, 0], "clamp") };
  });
  const cameraStyle = useAnimatedStyle(() => {
    if (!exit) return { opacity: interpolate(stage.get(), [1.5, CAMERA], [0, 1], "clamp") };
    // A landing photo stays fully visible all the way into the composer.
    if (!toButton) return { opacity: 1 };
    return { opacity: interpolate(exitProgress.get(), [0, 0.5], [1, 0], "clamp") };
  });

  // The controls never fade in, so their glass is there as soon as the growing shell uncovers
  // them. They fade only on the way out, after their glass has switched off.
  const cameraControlsStyle = useAnimatedStyle(() => {
    if (exit && toButton)
      return { opacity: interpolate(exitProgress.get(), [0, 0.5], [1, 0], "clamp") };
    if (exit || mode === "camera") return { opacity: 1 };
    return { opacity: interpolate(stage.get(), [1.5, CAMERA], [0, 1], "clamp") };
  });

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

  const shellContent = (
    <>
      <Reanimated.View
        accessibilityViewIsModal={mode === "menu"}
        className="absolute top-0 left-0"
        pointerEvents={mode === "menu" ? "auto" : "none"}
        style={[{ width: MENU_WIDTH, height: MENU_HEIGHT, padding: MENU_PADDING }, menuStyle]}
      >
        {MENU_ITEMS.map((item) => (
          <Pressable
            accessibilityHint={menuDisabled ? "A message holds up to five attachments." : undefined}
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
          className="absolute inset-0 overflow-hidden border-continuous"
          pointerEvents={mode === "camera" ? "auto" : "none"}
          style={cornerStyle}
        >
          <Reanimated.View
            style={[{ width: cameraFrame.width, height: cameraFrame.height }, cameraContentStyle]}
          >
            <CameraPanel
              active={mode === "camera" && isScreenFocused}
              cameraStyle={cameraStyle}
              controlsStyle={cameraControlsStyle}
              glass={mode === "camera" && !exit}
              onBack={backToMenu}
              onCaptured={landPhoto}
              remaining={sources.remaining}
            />
          </Reanimated.View>
        </Reanimated.View>
      ) : null}
    </>
  );

  return (
    <OverKeyboardView visible={presented !== null}>
      <View className="flex-1" pointerEvents={exit ? "none" : "auto"}>
        <Pressable
          accessibilityLabel="Close attachment options"
          accessibilityRole="button"
          className="absolute inset-0"
          onPress={() => close()}
        />
        {reducedTransparency ? (
          <Reanimated.View
            className="absolute border border-border border-continuous bg-card"
            style={[shellStyle, opaqueShellStyle]}
          >
            {shellContent}
          </Reanimated.View>
        ) : (
          // The shell is one Liquid Glass surface. It materializes on the plus button, grows into
          // the menu or camera, and dissolves over the second half of its fold back into the
          // button. A landing photo covers it, so its glass dissolves at once. Glass never fades
          // through opacity, which would stop it rendering, so its style switches instead.
          <AnimatedGlassView
            className="absolute border-continuous"
            glassEffectStyle={{
              style: dissolved || exit?.to === "attachment" ? "none" : "regular",
              animate: !reducedMotion,
              animationDuration: (dissolved ? DISSOLVE_DURATION : TIMING.duration) / 1000,
            }}
            style={shellStyle}
          >
            {shellContent}
          </AnimatedGlassView>
        )}
      </View>
    </OverKeyboardView>
  );
}
