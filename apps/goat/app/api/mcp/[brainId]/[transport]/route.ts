import { getDb } from "@opencompany/db/client";
import { goatBrains } from "@opencompany/db/goat-schema";
import { getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { eq } from "drizzle-orm";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import * as z from "zod/v4-mini";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import {
  buildGoatMcpResourceMetadataPath,
  resolveGoatAuthKitDomain,
  userWorkosIdFromMcpAuth,
  verifyGoatMcpBearerToken,
} from "@/lib/mcp-oauth";

export const runtime = "nodejs";
export const maxDuration = 120;

type RouteContext = {
  params: Promise<{
    brainId: string;
    transport: string;
  }>;
};

type McpBrain = NonNullable<Awaited<ReturnType<typeof getGoatBrainAccess>>>["brain"];
const queryBrainInputSchema = {
  text: z.string().check(z.minLength(1)),
  folder: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50))),
};

const getDocumentInputSchema = {
  ids: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(20)),
};

type BrainAccessResult =
  | {
      ok: true;
      brain: McpBrain;
    }
  | {
      ok: false;
      status: 403 | 404;
      error: string;
    };

async function handleMcpRequest(request: Request, context: RouteContext) {
  const { brainId, transport } = await context.params;
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

      const access = await loadMcpBrainAccess({ userWorkosId, brainId });
      if (!access.ok) {
        return Response.json({ error: access.error }, { status: access.status });
      }

      const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
      if (!gatewayApiKey) {
        return Response.json({ error: "Goat brain MCP is not configured." }, { status: 503 });
      }

      const handler = createMcpHandler(
        (server) => {
          server.registerTool(
            "query_brain",
            {
              title: "Query brain",
              description: `Search the "${access.brain.name}" knowledge brain for people, companies, projects, decisions, notes, and related context.`,
              inputSchema: queryBrainInputSchema,
            },
            async ({ text, folder, limit }) => {
              const output = await runGoatBrainToolForUser({
                brainRef: brainId,
                userWorkosId,
                toolInput: {
                  command: "query",
                  flags: {
                    text,
                    ...(folder ? { folder } : {}),
                    limit: limit ?? 10,
                    json: true,
                  },
                },
                gatewayApiKey,
                sourceRef: `mcp:${brainId}`,
                signal: authenticatedRequest.signal,
              });
              const body = output.parsed ? JSON.stringify(output.parsed, null, 2) : output.stdout;

              return {
                content: [
                  {
                    type: "text" as const,
                    text: output.ok
                      ? body
                      : `Query failed: ${
                          output.error || output.stderr || output.stdout || "Unknown error."
                        }`,
                  },
                ],
                isError: !output.ok,
              };
            },
          );
          server.registerTool(
            "get_document",
            {
              title: "Get brain document",
              description: `Fetch full documents from the "${access.brain.name}" knowledge brain by id (aliases resolve too): compiled truth, recent timeline, and linked pages. Use after query_brain to read a hit in full or follow its links.`,
              inputSchema: getDocumentInputSchema,
            },
            async ({ ids }) => {
              const output = await runGoatBrainToolForUser({
                brainRef: brainId,
                userWorkosId,
                toolInput: {
                  command: "get",
                  flags: { id: ids, json: true },
                },
                gatewayApiKey,
                sourceRef: `mcp:${brainId}`,
                signal: authenticatedRequest.signal,
              });
              const body = output.parsed ? JSON.stringify(output.parsed, null, 2) : output.stdout;

              return {
                content: [
                  {
                    type: "text" as const,
                    text: output.ok
                      ? body
                      : `Get failed: ${
                          output.error || output.stderr || output.stdout || "Unknown error."
                        }`,
                  },
                ],
                isError: !output.ok,
              };
            },
          );
        },
        {
          serverInfo: {
            name: "goat-brain",
            version: "0.1.0",
          },
        },
        {
          basePath: `/api/mcp/${brainId}`,
          disableSse: true,
          maxDuration,
        },
      );

      return handler(authenticatedRequest);
    },
    verifyGoatMcpBearerToken,
    {
      required: true,
      resourceMetadataPath: buildGoatMcpResourceMetadataPath(brainId),
    },
  );

  return authHandler(request);
}

async function loadMcpBrainAccess(input: {
  userWorkosId: string;
  brainId: string;
}): Promise<BrainAccessResult> {
  const access = await getGoatBrainAccess({
    userWorkosId: input.userWorkosId,
    brainRef: input.brainId,
  });
  if (access) return { ok: true, brain: access.brain };

  const db = getDb();
  const [brain] = await db
    .select({ id: goatBrains.id })
    .from(goatBrains)
    .where(eq(goatBrains.id, input.brainId))
    .limit(1);

  if (!brain) {
    return { ok: false, status: 404, error: "Brain not found." };
  }
  return { ok: false, status: 403, error: "You do not have access to this brain." };
}

export { handleMcpRequest as DELETE, handleMcpRequest as GET, handleMcpRequest as POST };
