import { createMCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
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

const MAX_LINEAR_WORKER_TOOLS = 12;

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

const READ_TOOL_PATTERN = /^(list|get|search)_/;
const MUTATION_TOOL_PATTERN = /(create|update|delete|add|remove|archive|assign|move|set)_/;

export const linearCapability: GoatCapabilityDefinition = {
  id: "linear",
  sideEffect: "read",
  workerModel: "openai/gpt-5.4-mini",
  async resolve(userWorkosId) {
    const state = await getGoatLinearIntegrationState(userWorkosId);
    if (!state.connected) return null;

    return {
      indexLine:
        "linear — reads the user's Linear workspace. CAN list and look up issues, projects, teams, users, comments, and documents. CANNOT create, update, comment on, or delete anything.",
      recipeLines: [
        "To find issues, use list_issues with its filters (team, assignee, state, updatedAt ranges); do not use documentation search for workspace issues.",
        "Resolve people or teams first when a filter needs an id the request only names.",
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
      tools: selectLinearReadTools(rawTools),
      close: async () => {
        await client.close().catch(() => {});
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

// The Linear MCP catalog is not split by side effect, so the read-only
// guarantee lives here: mutations are excluded by name, and only prefix-safe
// read tools pass, preferred ones first.
export function selectLinearReadTools(rawTools: ToolSet): ToolSet {
  const readNames = Object.keys(rawTools).filter(
    (name) => READ_TOOL_PATTERN.test(name) && !MUTATION_TOOL_PATTERN.test(name),
  );
  const ordered = [
    ...PREFERRED_READ_TOOLS.filter((name) => readNames.includes(name)),
    ...readNames.filter((name) => !(PREFERRED_READ_TOOLS as readonly string[]).includes(name)),
  ].slice(0, MAX_LINEAR_WORKER_TOOLS);

  const tools: ToolSet = {};
  for (const name of ordered) {
    const entry = rawTools[name];
    if (entry) tools[name] = entry;
  }
  return tools;
}
