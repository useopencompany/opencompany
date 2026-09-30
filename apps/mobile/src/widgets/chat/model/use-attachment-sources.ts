import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { until } from "until-async";
import { analytics, captureError } from "@/shared/lib/analytics";
import { MAX_CHAT_ATTACHMENTS, validateComposerAttachments } from "./attachment-validation";
import { type ComposerAttachment, useChatComposer } from "./chat-composer-context";
import { prepareImageAttachments } from "./prepare-image-attachment";

export type AttachmentSource = "camera" | "photos" | "files";

/** How adding attachments ended. Failures carry a title and message for the caller to show. */
export type AttachmentResult =
  | { status: "added" }
  | { status: "canceled" }
  | { status: "failed"; title: string; message: string };

let nextAttachmentSequence = 0;

const createAttachmentId = (uri: string): string => {
  nextAttachmentSequence += 1;
  return `${Date.now()}-${nextAttachmentSequence}-${uri}`;
};

/**
 * Picks, validates, prepares, and durably stores draft attachments for the active conversation.
 * Every source ends in the same persistence path, so limits and conversions match.
 */
export function useAttachmentSources() {
  const { addAttachments, attachments: currentAttachments } = useChatComposer();
  const remaining = Math.max(0, MAX_CHAT_ATTACHMENTS - currentAttachments.length);

  const persist = async (attachments: ComposerAttachment[]): Promise<AttachmentResult> => {
    const [preparationError, prepared] = await until(() => prepareImageAttachments(attachments));
    if (preparationError) {
      captureError("attachment_prepare_failed", preparationError);
      return {
        status: "failed",
        title: "Attachment Not Added",
        message: "opencompany could not convert that image to JPEG.",
      };
    }
    const validation = validateComposerAttachments(currentAttachments.length, prepared);
    if (validation.error) {
      analytics.capture("attachment_add_rejected", { reason: "validation" });
      return { status: "failed", title: "Attachment Not Added", message: validation.error };
    }
    const [copyError] = await until(() => addAttachments(validation.valid));
    if (copyError) {
      captureError("attachment_add_failed", copyError);
      return {
        status: "failed",
        title: "Attachment Not Added",
        message: "opencompany could not save that file on this device.",
      };
    }
    analytics.capture("attachment_added", {
      count: validation.valid.length,
      kinds: [...new Set(validation.valid.map((attachment) => attachment.kind))],
    });
    return { status: "added" };
  };

  const pickPhotos = async (): Promise<AttachmentResult> => {
    const [pickerError, result] = await until(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, remaining),
        quality: 0.9,
      }),
    );
    if (pickerError) {
      captureError("attachment_source_failed", pickerError, { source: "photos" });
      return {
        status: "failed",
        title: "Unable to Open Photos",
        message: "opencompany could not open your photo library.",
      };
    }
    if (result.canceled) {
      analytics.capture("attachment_source_canceled", { source: "photos" });
      return { status: "canceled" };
    }
    return persist(
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

  const pickFiles = async (): Promise<AttachmentResult> => {
    const [pickerError, result] = await until(() =>
      DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: "*/*",
      }),
    );
    if (pickerError) {
      captureError("attachment_source_failed", pickerError, { source: "files" });
      return {
        status: "failed",
        title: "Unable to Open Files",
        message: "opencompany could not open the file picker.",
      };
    }
    if (result.canceled) {
      analytics.capture("attachment_source_canceled", { source: "files" });
      return { status: "canceled" };
    }
    return persist(
      result.assets.map((asset) => ({
        id: createAttachmentId(asset.uri),
        kind: asset.mimeType?.startsWith("image/") ? "image" : "file",
        uri: asset.uri,
        name: asset.name,
        ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
        ...(asset.size ? { size: asset.size } : {}),
      })),
    );
  };

  const addCameraPhoto = async (picture: {
    uri: string;
    width: number;
    height: number;
  }): Promise<AttachmentResult> => {
    const [sizeError, size] = await until(async () => new File(picture.uri).size ?? 0);
    if (sizeError) captureError("attachment_prepare_failed", sizeError, { source: "camera" });
    return persist([
      {
        id: createAttachmentId(picture.uri),
        kind: "image",
        uri: picture.uri,
        name: "Photo.jpg",
        mimeType: "image/jpeg",
        size: size ?? 0,
        width: picture.width,
        height: picture.height,
      },
    ]);
  };

  return { remaining, pickPhotos, pickFiles, addCameraPhoto };
}
