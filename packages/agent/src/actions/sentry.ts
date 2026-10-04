import { getDb } from "@opencompany/db/client";
import { getSentryConnection, type SentryConnection, sentryRows } from "@opencompany/db/sentry";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  SentryApiError,
  SentryIssueSchema,
  SentryProjectSchema,
  sentryApi,
  sentryIssuePath,
} from "../integrations/sentry";
import {
  ACTION_EFFECTS_READ,
  ACTION_EFFECTS_WRITE,
  ActionAuthError,
  ActionInvalidParamsError,
  ActionPermissionError,
  type ActionProviderCatalog,
  type ResolvedAction,
} from "./types";

const ProjectId = z.string().regex(/^\d+$/);
const Cursor = z.string().max(256).optional();
const Page = { cursor: Cursor, limit: z.number().int().min(1).max(50).default(25) };
const Issue = { issueId: ProjectId };
const Range = { start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) };
const Query = z.string().max(2000).default("");
const SPECS = {
  list_projects: {
    description: "List projects selected by the workspace admin.",
    schema: z.object({ ...Page }).strict(),
  },
  list_assignees: {
    description:
      "List eligible project members or teams. kind defaults to users; use kind=teams for teams.",
    schema: z
      .object({ projectId: ProjectId, kind: z.enum(["users", "teams"]).default("users"), ...Page })
      .strict(),
  },
  search_issues: {
    description: "Search issues in one selected project using Sentry query syntax.",
    schema: z.object({ projectId: ProjectId, query: Query, ...Page }).strict(),
  },
  get_issue: {
    description:
      "Retrieve issue details after checking its project belongs to the selected projects.",
    schema: z.object(Issue).strict(),
  },
  list_occurrences: {
    description: "List issue occurrences with pagination.",
    schema: z.object({ ...Issue, ...Page }).strict(),
  },
  get_occurrence: {
    description: "Retrieve an issue occurrence by ID, oldest, latest or recommended.",
    schema: z
      .object({
        ...Issue,
        eventId: z.string().regex(/^(?:[a-fA-F0-9]{32}|oldest|latest|recommended)$/),
      })
      .strict(),
  },
  get_release: {
    description: "Retrieve release details for a selected project.",
    schema: z.object({ projectId: ProjectId, version: z.string().min(1).max(256) }).strict(),
  },
  list_release_commits: {
    description: "List commits associated with a release present in a selected project.",
    schema: z
      .object({ projectId: ProjectId, version: z.string().min(1).max(256), ...Page })
      .strict(),
  },
  search_logs: {
    description:
      "Search structured logs in a selected project and explicit time range. Missing telemetry or permissions is distinct from no results.",
    schema: z.object({ projectId: ProjectId, query: Query, ...Range, ...Page }).strict(),
  },
  search_spans: {
    description: "Search spans in a selected project and explicit time range.",
    schema: z.object({ projectId: ProjectId, query: Query, ...Range, ...Page }).strict(),
  },
  get_trace: {
    description:
      "Retrieve a trace in an explicit time range. Inaccessible projects are removed recursively.",
    schema: z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), ...Range }).strict(),
  },
  assign_issue: {
    description:
      "Assign an issue to a project member or team. Requires approval unless an admin enabled writes.",
    schema: z.object({ ...Issue, assignee: z.string().regex(/^(user|team):\d+$/) }).strict(),
  },
  unassign_issue: {
    description: "Unassign an issue. Requires approval unless an admin enabled writes.",
    schema: z.object(Issue).strict(),
  },
  resolve_issue: {
    description: "Resolve an issue normally. Requires approval unless an admin enabled writes.",
    schema: z.object(Issue).strict(),
  },
  archive_issue: {
    description: "Permanently archive an issue. Requires approval unless an admin enabled writes.",
    schema: z.object(Issue).strict(),
  },
};
export type SentryToolName = keyof typeof SPECS;
export const SENTRY_TOOL_NAMES = Object.keys(SPECS) as SentryToolName[];
const WRITES = new Set<SentryToolName>([
  "assign_issue",
  "unassign_issue",
  "resolve_issue",
  "archive_issue",
]);
export function sentryToolMode(connection: SentryConnection, name: SentryToolName) {
  return (
    connection.toolModes[name] ??
    connection.capabilityModes[WRITES.has(name) ? "write" : "read"] ??
    (WRITES.has(name) ? "ask" : "on")
  );
}
export async function resolveSentryActions(input: {
  workspaceId: string;
  userWorkosId: string;
}): Promise<ActionProviderCatalog | null> {
  const connection = await getSentryConnection(input.workspaceId);
  if (!connection) return null;
  const catalog: ActionProviderCatalog = {
    id: "sentry",
    label: "Sentry (company)",
    description: "Investigate and update Sentry issues in the workspace's selected projects.",
    actions: [],
  };
  if (connection.status !== "connected" || !connection.verifiedAt) return catalog;
  for (const name of SENTRY_TOOL_NAMES) {
    const mode = sentryToolMode(connection, name);
    if (mode === "off") continue;
    const write = WRITES.has(name);
    const action: ResolvedAction = {
      id: `sentry.${name}`,
      provider: "sentry",
      capability: write ? "write" : "read",
      effects: write ? ACTION_EFFECTS_WRITE : ACTION_EFFECTS_READ,
      description: SPECS[name].description,
      params: z.toJSONSchema(SPECS[name].schema) as ResolvedAction["params"],
      permissionMode: mode,
      approvalContext: `sentry:${connection.integrationId}:${JSON.stringify(connection.selectedProjectIds)}`,
      ...(mode === "ask"
        ? {
            permission: {
              provider: "sentry" as const,
              capabilityId: write ? ("write" as const) : ("read" as const),
              label: SPECS[name].description,
              integrationIds: [connection.integrationId],
              toolId: name,
            },
          }
        : {}),
      async execute(params, context) {
        const current = await getSentryConnection(input.workspaceId);
        const member = sentryRows(
          await getDb().execute(
            sql`SELECT 1 FROM goat.workspace_members WHERE workspace_id = ${input.workspaceId} AND user_workos_id = ${context.userWorkosId}`,
          ),
        )[0];
        if (
          !current ||
          !member ||
          current.status !== "connected" ||
          !current.verifiedAt ||
          current.integrationId !== connection.integrationId ||
          context.workspaceId !== input.workspaceId
        )
          throw new ActionAuthError(
            "not_connected",
            "sentry",
            "Sentry account or workspace access was revoked.",
          );
        const currentMode = sentryToolMode(current, name);
        if (currentMode === "off" || (mode === "on" && currentMode === "ask"))
          throw new ActionPermissionError(
            "sentry",
            "Sentry permission changed. Request approval again.",
          );
        return executeSentryTool(current, name, params, { signal: context.signal });
      },
    };
    catalog.actions.push(action);
  }
  return catalog;
}
export async function executeSentryTool(
  connection: SentryConnection,
  name: SentryToolName,
  raw: Record<string, unknown>,
  options: { signal?: AbortSignal; db?: any } = {},
) {
  const parsed = SPECS[name].schema.safeParse(raw);
  if (!parsed.success)
    throw new ActionInvalidParamsError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const params = parsed.data as Record<string, string | number>;
  const org = encodeURIComponent(connection.organizationSlug);
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  if (projectId && !connection.selectedProjectIds.includes(projectId))
    throw new ActionPermissionError(
      "sentry",
      "This project is not selected by the workspace admin.",
    );
  if (
    params.start &&
    (new Date(params.start) >= new Date(params.end!) ||
      new Date(params.end!).getTime() - new Date(params.start).getTime() > 31 * 86400_000)
  )
    throw new ActionInvalidParamsError(
      "Choose a time range of at most 31 days with start before end.",
    );
  const query = new URLSearchParams({ per_page: String(params.limit ?? 25) });
  if (params.cursor) query.set("cursor", String(params.cursor));
  let path = "";
  let body: Record<string, unknown> | null = null;
  let issue: z.infer<typeof SentryIssueSchema> | null = null;
  if (params.issueId) {
    issue = SentryIssueSchema.parse(
      (
        await sentryApi(
          connection,
          sentryIssuePath(connection, String(params.issueId)),
          undefined,
          options,
        )
      ).data,
    );
    if (issue.id !== params.issueId || !connection.selectedProjectIds.includes(issue.project.id))
      throw new ActionPermissionError("sentry", "This issue belongs to an inaccessible project.");
    path = sentryIssuePath(connection, String(params.issueId));
  }
  switch (name) {
    case "list_projects": {
      const offset = params.cursor ? Number(params.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ActionInvalidParamsError("Invalid project cursor.");
      const ids = connection.selectedProjectIds.slice(offset, offset + Number(params.limit));
      const projects = await Promise.all(
        ids.map(async (id) =>
          SentryProjectSchema.parse(
            (await sentryApi(connection, `projects/${org}/${id}/`, undefined, options)).data,
          ),
        ),
      );
      return boundedSentryResult({
        data: projects,
        nextCursor:
          offset + ids.length < connection.selectedProjectIds.length
            ? String(offset + ids.length)
            : null,
        source: `https://${connection.organizationSlug}.sentry.io/settings/projects/`,
        unavailable: false,
      });
    }
    case "list_assignees": {
      const { assignees, ...page } = await readSentryAssignees(
        connection,
        projectId!,
        params.kind === "teams" ? "team" : "user",
        {
          limit: Number(params.limit),
          ...(params.cursor ? { cursor: String(params.cursor) } : {}),
        },
        options,
      );
      return boundedSentryResult({ data: assignees, ...page, unavailable: false });
    }
    case "search_issues":
      path = `organizations/${org}/issues/`;
      query.set("project", projectId!);
      query.set("query", String(params.query));
      break;
    case "get_issue":
      return boundedSentryResult({
        data: issue,
        source:
          issue?.permalink ??
          `https://${connection.organizationSlug}.sentry.io/issues/${params.issueId}/`,
        nextCursor: null,
        unavailable: false,
      });
    case "list_occurrences":
      path += "events/";
      break;
    case "get_occurrence":
      path += `events/${params.eventId}/`;
      break;
    case "get_release":
      path = `projects/${org}/${projectId}/releases/${encodeURIComponent(String(params.version))}/`;
      break;
    case "list_release_commits":
      path = `projects/${org}/${projectId}/releases/${encodeURIComponent(String(params.version))}/commits/`;
      break;
    case "search_logs":
    case "search_spans":
      path = `organizations/${org}/events/`;
      query.set("dataset", name === "search_logs" ? "logs" : "spans");
      query.set("project", projectId!);
      query.set("query", String(params.query));
      query.set("start", String(params.start));
      query.set("end", String(params.end));
      for (const field of name === "search_logs"
        ? ["id", "timestamp", "message", "severity", "project.id", "trace"]
        : [
            "id",
            "timestamp",
            "span.op",
            "span.description",
            "span.duration",
            "project.id",
            "trace",
          ])
        query.append("field", field);
      break;
    case "get_trace":
      path = `organizations/${org}/trace/${params.traceId}/`;
      query.set("start", String(params.start));
      query.set("end", String(params.end));
      connection.selectedProjectIds.forEach((id) => query.append("project", id));
      break;
    case "assign_issue": {
      if (
        !(await isSentryAssignee(connection, issue!.project.id, String(params.assignee), options))
      )
        throw new ActionInvalidParamsError(
          "Assignee is not an eligible member or team of this project. List project assignees first.",
        );
      body = { assignedTo: params.assignee };
      break;
    }
    case "unassign_issue":
      body = { assignedTo: "" };
      break;
    case "resolve_issue":
      body = { status: "resolved" };
      break;
    case "archive_issue":
      body = { status: "ignored", substatus: "archived_forever", statusDetails: {} };
      break;
  }
  try {
    const response = await sentryApi(connection, path, body ?? query, {
      ...options,
      ...(body ? { method: "PUT" } : {}),
    });
    let data = response.data;
    if (name === "search_issues") {
      data = z
        .array(SentryIssueSchema)
        .parse(data)
        .filter((item) => item.project.id === projectId);
    }
    if (name === "search_logs" || name === "search_spans") {
      const record = z
        .object({ data: z.array(z.record(z.string(), z.unknown())), meta: z.unknown().optional() })
        .parse(data);
      data = {
        ...record,
        data: record.data.filter((item) => String(item["project.id"]) === projectId),
      };
    }
    if (name === "get_trace")
      data = filterSentryTrace(data, new Set(connection.selectedProjectIds));
    return boundedSentryResult({
      data,
      nextCursor: response.nextCursor,
      source: response.source,
      unavailable: false,
      ...(name === "get_trace" ? { inaccessibleProjectsRemoved: true } : {}),
    });
  } catch (error) {
    if (
      (name === "search_logs" || name === "search_spans" || name === "get_trace") &&
      error instanceof SentryApiError &&
      [403, 404].includes(error.status)
    )
      return {
        data: null,
        nextCursor: null,
        unavailable: true,
        reason: error.status === 403 ? "missing permissions" : "telemetry unavailable",
        source: null,
        truncated: false,
      };
    throw error;
  }
}
// Members without a user are pending invitations, which Sentry cannot assign.
const SentryMemberSchema = z
  .object({
    email: z.string().nullish(),
    user: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        name: z.string().nullish(),
        email: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
const SentryTeamSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    slug: z.string().nullish(),
    name: z.string().nullish(),
  })
  .passthrough();
type SentryAssigneeKind = "user" | "team";
// `assignee` is the exact value assign_issue accepts, so discovery and validation agree.
type SentryAssignee = { assignee: string; kind: SentryAssigneeKind; name: string };

// One page of a project's assignable members or teams.
async function readSentryAssignees(
  connection: SentryConnection,
  projectId: string,
  kind: SentryAssigneeKind,
  page: { cursor?: string; limit: number },
  options: { signal?: AbortSignal; db?: any } = {},
): Promise<{ assignees: SentryAssignee[]; nextCursor: string | null; source: string }> {
  const query = new URLSearchParams({ per_page: String(page.limit) });
  if (page.cursor) query.set("cursor", page.cursor);
  const response = await sentryApi(
    connection,
    `projects/${encodeURIComponent(connection.organizationSlug)}/${projectId}/${kind === "team" ? "teams" : "members"}/`,
    query,
    options,
  );
  let assignees: SentryAssignee[];
  if (kind === "team") {
    assignees = z
      .array(SentryTeamSchema)
      .parse(response.data)
      .map((team) => ({
        assignee: `team:${team.id}`,
        kind,
        name: team.name || team.slug || team.id,
      }));
  } else {
    assignees = z
      .array(SentryMemberSchema)
      .parse(response.data)
      .flatMap(({ email, user }) =>
        user
          ? [
              {
                assignee: `user:${user.id}`,
                kind,
                name: user.name || user.email || email || user.id,
              },
            ]
          : [],
      );
  }
  return { assignees, nextCursor: response.nextCursor, source: response.source };
}

// Reads every page, so an assignee listed past the first page stays eligible.
async function isSentryAssignee(
  connection: SentryConnection,
  projectId: string,
  assignee: string,
  options: { signal?: AbortSignal; db?: any },
) {
  const kind: SentryAssigneeKind = assignee.startsWith("team:") ? "team" : "user";
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const result = await readSentryAssignees(
      connection,
      projectId,
      kind,
      { limit: 100, ...(cursor ? { cursor } : {}) },
      options,
    );
    if (result.assignees.some((candidate) => candidate.assignee === assignee)) return true;
    cursor = result.nextCursor ?? undefined;
    if (!cursor) return false;
    if (seen.has(cursor)) throw new Error("Sentry assignee pagination did not advance.");
    seen.add(cursor);
  }
}

// Drop a foreign node and all its children. Some trace nodes identify projects by slug rather than
// id, so unknown identities also fail closed. Root containers have no project and are traversed.
export function filterSentryTrace(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (Array.isArray(value))
    return value
      .map((item) => filterSentryTrace(item, allowed))
      .filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const project =
    record.project_id ??
    record.projectId ??
    record["project.id"] ??
    (record.project && typeof record.project === "object"
      ? (record.project as Record<string, unknown>).id
      : record.project);
  if (
    (project === undefined &&
      (record.project_slug !== undefined ||
        record.projectSlug !== undefined ||
        record.span_id !== undefined ||
        record.event_id !== undefined)) ||
    (project !== undefined && !allowed.has(String(project)))
  )
    return undefined;
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, item]) => [key, filterSentryTrace(item, allowed)])
      .filter(([, item]) => item !== undefined),
  );
}
export function boundedSentryResult(value: { data: unknown; [key: string]: unknown }) {
  let remaining = 12_000;
  let truncated = false;
  function bound(item: unknown, depth = 0): unknown {
    if (remaining <= 0 || depth > 16) {
      truncated = true;
      return "[truncated]";
    }
    if (typeof item === "string") {
      const limit = Math.min(2000, remaining);
      remaining -= Math.min(item.length, limit);
      if (item.length > limit) truncated = true;
      return item.slice(0, limit);
    }
    if (Array.isArray(item)) {
      const result = [];
      for (const entry of item) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        remaining -= 8;
        result.push(bound(entry, depth + 1));
      }
      return result;
    }
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        remaining -= key.length + 8;
        result[key] = bound(entry, depth + 1);
      }
      return result;
    }
    remaining -= 20;
    return item;
  }
  return { ...value, data: bound(value.data), truncated };
}
