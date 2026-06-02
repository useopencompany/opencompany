"use server";

import { getDb } from "@opencompany/db/client";
import { agentSessions } from "@opencompany/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

type FeedbackKind = "bug" | "feedback" | "idea";

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

type LinearAttachmentCreateResponse = {
  attachmentCreate?: {
    success: boolean;
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
  screenshotUrl,
}: {
  message: string;
  kind: FeedbackKind;
  user: { email: string; firstName?: string | null; lastName?: string | null };
  workspace: { id: string; name: string };
  sessionId?: string | null;
  screenshotUrl?: string | null;
}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const submittedBy = name ? `${name} <${user.email}>` : user.email;

  const context = [
    message,
    "",
    "---",
    `Submitted from: opencompany app`,
    `Submitted by: ${submittedBy}`,
    `User email: ${user.email}`,
    `Workspace: ${workspace.name} (${workspace.id})`,
    ...(sessionId ? [`Session ID: ${sessionId}`] : []),
    `Type: ${kind}`,
    ...(screenshotUrl ? ["", `![Screenshot](${screenshotUrl})`] : []),
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

/**
 * Uploads a screenshot to Linear's file storage and returns the public asset URL.
 * Returns null without throwing if the upload fails — a screenshot is non-critical.
 */
async function uploadScreenshotToLinear(file: File): Promise<string | null> {
  try {
    const data = await linearGraphql<LinearFileUploadResponse>(
      `
        mutation FeedbackFileUpload($contentType: String!, $size: Int!) {
          fileUpload(contentType: $contentType, size: $size) {
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
      { contentType: file.type, size: file.size },
    );

    const upload = data.fileUpload?.uploadFile;
    if (!data.fileUpload?.success || !upload) return null;

    const extraHeaders: Record<string, string> = {};
    for (const { key, value } of upload.headers) {
      extraHeaders[key] = value;
    }

    const putResponse = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
        ...extraHeaders,
      },
      body: file,
    });

    if (!putResponse.ok) return null;

    return upload.assetUrl;
  } catch {
    // Screenshot upload should never block feedback submission.
    return null;
  }
}

/**
 * Links a previously-uploaded file as an attachment on a Linear issue.
 * Silently ignores failures — an attachment is supplementary.
 */
async function attachScreenshotToIssue(issueId: string, assetUrl: string): Promise<void> {
  try {
    await linearGraphql<LinearAttachmentCreateResponse>(
      `
        mutation FeedbackAttachmentCreate($issueId: String!, $url: String!, $title: String!) {
          attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
            success
          }
        }
      `,
      { issueId, url: assetUrl, title: "Screenshot" },
    );
  } catch {
    // Non-critical; do not surface to user.
  }
}

export async function submitFeedback(
  _previousState: FeedbackActionState | null,
  formData: FormData,
): Promise<FeedbackActionState> {
  const rawKind = readString(formData, "kind");
  const message = readString(formData, "message");
  const rawSessionId = readString(formData, "sessionId");
  const screenshotFile = formData.get("screenshot");

  const kind = isFeedbackKind(rawKind) ? rawKind : "feedback";

  if (message.length < 3) {
    return { ok: false, error: "Enter feedback." };
  }

  if (message.length > 4000) {
    return { ok: false, error: "Keep feedback under 4,000 characters." };
  }

  const screenshot =
    screenshotFile instanceof File && screenshotFile.size > 0 ? screenshotFile : null;

  // Upload screenshot before creating the issue so we can embed the URL in the description.
  const screenshotUrl = screenshot ? await uploadScreenshotToLinear(screenshot) : null;

  const { authUser, user, workspace } = await currentWorkspace();
  const sessionId = await resolveFeedbackSessionId(rawSessionId, user.id, workspace.id);
  const title = titleFromMessage(kind, message);
  const description = buildDescription({
    message,
    kind,
    user: authUser,
    workspace,
    sessionId,
    screenshotUrl,
  });

  try {
    const issue = await createLinearIssue({
      title,
      description,
      kind,
    });

    // Attach the screenshot as a Linear attachment in addition to the inline image.
    if (screenshotUrl) {
      await attachScreenshotToIssue(issue.id, screenshotUrl);
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not send feedback. Try again in a minute.",
    };
  }
}
