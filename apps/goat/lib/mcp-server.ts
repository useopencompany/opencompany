import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoatBrainWithWorkspace } from "@opencompany/db/goat-workspaces";
import { listAccessibleGoatBrainsForUser } from "@opencompany/db/goat-workspaces";
import * as z from "zod/v4-mini";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import { GOAT_BRAIN_READ_COMMANDS, normalizeGoatBrainReadToolInput } from "@/lib/brain-surface";
import { GOAT_BRAIN_TOOL_NAME, type GoatBrainToolInput } from "@/lib/chat-ui";

// Tool registration for the user-level Goat MCP connector: one read-only
// surface spanning every brain the token's user can access, addressed via an
// optional `brain` argument plus a `list_brains` tool.
export type GoatMcpToolContext = {
  userWorkosId: string;
  gatewayApiKey: string;
  signal?: AbortSignal;
};

const queryBrainInputSchema = {
  text: z.string().check(z.minLength(1)),
  folder: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
  type: z.optional(z.string().check(z.minLength(1))),
  kind: z.optional(z.enum(["page", "evidence"])),
  since: z.optional(z.string().check(z.minLength(1))),
  hops: z.optional(z.number().check(z.int(), z.minimum(0))),
  lexicalOnly: z.optional(z.boolean()),
  includeMerged: z.optional(z.boolean()),
  includeArchived: z.optional(z.boolean()),
};

const getDocumentInputSchema = {
  ids: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(20)),
};

const goatBrainFlagValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

const goatBrainInputSchema = {
  command: z.enum([...GOAT_BRAIN_READ_COMMANDS]),
  flags: z.optional(z.record(z.string(), goatBrainFlagValueSchema)),
  stdin: z.optional(z.string()),
};

const brainArgSchema = {
  brain: z.optional(z.string().check(z.minLength(1))),
};

export function mcpTextToolResult(output: {
  ok: boolean;
  stdout: string;
  stderr: string;
  parsed?: unknown;
  error?: string;
}) {
  const body = output.parsed ? JSON.stringify(output.parsed, null, 2) : output.stdout;
  return {
    content: [
      {
        type: "text" as const,
        text: output.ok ? body : output.error || output.stderr || output.stdout || "Unknown error.",
      },
    ],
    isError: !output.ok,
  };
}

type BrainResolution =
  | { ok: true; brain: GoatBrainWithWorkspace["brain"] }
  | { ok: false; error: string };

// Pure resolver for the `brain` argument: exact id first, then a unique slug
// (the default "general" slug repeats across workspaces, so slug hits can be
// ambiguous). Omitting the argument only works with one brain.
export function resolveGoatMcpBrain(
  accessible: GoatBrainWithWorkspace[],
  brainParam: string | undefined,
): BrainResolution {
  const wanted = brainParam?.trim();
  const only = accessible.length === 1 ? accessible[0] : undefined;
  if (!wanted) {
    if (only) return { ok: true, brain: only.brain };
    if (accessible.length === 0) {
      return { ok: false, error: "You do not have access to any brains yet." };
    }
    return {
      ok: false,
      error: `Multiple brains are available. Pass "brain" with one of these ids:\n${renderBrainList(accessible)}`,
    };
  }

  const byId = accessible.find(({ brain }) => brain.id === wanted);
  if (byId) return { ok: true, brain: byId.brain };

  const bySlug = accessible.filter(({ brain }) => brain.slug === wanted);
  const onlySlugMatch = bySlug.length === 1 ? bySlug[0] : undefined;
  if (onlySlugMatch) return { ok: true, brain: onlySlugMatch.brain };
  if (bySlug.length > 1) {
    return {
      ok: false,
      error: `The slug "${wanted}" matches brains in more than one workspace. Pass one of these ids instead:\n${renderBrainList(bySlug)}`,
    };
  }
  return {
    ok: false,
    error: `No accessible brain matches "${wanted}". Call list_brains to see what you can access.`,
  };
}

function renderBrainList(brains: GoatBrainWithWorkspace[]) {
  return brains
    .map(({ brain, workspace }) => `- ${brain.id} — "${brain.name}" (workspace: ${workspace.name})`)
    .join("\n");
}

function queryToolInput(input: {
  text: string;
  folder?: string | undefined;
  limit?: number | undefined;
  type?: string | undefined;
  kind?: "page" | "evidence" | undefined;
  since?: string | undefined;
  hops?: number | undefined;
  lexicalOnly?: boolean | undefined;
  includeMerged?: boolean | undefined;
  includeArchived?: boolean | undefined;
}): GoatBrainToolInput {
  return {
    command: "query",
    flags: {
      text: input.text,
      ...(input.folder ? { folder: input.folder } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.hops !== undefined ? { hops: input.hops } : {}),
      limit: input.limit ?? 10,
      ...(input.lexicalOnly ? { lexicalOnly: input.lexicalOnly } : {}),
      ...(input.includeMerged ? { includeMerged: input.includeMerged } : {}),
      ...(input.includeArchived ? { includeArchived: input.includeArchived } : {}),
      json: true,
    },
  };
}

export function registerGoatBrainTools(server: McpServer, ctx: GoatMcpToolContext) {
  const brainArgHint =
    'Pass "brain" (id, or slug when unique) to choose a brain; omit it if you only have one. Call list_brains to see what you can access.';

  const run = async (brainParam: string | undefined, toolInput: GoatBrainToolInput) => {
    const accessible = await listAccessibleGoatBrainsForUser(ctx.userWorkosId);
    const resolved = resolveGoatMcpBrain(accessible, brainParam);
    if (!resolved.ok) {
      return mcpTextToolResult({ ok: false, stdout: "", stderr: "", error: resolved.error });
    }
    const output = await runGoatBrainToolForUser({
      brainRef: resolved.brain.id,
      userWorkosId: ctx.userWorkosId,
      toolInput,
      gatewayApiKey: ctx.gatewayApiKey,
      sourceRef: `mcp:${resolved.brain.id}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return mcpTextToolResult(output);
  };

  server.registerTool(
    GOAT_BRAIN_TOOL_NAME,
    {
      title: "Goat brain",
      description: `Read your Goat knowledge brains using the same read-only goat_brain command surface as OpenCompany chat. Use query for recall/search, list for inventory, get for known ids, timeline for dated evidence, doctor for validation, and help for usage. ${brainArgHint} Query/timeline since accepts relative windows like 6h, 2d, 1w or an ISO-8601 timestamp.`,
      inputSchema: { ...goatBrainInputSchema, ...brainArgSchema },
    },
    async (args) => {
      try {
        return await run(args.brain, normalizeGoatBrainReadToolInput(args));
      } catch (error) {
        return mcpTextToolResult({
          ok: false,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  server.registerTool(
    "query_brain",
    {
      title: "Query brain",
      description: `Compatibility wrapper over goat_brain query for your Goat knowledge brains. Prefer goat_brain for the full shared read surface. ${brainArgHint}`,
      inputSchema: { ...queryBrainInputSchema, ...brainArgSchema },
    },
    async ({ brain, ...args }) => run(brain, queryToolInput(args)),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get brain document",
      description: `Compatibility wrapper over goat_brain get for your Goat knowledge brains. Prefer goat_brain for the full shared read surface. ${brainArgHint}`,
      inputSchema: { ...getDocumentInputSchema, ...brainArgSchema },
    },
    async ({ brain, ids }) => run(brain, { command: "get", flags: { id: ids, json: true } }),
  );

  server.registerTool(
    "list_brains",
    {
      title: "List brains",
      description:
        'List every Goat brain you can access, grouped by workspace. Use a returned id as the "brain" argument for goat_brain, query_brain, and get_document.',
      inputSchema: {},
    },
    async () => {
      const accessible = await listAccessibleGoatBrainsForUser(ctx.userWorkosId);
      const workspaces = new Map<string, { name: string; brains: unknown[] }>();
      for (const { brain, workspace } of accessible) {
        const entry = workspaces.get(workspace.id) ?? { name: workspace.name, brains: [] };
        entry.brains.push({
          id: brain.id,
          slug: brain.slug,
          name: brain.name,
          ...(brain.description ? { description: brain.description } : {}),
        });
        workspaces.set(workspace.id, entry);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ workspaces: [...workspaces.values()] }, null, 2),
          },
        ],
      };
    },
  );
}
