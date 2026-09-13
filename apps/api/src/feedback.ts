import { getAppUrl } from "@opencompany/agent/app-url";
import type { Actor } from "@opencompany/core";
import { chatSessions, tasks, users, workspaces } from "@opencompany/db/product-schema";
import { and, eq } from "drizzle-orm";
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
    command: { kind: FeedbackKind; message: string; context?: FeedbackContext },
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
}): FeedbackService {
  const fetchImpl = input.fetch ?? globalThis.fetch;

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

      const title = titleFromMessage(command.kind, command.message);
      const description = buildDescription({
        message: command.message,
        kind: command.kind,
        user,
        workspace,
        reference,
      });

      try {
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

// Lines describing the run the report came from, already scoped to the actor.
// `null` fields mean the row is gone or was never the reporter's, which is worth
// saying out loud rather than dropping the reference the reporter was promised.
type FeedbackReference = {
  context: FeedbackContext;
  taskId: string | null;
  taskDisplayId: string | null;
  sessionId: string | null;
};

// Only the reporter's own rows resolve: a chat session is user-owned, a task is
// workspace-owned. An id that matches neither still gets reported, unresolved.
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
    return {
      context,
      taskId: null,
      taskDisplayId: null,
      sessionId: session?.id ?? null,
    };
  }

  const [task] = await db
    .select({ id: tasks.id, displayId: tasks.displayId, sessionId: tasks.sessionId })
    .from(tasks)
    .where(and(eq(tasks.id, context.id), eq(tasks.workspaceId, actor.workspaceId)))
    .limit(1);
  return {
    context,
    taskId: task?.id ?? null,
    taskDisplayId: task?.displayId ?? null,
    sessionId: task?.sessionId ?? null,
  };
}

function referenceLines(reference: FeedbackReference) {
  const { context } = reference;
  const path = context.kind === "chat" ? "/chat" : "/tasks";
  const link = new URL(`${path}/${encodeURIComponent(context.id)}`, getAppUrl()).toString();

  if (context.kind === "chat") {
    return [
      `Session: ${context.id}${reference.sessionId ? "" : " (not accessible to the reporter)"}`,
      `Link: ${link}`,
    ];
  }

  if (!reference.taskId) {
    return [`Task: ${context.id} (not accessible to the reporter)`, `Link: ${link}`];
  }

  return [
    `Task: ${context.id} (${reference.taskDisplayId})`,
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
}: {
  message: string;
  kind: FeedbackKind;
  user: { email: string; firstName?: string | null; lastName?: string | null };
  workspace: { id: string; name: string };
  reference: FeedbackReference | null;
}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const submittedBy = name ? `${name} <${user.email}>` : user.email;

  return [
    message,
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
