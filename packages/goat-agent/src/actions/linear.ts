import { createMCPClient } from "@ai-sdk/mcp";
import { isValidGoatBrainSourceRef } from "@opencompany/goat-brain";
import type { JSONSchema7, ToolExecutionOptions, ToolSet } from "ai";
import {
  GOAT_LINEAR_MCP_ENDPOINT_URL,
  getGoatLinearIntegrationState,
  loadGoatLinearMcpWorkerConnection,
} from "../integrations/linear-mcp";
import { effectiveCapabilityMode, type GoatCapabilityId, providerCapability } from "./capabilities";
import {
  GOAT_ACTION_EFFECTS_READ,
  GOAT_ACTION_EFFECTS_WRITE,
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  type ResolvedGoatAction,
  requiredStringParam,
} from "./types";

// Linear treats priority=0 and assignee=null as active filters, but models
// commonly emit them as placeholders for omitted optional fields. Expose
// explicit booleans for those two searches and normalize every argument before
// the remote MCP tool receives it.
const LINEAR_LIST_ISSUES_STRING_FILTERS = [
  "cursor",
  "query",
  "team",
  "state",
  "cycle",
  "label",
  "assignee",
  "delegate",
  "project",
  "release",
  "parentId",
  "createdAt",
  "updatedAt",
] as const;

const LINEAR_LIST_ISSUES_PARAMS: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "number", minimum: 1, maximum: 250 },
    cursor: {
      type: "string",
      description: "Next page cursor. Omit on the first page.",
    },
    orderBy: { type: "string", enum: ["createdAt", "updatedAt"] },
    query: {
      type: "string",
      description: "Search issue title or description.",
    },
    team: { type: "string", description: "Team name or ID." },
    state: { type: "string", description: "State type, name, or ID." },
    cycle: { type: "string", description: "Cycle name, number, or ID." },
    label: { type: "string", description: "Label name or ID." },
    assignee: {
      type: "string",
      description:
        'User ID, name, email, or "me". Omit unless the request explicitly filters by assignee.',
    },
    unassigned: {
      type: "boolean",
      description:
        "Set true only when the request explicitly asks for unassigned issues. Omit otherwise.",
    },
    delegate: { type: "string", description: "Agent name or ID." },
    project: { type: "string", description: "Project name, ID, or slug." },
    release: { type: "string", description: "Release ID or slug." },
    priority: {
      type: "number",
      description:
        "Priority filter: 1=Urgent, 2=High, 3=Medium, 4=Low. Omit when no priority filter was requested; use unprioritized for issues with no priority.",
    },
    unprioritized: {
      type: "boolean",
      description:
        "Set true only when the request explicitly asks for issues with no priority. Omit otherwise.",
    },
    parentId: { type: "string", description: "Parent issue ID or identifier." },
    createdAt: {
      type: "string",
      description: "Created-after ISO-8601 date or duration.",
    },
    updatedAt: {
      type: "string",
      description: "Updated-after ISO-8601 date or duration.",
    },
    includeArchived: {
      type: "boolean",
      description: "Whether to include archived issues.",
    },
  },
};

const MAX_LINEAR_ISSUE_TITLE_CHARS = 255;
const MAX_LINEAR_MARKDOWN_BODY_CHARS = 249_999;
const MAX_LINEAR_SELECTOR_CHARS = 500;
const MAX_LINEAR_PARENT_ID_CHARS = 100;
const MAX_LINEAR_LABELS = 25;
const MAX_LINEAR_LABEL_CHARS = 100;

const LINEAR_CREATE_ISSUE_PARAMS: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "team"],
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_ISSUE_TITLE_CHARS,
      description: "Issue title.",
    },
    team: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description:
        "Team name, key, or ID. Use linear.list_teams first when it is available and the team is unclear.",
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_MARKDOWN_BODY_CHARS,
      description: "Optional Markdown issue description.",
    },
    assignee: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: 'Optional assignee name, email, ID, or "me".',
    },
    state: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: "Optional workflow state name or ID.",
    },
    project: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: "Optional project name, slug, or ID.",
    },
    priority: {
      type: "integer",
      enum: [0, 1, 2, 3, 4],
      description: "Optional priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low.",
    },
    labels: {
      type: "array",
      maxItems: MAX_LINEAR_LABELS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: MAX_LINEAR_LABEL_CHARS,
      },
      description: "Optional label names or IDs.",
    },
    parentId: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_PARENT_ID_CHARS,
      description: "Optional parent issue ID or identifier when creating a sub-issue.",
    },
  },
};

const LINEAR_UPDATE_ISSUE_PARAMS: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  minProperties: 2,
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: "Issue ID or identifier such as ENG-123.",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_ISSUE_TITLE_CHARS,
      description: "Replacement issue title.",
    },
    team: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: "Team name, key, or ID to move the issue to.",
    },
    description: {
      type: "string",
      maxLength: MAX_LINEAR_MARKDOWN_BODY_CHARS,
      description: "Replacement Markdown issue description. Use an empty string to clear it.",
    },
    assignee: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: 'Assignee name, email, ID, or "me"; use null to remove the assignee.',
    },
    state: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description:
        'Workflow state name or ID. To cancel an issue, set its team cancellation state (usually "Canceled").',
    },
    project: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: "Project name, slug, or ID; use null to remove the project association.",
    },
    priority: {
      type: "integer",
      enum: [0, 1, 2, 3, 4],
      description: "Priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low.",
    },
    labels: {
      type: "array",
      maxItems: MAX_LINEAR_LABELS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: MAX_LINEAR_LABEL_CHARS,
      },
      description: "Replacement label names or IDs. Use an empty array to remove all labels.",
    },
    parentId: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_PARENT_ID_CHARS,
      description: "Parent issue ID or identifier.",
    },
  },
};

const LINEAR_CREATE_COMMENT_PARAMS: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["issueId", "body"],
  properties: {
    issueId: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_SELECTOR_CHARS,
      description: "Issue ID or identifier such as ENG-123.",
    },
    body: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LINEAR_MARKDOWN_BODY_CHARS,
      description: "Markdown comment body.",
    },
  },
};

// Static curated catalog against Linear's hosted MCP server. Descriptors
// stay local so catalog resolution costs no MCP handshake; the remote tool is
// looked up by name at execute time.
type LinearActionSpec = {
  id: string;
  remoteName: string;
  capability: GoatCapabilityId;
  description: string;
  params: JSONSchema7;
  normalize?: (params: Record<string, unknown>) => Record<string, unknown>;
};

const LINEAR_ACTION_SPECS: readonly LinearActionSpec[] = [
  {
    id: "linear.list_issues",
    remoteName: "list_issues",
    capability: "read",
    description:
      "List and filter Linear issues (team, assignee, state, project, updated/created ranges, full-text query). Omit unused filters; use unassigned=true only for explicitly unassigned work.",
    params: LINEAR_LIST_ISSUES_PARAMS,
    normalize: normalizeLinearListIssuesInput,
  },
  {
    id: "linear.get_issue",
    remoteName: "get_issue",
    capability: "read",
    description: "Fetch one Linear issue by its ID or identifier (for example ENG-123).",
    params: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Issue ID or identifier such as ENG-123." },
      },
    },
  },
  {
    id: "linear.list_comments",
    remoteName: "list_comments",
    capability: "read",
    description: "List the comments on one Linear issue.",
    params: {
      type: "object",
      additionalProperties: false,
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "Issue ID or identifier such as ENG-123." },
      },
    },
  },
  {
    id: "linear.list_projects",
    remoteName: "list_projects",
    capability: "read",
    description: "List Linear projects, optionally filtered by team.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        team: { type: "string", description: "Team name or ID." },
        limit: { type: "number", minimum: 1, maximum: 250 },
        query: { type: "string", description: "Search project names." },
      },
    },
  },
  {
    id: "linear.get_project",
    remoteName: "get_project",
    capability: "read",
    description: "Fetch one Linear project by name, ID, or slug.",
    params: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Project name, ID, or slug." },
      },
    },
  },
  {
    id: "linear.list_teams",
    remoteName: "list_teams",
    capability: "read",
    description: "List the Linear teams in the workspace.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search team names." },
        limit: { type: "number", minimum: 1, maximum: 250 },
      },
    },
  },
  {
    id: "linear.list_users",
    remoteName: "list_users",
    capability: "read",
    description: "List Linear workspace members to resolve names to user IDs.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search user names or emails." },
        limit: { type: "number", minimum: 1, maximum: 250 },
      },
    },
  },
  {
    id: "linear.list_issue_statuses",
    remoteName: "list_issue_statuses",
    capability: "read",
    description: "List the issue statuses (workflow states) available for a team.",
    params: {
      type: "object",
      additionalProperties: false,
      properties: {
        team: { type: "string", description: "Team name or ID." },
      },
    },
  },
  {
    id: "linear.create_issue",
    remoteName: "save_issue",
    capability: "write",
    description:
      "Create a new Linear issue in a specific team. Use only when the user explicitly asked to create a ticket; include only issue fields the user requested or clearly supplied.",
    params: LINEAR_CREATE_ISSUE_PARAMS,
    normalize: normalizeLinearCreateIssueInput,
  },
  {
    id: "linear.update_issue",
    remoteName: "save_issue",
    capability: "write",
    description:
      'Update an existing Linear issue, including its state, title, description, team, assignee, project, priority, labels, or parent. Use the team cancellation state (usually "Canceled") to cancel an issue. Include only fields the user explicitly asked to change.',
    params: LINEAR_UPDATE_ISSUE_PARAMS,
    normalize: normalizeLinearUpdateIssueInput,
  },
  {
    id: "linear.create_comment",
    remoteName: "save_comment",
    capability: "write",
    description:
      "Add a Markdown comment to an existing Linear issue. Use only when the user explicitly asked to post or leave the comment.",
    params: LINEAR_CREATE_COMMENT_PARAMS,
    normalize: normalizeLinearCreateCommentInput,
  },
];

export async function resolveLinearActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const state = await getGoatLinearIntegrationState(userWorkosId);
  const integrationId = state.integrationId;
  if (!state.connected || !integrationId) return null;

  const readEnabled = effectiveCapabilityMode("linear", "read", state.capabilityModes) !== "off";
  const writeEnabled = effectiveCapabilityMode("linear", "write", state.capabilityModes) !== "off";
  if (!readEnabled && !writeEnabled) return null;

  const specs = LINEAR_ACTION_SPECS.filter(
    (spec) =>
      (spec.capability === "read" && readEnabled) || (spec.capability === "write" && writeEnabled),
  );

  const actions: ResolvedGoatAction[] = specs.map((spec) => ({
    id: spec.id,
    provider: "linear",
    capability: spec.capability,
    effects: spec.capability === "read" ? GOAT_ACTION_EFFECTS_READ : GOAT_ACTION_EFFECTS_WRITE,
    ...permissionAnnotation(spec.capability, {
      integrationId,
      capabilityModes: state.capabilityModes,
    }),
    description: spec.description,
    params: spec.params,
    execute: (params, context) =>
      executeLinearAction(
        spec,
        spec.normalize ? spec.normalize(params) : params,
        context,
        integrationId,
      ),
  }));

  return {
    id: "linear",
    label: "Linear workspace",
    description:
      readEnabled && writeEnabled
        ? "Read Linear workspace context, create and update issues, and add comments."
        : readEnabled
          ? "Read issues, comments, projects, teams, members, and workflow statuses."
          : "Create and update issues and add comments in Linear.",
    actions,
  };
}

function permissionAnnotation(
  capabilityId: GoatCapabilityId,
  state: { integrationId: string; capabilityModes: unknown },
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  if (effectiveCapabilityMode("linear", capabilityId, state.capabilityModes) !== "ask") {
    return { permissionMode: "on" };
  }
  return {
    permissionMode: "ask",
    permission: {
      provider: "linear",
      capabilityId,
      label: providerCapability("linear", capabilityId)?.label ?? capabilityId,
      integrationIds: [state.integrationId],
    },
  };
}

async function executeLinearAction(
  spec: LinearActionSpec,
  params: Record<string, unknown>,
  context: GoatActionExecuteContext,
  expectedIntegrationId: string,
): Promise<unknown> {
  if (spec.capability === "write") {
    await assertLinearWriteStillEnabled(context.userWorkosId, expectedIntegrationId);
  }

  const connection = await loadGoatLinearMcpWorkerConnection({
    userWorkosId: context.userWorkosId,
    onAuthorizationRequired: () => {
      throw new GoatActionAuthError(
        "auth_expired",
        "linear",
        "The Linear connection needs reauthorization; reconnect Linear in Settings → Integrations.",
      );
    },
  });
  if (!connection.ok) {
    throw new GoatActionAuthError(
      connection.reason === "not_connected" ? "not_connected" : "auth_expired",
      "linear",
      "Linear is not usable for this account; reconnect Linear in Settings → Integrations.",
    );
  }
  if (spec.capability === "write" && connection.integrationId !== expectedIntegrationId) {
    throw new GoatActionPermissionError(
      "linear",
      "The Linear connection changed before this change could be made. Retry so Goat can use the current connection and permission.",
    );
  }

  const client = await createMCPClient({
    clientName: "opencompany-goat-actions",
    version: "0.1.0",
    transport: {
      type: "http" as const,
      url: GOAT_LINEAR_MCP_ENDPOINT_URL,
      authProvider: connection.authProvider,
    },
  });

  try {
    const definitions = await client.listTools({ options: { signal: context.signal } });
    const rawTools = client.toolsFromDefinitions(definitions) as ToolSet;
    const remote = rawTools[spec.remoteName] as
      | { execute?: (input: unknown, options: ToolExecutionOptions) => Promise<unknown> }
      | undefined;
    const execute = remote?.execute?.bind(remote);
    if (!execute) {
      throw new Error(
        `Linear no longer exposes the "${spec.remoteName}" tool; this action is unavailable.`,
      );
    }
    const result = await execute(params, {
      toolCallId: `goat-action-${spec.remoteName}`,
      messages: [],
      abortSignal: context.signal,
    });
    return addLinearSourceMetadata(unwrapMcpResult(result), spec, connection.integrationId);
  } finally {
    await client.close().catch(() => {});
  }
}

async function assertLinearWriteStillEnabled(userWorkosId: string, expectedIntegrationId: string) {
  const state = await getGoatLinearIntegrationState(userWorkosId);
  // Let the normal connection loader return the structured reconnect error for
  // disconnected accounts. A different connected row is a permission boundary:
  // the approval/catalog belonged to the previous connection.
  if (!state.connected) return;
  if (state.integrationId !== expectedIntegrationId) {
    throw new GoatActionPermissionError(
      "linear",
      "The Linear connection changed before this change could be made. Retry so Goat can use the current connection and permission.",
    );
  }
  if (effectiveCapabilityMode("linear", "write", state.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "linear",
      "Writing to Linear is turned off. It can be changed under Settings → Integrations.",
    );
  }
}

function addLinearSourceMetadata(
  value: unknown,
  spec: LinearActionSpec,
  integrationId: string,
): unknown {
  if (
    spec.remoteName !== "list_issues" &&
    spec.remoteName !== "get_issue" &&
    spec.remoteName !== "save_issue"
  ) {
    return value;
  }
  if (!isRecord(value)) return value;

  if (Array.isArray(value.issues)) {
    return {
      ...value,
      integrationId,
      issues: value.issues.map((issue) => addLinearIssueSource(issue, integrationId)),
    };
  }
  return addLinearIssueSource(value, integrationId);
}

function addLinearIssueSource(value: unknown, integrationId: string): unknown {
  if (!isRecord(value)) return value;
  const identifier = typeof value.identifier === "string" ? value.identifier.trim() : "";
  if (!identifier) return { ...value, integrationId };
  const sourceRef = `linear:issue:${identifier}`;
  if (!isValidGoatBrainSourceRef(sourceRef)) {
    throw new Error("Linear returned an identifier that cannot form a Brain source reference.");
  }
  return { ...value, sourceRef, integrationId };
}

export function normalizeLinearListIssuesInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};

  const normalized: Record<string, unknown> = {};
  for (const key of LINEAR_LIST_ISSUES_STRING_FILTERS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) normalized[key] = value.trim();
  }

  if (typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0) {
    normalized.limit = Math.min(input.limit, 250);
  }
  if (input.orderBy === "createdAt" || input.orderBy === "updatedAt") {
    normalized.orderBy = input.orderBy;
  }
  if (input.includeArchived === true || input.includeArchived === false) {
    normalized.includeArchived = input.includeArchived;
  }

  const priority = input.priority;
  const unprioritized = input.unprioritized === true;
  if (unprioritized && priority !== undefined && priority !== null && priority !== 0) {
    throw new GoatActionInvalidParamsError(
      "Choose either a priority or unprioritized issues, not both.",
    );
  }
  if (unprioritized) {
    normalized.priority = 0;
  } else if (priority === 1 || priority === 2 || priority === 3 || priority === 4) {
    normalized.priority = priority;
  }

  const assignee = normalized.assignee;
  const unassigned = input.unassigned === true;
  if (unassigned && assignee !== undefined) {
    throw new GoatActionInvalidParamsError(
      "Choose either an assignee or unassigned issues, not both.",
    );
  }
  if (unassigned) normalized.assignee = null;

  return normalized;
}

export function normalizeLinearCreateIssueInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new GoatActionInvalidParamsError("Linear issue parameters must be an object.");
  }
  assertOnlyKnownParams(input, LINEAR_CREATE_ISSUE_PARAM_KEYS);

  const normalized: Record<string, unknown> = {
    title: requiredBoundedString(input, "title", MAX_LINEAR_ISSUE_TITLE_CHARS),
    team: requiredBoundedString(input, "team", MAX_LINEAR_SELECTOR_CHARS),
  };
  for (const [key, maxChars] of [
    ["description", MAX_LINEAR_MARKDOWN_BODY_CHARS],
    ["assignee", MAX_LINEAR_SELECTOR_CHARS],
    ["state", MAX_LINEAR_SELECTOR_CHARS],
    ["project", MAX_LINEAR_SELECTOR_CHARS],
    ["parentId", MAX_LINEAR_PARENT_ID_CHARS],
  ] as const) {
    const value = optionalBoundedString(input, key, maxChars);
    if (value !== undefined) normalized[key] = value;
  }

  const priority = normalizeLinearPriority(input.priority);
  if (priority !== undefined) normalized.priority = priority;

  const labels = normalizeLinearLabels(input.labels);
  if (labels !== undefined) normalized.labels = labels;
  return normalized;
}

export function normalizeLinearUpdateIssueInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new GoatActionInvalidParamsError("Linear issue parameters must be an object.");
  }
  assertOnlyKnownParams(input, LINEAR_UPDATE_ISSUE_PARAM_KEYS);

  const normalized: Record<string, unknown> = {
    id: requiredBoundedString(input, "id", MAX_LINEAR_SELECTOR_CHARS),
  };
  for (const [key, maxChars] of [
    ["title", MAX_LINEAR_ISSUE_TITLE_CHARS],
    ["team", MAX_LINEAR_SELECTOR_CHARS],
    ["state", MAX_LINEAR_SELECTOR_CHARS],
    ["parentId", MAX_LINEAR_PARENT_ID_CHARS],
  ] as const) {
    const value = optionalBoundedString(input, key, maxChars);
    if (value !== undefined) normalized[key] = value;
  }

  if (input.description !== undefined && input.description !== null) {
    normalized.description = boundedStringAllowingEmpty(
      input.description,
      "description",
      MAX_LINEAR_MARKDOWN_BODY_CHARS,
    );
  }
  if (input.assignee === null) {
    normalized.assignee = null;
  } else {
    const assignee = optionalBoundedString(input, "assignee", MAX_LINEAR_SELECTOR_CHARS);
    if (assignee !== undefined) normalized.assignee = assignee;
  }
  if (input.project === null) {
    normalized.project = null;
  } else {
    const project = optionalBoundedString(input, "project", MAX_LINEAR_SELECTOR_CHARS);
    if (project !== undefined) normalized.project = project;
  }

  const priority = normalizeLinearPriority(input.priority);
  if (priority !== undefined) normalized.priority = priority;
  const labels = normalizeLinearLabels(input.labels);
  if (labels !== undefined) normalized.labels = labels;

  if (Object.keys(normalized).length === 1) {
    throw new GoatActionInvalidParamsError("Provide at least one issue field to update.");
  }
  return normalized;
}

export function normalizeLinearCreateCommentInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new GoatActionInvalidParamsError("Linear comment parameters must be an object.");
  }
  assertOnlyKnownParams(input, LINEAR_CREATE_COMMENT_PARAM_KEYS);
  return {
    issueId: requiredBoundedString(input, "issueId", MAX_LINEAR_SELECTOR_CHARS),
    body: requiredBoundedString(input, "body", MAX_LINEAR_MARKDOWN_BODY_CHARS),
  };
}

const LINEAR_CREATE_ISSUE_PARAM_KEYS = [
  "title",
  "team",
  "description",
  "assignee",
  "state",
  "project",
  "priority",
  "labels",
  "parentId",
] as const;

const LINEAR_UPDATE_ISSUE_PARAM_KEYS = [
  "id",
  "title",
  "team",
  "description",
  "assignee",
  "state",
  "project",
  "priority",
  "labels",
  "parentId",
] as const;

const LINEAR_CREATE_COMMENT_PARAM_KEYS = ["issueId", "body"] as const;

function assertOnlyKnownParams(params: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(params).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new GoatActionInvalidParamsError(`Unknown parameter ${JSON.stringify(unknown)}.`);
  }
}

function requiredBoundedString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = requiredStringParam(params, key);
  if (value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" exceeds ${maxChars} characters.`);
  }
  return value;
}

function optionalBoundedString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError(`"${key}" must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" exceeds ${maxChars} characters.`);
  }
  return trimmed;
}

function boundedStringAllowingEmpty(value: unknown, key: string, maxChars: number) {
  if (typeof value !== "string") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" exceeds ${maxChars} characters.`);
  }
  return trimmed;
}

function normalizeLinearPriority(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) {
    throw new GoatActionInvalidParamsError(
      '"priority" must be an integer from 0 (none) to 4 (low).',
    );
  }
  return value;
}

function normalizeLinearLabels(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new GoatActionInvalidParamsError('"labels" must be an array of label names or IDs.');
  }
  if (value.length > MAX_LINEAR_LABELS) {
    throw new GoatActionInvalidParamsError(`"labels" allows at most ${MAX_LINEAR_LABELS} entries.`);
  }
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new GoatActionInvalidParamsError(
        '"labels" must contain only non-empty label names or IDs.',
      );
    }
    const label = entry.trim();
    if (label.length > MAX_LINEAR_LABEL_CHARS) {
      throw new GoatActionInvalidParamsError(
        `Linear labels may not exceed ${MAX_LINEAR_LABEL_CHARS} characters.`,
      );
    }
    const normalized = label.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    labels.push(label);
  }
  return labels;
}

// MCP tool results arrive as {content: [{type:"text", text}...], isError?}.
// Surface remote errors as provider errors and hand the model parsed JSON when
// the payload is a single JSON text block.
function unwrapMcpResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const texts = result.content
    .filter((entry): entry is { type: string; text: string } =>
      Boolean(isRecord(entry) && entry.type === "text" && typeof entry.text === "string"),
    )
    .map((entry) => entry.text);
  const joined = texts.join("\n");
  if (result.isError === true) {
    throw new Error(joined || "Linear returned an error for this action.");
  }
  if (texts.length === 0) return result;
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    return joined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
