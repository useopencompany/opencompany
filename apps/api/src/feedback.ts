import { getAppUrl } from "@opencompany/agent/app-url";
import { downloadChatAttachment } from "@opencompany/agent/chat-attachment-storage";
import type { Actor } from "@opencompany/core";
import {
  type ChatMessageAttachment,
  chatSessions,
  tasks,
  users,
  workspaces,
} from "@opencompany/db/product-schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { ApiError } from "./errors";

// A small feedback report from the sidebar widget. Bug / Feedback / Idea only —
// enough for Linear Triage Intelligence to sort, without asking the user to pick
// a team or priority.
export type FeedbackKind = "bug" | "feedback" | "idea";

// The chat session or task the reporter had open. Resolving it into the issue
// description is what lets triage open the failing run without a round trip.
export type FeedbackContext = { kind: "chat" | "task"; id: string };

export type FeedbackService = {
  submit(
    actor: Actor,
    command: {
      kind: FeedbackKind;
      message: string;
      context?: FeedbackContext;
      attachmentIds?: string[];
    },
  ): Promise<void>;
};

type DbLike = any;

type LinearIssueResponse = {
  issueCreate?: {
    success: boolean;
    issue?: { id: string; identifier: string } | null;
  } | null;
};

type LinearTeamStatesResponse = {
  team?: {
    states: {
      nodes: Array<{ id: string; type: string }>;
    };
  } | null;
};

type LinearLabelsResponse = {
  team?: {
    labels: {
      nodes: Array<{ id: string; name: string }>;
    };
  } | null;
};

type LinearLabelCreateResponse = {
  issueLabelCreate?: {
    success: boolean;
    issueLabel?: { id: string; name: string } | null;
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

const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "bug",
  feedback: "feedback",
  idea: "idea",
};

const LABEL_COLORS: Record<string, string> = {
  bug: "#ef4444",
  feedback: "#0ea5e9",
  idea: "#4f46e5",
  "source:goat": "#f59e0b",
};

export function createFeedbackService(input: {
  db: DbLike;
  fetch?: typeof globalThis.fetch;
  resolveAttachments?: (input: {
    actor: Actor;
    attachmentIds: readonly string[];
  }) => Promise<{ attachments: readonly ChatMessageAttachment[] }>;
  downloadAttachment?: (blobUrl: string) => Promise<Buffer>;
}): FeedbackService {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const downloadAttachment = input.downloadAttachment ?? downloadChatAttachment;

  return {
    async submit(actor, command) {
      const [user] = await input.db
        .select({
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(eq(users.workosUserId, actor.userId))
        .limit(1);
      if (!user) {
        throw new ApiError(404, "not_found", "The acting user's profile was not found.");
      }
      const [workspace] = await input.db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, actor.workspaceId))
        .limit(1);
      if (!workspace) {
        throw new ApiError(404, "not_found", "The acting workspace was not found.");
      }

      const reference = command.context
        ? await resolveContext(input.db, actor, command.context)
        : null;

      const attachmentIds = command.attachmentIds ?? [];
      if (attachmentIds.length > 5 || new Set(attachmentIds).size !== attachmentIds.length) {
        throw new ApiError(400, "invalid_request", "Select up to five unique screenshots.");
      }
      const attachments = attachmentIds.length
        ? await resolveFeedbackAttachments(input.resolveAttachments, actor, attachmentIds)
        : [];

      try {
        const screenshots = await Promise.all(
          attachments.map(async (attachment) => ({
            filename: attachment.filename,
            assetUrl: await uploadScreenshotToLinear(
              fetchImpl,
              attachment,
              await downloadAttachment(attachment.blobUrl),
            ),
          })),
        );
        const title = titleFromMessage(command.kind, command.message);
        const description = buildDescription({
          message: command.message,
          kind: command.kind,
          user,
          workspace,
          reference,
          screenshots,
        });
        await createLinearIssue(fetchImpl, { title, description, kind: command.kind });
      } catch (error) {
        // Delivery failures surface to the widget with the upstream message,
        // matching the retired web Server Action behavior.
        throw new ApiError(
          503,
          "unavailable",
          error instanceof Error
            ? error.message
            : "Could not send feedback. Try again in a minute.",
          true,
        );
      }
    },
  };
}

async function resolveFeedbackAttachments(
  resolver:
    | ((input: {
        actor: Actor;
        attachmentIds: readonly string[];
      }) => Promise<{ attachments: readonly ChatMessageAttachment[] }>)
    | undefined,
  actor: Actor,
  attachmentIds: readonly string[],
) {
  if (!resolver) {
    throw new ApiError(503, "unavailable", "Feedback attachments are not configured.", true);
  }
  const { attachments } = await resolver({ actor, attachmentIds });
  if (
    attachments.length !== attachmentIds.length ||
    attachments.some((item) => item.kind !== "image")
  ) {
    throw new ApiError(400, "invalid_request", "Feedback attachments must be screenshots.");
  }
  return attachments;
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

// The run the report came from. An unresolved reference means the reporter
// cannot open the id they submitted — worth saying out loud in the issue rather
// than dropping the reference the dialog promised them.
type FeedbackReference =
  | { kind: "chat" | "task"; id: string; resolved: false }
  | { kind: "chat"; id: string; resolved: true }
  | { kind: "task"; id: string; resolved: true; displayId: string; sessionId: string | null };

// Mirrors the access rules the reporter's own reads use: a chat session is
// owner-scoped, and a task belongs either to the acting workspace or, when it
// predates one, to the acting user.
async function resolveContext(
  db: DbLike,
  actor: Actor,
  context: FeedbackContext,
): Promise<FeedbackReference> {
  if (context.kind === "chat") {
    const [session] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, context.id), eq(chatSessions.userWorkosId, actor.userId)))
      .limit(1);
    return session
      ? { kind: "chat", id: context.id, resolved: true }
      : { kind: "chat", id: context.id, resolved: false };
  }

  const [task] = await db
    .select({ displayId: tasks.displayId, sessionId: tasks.sessionId })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, context.id),
        or(
          eq(tasks.workspaceId, actor.workspaceId),
          and(isNull(tasks.workspaceId), eq(tasks.userWorkosId, actor.userId)),
        ),
      ),
    )
    .limit(1);
  return task
    ? {
        kind: "task",
        id: context.id,
        resolved: true,
        displayId: task.displayId,
        sessionId: task.sessionId,
      }
    : { kind: "task", id: context.id, resolved: false };
}

function referenceLines(reference: FeedbackReference) {
  const segment = reference.kind === "chat" ? "chat" : "tasks";
  const link = new URL(`/${segment}/${encodeURIComponent(reference.id)}`, getAppUrl()).toString();

  if (!reference.resolved) {
    const label = reference.kind === "chat" ? "Session" : "Task";
    return [`${label}: ${reference.id} (not accessible to the reporter)`, `Link: ${link}`];
  }
  if (reference.kind === "chat") {
    return [`Session: ${reference.id}`, `Link: ${link}`];
  }

  return [
    `Task: ${reference.id} (${reference.displayId})`,
    ...(reference.sessionId ? [`Session: ${reference.sessionId}`] : []),
    `Link: ${link}`,
  ];
}

function buildDescription({
  message,
  kind,
  user,
  workspace,
  reference,
  screenshots,
}: {
  message: string;
  kind: FeedbackKind;
  user: { email: string; firstName?: string | null; lastName?: string | null };
  workspace: { id: string; name: string };
  reference: FeedbackReference | null;
  screenshots: Array<{ filename: string; assetUrl: string }>;
}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const submittedBy = name ? `${name} <${user.email}>` : user.email;

  return [
    message,
    ...(screenshots.length
      ? [
          "",
          "### Screenshots",
          ...screenshots.map(
            (screenshot) =>
              `![${escapeMarkdownAltText(screenshot.filename)}](${screenshot.assetUrl})`,
          ),
        ]
      : []),
    "",
    "---",
    "Submitted from: opencompany app",
    `Submitted by: ${submittedBy}`,
    `User email: ${user.email}`,
    `Workspace: ${workspace.name} (${workspace.id})`,
    `Type: ${kind}`,
    ...(reference ? referenceLines(reference) : []),
  ].join("\n");
}

function escapeMarkdownAltText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

async function linearGraphql<T>(
  fetchImpl: typeof globalThis.fetch,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  // Reuses the shared Linear API key (same one the web app's feedback intake uses).
  // Only the target team differs — OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID points at the opencompany team.
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("Missing LINEAR_API_KEY.");
  }

  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Linear personal API keys authenticate as the raw header value (no "Bearer").
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

async function uploadScreenshotToLinear(
  fetchImpl: typeof globalThis.fetch,
  attachment: ChatMessageAttachment,
  bytes: Buffer,
) {
  if (bytes.byteLength !== attachment.sizeBytes) {
    throw new Error("The screenshot size changed before delivery.");
  }
  const data = await linearGraphql<LinearFileUploadResponse>(
    fetchImpl,
    `
      mutation FeedbackFileUpload($filename: String!, $contentType: String!, $size: Int!) {
        fileUpload(filename: $filename, contentType: $contentType, size: $size) {
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
      filename: attachment.filename,
      contentType: attachment.mediaType,
      size: bytes.byteLength,
    },
  );
  const upload = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !upload) {
    throw new Error("Linear did not prepare the screenshot upload.");
  }

  const uploadUrl = httpsUrl(upload.uploadUrl, "upload");
  const assetUrl = httpsUrl(upload.assetUrl, "asset");
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000",
    "Content-Type": attachment.mediaType,
  });
  for (const header of upload.headers) headers.set(header.key, header.value);

  const response = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers,
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`Linear screenshot upload failed with status ${response.status}.`);
  }
  return assetUrl;
}

function httpsUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Linear returned an invalid ${label} URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Linear returned an invalid ${label} URL.`);
  }
  return url.toString();
}

// The team's Triage workflow state, present only when Triage is enabled for the
// team. Setting it explicitly guarantees the issue lands in Triage regardless of
// the API actor. Returns null when Triage is off — the issue then uses the team's
// default state instead of failing.
async function resolveTriageStateId(
  fetchImpl: typeof globalThis.fetch,
  teamId: string,
): Promise<string | null> {
  try {
    const data = await linearGraphql<LinearTeamStatesResponse>(
      fetchImpl,
      `
        query FeedbackTriageState($teamId: String!) {
          team(id: $teamId) {
            states {
              nodes {
                id
                type
              }
            }
          }
        }
      `,
      { teamId },
    );
    return data.team?.states.nodes.find((state) => state.type === "triage")?.id ?? null;
  } catch {
    // Never block feedback on a state lookup — fall back to the default state.
    return null;
  }
}

async function resolveLabelIds(
  fetchImpl: typeof globalThis.fetch,
  teamId: string,
  names: string[],
) {
  const data = await linearGraphql<LinearLabelsResponse>(
    fetchImpl,
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
        fetchImpl,
        `
          mutation FeedbackCreateLabel($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              success
              issueLabel {
                id
                name
              }
            }
          }
        `,
        { input: { teamId, name, color: LABEL_COLORS[name] ?? "#71717a" } },
      );

      const label = created.issueLabelCreate?.issueLabel;
      if (created.issueLabelCreate?.success && label) {
        labelsByName.set(label.name.toLowerCase(), label.id);
        labelIds.push(label.id);
      }
    } catch {
      // Label creation permission shouldn't block feedback intake.
    }
  }

  return labelIds;
}

async function createLinearIssue(
  fetchImpl: typeof globalThis.fetch,
  {
    title,
    description,
    kind,
  }: {
    title: string;
    description: string;
    kind: FeedbackKind;
  },
) {
  const teamId = process.env.OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID;
  if (!teamId) {
    throw new Error("Missing OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID.");
  }

  const labelNames = uniqueLabels([
    "source:goat",
    KIND_LABELS[kind],
    ...splitEnvList(process.env.OPENCOMPANY_FEEDBACK_LINEAR_LABELS),
  ]);

  const [labelIds, triageStateId] = await Promise.all([
    resolveLabelIds(fetchImpl, teamId, labelNames),
    resolveTriageStateId(fetchImpl, teamId),
  ]);

  const data = await linearGraphql<LinearIssueResponse>(
    fetchImpl,
    `
      mutation FeedbackCreateIssue($input: IssueCreateInput!) {
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
        ...(triageStateId ? { stateId: triageStateId } : {}),
        ...(process.env.OPENCOMPANY_FEEDBACK_LINEAR_PROJECT_ID
          ? { projectId: process.env.OPENCOMPANY_FEEDBACK_LINEAR_PROJECT_ID }
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
