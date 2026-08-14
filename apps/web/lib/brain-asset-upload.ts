import { createApiClient } from "@opencompany/protocol";
import {
  CHAT_ATTACHMENT_ACCEPT,
  validateChatAttachmentCandidate,
} from "@/lib/chat-attachment-formats";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

// Client validation is for fast feedback only. The canonical API receives the
// bytes, recomputes their hash, stores them privately, and registers the asset.
export const BRAIN_ASSET_ACCEPT = CHAT_ATTACHMENT_ACCEPT;
export const BRAIN_ASSET_MAX_BYTES = 20 * 1024 * 1024;

export function validateBrainAssetFile(file: File): string | null {
  if (file.size === 0) return "That file is empty.";
  const validation = validateChatAttachmentCandidate({
    mediaType: file.type,
    filename: file.name,
    sizeBytes: file.size,
  });
  return validation.ok ? null : validation.message;
}

export async function uploadHeadlessBrainAsset(
  input: { brainId: string; folderPath: string; file: File },
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch; idempotencyKey?: string } = {},
) {
  const client = brainAssetClient(options);
  const response = await client.v1.brains[":brainId"].assets.$post({
    param: { brainId: input.brainId },
    header: {
      "idempotency-key": options.idempotencyKey ?? `web-brain-asset:${crypto.randomUUID()}`,
    },
    form: { folderPath: input.folderPath, file: input.file },
  });
  if (!response.ok) throw await brainAssetResponseError(response);
  return (await response.json()).data;
}

export async function replaceHeadlessBrainAsset(
  input: { brainId: string; documentId: string; file: File },
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch; idempotencyKey?: string } = {},
) {
  const client = brainAssetClient(options);
  const response = await client.v1.brains[":brainId"].assets[":documentId"].replace.$post({
    param: { brainId: input.brainId, documentId: input.documentId },
    header: {
      "idempotency-key": options.idempotencyKey ?? `web-brain-asset-replace:${crypto.randomUUID()}`,
    },
    form: { file: input.file },
  });
  if (!response.ok) throw await brainAssetResponseError(response);
  return (await response.json()).data;
}

function brainAssetClient(options: { baseUrl?: string; fetch?: typeof globalThis.fetch }) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

async function brainAssetResponseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `The Brain asset upload failed with HTTP ${response.status}.`}${
      requestId ? ` (request ${requestId})` : ""
    }`,
  );
}
