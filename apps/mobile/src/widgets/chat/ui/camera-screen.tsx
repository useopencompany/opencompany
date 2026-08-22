import { type CameraType, CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { until } from "until-async";

import { StyledCameraView } from "@/shared/ui/styled-camera-view";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useChatComposer } from "../model/chat-composer-context";

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const cameraRef = useRef<CameraView>(null);
  const hasRequestedPermissionRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>("back");
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const { addAttachments } = useChatComposer();

  useEffect(() => {
    if (
      !permission ||
      permission.granted ||
      !permission.canAskAgain ||
      hasRequestedPermissionRef.current
    ) {
      return;
    }

    hasRequestedPermissionRef.current = true;
    void until(requestPermission).then(([permissionError]) => {
      if (permissionError) {
        Alert.alert("Camera Unavailable", "OpenCompany could not request camera access.");
      }
    });
  }, [permission, requestPermission]);

  const takePhoto = async () => {
    const camera = cameraRef.current;
    if (!camera || isTakingPhoto) {
      return;
    }

    setIsTakingPhoto(true);
    const [captureError, photo] = await until(() => camera.takePictureAsync({ quality: 0.9 }));

    if (captureError) {
      setIsTakingPhoto(false);
      Alert.alert("Unable to Take Photo", "OpenCompany could not capture this photo.");
      return;
    }

    addAttachments([
      {
        id: `camera-${Date.now()}-${photo.uri}`,
        kind: "image",
        uri: photo.uri,
        name: `Photo ${new Date().toLocaleTimeString()}.jpg`,
        mimeType: "image/jpeg",
        width: photo.width,
        height: photo.height,
      },
    ]);
    router.back();
  };

  if (!permission) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator colorClassName="accent-white" size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View className="flex-1 items-center justify-center gap-5 bg-black px-8">
        <StyledSymbolView
          name="camera.fill"
          size={42}
          tintColorClassName="accent-white"
          weight="regular"
        />
        <View className="items-center gap-2">
          <Text className="text-center font-semibold text-[20px] text-white leading-6">
            Camera access is required
          </Text>
          <Text className="text-center text-[16px] text-white/65 leading-[21px]">
            Allow camera access to take a photo and attach it to your message.
          </Text>
        </View>
        {permission.canAskAgain ? (
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-white px-5 py-3 active:opacity-65"
            onPress={() => void requestPermission()}
          >
            <Text className="font-semibold text-[16px] text-black">Allow Camera</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          className="px-5 py-3 active:opacity-65"
          onPress={() => router.back()}
        >
          <Text className="font-medium text-[16px] text-white">Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      {isFocused ? (
        <StyledCameraView
          className="flex-1"
          facing={facing}
          mirror={facing === "front"}
          ref={cameraRef}
        />
      ) : null}

      <View
        className="absolute right-0 left-0 flex-row items-center justify-between px-5"
        style={{ top: insets.top + 12 }}
      >
        <Pressable
          accessibilityLabel="Close camera"
          accessibilityRole="button"
          className="h-11 w-11 items-center justify-center rounded-full bg-black/45 active:opacity-65"
          onPress={() => router.back()}
        >
          <StyledSymbolView
            name="xmark"
            size={19}
            tintColorClassName="accent-white"
            weight="semibold"
          />
        </Pressable>

        <Pressable
          accessibilityLabel="Switch camera"
          accessibilityRole="button"
          className="h-11 w-11 items-center justify-center rounded-full bg-black/45 active:opacity-65"
          onPress={() =>
            setFacing((currentFacing) => (currentFacing === "back" ? "front" : "back"))
          }
        >
          <StyledSymbolView
            name="arrow.triangle.2.circlepath.camera"
            size={21}
            tintColorClassName="accent-white"
            weight="medium"
          />
        </Pressable>
      </View>

      <View className="absolute right-0 left-0 items-center" style={{ bottom: insets.bottom + 28 }}>
        <Pressable
          accessibilityLabel="Take photo"
          accessibilityRole="button"
          className="h-[78px] w-[78px] items-center justify-center rounded-full border-[5px] border-white active:opacity-65"
          disabled={isTakingPhoto}
          onPress={() => void takePhoto()}
        >
          <View className="h-[60px] w-[60px] rounded-full bg-white" />
        </Pressable>
      </View>
    </View>
  );
}
