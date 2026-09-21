import { CHAT_IMAGE_MAX_BYTES } from "@opencompany/core/attachments";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import type { ComposerAttachment } from "./chat-composer-context";

const HEIC_MEDIA_TYPES = new Set(["image/heic", "image/heif"]);
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);
const INITIAL_JPEG_QUALITY = 0.9;
const MINIMUM_JPEG_QUALITY = 0.65;
const MAXIMUM_RESIZE_ATTEMPTS = 4;

const fileExtension = (name: string): string => name.split(".").at(-1)?.toLowerCase() ?? "";

const isHeicAttachment = (attachment: ComposerAttachment): boolean =>
  HEIC_MEDIA_TYPES.has(attachment.mimeType?.toLowerCase() ?? "") ||
  HEIC_EXTENSIONS.has(fileExtension(attachment.name));

const jpegFilename = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const basename = dot > 0 ? name.slice(0, dot) : name;
  return `${basename || "Photo"}.jpg`;
};

const renderJpeg = async ({
  compress,
  sourceUri,
  width,
}: {
  compress: number;
  sourceUri: string;
  width?: number;
}) => {
  const context = ImageManipulator.manipulate(sourceUri);
  if (width) context.resize({ width });
  const image = await context.renderAsync();
  try {
    return await image.saveAsync({ compress, format: SaveFormat.JPEG });
  } finally {
    image.release();
    context.release();
  }
};

export const prepareImageAttachment = async (
  attachment: ComposerAttachment,
): Promise<ComposerAttachment> => {
  if (!isHeicAttachment(attachment)) return attachment;

  let result = await renderJpeg({
    compress: INITIAL_JPEG_QUALITY,
    sourceUri: attachment.uri,
  });
  let size = new File(result.uri).size ?? 0;

  for (
    let attempt = 0;
    size > CHAT_IMAGE_MAX_BYTES && attempt < MAXIMUM_RESIZE_ATTEMPTS;
    attempt += 1
  ) {
    const ratio = Math.min(0.9, Math.sqrt(CHAT_IMAGE_MAX_BYTES / size) * 0.9);
    const width = Math.max(1, Math.floor(result.width * ratio));
    const compress = Math.max(MINIMUM_JPEG_QUALITY, INITIAL_JPEG_QUALITY - (attempt + 1) * 0.08);
    result = await renderJpeg({ compress, sourceUri: result.uri, width });
    size = new File(result.uri).size ?? 0;
  }

  return {
    ...attachment,
    kind: "image",
    uri: result.uri,
    name: jpegFilename(attachment.name),
    mimeType: "image/jpeg",
    size,
    width: result.width,
    height: result.height,
  };
};

export const prepareImageAttachments = async (
  attachments: ComposerAttachment[],
): Promise<ComposerAttachment[]> => {
  const prepared: ComposerAttachment[] = [];
  for (const attachment of attachments) prepared.push(await prepareImageAttachment(attachment));
  return prepared;
};
