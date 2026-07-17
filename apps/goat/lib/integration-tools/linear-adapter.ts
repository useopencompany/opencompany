import { connectGoatLinearMcpClientForUser } from "@/lib/integrations/linear-mcp";
import type { IntegrationProviderExecutor } from "./dispatcher";
import type { IntegrationToolCard } from "./types";

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type McpToolBody = (input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>;

// Executes curated Linear tools against Linear's hosted MCP server. A fresh
// client is connected per call (mirroring the runner's task-side pattern) and
// the tool is resolved from the live catalog by name, so schema drift on
// Linear's side degrades into a recoverable "unknown tool" error rather than a
// stale local schema.
export function createLinearIntegrationExecutor(input: {
  userWorkosId: string;
  signal?: AbortSignal;
}): IntegrationProviderExecutor {
  return {
    execute: ({ tool, args }) =>
      withLinearMcpClient(input, async ({ bodies, definitions }) => {
        const body = bodies.get(tool.name);
        if (!body) throw unknownLinearToolError(tool, definitions);
        return body(args, { toolCallId: `goat_chat_linear_${tool.name}` });
      }),
    inspect: ({ tool }) =>
      withLinearMcpClient(input, async ({ definitions }) => {
        const definition = definitions.find((entry) => entry.name === tool.name);
        if (!definition) throw unknownLinearToolError(tool, definitions);
        return {
          inputSchema: definition.inputSchema ?? null,
          conventions: [
            ...(definition.description ? [definition.description] : []),
            "Executed on Linear's hosted MCP server with the user's connected Linear account.",
            "Issue ids accept Linear issue keys like ENG-123.",
          ],
        };
      }),
  };
}

async function withLinearMcpClient<T>(
  input: { userWorkosId: string; signal?: AbortSignal },
  run: (catalog: {
    definitions: McpToolDefinition[];
    bodies: Map<string, McpToolBody>;
  }) => Promise<T>,
): Promise<T> {
  const client = await connectGoatLinearMcpClientForUser(input.userWorkosId);
  try {
    const listed = await client.listTools({
      ...(input.signal ? { options: { signal: input.signal } } : {}),
    });
    const rawTools = client.toolsFromDefinitions(listed);
    const definitions: McpToolDefinition[] = (
      (listed as { tools?: McpToolDefinition[] }).tools ?? []
    ).map((entry) => ({
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.inputSchema !== undefined ? { inputSchema: entry.inputSchema } : {}),
    }));
    const bodies = new Map<string, McpToolBody>();
    for (const [name, rawTool] of Object.entries(rawTools)) {
      const execute = (rawTool as unknown as { execute?: McpToolBody }).execute;
      if (execute) bodies.set(name, execute);
    }
    return await run({ definitions, bodies });
  } finally {
    await client.close().catch(() => {});
  }
}

function unknownLinearToolError(tool: IntegrationToolCard, definitions: McpToolDefinition[]) {
  const available = definitions
    .map((entry) => entry.name)
    .slice(0, 40)
    .join(", ");
  return new Error(
    `Linear no longer exposes a "${tool.name}" tool. Available Linear tools: ${available || "none"}.`,
  );
}
