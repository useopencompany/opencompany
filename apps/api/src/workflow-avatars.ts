import { randomUUID } from "node:crypto";
import { getAppUrl } from "@opencompany/agent/app-url";
import {
  type Actor,
  WORKFLOW_AVATAR_MAX_BYTES,
  WORKFLOW_AVATAR_MEDIA_TYPES,
  type WorkflowApplicationService,
  type WorkflowAvatarMediaType,
} from "@opencompany/core";
import { BlobNotFoundError, get, put } from "@vercel/blob";
import sharp from "sharp";
import { ApiError } from "./errors";

// Slack downloads `icon_url` itself, so an uploaded avatar has to be reachable without a session.
// The bytes stay in the private product store and leave only through the unauthenticated public
// download below, addressed by a UUID nobody can enumerate.
const BLOB_PREFIX = "goat-workflow-avatars";

const EXTENSIONS: Readonly<Record<WorkflowAvatarMediaType, "png" | "jpg" | "webp">> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// The declared content type is caller-controlled, so the leading bytes decide the real format.
// Serving a mislabelled file from a public URL is the one failure this endpoint must not allow.
const SIGNATURES: readonly {
  mediaType: WorkflowAvatarMediaType;
  matches: (b: Buffer) => boolean;
}[] = [
  {
    mediaType: "image/png",
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mediaType: "image/jpeg",
    matches: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mediaType: "image/webp",
    matches: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

export type WorkflowAvatarStorage = {
  put(input: { pathname: string; bytes: Buffer; mediaType: string }): Promise<void>;
  get(input: { pathname: string }): Promise<{
    stream: ReadableStream<Uint8Array>;
    sizeBytes: number | null;
  } | null>;
};

export type WorkflowAvatarDownload = {
  stream: ReadableStream<Uint8Array>;
  mediaType: string;
  filename: string;
  sizeBytes: number | null;
  inline: boolean;
  cacheControl: string;
  contentSecurityPolicy: string | null;
};

export type WorkflowAvatarService = {
  upload(input: { actor: Actor; workflowId: string; file: File }): Promise<{ avatarUrl: string }>;
  download(input: { workflowId: string; assetId: string }): Promise<WorkflowAvatarDownload>;
};

export function createWorkflowAvatarService(input: {
  workflows: Pick<WorkflowApplicationService, "authorizeWorkflowWrite">;
  storage?: WorkflowAvatarStorage;
  slackAppIcon?: boolean;
}): WorkflowAvatarService {
  const storage = input.storage ?? vercelBlobStorage();
  return {
    async upload({ actor, workflowId, file }) {
      const authorizedWorkflowId = await input.workflows.authorizeWorkflowWrite(actor, workflowId);
      const origin = publicOrigin();
      const detected = await validatedImage(file);
      let bytes = Buffer.from(await file.arrayBuffer());
      if (input.slackAppIcon) {
        try {
          bytes = await sharp(bytes, { limitInputPixels: 16_000_000 })
            .rotate()
            .resize(512, 512, { fit: "cover" })
            .png()
            .toBuffer();
        } catch {
          throw new ApiError(
            400,
            "invalid_argument",
            "This image could not be processed. Choose another PNG, JPEG, or WebP image.",
          );
        }
      }
      const mediaType = input.slackAppIcon ? "image/png" : detected;
      const assetId = `${randomUUID()}.${EXTENSIONS[mediaType]}`;
      const pathname = avatarPathname(authorizedWorkflowId, assetId);
      await storage.put({
        pathname,
        bytes,
        mediaType,
      });
      return {
        avatarUrl: new URL(
          `/workflow-avatars/${encodeURIComponent(authorizedWorkflowId)}/${assetId}`,
          origin,
        ).toString(),
      };
    },
    async download({ workflowId, assetId }) {
      const stored = await storage.get({ pathname: avatarPathname(workflowId, assetId) });
      if (!stored) throw new ApiError(404, "not_found", "Avatar not found.");
      return {
        stream: stored.stream,
        mediaType: mediaTypeForAssetId(assetId),
        filename: assetId,
        sizeBytes: stored.sizeBytes,
        inline: true,
        // The pathname carries a fresh UUID on every upload, so the bytes behind a URL never
        // change and Slack may cache them for as long as it likes.
        cacheControl: "public, max-age=31536000, immutable",
        contentSecurityPolicy: "default-src 'none'; sandbox",
      };
    },
  };
}

// A stored avatar URL has to satisfy the same HTTPS rule the workflow update applies, or the
// upload would succeed and saving it would fail with a confusing error from a different endpoint.
// Only a local stack served over plain HTTP can land here, and Slack could not fetch it anyway.
function publicOrigin() {
  const origin = getAppUrl();
  if (!origin.startsWith("https://")) {
    throw new ApiError(
      503,
      "unavailable",
      "Avatar uploads need this workspace to be served over HTTPS.",
      true,
    );
  }
  return origin;
}

function avatarPathname(workflowId: string, assetId: string) {
  return `${BLOB_PREFIX}/${workflowId}/${assetId}`;
}

function mediaTypeForAssetId(assetId: string) {
  if (assetId.endsWith(".png")) return "image/png";
  if (assetId.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function validatedImage(file: File): Promise<WorkflowAvatarMediaType> {
  if (file.size <= 0) throw new ApiError(400, "invalid_argument", "The image file is empty.");
  if (file.size > WORKFLOW_AVATAR_MAX_BYTES) {
    throw new ApiError(400, "invalid_argument", "Avatars are limited to 1 MB.");
  }
  const declared = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!WORKFLOW_AVATAR_MEDIA_TYPES.includes(declared as WorkflowAvatarMediaType)) {
    throw new ApiError(400, "invalid_argument", "Avatars must be a PNG, JPEG, or WebP image.");
  }
  const head = Buffer.from(await file.slice(0, 12).arrayBuffer());
  const actual = SIGNATURES.find((signature) => signature.matches(head))?.mediaType;
  if (!actual || actual !== declared) {
    throw new ApiError(400, "invalid_argument", "Avatars must be a PNG, JPEG, or WebP image.");
  }
  return actual;
}

function vercelBlobStorage(): WorkflowAvatarStorage {
  return {
    async put({ pathname, bytes, mediaType }) {
      await put(pathname, bytes, {
        access: "private",
        addRandomSuffix: false,
        contentType: mediaType,
      });
    },
    async get({ pathname }) {
      try {
        const result = await get(pathname, { access: "private", useCache: false });
        if (result?.statusCode !== 200 || !result.stream) return null;
        return { stream: result.stream, sizeBytes: result.blob.size };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw error;
      }
    },
  };
}
