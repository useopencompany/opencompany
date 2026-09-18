import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  renderWikiToolContext,
  WIKI_TOOL_COMMANDS,
  WIKI_TOOL_DESCRIPTION,
  WIKI_TOOL_NAME,
  type WikiToolInput,
  type WikiToolOutput,
} from "@opencompany/wiki/tool";
import * as z from "zod/v4-mini";
import { mcpInvocationId } from "./mcp-invocation";

// Tool registration for the user-level opencompany MCP connector.
// API-owned wiki gateway injected by apps/api. The agent package never queries
// the wiki database: it asks the gateway which workspaces the user can reach and
// hands resolved commands back for in-process execution against the same
// application service the browser and runner use.
export type McpWikiGateway = {
  getAccess(userWorkosId: string): Promise<{
    workspaces: Array<{ id: string; name: string; slug: string | null }>;
  }>;
  execute(input: {
    userWorkosId: string;
    workspaceId: string;
    command: WikiToolInput;
    wikiId?: string;
    idempotencyKey: string;
  }): Promise<WikiToolOutput>;
};

export type McpToolContext = {
  userWorkosId: string;
  gatewayApiKey: string;
  wiki?: McpWikiGateway;
  onSuccessfulWikiCall?: () => Promise<void>;
  signal?: AbortSignal;
};

export function mcpTextToolResult(output: {
  ok: boolean;
  stdout?: string;
  stderr: string;
  parsed?: unknown;
  error?: string;
}) {
  const errorText = output.error || output.stderr || output.stdout || "Unknown error.";
  // Compact JSON: this text body mirrors structuredContent (per the MCP spec), so pretty-printing
  // it just doubles the already-duplicated payload with no reader benefit.
  const body = output.parsed !== undefined ? JSON.stringify(output.parsed) : (output.stdout ?? "");
  const structuredContent =
    output.parsed && typeof output.parsed === "object" && !Array.isArray(output.parsed)
      ? (output.parsed as Record<string, unknown>)
      : !output.ok
        ? { ok: false, error: errorText }
        : undefined;
  return {
    content: [
      {
        type: "text" as const,
        text: output.ok ? body : errorText,
      },
    ],
    ...(structuredContent ? { structuredContent } : {}),
    isError: !output.ok,
  };
}

// --- wiki -------------------------------------------------------------------------------------

const wikiNonEmptyString = z.string().check(z.minLength(1));

// Mirrors WIKI_TOOL_INPUT_JSON_SCHEMA in zod-mini (the MCP SDK wants a zod
// shape), plus an MCP-only `workspace` selector for users in several
// workspaces — chat resolves the workspace from the session instead.
const wikiToolMcpInputSchema = {
  command: z.enum([...WIKI_TOOL_COMMANDS]),
  wiki: z.optional(wikiNonEmptyString),
  depth: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(10))),
  pages: z.optional(
    z.union([
      wikiNonEmptyString,
      z.array(wikiNonEmptyString).check(z.minLength(1), z.maxLength(20)),
    ]),
  ),
  path: z.optional(wikiNonEmptyString),
  body: z.optional(z.string()),
  kind: z.optional(z.enum(["project", "person", "company", "research", "meeting", "other"])),
  title: z.optional(wikiNonEmptyString),
  query: z.optional(wikiNonEmptyString),
  since: z.optional(wikiNonEmptyString),
  to: z.optional(wikiNonEmptyString),
  recursive: z.optional(z.boolean()),
  ignoreCase: z.optional(z.boolean()),
  at: z.optional(wikiNonEmptyString),
  text: z.optional(wikiNonEmptyString),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  offset: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER))),
  workspace: z.optional(wikiNonEmptyString),
};

const WIKI_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerWikiTool(server: McpServer, ctx: McpToolContext) {
  server.registerTool(
    WIKI_TOOL_NAME,
    {
      title: "Workspace wiki",
      description: `${WIKI_TOOL_DESCRIPTION} Pass "workspace" (id or slug) when you belong to more than one workspace.`,
      inputSchema: wikiToolMcpInputSchema,
      annotations: WIKI_TOOL_ANNOTATIONS,
    },
    async (
      args: WikiToolInput & { workspace?: string | undefined },
      extra?: { requestId?: string | number; sessionId?: string },
    ) => {
      try {
        const wiki = ctx.wiki;
        if (!wiki) {
          return mcpTextToolResult({
            ok: false,
            stdout: "",
            stderr: "",
            error: "The wiki tool is not configured.",
          });
        }
        const access = await wiki.getAccess(ctx.userWorkosId);
        const wanted = args.workspace?.trim();
        const matches = wanted
          ? access.workspaces.filter(
              (workspace) => workspace.id === wanted || workspace.slug === wanted,
            )
          : access.workspaces;
        const workspace = matches.length === 1 ? matches[0] : undefined;
        if (!workspace) {
          const listing = access.workspaces
            .map((entry) => `- ${entry.id}${entry.slug ? ` (${entry.slug})` : ""} — ${entry.name}`)
            .join("\n");
          return mcpTextToolResult({
            ok: false,
            stdout: "",
            stderr: "",
            error:
              access.workspaces.length === 0
                ? "You are not a member of any workspace."
                : `Pass "workspace" with one of:\n${listing}`,
          });
        }
        const { workspace: _workspace, wiki: wikiId, ...command } = args;
        const idempotencyKey = mcpInvocationId(
          `wiki:${ctx.userWorkosId}:${workspace.id}`,
          extra?.sessionId,
          extra?.requestId,
        );
        const output = await wiki.execute({
          userWorkosId: ctx.userWorkosId,
          workspaceId: workspace.id,
          command,
          ...(wikiId ? { wikiId } : {}),
          idempotencyKey,
        });
        if (output.ok && ctx.onSuccessfulWikiCall) {
          try {
            await ctx.onSuccessfulWikiCall();
          } catch (error) {
            console.error("[opencompany] Failed to record MCP setup completion", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const result = mcpTextToolResult(
          output.ok
            ? { ok: true, stdout: "", stderr: "", parsed: output.result }
            : { ok: false, stdout: "", stderr: "", error: output.error },
        );
        return output.wikiContext
          ? {
              ...result,
              content: [
                { type: "text" as const, text: renderWikiToolContext(output.wikiContext) },
                ...result.content,
              ],
            }
          : result;
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
}
