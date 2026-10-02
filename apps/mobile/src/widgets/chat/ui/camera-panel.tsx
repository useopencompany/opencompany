import { type CameraView, type FlashMode, useCameraPermissions } from "expo-camera";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  type StyleProp,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Reanimated, {
  type AnimatedStyle,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  withSpring,
} from "react-native-reanimated";
import { until } from "until-async";
import { analytics, captureError } from "@/shared/lib/analytics";
import { useReducedTransparency } from "@/shared/lib/use-reduced-transparency";
import { StyledAnimatedSymbol } from "@/shared/ui/animated-symbol";
import { StyledCameraView } from "@/shared/ui/styled-camera-view";
import { StyledGlassContainer, StyledGlassView } from "@/shared/ui/styled-glass-view";

export interface CapturedPicture {
  uri: string;
  width: number;
  height: number;
}

const FLASH_SEQUENCE: FlashMode[] = ["off", "auto", "on"];
const FLASH_SYMBOLS: Record<"off" | "auto" | "on", SFSymbol> = {
  off: "bolt.slash.fill",
  auto: "bolt.badge.automatic.fill",
  on: "bolt.fill",
};
const FLASH_LABELS = { off: "Off", auto: "Auto", on: "On" } as const;
const CONTROL_SIZE = 48;
const CONTROL_GAP = 12;
const SHUTTER_SIZE = 74;
// Flash and Flip slide out of the options button inside one glass container, so their glass
// stretches out of it and merges back in on the way down.
const OPTIONS_SPRING = { duration: 320, dampingRatio: 0.82 };
const GLASS_REVEAL_SECONDS = 0.2;

type CameraFailure = { kind: "unavailable" } | { kind: "capture"; message: string };

function GlassControl({
  accessibilityLabel,
  disabled = false,
  expanded,
  glass,
  iconStyle,
  onPress,
  symbol,
  visible = true,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  expanded?: boolean;
  glass: boolean;
  iconStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
  onPress: () => void;
  symbol: SFSymbol;
  visible?: boolean;
}) {
  const reducedTransparency = useReducedTransparency();
  return (
    <Pressable
      accessibilityElementsHidden={!visible}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded }}
      disabled={disabled || !visible}
      hitSlop={6}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      onPress={onPress}
      style={{ width: CONTROL_SIZE, height: CONTROL_SIZE }}
    >
      {reducedTransparency ? (
        <View
          className={
            visible
              ? "absolute inset-0 rounded-full border border-white/25 bg-neutral-800"
              : "absolute inset-0 rounded-full"
          }
        />
      ) : (
        // A hidden control keeps its glass: it sits under the options button inside the same
        // glass container, so its glass merges into that button and stretches out when shown.
        <StyledGlassView
          className="absolute inset-0 rounded-full"
          colorScheme="dark"
          glassEffectStyle={{
            style: glass ? "regular" : "none",
            animate: true,
            animationDuration: GLASS_REVEAL_SECONDS,
          }}
          isInteractive
        />
      )}
      <Reanimated.View
        className="flex-1 items-center justify-center"
        pointerEvents="none"
        style={iconStyle}
      >
        <StyledAnimatedSymbol
          name={symbol}
          size={19}
          speed={2}
          style={{ opacity: disabled ? 0.4 : 1 }}
          tintColor="#ffffff"
          weight="semibold"
        />
      </Reanimated.View>
    </Pressable>
  );
}

/**
 * A secondary control that slides between its own slot and the options button below it. Its
 * icon fades in once the glass has pulled away from the button.
 */
function OptionControl({
  expanded,
  slot,
  ...control
}: Omit<Parameters<typeof GlassControl>[0], "iconStyle" | "visible"> & {
  expanded: boolean;
  slot: number;
}) {
  const reducedMotion = useReducedMotion();
  const offset = slot * (CONTROL_SIZE + CONTROL_GAP);
  const progress = useDerivedValue(() => {
    const target = expanded ? 1 : 0;
    return reducedMotion ? target : withSpring(target, OPTIONS_SPRING);
  });
  const slotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset * (1 - progress.get()) }],
  }));
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0.35, 0.9], [0, 1], "clamp"),
  }));
  return (
    <Reanimated.View
      className="absolute left-0"
      pointerEvents={expanded ? "auto" : "none"}
      style={[{ bottom: offset }, slotStyle]}
    >
      <GlassControl {...control} iconStyle={iconStyle} visible={expanded} />
    </Reanimated.View>
  );
}

/**
 * The live camera inside the attachment overlay. It opens on the rear camera with flash off and
 * stops whenever it is not the active panel or the app leaves the foreground. A capture freezes
 * the preview on the shutter press and hands the photo over once the camera delivers it.
 */
export function CameraPanel({
  active,
  glass,
  onBack,
  onCaptured,
  remaining,
}: {
  active: boolean;
  /** Whether the controls show their glass. Off while the panel fades in or out. */
  glass: boolean;
  onBack: () => void;
  onCaptured: (picture: CapturedPicture) => void;
  remaining: number;
}) {
  const reducedTransparency = useReducedTransparency();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [failure, setFailure] = useState<CameraFailure | null>(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"off" | "auto" | "on">("off");
  const [controlsExpanded, setControlsExpanded] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  // Ask once when the panel opens. A refusal the system will not ask again leads to Settings.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission?.granted, permission?.canAskAgain]);

  const running = active && foreground && Boolean(permission?.granted);
  // A stopped session has to report ready again before the shutter works.
  useEffect(() => {
    if (!running) setReady(false);
  }, [running]);

  const setPreviewPaused = (camera: CameraView, paused: boolean) =>
    void until(() => (paused ? camera.pausePreview() : camera.resumePreview())).then(([error]) => {
      if (error) captureError("camera_preview_toggle_failed", error, { paused });
    });

  const capture = async () => {
    const camera = cameraRef.current;
    if (!camera || capturing || !ready || remaining === 0) return;
    setCapturing(true);
    setFailure(null);
    // Hold the frame the shutter caught while the camera finishes the photo, so the press feels
    // instant. The held frame is what flies into the composer.
    setPreviewPaused(camera, true);
    const [captureError_, picture] = await until(async () => {
      const result = await camera.takePictureAsync({ quality: 0.85 });
      if (!result) throw new Error("The camera returned no photo.");
      return result;
    });
    if (captureError_) {
      captureError("camera_capture_failed", captureError_);
      setPreviewPaused(camera, false);
      setFailure({ kind: "capture", message: "The photo could not be taken. Try again." });
      setCapturing(false);
      return;
    }
    analytics.capture("camera_photo_captured", { facing, flash });
    onCaptured({ uri: picture.uri, width: picture.width, height: picture.height });
  };

  const nextFlash = FLASH_SEQUENCE[(FLASH_SEQUENCE.indexOf(flash) + 1) % 3] as typeof flash;
  const shutterDisabled = !running || !ready || capturing || remaining === 0;

  let status: {
    title: string;
    message: string;
    action?: { label: string; onPress: () => void };
  } | null = null;
  if (!permission) status = null;
  else if (!permission.granted)
    status = permission.canAskAgain
      ? { title: "Camera Access", message: "Allow camera access to take a photo." }
      : {
          title: "Camera Access Is Off",
          message: "Turn on camera access for opencompany in Settings to take photos here.",
          action: { label: "Open Settings", onPress: () => void Linking.openSettings() },
        };
  else if (failure?.kind === "unavailable")
    status = {
      title: "Camera Unavailable",
      message: "This device has no camera opencompany can use right now.",
    };

  return (
    <View className="flex-1 overflow-hidden bg-black">
      {permission?.granted && failure?.kind !== "unavailable" ? (
        <StyledCameraView
          active={running}
          animateShutter
          className="absolute inset-0"
          facing={facing}
          flash={flash}
          mode="picture"
          onCameraReady={() => setReady(true)}
          onMountError={(event) => {
            captureError("camera_mount_failed", new Error(event.message));
            setFailure({ kind: "unavailable" });
          }}
          ref={cameraRef}
        />
      ) : null}

      {status ? (
        <View className="absolute inset-0 items-center justify-center gap-2 px-8 pb-24">
          <Text className="text-center font-semibold text-[17px] text-white">{status.title}</Text>
          <Text className="text-center text-[15px] text-white/70 leading-5">{status.message}</Text>
          {status.action ? (
            <Pressable
              accessibilityRole="button"
              className="mt-2 rounded-full bg-white px-4 py-2 active:opacity-70"
              onPress={status.action.onPress}
            >
              <Text className="font-semibold text-[15px] text-black">{status.action.label}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {failure?.kind === "capture" ? (
        <View
          accessibilityLiveRegion="polite"
          className="absolute top-4 right-4 left-4 items-center"
          pointerEvents="none"
        >
          <Text className="overflow-hidden rounded-full bg-black/70 px-3 py-1.5 text-center text-[14px] text-white">
            {failure.message}
          </Text>
        </View>
      ) : null}

      {/* Controls leave with the shutter press, so only the held frame flies to the composer. */}
      <View
        className={
          capturing
            ? "hidden"
            : "absolute right-0 bottom-0 left-0 flex-row items-center justify-between px-5 pb-5"
        }
      >
        <GlassControl
          accessibilityLabel="Back to attachment options"
          glass={glass}
          onPress={onBack}
          symbol="chevron.left"
        />
        <Pressable
          accessibilityHint={
            remaining === 0 ? "A message holds up to five attachments." : undefined
          }
          accessibilityLabel="Take photo"
          accessibilityRole="button"
          accessibilityState={{ disabled: shutterDisabled }}
          className="items-center justify-center"
          disabled={shutterDisabled}
          onPress={() => void capture()}
          style={{ width: SHUTTER_SIZE, height: SHUTTER_SIZE }}
        >
          {reducedTransparency ? (
            <View className="absolute inset-0 rounded-full border-4 border-white" />
          ) : (
            <StyledGlassView
              className="absolute inset-0 rounded-full"
              colorScheme="dark"
              glassEffectStyle={{
                style: glass ? "regular" : "none",
                animate: true,
                animationDuration: GLASS_REVEAL_SECONDS,
              }}
              isInteractive
            />
          )}
          <View
            className="size-[60px] rounded-full bg-white"
            style={{ opacity: shutterDisabled ? 0.45 : 1 }}
          />
        </Pressable>
        {/* Sized like one control so the options button lines up with Back and the shutter. The
            container rises above it for Flash and Flip. */}
        <View style={{ width: CONTROL_SIZE, height: CONTROL_SIZE }}>
          <StyledGlassContainer
            className="absolute bottom-0 left-0"
            spacing={CONTROL_GAP + 4}
            style={{
              width: CONTROL_SIZE,
              height: CONTROL_SIZE * 3 + CONTROL_GAP * 2,
            }}
            pointerEvents="box-none"
          >
            <OptionControl
              glass={glass}
              accessibilityLabel={`Flash: ${FLASH_LABELS[flash]}`}
              expanded={controlsExpanded}
              onPress={() => setFlash(nextFlash)}
              slot={2}
              symbol={FLASH_SYMBOLS[flash]}
            />
            <OptionControl
              glass={glass}
              accessibilityLabel={
                facing === "back" ? "Switch to front camera" : "Switch to rear camera"
              }
              expanded={controlsExpanded}
              onPress={() => setFacing(facing === "back" ? "front" : "back")}
              slot={1}
              symbol={
                facing === "back"
                  ? "arrow.triangle.2.circlepath.camera"
                  : "arrow.triangle.2.circlepath.camera.fill"
              }
            />
            <View className="absolute bottom-0 left-0">
              <GlassControl
                glass={glass}
                accessibilityLabel={
                  controlsExpanded ? "Hide camera options" : "More camera options"
                }
                expanded={controlsExpanded}
                onPress={() => setControlsExpanded(!controlsExpanded)}
                symbol={controlsExpanded ? "xmark" : "ellipsis"}
              />
            </View>
          </StyledGlassContainer>
        </View>
      </View>
    </View>
  );
}
