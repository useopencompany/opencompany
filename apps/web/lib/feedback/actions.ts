"use server";

import { ATTACHMENT_IMAGE_MIME_TYPES } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { del, get } from "@vercel/blob";
import { and, eq, isNull } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

type FeedbackKind = "bug" | "feedback" | "idea";

// One screenshot the client uploaded to the transit blob store, as serialized in the form.
type FeedbackImageRef = {
  blobPathname: string;
  blobUrl: string;
  filename: string;
  mediaType: string;
};

// Up to this many screenshots per feedback submission (mirrors the client-side cap).
const MAX_FEEDBACK_IMAGES = 3;

export type FeedbackActionState =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

type LinearIssueResponse = {
  issueCreate?: {
    success: boolean;
    issue?: {
      id: string;
      identifier: string;
    } | null;
  } | null;
};

type LinearLabelsResponse = {
  team?: {
    labels: {
      nodes: Array<{
        id: string;
        name: string;
      }>;
    };
  } | null;
};

type LinearLabelCreateResponse = {
  issueLabelCreate?: {
    success: boolean;
    issueLabel?: {
      id: string;
      name: string;
    } | null;
  } | null;
};

type LinearFileUploadResponse = {
  fileUpload?: {
    success: boolean;
    uploadFile?: {
      uploadUrl: string;
      assetUrl: string;
      headers: Array<{ key: string; value: string }>;
    } | null;
  } | null;
};

const kindLabels: Record<FeedbackKind, string[]> = {
  bug: ["bug"],
  feedback: ["feedback"],
  idea: ["idea"],
};

const labelColors: Record<string, string> = {
  bug: "#ef4444",
  feedback: "#0ea5e9",
  idea: "#4f46e5",
  "source:app": "#14b8a6",
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function isFeedbackKind(value: string): value is FeedbackKind {
  return ["bug", "feedback", "idea"].includes(value);
}

function splitEnvList(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function uniqueLabels(labels: string[]) {
  return Array.from(new Set(labels.map((label) => label.toLowerCase())));
}

function titlePrefix(kind: FeedbackKind) {
  switch (kind) {
    case "bug":
      return "Bug";
    case "feedback":
      return "Feedback";
    case "idea":
      return "Idea";
  }
}

function titleFromMessage(kind: FeedbackKind, message: string) {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const base = firstLine || message.trim();
  const compact = base.replace(/\s+/g, " ");
  const title = compact.length > 92 ? `${compact.slice(0, 89).trimEnd()}...` : compact;

  return `[${titlePrefix(kind)}] ${title}`;
}

function buildDescription({
  message,
  kind,
  user,
  workspace,
  sessionId,
  images = [],
  failedImageCount = 0,
}: {
  message: string;
  kind: FeedbackKind;
  user: { email: string; firstName?: string | null; lastName?: string | null };
  workspace: { id: string; name: string };
  sessionId?: string | null;
  images?: Array<{ filename: string; assetUrl: string }>;
  failedImageCount?: number;
}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const submittedBy = name ? `${name} <${user.email}>` : user.email;

  // Linear renders `![alt](assetUrl)` inline in the issue body, so the screenshots show right
  // under the user's message — before the metadata separator.
  const imageBlock = images.length
    ? ["", ...images.map((image) => `![${image.filename}](${image.assetUrl})`)]
    : [];
  const failedNote =
    failedImageCount > 0
      ? [
          "",
          `> Note: ${failedImageCount} screenshot${failedImageCount === 1 ? "" : "s"} could not be attached.`,
        ]
      : [];

  const context = [
    message,
    ...imageBlock,
    ...failedNote,
    "",
    "---",
    `Submitted from: opencompany app`,
    `Submitted by: ${submittedBy}`,
    `User email: ${user.email}`,
    `Workspace: ${workspace.name} (${workspace.id})`,
    ...(sessionId ? [`Session ID: ${sessionId}`] : []),
    `Type: ${kind}`,
  ];

  return context.join("\n");
}

async function resolveFeedbackSessionId(sessionId: string, userId: string, workspaceId: string) {
  if (!sessionId) return null;

  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  return session?.id ?? null;
}

async function linearGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LINEAR_API_KEY.");
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (!response.ok || payload.errors?.length) {
    throw new Error(
      payload.errors?.map((error) => error.message).join("; ") ||
        `Linear request failed with status ${response.status}.`,
    );
  }

  if (!payload.data) {
    throw new Error("Linear returned an empty response.");
  }

  return payload.data;
}

async function createLinearIssue({
  title,
  description,
  kind,
}: {
  title: string;
  description: string;
  kind: FeedbackKind;
}) {
  const teamId = process.env.LINEAR_TEAM_ID;

  if (!teamId) {
    throw new Error("Missing LINEAR_TEAM_ID.");
  }

  const labelNames = uniqueLabels([
    "feedback",
    "source:app",
    ...kindLabels[kind],
    ...splitEnvList(process.env.LINEAR_FEEDBACK_LABELS),
  ]);
  const labelIds = await resolveLinearLabelIds(teamId, labelNames);

  const data = await linearGraphql<LinearIssueResponse>(
    `
      mutation CreateFeedbackIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
          }
        }
      }
    `,
    {
      input: {
        teamId,
        title,
        description,
        priority: 3,
        labelIds,
        ...(process.env.LINEAR_FEEDBACK_PROJECT_ID
          ? { projectId: process.env.LINEAR_FEEDBACK_PROJECT_ID }
          : {}),
      },
    },
  );

  const issue = data.issueCreate?.issue;
  if (!data.issueCreate?.success || !issue) {
    throw new Error("Linear did not create an issue.");
  }

  return issue;
}

async function resolveLinearLabelIds(teamId: string, names: string[]) {
  const data = await linearGraphql<LinearLabelsResponse>(
    `
      query FeedbackLabels($teamId: String!) {
        team(id: $teamId) {
          labels {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { teamId },
  );

  const labelsByName = new Map(
    data.team?.labels.nodes.map((label) => [label.name.toLowerCase(), label.id]) ?? [],
  );
  const labelIds = names
    .map((name) => labelsByName.get(name.toLowerCase()))
    .filter((id): id is string => Boolean(id));

  for (const name of names) {
    if (labelsByName.has(name.toLowerCase())) continue;

    try {
      const created = await linearGraphql<LinearLabelCreateResponse>(
        `
          mutation CreateFeedbackLabel($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              success
              issueLabel {
                id
                name
              }
            }
          }
        `,
        {
          input: {
            teamId,
            name,
            color: labelColors[name] ?? "#71717a",
          },
        },
      );

      const label = created.issueLabelCreate?.issueLabel;
      if (created.issueLabelCreate?.success && label) {
        labelsByName.set(label.name.toLowerCase(), label.id);
        labelIds.push(label.id);
      }
    } catch {
      // Label creation permissions should not block feedback intake.
    }
  }

  return labelIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The `get()` token can read ANY blob in the store, so we MUST validate the URL we are about to
// read — not just the sibling `blobPathname` field, which the client controls independently. A
// crafted submission could otherwise pair a legit-looking pathname with a `blobUrl` pointing at
// another workspace's private blob. We require the Vercel Blob host and a path scoped to this
// workspace's feedback prefix.
function isOwnedFeedbackBlobUrl(blobUrl: string, workspaceId: string): boolean {
  let url: URL;
  try {
    url = new URL(blobUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.hostname.endsWith(".blob.vercel-storage.com")) return false;
  const path = url.pathname.replace(/^\/+/, "");
  return path.startsWith(`workspace/${workspaceId}/feedback/`);
}

// Parses the `images` form fields (one JSON blob per ready screenshot) and keeps only entries the
// caller is allowed to read (see isOwnedFeedbackBlobUrl). Also re-checks the media type so a
// tampered field can't smuggle a non-image through. Capped to MAX_FEEDBACK_IMAGES.
function readFeedbackImages(formData: FormData, workspaceId: string): FeedbackImageRef[] {
  const images: FeedbackImageRef[] = [];

  for (const entry of formData.getAll("images")) {
    if (typeof entry !== "string") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const { blobPathname, blobUrl, filename, mediaType } = parsed;
    if (
      typeof blobPathname !== "string" ||
      typeof blobUrl !== "string" ||
      typeof filename !== "string" ||
      typeof mediaType !== "string"
    ) {
      continue;
    }
    if (!isOwnedFeedbackBlobUrl(blobUrl, workspaceId)) continue;
    if (!(ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType)) continue;

    images.push({ blobPathname, blobUrl, filename, mediaType });
    if (images.length >= MAX_FEEDBACK_IMAGES) break;
  }

  return images;
}

// Reads a private transit blob's bytes server-side. Mirrors app/api/attachments/[id]/route.ts:46.
async function readFeedbackBlob(blobUrl: string): Promise<Buffer> {
  const result = await get(blobUrl, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error("Could not read uploaded image.");
  }

  const chunks: Uint8Array[] = [];
  const reader = result.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Uploads one image to Linear's own storage and returns its permanent asset URL, suitable for
// inline markdown embedding. Two-step per Linear's API: request a pre-signed URL, then PUT the
// bytes with the headers Linear returned (omitting any of them yields a 403). Must run server-side
// — Linear's CSP blocks client-side uploads.
async function uploadImageToLinear(image: {
  bytes: Buffer;
  contentType: string;
  filename: string;
}): Promise<string> {
  const data = await linearGraphql<LinearFileUploadResponse>(
    `
      mutation FeedbackFileUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success
          uploadFile {
            uploadUrl
            assetUrl
            headers {
              key
              value
            }
          }
        }
      }
    `,
    {
      contentType: image.contentType,
      filename: image.filename,
      size: image.bytes.byteLength,
    },
  );

  const uploadFile = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !uploadFile) {
    throw new Error("Linear did not accept the file upload.");
  }

  const headers = new Headers();
  headers.set("Content-Type", image.contentType);
  headers.set("Cache-Control", "public, max-age=31536000");
  for (const { key, value } of uploadFile.headers) {
    headers.set(key, value);
  }

  const put = await fetch(uploadFile.uploadUrl, {
    method: "PUT",
    headers,
    body: new Uint8Array(image.bytes),
  });
  if (!put.ok) {
    throw new Error(`Linear file upload failed with status ${put.status}.`);
  }

  return uploadFile.assetUrl;
}

// Reads each screenshot back from the transit store and pushes it to Linear. The images are
// independent, so they run concurrently (capped at MAX_FEEDBACK_IMAGES) rather than serializing
// three blob-read + Linear-upload round-trips on the submit path. A single image failing must NOT
// block the feedback (same philosophy as label creation) — we skip it, count it, and surface the
// count in the issue body. Promise.all preserves order, so embeds stay in attach order.
async function uploadFeedbackImages(images: FeedbackImageRef[]): Promise<{
  uploaded: Array<{ filename: string; assetUrl: string }>;
  failedCount: number;
}> {
  const results = await Promise.all(
    images.map(async (image) => {
      try {
        const bytes = await readFeedbackBlob(image.blobUrl);
        const assetUrl = await uploadImageToLinear({
          bytes,
          contentType: image.mediaType,
          filename: image.filename,
        });
        return { filename: image.filename, assetUrl };
      } catch {
        return null;
      }
    }),
  );

  const uploaded = results.filter(
    (result): result is { filename: string; assetUrl: string } => result !== null,
  );
  return { uploaded, failedCount: results.length - uploaded.length };
}

export async function submitFeedback(
  _previousState: FeedbackActionState | null,
  formData: FormData,
): Promise<FeedbackActionState> {
  const rawKind = readString(formData, "kind");
  const message = readString(formData, "message");
  const rawSessionId = readString(formData, "sessionId");

  const kind = isFeedbackKind(rawKind) ? rawKind : "feedback";

  if (message.length < 3) {
    return { ok: false, error: "Enter feedback." };
  }

  if (message.length > 4000) {
    return { ok: false, error: "Keep feedback under 4,000 characters." };
  }

  const { authUser, user, workspace } = await currentWorkspace();
  const sessionId = await resolveFeedbackSessionId(rawSessionId, user.id, workspace.id);
  const images = readFeedbackImages(formData, workspace.id);
  const { uploaded, failedCount } = await uploadFeedbackImages(images);

  const title = titleFromMessage(kind, message);
  const description = buildDescription({
    message,
    kind,
    user: authUser,
    workspace,
    sessionId,
    images: uploaded,
    failedImageCount: failedCount,
  });

  try {
    await createLinearIssue({
      title,
      description,
      kind,
    });
  } catch (error) {
    // Leave the transit blobs in place so a retry can reuse them.
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not send feedback. Try again in a minute.",
    };
  }

  // The screenshots live in Linear now — drop the transient blobs (best-effort, non-blocking).
  await Promise.all(
    images.map(async (image) => {
      try {
        await del(image.blobUrl);
      } catch {
        // Orphaned transit blobs are harmless; never fail feedback over cleanup.
      }
    }),
  );

  return { ok: true };
}
