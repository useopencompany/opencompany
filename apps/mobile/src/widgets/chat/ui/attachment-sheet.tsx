import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useUniwind } from "uniwind";
import { until } from "until-async";

import { PressableScale } from "@/shared/ui/pressable-scale";
import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { MAX_CHAT_ATTACHMENTS, validateComposerAttachments } from "../model/attachment-validation";
import {
  CHAT_MODELS,
  type ComposerAttachment,
  useChatComposer,
} from "../model/chat-composer-context";

interface AttachmentAction {
  label: string;
  icon: SFSymbol;
  onPress: () => void;
}

let nextAttachmentSequence = 0;

function createAttachmentId(uri: string): string {
  nextAttachmentSequence += 1;
  return `${Date.now()}-${nextAttachmentSequence}-${uri}`;
}

export default function AttachmentSheet() {
  const { theme } = useUniwind();
  const {
    addAttachments,
    attachments: currentAttachments,
    selectedModelId,
    selectModel,
  } = useChatComposer();

  const persistPickedAttachments = async (attachments: ComposerAttachment[]) => {
    const validation = validateComposerAttachments(currentAttachments.length, attachments);
    if (validation.error) {
      Alert.alert("Attachment Not Added", validation.error);
      return;
    }
    const [copyError] = await until(() => addAttachments(validation.valid));
    if (copyError) {
      Alert.alert("Attachment Not Added", "opencompany could not save that file on this device.");
      return;
    }
    router.back();
  };

  const pickPhotos = async () => {
    const [pickerError, result] = await until(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, MAX_CHAT_ATTACHMENTS - currentAttachments.length),
        quality: 0.9,
      }),
    );

    if (pickerError) {
      Alert.alert("Unable to Open Photos", "opencompany could not open your photo library.");
      return;
    }

    if (result.canceled) {
      return;
    }

    await persistPickedAttachments(
      result.assets.map((asset) => ({
        id: createAttachmentId(asset.uri),
        kind: "image",
        uri: asset.uri,
        name: asset.fileName ?? "Photo",
        ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
        ...(asset.fileSize ? { size: asset.fileSize } : {}),
        width: asset.width,
        height: asset.height,
      })),
    );
  };

  const pickFiles = async () => {
    const [pickerError, result] = await until(() =>
      DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: "*/*",
      }),
    );

    if (pickerError) {
      Alert.alert("Unable to Open Files", "opencompany could not open the file picker.");
      return;
    }

    if (result.canceled) {
      return;
    }

    const attachments: ComposerAttachment[] = result.assets.map((asset) => ({
      id: createAttachmentId(asset.uri),
      kind: asset.mimeType?.startsWith("image/") ? "image" : "file",
      uri: asset.uri,
      name: asset.name,
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
      ...(asset.size ? { size: asset.size } : {}),
    }));

    await persistPickedAttachments(attachments);
  };

  const attachmentActions: AttachmentAction[] = [
    {
      label: "Camera",
      icon: "camera",
      onPress: () => router.replace("./camera"),
    },
    { label: "Photos", icon: "photo.on.rectangle", onPress: () => void pickPhotos() },
    { label: "Files", icon: "paperclip", onPress: () => void pickFiles() },
  ];

  return (
    <ScrollView
      bounces={false}
      contentContainerClassName="px-5 pt-7 pb-2"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="flex-row gap-3">
        {attachmentActions.map((action) => (
          <PressableScale
            accessibilityLabel={action.label}
            className="h-[84px] flex-1 items-center justify-center gap-2 rounded-[17px] border-continuous bg-secondary"
            key={action.label}
            onPress={action.onPress}
          >
            <StyledSymbolView
              name={action.icon}
              size={25}
              tintColorClassName="accent-secondary-foreground"
              weight="medium"
            />
            <Text className="font-medium text-[17px] text-secondary-foreground leading-[21px] tracking-[-0.2px]">
              {action.label}
            </Text>
          </PressableScale>
        ))}
      </View>

      <Text className="px-1 pt-[25px] pb-2 text-[17px] text-muted-foreground leading-[22px]">
        Models
      </Text>

      <View className="gap-0.5">
        {CHAT_MODELS.map((model) => {
          const selected = model.id === selectedModelId;
          const logoSource = theme === "dark" ? model.logo.dark : model.logo.light;

          return (
            <Pressable
              accessibilityLabel={`${model.label}, ${model.provider}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              className="min-h-[58px] flex-row items-center rounded-[14px] border-continuous px-1"
              key={model.id}
              onPress={() => {
                selectModel(model.id);
                router.back();
              }}
            >
              <View className="w-[30px] items-center justify-center">
                {selected ? (
                  <StyledSymbolView
                    name="checkmark"
                    size={19}
                    tintColorClassName="accent-muted-foreground"
                    weight="medium"
                  />
                ) : null}
              </View>
              <View className="mr-3 w-9 items-center justify-center">
                <StyledImage
                  accessibilityIgnoresInvertColors
                  className="size-6 opacity-55"
                  contentFit="contain"
                  source={logoSource}
                />
              </View>
              <View className="flex-1 py-2">
                <Text className="font-medium text-[16px] text-foreground leading-5 tracking-[-0.2px]">
                  {model.label}
                </Text>
                <Text className="text-[13px] text-muted-foreground leading-[17px] tracking-[-0.1px]">
                  {model.provider}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
