import { type CameraView, type FlashMode, useCameraPermissions } from "expo-camera";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, Text, View } from "react-native";
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
} from "react-native-reanimated";
import { until } from "until-async";
import { analytics, captureError } from "@/shared/lib/analytics";
import { useReducedTransparency } from "@/shared/lib/use-reduced-transparency";
import { StyledAnimatedSymbol } from "@/shared/ui/animated-symbol";
import { StyledCameraView } from "@/shared/ui/styled-camera-view";
import { StyledGlassContainer, StyledGlassView } from "@/shared/ui/styled-glass-view";
import type { AttachmentResult } from "../model/use-attachment-sources";

const FLASH_SEQUENCE: FlashMode[] = ["off", "auto", "on"];
const FLASH_SYMBOLS: Record<"off" | "auto" | "on", SFSymbol> = {
  off: "bolt.slash.fill",
  auto: "bolt.badge.automatic.fill",
  on: "bolt.fill",
};
const FLASH_LABELS = { off: "Off", auto: "Auto", on: "On" } as const;
const CONTROL_SIZE = 48;
const REVEAL_TIMING = { duration: 260, easing: Easing.bezier(0.22, 1, 0.36, 1) };

type CameraFailure = { kind: "unavailable" } | { kind: "capture"; message: string };

function GlassCircle({
  accessibilityLabel,
  disabled = false,
  expanded,
  onPress,
  symbol,
  visible = true,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  expanded?: boolean;
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
        // Glass fades by switching its effect style. Fading a glass view's opacity to zero stops
        // it from rendering at all. A faint fill keeps the button visible over a dark scene.
        <>
          <View
            className={
              visible
                ? "absolute inset-0 rounded-full bg-white/15"
                : "absolute inset-0 rounded-full"
            }
          />
          <StyledGlassView
            className="absolute inset-0 rounded-full"
            colorScheme="dark"
            glassEffectStyle={{ style: visible ? "regular" : "none", animate: true }}
            isInteractive
          />
        </>
      )}
      <View className="flex-1 items-center justify-center">
        <StyledAnimatedSymbol
          name={symbol}
          size={19}
          style={{ opacity: visible ? (disabled ? 0.4 : 1) : 0 }}
          tintColor="#ffffff"
          weight="semibold"
        />
      </View>
    </Pressable>
  );
}

/**
 * The live camera inside the attachment overlay. It opens on the rear camera with flash off and
 * stops whenever it is not the active panel or the app leaves the foreground.
 */
export function CameraPanel({
  active,
  onBack,
  onCaptured,
  remaining,
  takePhoto,
}: {
  active: boolean;
  onBack: () => void;
  onCaptured: () => void;
  remaining: number;
  takePhoto: (picture: { uri: string; width: number; height: number }) => Promise<AttachmentResult>;
}) {
  const reducedMotion = useReducedMotion();
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

  const revealStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: reducedMotion
          ? 0
          : withTiming(controlsExpanded ? 0 : CONTROL_SIZE, REVEAL_TIMING),
      },
    ],
  }));

  const capture = async () => {
    if (!cameraRef.current || capturing || !ready || remaining === 0) return;
    setCapturing(true);
    setFailure(null);
    const [captureError_, picture] = await until(async () => {
      const result = await cameraRef.current?.takePictureAsync({ quality: 0.85 });
      if (!result) throw new Error("The camera returned no photo.");
      return result;
    });
    if (captureError_) {
      captureError("camera_capture_failed", captureError_);
      setFailure({ kind: "capture", message: "The photo could not be taken. Try again." });
      setCapturing(false);
      return;
    }
    const result = await takePhoto(picture);
    setCapturing(false);
    if (result.status === "failed") {
      setFailure({ kind: "capture", message: result.message });
      return;
    }
    analytics.capture("camera_photo_captured", { facing, flash });
    onCaptured();
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
      ) : !permission || (running && !ready) ? (
        <View className="absolute inset-0 items-center justify-center pb-24">
          <ActivityIndicator color="#ffffff" />
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

      <View className="absolute right-0 bottom-0 left-0 flex-row items-end justify-between px-5 pb-5">
        <GlassCircle
          accessibilityLabel="Back to attachment options"
          onPress={onBack}
          symbol="chevron.left"
        />
        <Pressable
          accessibilityHint={
            remaining === 0 ? "A message holds up to five attachments." : undefined
          }
          accessibilityLabel={capturing ? "Saving photo" : "Take photo"}
          accessibilityRole="button"
          accessibilityState={{ disabled: shutterDisabled, busy: capturing }}
          className="size-[74px] items-center justify-center rounded-full border-4 border-white"
          disabled={shutterDisabled}
          onPress={() => void capture()}
          style={{ opacity: shutterDisabled && !capturing ? 0.45 : 1 }}
        >
          <View className="size-[60px] items-center justify-center rounded-full bg-white">
            {capturing ? <ActivityIndicator color="#000000" /> : null}
          </View>
        </Pressable>
        <View className="items-center">
          <Reanimated.View style={revealStyle}>
            <StyledGlassContainer className="items-center gap-3 pb-3" spacing={12}>
              <GlassCircle
                accessibilityLabel={`Flash: ${FLASH_LABELS[flash]}`}
                onPress={() => setFlash(nextFlash)}
                symbol={FLASH_SYMBOLS[flash]}
                visible={controlsExpanded}
              />
              <GlassCircle
                accessibilityLabel={
                  facing === "back" ? "Switch to front camera" : "Switch to rear camera"
                }
                onPress={() => setFacing(facing === "back" ? "front" : "back")}
                symbol={
                  facing === "back"
                    ? "arrow.triangle.2.circlepath.camera"
                    : "arrow.triangle.2.circlepath.camera.fill"
                }
                visible={controlsExpanded}
              />
            </StyledGlassContainer>
          </Reanimated.View>
          <GlassCircle
            accessibilityLabel={controlsExpanded ? "Hide camera options" : "More camera options"}
            expanded={controlsExpanded}
            onPress={() => setControlsExpanded(!controlsExpanded)}
            symbol={controlsExpanded ? "xmark" : "ellipsis"}
          />
        </View>
      </View>
    </View>
  );
}
