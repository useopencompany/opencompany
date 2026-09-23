import { imageSize } from "@fumari/image-size";
import type { FilePart, ModelMessage } from "ai";

// Only inspect local bytes already hydrated by the attachment layer. Estimation must never fetch
// arbitrary URLs or resolve provider file IDs. Bound parsing work even for malformed uploads.
const MAX_HEADER_BYTES = 512 * 1024;
const UNVERIFIED_MODEL_IMAGE_TOKENS = 40_000;

// Claude applies stricter dimension limits above 20 images and caps standard requests at 32 MB.
// Leave half that byte budget for text, tools and JSON framing. These bounds also apply to summary
// batches: small vision-token counts must not admit an unbounded base64 request body.
export function fitsImageRequest(messages: readonly ModelMessage[]) {
  let count = 0;
  let bytes = 0;
  for (const message of messages) {
    if (typeof message.content === "string" || message.role === "tool") continue;
    for (const part of message.content) {
      if (!isContextImage(part)) continue;
      count += 1;
      const source = localImageSource(part);
      if (typeof source === "string") bytes += source.length;
      else if (source instanceof Uint8Array || source instanceof ArrayBuffer)
        bytes += Math.ceil(source.byteLength / 3) * 4;
    }
  }
  return count <= 20 && bytes <= 16 * 1024 * 1024;
}

export function isContextImage(part: { type: string; mediaType?: string }): part is FilePart {
  return (
    part.type === "file" &&
    (part.mediaType === "image" || part.mediaType?.startsWith("image/") === true)
  );
}

/** A conservative vision-token estimate, not an exact provider usage/billing calculation. */
export function estimateImageContextTokens(part: FilePart, modelId?: string): number {
  const policy = imagePolicy(modelId, part.providerOptions?.openai?.imageDetail);
  if (!policy) return UNVERIFIED_MODEL_IMAGE_TOKENS;
  const size = localImageDimensions(part);
  if (!size) return Math.ceil(policy.maxPatches * policy.multiplier);

  const scale = Math.min(1, policy.maxEdge / Math.max(size.width, size.height));
  const width = Math.max(1, Math.ceil(size.width * scale));
  const height = Math.max(1, Math.ceil(size.height * scale));
  const patches = Math.ceil(width / policy.patchSize) * Math.ceil(height / policy.patchSize);
  // For inputs that require patch-budget resizing, reserving the entire budget is an upper bound
  // independent of provider rounding. Smaller inputs use their actual patch grid.
  if (!policy.resizesToBudget && patches > policy.maxPatches) {
    throw new Error(
      "This image exceeds the model's supported image dimensions. Resize it before sending it again.",
    );
  }
  return Math.ceil(Math.min(patches, policy.maxPatches) * policy.multiplier);
}

function imagePolicy(modelId: string | undefined, detail: unknown) {
  // https://developers.openai.com/api/docs/guides/images-vision
  // Match only verified families; don't silently apply one provider's rules to other models.
  if (
    modelId &&
    /^openai\/(gpt-5\.4(?:-(?:mini|nano))?|gpt-5\.5|gpt-5\.6-(?:sol|terra|luna)|gpt-6-(?:astra|sol|luna))$/.test(
      modelId,
    )
  ) {
    const newer = /^openai\/(gpt-5\.6|gpt-6)/.test(modelId);
    const defaultOriginal = newer || modelId === "openai/gpt-5.5";
    const resolvedDetail =
      detail === undefined || detail === "auto" ? (defaultOriginal ? "original" : "high") : detail;
    if (resolvedDetail === "low") {
      return {
        patchSize: 32,
        maxEdge: defaultOriginal ? 512 : 2048,
        maxPatches: defaultOriginal ? 256 : 6144,
        multiplier: 1.2,
        resizesToBudget: true,
      };
    }
    if (resolvedDetail === "high") {
      return {
        patchSize: 32,
        // GPT-6 lifts the high-detail edge limit across the family; GPT-5.x still resizes to 2048.
        maxEdge: modelId.startsWith("openai/gpt-6-") ? 65535 : 2048,
        maxPatches: 2500,
        multiplier: 1.2,
        resizesToBudget: true,
      };
    }
    if (resolvedDetail === "original") {
      return {
        patchSize: 32,
        maxEdge: newer ? 65535 : 6000,
        maxPatches: newer ? 30000 : 10000,
        multiplier: 1.2,
        resizesToBudget: !newer,
      };
    }
    return null;
  }
  // https://platform.claude.com/docs/en/build-with-claude/vision
  const claude = modelId?.match(
    /^anthropic\/claude-(?:haiku|sonnet|opus|fable)-(\d+)(?:\.(\d+))?$/,
  );
  if (claude) {
    const highResolution =
      Number(claude[1]) >= 5 || (Number(claude[1]) === 4 && Number(claude[2]) >= 7);
    return {
      patchSize: 28,
      maxEdge: highResolution ? 2576 : 1568,
      maxPatches: highResolution ? 4784 : 1568,
      multiplier: 1,
      resizesToBudget: true,
    };
  }
  return null;
}

function localImageSource(part: FilePart): unknown {
  // SDK callers may supply either tagged FileData or the legacy raw data/URL forms.
  let source: unknown = part.data;
  if (source && typeof source === "object" && "type" in source) {
    if (source.type === "data" && "data" in source) source = source.data;
    else if (source.type === "url" && "url" in source) source = source.url;
    else return null;
  }
  if (source instanceof URL) {
    if (source.protocol !== "data:") return null;
    source = source.href;
  }
  return source;
}

function localImageDimensions(part: FilePart) {
  const source = localImageSource(part);
  let bytes: Uint8Array;
  if (typeof source === "string") {
    let start = 0;
    if (source.startsWith("data:")) {
      const comma = source.indexOf(",");
      if (comma < 0 || !source.slice(0, comma).endsWith(";base64")) return null;
      start = comma + 1;
    }
    bytes = Buffer.from(source.slice(start, start + Math.ceil(MAX_HEADER_BYTES / 3) * 4), "base64");
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source, 0, Math.min(source.byteLength, MAX_HEADER_BYTES));
  } else if (source instanceof Uint8Array) {
    bytes = source.subarray(0, MAX_HEADER_BYTES);
  } else return null;
  // Restrict parsing to the raster formats the chat upload path accepts.
  if (!isRasterHeader(bytes)) return null;
  const size = imageSize(bytes);
  return size &&
    Number.isSafeInteger(size.width) &&
    Number.isSafeInteger(size.height) &&
    size.width > 0 &&
    size.height > 0
    ? size
    : null;
}

function isRasterHeader(bytes: Uint8Array) {
  const header = Buffer.from(bytes.subarray(0, 12));
  return (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (header[0] === 0xff && header[1] === 0xd8) ||
    header.toString("ascii", 0, 3) === "GIF" ||
    (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP")
  );
}
