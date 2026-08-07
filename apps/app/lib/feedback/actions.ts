"use server";

import { currentUser } from "@/lib/auth";

// A small feedback report from the sidebar widget. Bug / Feedback / Idea only —
// enough for Linear Triage Intelligence to sort, without asking the user to pick
// a team or priority.
type FeedbackKind = "bug" | "feedback" | "idea";

export type FeedbackActionState = { ok: true } | { ok: false; error: string };

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

function isFeedbackKind(value: string): value is FeedbackKind {
  return value === "bug" || value === "feedback" || value === "idea";
}

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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
}: {
  message: string;
  kind: FeedbackKind;
  user: { email: string; firstName?: string | null; lastName?: string | null };
  workspace: { id: string; name: string };
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
  ].join("\n");
}

async function linearGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  // Reuses the shared Linear API key (same one the web app's feedback intake uses).
  // Only the target team differs — FEEDBACK_LINEAR_TEAM_ID points at the product team.
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("Missing LINEAR_API_KEY.");
  }

  const response = await fetch("https://api.linear.app/graphql", {
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
async function resolveTriageStateId(teamId: string): Promise<string | null> {
  try {
    const data = await linearGraphql<LinearTeamStatesResponse>(
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

async function resolveLabelIds(teamId: string, names: string[]) {
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

async function createLinearIssue({
  title,
  description,
  kind,
}: {
  title: string;
  description: string;
  kind: FeedbackKind;
}) {
  const teamId = process.env.FEEDBACK_LINEAR_TEAM_ID;
  if (!teamId) {
    throw new Error("Missing FEEDBACK_LINEAR_TEAM_ID.");
  }

  const labelNames = uniqueLabels([
    "source:goat",
    KIND_LABELS[kind],
    ...splitEnvList(process.env.FEEDBACK_LINEAR_LABELS),
  ]);

  const [labelIds, triageStateId] = await Promise.all([
    resolveLabelIds(teamId, labelNames),
    resolveTriageStateId(teamId),
  ]);

  const data = await linearGraphql<LinearIssueResponse>(
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
        ...(process.env.FEEDBACK_LINEAR_PROJECT_ID
          ? { projectId: process.env.FEEDBACK_LINEAR_PROJECT_ID }
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

export async function submitFeedback(
  _previousState: FeedbackActionState | null,
  formData: FormData,
): Promise<FeedbackActionState> {
  const rawKind = readString(formData, "kind");
  const message = readString(formData, "message");
  const kind = isFeedbackKind(rawKind) ? rawKind : "feedback";

  if (message.length < 3) {
    return { ok: false, error: "Enter a bit more detail." };
  }
  if (message.length > 4000) {
    return { ok: false, error: "Keep feedback under 4,000 characters." };
  }

  const { authUser, workspace } = await currentUser();

  const title = titleFromMessage(kind, message);
  const description = buildDescription({ message, kind, user: authUser, workspace });

  try {
    await createLinearIssue({ title, description, kind });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not send feedback. Try again in a minute.",
    };
  }

  return { ok: true };
}
