import { createMCPClient } from "@ai-sdk/mcp";
import { jsonSchema, type ToolExecutionOptions, type ToolSet } from "ai";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityDefinition,
  type GoatCapabilityWorkerContext,
} from "@/lib/capabilities/types";
import {
  GOAT_LINEAR_MCP_ENDPOINT_URL,
  getGoatLinearIntegrationState,
  loadGoatLinearMcpWorkerConnection,
} from "@/lib/integrations/linear-mcp";

const MAX_LINEAR_READ_TOOLS = 12;
const MAX_LINEAR_WRITE_TOOLS = 13;
const MAX_LINEAR_ISSUE_CREATES_PER_CALL = 10;

// Verified against the live catalog during manual testing; anything the server
// renames simply falls back to the prefix allowlist below.
const PREFERRED_READ_TOOLS = [
  "list_issues",
  "get_issue",
  "list_comments",
  "list_projects",
  "get_project",
  "list_teams",
  "get_team",
  "list_users",
  "get_user",
  "list_issue_statuses",
  "list_documents",
  "get_document",
] as const;

// Keep the first write release deliberately narrow. Linear's MCP server also
// exposes broader mutations, but the foreground worker currently supports only
// creating issues that the user explicitly requested.
const ALLOWED_WRITE_TOOLS = ["create_issue"] as const;

const READ_TOOL_PATTERN = /^(list|get|search)_/;
const MUTATION_TOOL_PATTERN = /(^|_)(create|update|delete|add|remove|archive|assign|move|set)(_|$)/;

// Linear treats priority=0 and assignee=null as active filters, but small models commonly emit
// them as placeholders for omitted optional fields. Expose explicit booleans for those two
// searches and normalize every argument before the raw MCP tool receives it.
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

const LINEAR_LIST_ISSUES_INPUT_SCHEMA = jsonSchema<Record<string, unknown>>({
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "number", minimum: 1, maximum: 250 },
    cursor: { type: "string", description: "Next page cursor. Omit on the first page." },
    orderBy: { type: "string", enum: ["createdAt", "updatedAt"] },
    query: { type: "string", description: "Search issue title or description." },
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
    createdAt: { type: "string", description: "Created-after ISO-8601 date or duration." },
    updatedAt: { type: "string", description: "Updated-after ISO-8601 date or duration." },
    includeArchived: { type: "boolean", description: "Whether to include archived issues." },
  },
});

export const linearCapability: GoatCapabilityDefinition = {
  id: "linear",
  sideEffect: "write",
  workerModel: "openai/gpt-5.4-mini",
  async resolve(userWorkosId) {
    const state = await getGoatLinearIntegrationState(userWorkosId);
    if (!state.connected) return null;

    return {
      indexLine:
        "linear — reads the user's Linear workspace and creates issues on explicit request. CAN list and look up issues, projects, teams, users, comments, and documents; CAN create issues. CANNOT update issues, add comments, or delete anything.",
      recipeLines: [
        "To find issues, use list_issues with its filters (team, assignee, state, updatedAt ranges); do not use documentation search for workspace issues.",
        "Omit unused list_issues filters. Use unassigned=true only for explicitly unassigned work and unprioritized=true only for explicitly no-priority work.",
        "Resolve people or teams first when a filter needs an id the request only names.",
        "For an explicitly requested issue creation, resolve the team and named project or status only as needed, then call create_issue once for each requested issue. Preserve the requested title and description details.",
        "Before creating, search the target project for an exact-title match and reuse it instead of creating a duplicate. Never retry create_issue after an ambiguous provider error.",
        'Cite each issue you rely on as an entity: type "linear_issue", id set to the issue identifier (for example ENG-123), url set to the issue URL from the tool output.',
      ],
      createTools: createLinearTools,
    };
  },
};

async function createLinearTools(context: GoatCapabilityWorkerContext) {
  const connection = await loadGoatLinearMcpWorkerConnection({
    userWorkosId: context.userWorkosId,
    onAuthorizationRequired: () => {
      throw new GoatCapabilityAuthError(
        "auth_expired",
        "The Linear connection needs reauthorization; the user should reconnect Linear in Settings → Integrations.",
      );
    },
  });
  if (!connection.ok) {
    throw new GoatCapabilityAuthError(
      connection.reason === "not_connected" ? "not_connected" : "auth_expired",
      "Linear is not usable for this account; the user should reconnect Linear in Settings → Integrations.",
    );
  }

  const client = await createMCPClient({
    clientName: "opencompany-goat-capability",
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
    return {
      tools: selectLinearWorkerTools(rawTools, context.operation),
      close: async () => {
        await client.close().catch(() => {});
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

// The Linear MCP catalog is not split by side effect, so selection is the
// security boundary: read calls receive only prefix-safe reads; write calls add
// the explicit write allowlist and no other mutation.
export function selectLinearReadTools(rawTools: ToolSet): ToolSet {
  return selectLinearWorkerTools(rawTools, "read");
}

export function selectLinearWorkerTools(
  rawTools: ToolSet,
  operation: GoatCapabilityWorkerContext["operation"],
): ToolSet {
  const readNames = Object.keys(rawTools).filter(
    (name) => READ_TOOL_PATTERN.test(name) && !MUTATION_TOOL_PATTERN.test(name),
  );
  const allowedNames = [
    ...readNames,
    ...(operation === "write"
      ? ALLOWED_WRITE_TOOLS.filter((name) => Object.hasOwn(rawTools, name))
      : []),
  ];
  const preferredNames = [...PREFERRED_READ_TOOLS, ...ALLOWED_WRITE_TOOLS];
  const ordered = [
    ...preferredNames.filter((name) => allowedNames.includes(name)),
    ...allowedNames.filter((name) => !(preferredNames as readonly string[]).includes(name)),
  ].slice(0, operation === "write" ? MAX_LINEAR_WRITE_TOOLS : MAX_LINEAR_READ_TOOLS);

  const tools: ToolSet = {};
  let issueCreateCount = 0;
  for (const name of ordered) {
    const entry = rawTools[name];
    if (!entry) continue;
    tools[name] =
      name === "list_issues"
        ? safeLinearListIssuesTool(entry)
        : name === "create_issue"
          ? limitedLinearCreateIssueTool(entry, () => {
              issueCreateCount += 1;
              return issueCreateCount;
            })
          : entry;
  }
  return tools;
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
    throw new Error("Choose either a priority or unprioritized issues, not both.");
  }
  if (unprioritized) {
    normalized.priority = 0;
  } else if (priority === 1 || priority === 2 || priority === 3 || priority === 4) {
    normalized.priority = priority;
  }

  const assignee = normalized.assignee;
  const unassigned = input.unassigned === true;
  if (unassigned && assignee !== undefined) {
    throw new Error("Choose either an assignee or unassigned issues, not both.");
  }
  if (unassigned) normalized.assignee = null;

  return normalized;
}

type LinearWorkerTool = {
  execute?: (input: unknown, options: ToolExecutionOptions) => unknown | Promise<unknown>;
  [key: string]: unknown;
};

function safeLinearListIssuesTool(rawTool: ToolSet[string]): ToolSet[string] {
  const executableTool = rawTool as unknown as LinearWorkerTool;
  const execute = executableTool.execute?.bind(executableTool);
  if (!execute) return rawTool;

  return {
    ...executableTool,
    inputSchema: LINEAR_LIST_ISSUES_INPUT_SCHEMA,
    execute: (input: unknown, options: ToolExecutionOptions) =>
      execute(normalizeLinearListIssuesInput(input), options),
  } as unknown as ToolSet[string];
}

function limitedLinearCreateIssueTool(
  rawTool: ToolSet[string],
  nextCount: () => number,
): ToolSet[string] {
  const executableTool = rawTool as unknown as LinearWorkerTool;
  const execute = executableTool.execute?.bind(executableTool);
  if (!execute) return rawTool;
  let previousAttemptFailed = false;

  return {
    ...executableTool,
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      if (previousAttemptFailed) {
        throw new Error(
          "A previous create_issue attempt had an ambiguous failure, so it will not be retried.",
        );
      }
      if (nextCount() > MAX_LINEAR_ISSUE_CREATES_PER_CALL) {
        throw new Error(
          `A Linear worker call can create at most ${MAX_LINEAR_ISSUE_CREATES_PER_CALL} issues.`,
        );
      }
      try {
        return await execute(input, options);
      } catch (error) {
        previousAttemptFailed = true;
        throw error;
      }
    },
  } as unknown as ToolSet[string];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
