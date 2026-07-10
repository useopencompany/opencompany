import { getDb } from "@opencompany/db/client";
import { goatBrains, goatWorkspaces } from "@opencompany/db/goat-schema";
import { getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { eq } from "drizzle-orm";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import * as z from "zod/v4-mini";
import {
  GOAT_BRAIN_READ_COMMANDS,
  normalizeGoatBrainReadToolInput,
} from "@/lib/brain-surface";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import { GOAT_BRAIN_TOOL_NAME, type GoatBrainToolInput } from "@/lib/chat-ui";
import {
  buildGoatMcpResourceMetadataPath,
  resolveGoatAuthKitDomain,
  userWorkosIdFromMcpAuth,
  verifyGoatMcpBearerToken,
  workosOrganizationIdFromMcpAuth,
} from "@/lib/mcp-oauth";

export const runtime = "nodejs";
export const maxDuration = 120;

type RouteContext = {
  params: Promise<{
    brainRef: string;
    transport: string;
  }>;
};

type McpBrain = NonNullable<Awaited<ReturnType<typeof getGoatBrainAccess>>>["brain"];
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

type BrainAccessResult =
  | {
      ok: true;
      brain: McpBrain;
      workosOrganizationId: string;
    }
  | {
      ok: false;
      status: 403 | 404 | 503;
      error: string;
    };

async function handleMcpRequest(request: Request, context: RouteContext) {
  const { brainRef, transport } = await context.params;
  if (transport !== "mcp") {
    return Response.json({ error: "MCP transport not found." }, { status: 404 });
  }

  const authConfig = resolveGoatAuthKitDomain();
  if (!authConfig.ok) {
    return Response.json({ error: authConfig.error }, { status: 503 });
  }

  const authHandler = withMcpAuth(
    async (authenticatedRequest) => {
      const userWorkosId = userWorkosIdFromMcpAuth(authenticatedRequest.auth);
      if (!userWorkosId) {
        return Response.json({ error: "Invalid MCP authentication context." }, { status: 401 });
      }
      const tokenOrganizationId = workosOrganizationIdFromMcpAuth(authenticatedRequest.auth);

      const access = await loadMcpBrainAccess({ userWorkosId, brainRef });
      if (!access.ok) {
        return Response.json({ error: access.error }, { status: access.status });
      }
      if (!tokenOrganizationId || tokenOrganizationId !== access.workosOrganizationId) {
        return Response.json(
          { error: "MCP token was issued for a different workspace." },
          { status: 403 },
        );
      }

      const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
      if (!gatewayApiKey) {
        return Response.json({ error: "Goat brain MCP is not configured." }, { status: 503 });
      }

      const handler = createMcpHandler(
        (server) => {
          const runMcpGoatBrainTool = async (toolInput: GoatBrainToolInput) => {
            const output = await runGoatBrainToolForUser({
              brainRef,
              userWorkosId,
              toolInput,
              gatewayApiKey,
              sourceRef: `mcp:${brainRef}`,
              signal: authenticatedRequest.signal,
            });
            return mcpTextToolResult(output);
          };

          server.registerTool(
            GOAT_BRAIN_TOOL_NAME,
            {
              title: "Goat brain",
              description: `Read the "${access.brain.name}" knowledge brain using the same read-only goat_brain command surface as OpenCompany chat. Use query for recall/search, list for inventory, get for known ids, timeline for dated evidence, doctor for validation, and help for usage. Query/timeline since accepts relative windows like 6h, 2d, 1w or an ISO-8601 timestamp.`,
              inputSchema: goatBrainInputSchema,
            },
            async (args) => {
              try {
                return await runMcpGoatBrainTool(normalizeGoatBrainReadToolInput(args));
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
              description: `Compatibility wrapper over goat_brain query for the "${access.brain.name}" knowledge brain. Prefer goat_brain for the full shared read surface.`,
              inputSchema: queryBrainInputSchema,
            },
            async ({
              text,
              folder,
              limit,
              type,
              kind,
              since,
              hops,
              lexicalOnly,
              includeMerged,
              includeArchived,
            }) =>
              runMcpGoatBrainTool({
                command: "query",
                flags: {
                  text,
                  ...(folder ? { folder } : {}),
                  ...(type ? { type } : {}),
                  ...(kind ? { kind } : {}),
                  ...(since ? { since } : {}),
                  ...(hops !== undefined ? { hops } : {}),
                  limit: limit ?? 10,
                  ...(lexicalOnly ? { lexicalOnly } : {}),
                  ...(includeMerged ? { includeMerged } : {}),
                  ...(includeArchived ? { includeArchived } : {}),
                  json: true,
                },
              }),
          );
          server.registerTool(
            "get_document",
            {
              title: "Get brain document",
              description: `Compatibility wrapper over goat_brain get for the "${access.brain.name}" knowledge brain. Prefer goat_brain for the full shared read surface.`,
              inputSchema: getDocumentInputSchema,
            },
            async ({ ids }) =>
              runMcpGoatBrainTool({
                command: "get",
                flags: { id: ids, json: true },
              }),
          );
        },
        {
          serverInfo: {
            name: "goat-brain",
            version: "0.1.0",
          },
        },
        {
          basePath: `/api/mcp/${brainRef}`,
          disableSse: true,
          maxDuration,
        },
      );

      return handler(authenticatedRequest);
    },
    verifyGoatMcpBearerToken,
    {
      required: true,
      resourceMetadataPath: buildGoatMcpResourceMetadataPath(brainRef),
    },
  );

  return authHandler(request);
}

async function loadMcpBrainAccess(input: {
  userWorkosId: string;
  brainRef: string;
}): Promise<BrainAccessResult> {
  const access = await getGoatBrainAccess({
    userWorkosId: input.userWorkosId,
    brainRef: input.brainRef,
  });
  const db = getDb();
  if (access) {
    const [workspace] = await db
      .select({ workosOrganizationId: goatWorkspaces.workosOrganizationId })
      .from(goatWorkspaces)
      .where(eq(goatWorkspaces.id, access.brain.workspaceId))
      .limit(1);
    if (!workspace?.workosOrganizationId) {
      return { ok: false, status: 503, error: "Workspace organization is not configured." };
    }
    return {
      ok: true,
      brain: access.brain,
      workosOrganizationId: workspace.workosOrganizationId,
    };
  }

  const [brain] = await db
    .select({ id: goatBrains.id })
    .from(goatBrains)
    .where(eq(goatBrains.id, input.brainRef))
    .limit(1);

  if (!brain) {
    return { ok: false, status: 404, error: "Brain not found." };
  }
  return { ok: false, status: 403, error: "You do not have access to this brain." };
}

function mcpTextToolResult(output: {
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

export { handleMcpRequest as DELETE, handleMcpRequest as GET, handleMcpRequest as POST };
