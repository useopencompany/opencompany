import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainWithWorkspace } from "@opencompany/db/workspaces";
import { getBrainAccess, listAccessibleBrainsForUser } from "@opencompany/db/workspaces";
import {
  WIKI_TOOL_COMMANDS,
  WIKI_TOOL_DESCRIPTION,
  WIKI_TOOL_NAME,
  type WikiToolInput,
  type WikiToolOutput,
} from "@opencompany/wiki/tool";
import * as z from "zod/v4-mini";
import {
  type BrainCaptureResult,
  captureToBrainInbox as captureToSharedBrainInbox,
} from "./brain-capture";
import { runBrainToolForUser } from "./brain-cli";
import { nextAvailableBrainId } from "./brain-files";
import { normalizeBrainReadToolInput } from "./brain-surface";
import {
  BRAIN_ADVANCED_TOOL_DESCRIPTION,
  BRAIN_ADVANCED_TOOL_NAME,
  type BrainSelectorArgs,
  brainAdvancedInputSchema,
  coerceDocumentIds,
  GET_DOCUMENT_TOOL_DESCRIPTION,
  GET_DOCUMENT_TOOL_NAME,
  GET_TIMELINE_TOOL_DESCRIPTION,
  GET_TIMELINE_TOOL_NAME,
  type GetDocumentArgs,
  type GetTimelineArgs,
  getDocumentInputSchema,
  getDocumentToToolInput,
  getTimelineInputSchema,
  getTimelineToToolInput,
  LIST_BRAINS_TOOL_NAME,
  LIST_DOCUMENTS_TOOL_DESCRIPTION,
  LIST_DOCUMENTS_TOOL_NAME,
  type ListDocumentsArgs,
  listDocumentsInputSchema,
  listDocumentsToToolInput,
  resolveBrainParam,
  SAVE_TO_BRAIN_TOOL_DESCRIPTION,
  SAVE_TO_BRAIN_TOOL_NAME,
  SEARCH_BRAIN_TOOL_DESCRIPTION,
  SEARCH_BRAIN_TOOL_NAME,
  type SearchBrainArgs,
  saveToBrainInputSchema,
  searchBrainInputSchema,
  searchBrainToToolInput,
} from "./brain-tools";
import type { BrainToolInput } from "./chat-ui";

// Tool registration for the user-level opencompany MCP connector: one surface spanning
// every brain the token's user can access, addressed via an optional `brain`
// argument plus a `list_brains` tool. Reads are available to every brain member;
// captures preserve the same workspace-admin boundary as opencompany chat writes.
//
// The everyday surface is a small set of flat, intent-named tools (search_brain,
// get_document, list_documents, get_timeline) whose parameters match what an agent
// guesses without a system prompt. They map to the shared read engine via the pure
// mappers in brain-tools.ts. brain remains as an advanced escape hatch.
// API-owned wiki gateway injected by apps/api. The agent package never queries
// the wiki database: it asks the gateway which workspaces the user can reach and
// hands resolved commands back for in-process execution against the same
// application service the browser and runner use.
export type McpWikiGateway = {
  getAccess(userWorkosId: string): Promise<{
    enabled: boolean;
    workspaces: Array<{ id: string; name: string; slug: string | null }>;
  }>;
  execute(input: {
    userWorkosId: string;
    workspaceId: string;
    command: WikiToolInput;
    idempotencyKey: string;
  }): Promise<WikiToolOutput>;
};

export type McpToolContext = {
  userWorkosId: string;
  gatewayApiKey: string;
  wiki?: McpWikiGateway;
  signal?: AbortSignal;
};

const listBrainsOutputSchema = {
  workspaces: z.array(
    z.object({
      name: z.string(),
      brains: z.array(
        z.object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
          canSave: z.boolean(),
          description: z.optional(z.string()),
        }),
      ),
    }),
  ),
};

const saveToBrainOutputSchema = {
  ok: z.literal(true),
  status: z.literal("captured"),
  brainId: z.string(),
  draftId: z.string(),
  path: z.string(),
  title: z.string(),
  curation: z.enum(["queued", "paused_by_plan", "already_queued_or_completed"]),
};

const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CAPTURE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

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

function captureToBrainInbox(input: {
  brainRef: string;
  userWorkosId: string;
  text: string;
  title?: string;
  intent?: string;
  source: { kind: "mcp"; connectionId: string; itemId: string };
}): Promise<BrainCaptureResult> {
  const { userWorkosId, ...command } = input;
  return captureToSharedBrainInbox(
    { ...command, actorId: userWorkosId },
    { nextAvailableBrainId: nextAvailableBrainId },
  );
}

type BrainResolution =
  | { ok: true; brain: BrainWithWorkspace["brain"] }
  | { ok: false; error: string };

// Pure resolver for the `brain` argument: exact id first, then a unique slug
// (the default "general" slug repeats across workspaces, so slug hits can be
// ambiguous). Omitting the argument only works with one brain.
export function resolveMcpBrain(
  accessible: BrainWithWorkspace[],
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

function renderBrainList(brains: BrainWithWorkspace[]) {
  return brains
    .map(({ brain, workspace }) => `- ${brain.id} — "${brain.name}" (workspace: ${workspace.name})`)
    .join("\n");
}

export function registerBrainTools(server: McpServer, ctx: McpToolContext) {
  // Resolve the brain, then run a mapped read against the shared engine. Every flat read tool
  // funnels through here so brain resolution and error shaping stay identical.
  const run = async (selector: BrainSelectorArgs, toolInput: BrainToolInput) => {
    const accessible = await listAccessibleBrainsForUser(ctx.userWorkosId);
    const resolved = resolveMcpBrain(accessible, resolveBrainParam(selector));
    if (!resolved.ok) {
      return mcpTextToolResult({ ok: false, stdout: "", stderr: "", error: resolved.error });
    }
    const output = await runBrainToolForUser({
      brainRef: resolved.brain.id,
      userWorkosId: ctx.userWorkosId,
      toolInput,
      gatewayApiKey: ctx.gatewayApiKey,
      sourceRef: `mcp:${resolved.brain.id}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return mcpTextToolResult(output);
  };

  // Wrap a mapper so any synchronous mapping/validation error becomes a tool error result
  // instead of a thrown exception the transport would surface as a raw failure.
  const runMapped = async <A>(args: A, map: (args: A) => BrainToolInput) => {
    try {
      return await run(args as BrainSelectorArgs, map(args));
    } catch (error) {
      return mcpTextToolResult({
        ok: false,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  server.registerTool(
    SEARCH_BRAIN_TOOL_NAME,
    {
      title: "Search brain",
      description: SEARCH_BRAIN_TOOL_DESCRIPTION,
      inputSchema: searchBrainInputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async (args: SearchBrainArgs) => runMapped(args, searchBrainToToolInput),
  );

  server.registerTool(
    GET_DOCUMENT_TOOL_NAME,
    {
      title: "Get brain document",
      description: GET_DOCUMENT_TOOL_DESCRIPTION,
      inputSchema: getDocumentInputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async (args: GetDocumentArgs) => {
      if (coerceDocumentIds(args).length === 0) {
        return mcpTextToolResult({
          ok: false,
          stdout: "",
          stderr: "",
          error:
            'get_document needs at least one id. Pass "ids" (one id or a list) from a search_brain or list_documents hit.',
        });
      }
      return runMapped(args, getDocumentToToolInput);
    },
  );

  server.registerTool(
    LIST_DOCUMENTS_TOOL_NAME,
    {
      title: "List brain documents",
      description: LIST_DOCUMENTS_TOOL_DESCRIPTION,
      inputSchema: listDocumentsInputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async (args: ListDocumentsArgs) => runMapped(args, listDocumentsToToolInput),
  );

  server.registerTool(
    GET_TIMELINE_TOOL_NAME,
    {
      title: "Get brain document timeline",
      description: GET_TIMELINE_TOOL_DESCRIPTION,
      inputSchema: getTimelineInputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async (args: GetTimelineArgs) => runMapped(args, getTimelineToToolInput),
  );

  server.registerTool(
    BRAIN_ADVANCED_TOOL_NAME,
    {
      title: "opencompany brain (advanced)",
      description: BRAIN_ADVANCED_TOOL_DESCRIPTION,
      inputSchema: brainAdvancedInputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async (args) => runMapped(args, normalizeBrainReadToolInput),
  );

  server.registerTool(
    LIST_BRAINS_TOOL_NAME,
    {
      title: "List brains",
      description:
        'List every opencompany brain you can access, grouped by workspace. Each brain reports whether you can save to it. Use a returned id as the "brain" argument for other tools.',
      inputSchema: {},
      outputSchema: listBrainsOutputSchema,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => {
      const accessible = await listAccessibleBrainsForUser(ctx.userWorkosId);
      const workspaces = new Map<string, { name: string; brains: unknown[] }>();
      for (const { brain, workspace, workspaceRole } of accessible) {
        const entry = workspaces.get(workspace.id) ?? {
          name: workspace.name,
          brains: [],
        };
        entry.brains.push({
          id: brain.id,
          slug: brain.slug,
          name: brain.name,
          canSave: workspaceRole === "admin",
          ...(brain.description ? { description: brain.description } : {}),
        });
        workspaces.set(workspace.id, entry);
      }
      return mcpTextToolResult({
        ok: true,
        stdout: "",
        stderr: "",
        parsed: { workspaces: [...workspaces.values()] },
      });
    },
  );

  server.registerTool(
    SAVE_TO_BRAIN_TOOL_NAME,
    {
      title: "Save to opencompany brain",
      description: SAVE_TO_BRAIN_TOOL_DESCRIPTION,
      inputSchema: saveToBrainInputSchema,
      outputSchema: saveToBrainOutputSchema,
      annotations: CAPTURE_TOOL_ANNOTATIONS,
    },
    async ({ content, title, intent, ...selector }) => {
      try {
        const accessible = await listAccessibleBrainsForUser(ctx.userWorkosId);
        const resolved = resolveMcpBrain(accessible, resolveBrainParam(selector));
        if (!resolved.ok) {
          return mcpTextToolResult({
            ok: false,
            stdout: "",
            stderr: "",
            error: resolved.error,
          });
        }

        const access = await getBrainAccess({
          userWorkosId: ctx.userWorkosId,
          brainRef: resolved.brain.id,
        });
        if (access?.workspaceRole !== "admin") {
          return mcpTextToolResult({
            ok: false,
            stdout: "",
            stderr: "",
            error: "Only workspace admins can save content to this brain.",
          });
        }

        const itemId = `capture_${randomUUID()}`;
        const captured = await captureToBrainInbox({
          brainRef: resolved.brain.id,
          userWorkosId: ctx.userWorkosId,
          text: content,
          ...(title ? { title } : {}),
          ...(intent ? { intent } : {}),
          source: {
            kind: "mcp",
            connectionId: `mcp:${resolved.brain.id}`,
            itemId,
          },
        });
        if (!captured.ok) {
          return mcpTextToolResult({
            ok: false,
            stdout: "",
            stderr: "",
            error: captured.error,
          });
        }

        return mcpTextToolResult({
          ok: true,
          stdout: "",
          stderr: "",
          parsed: {
            ok: true,
            status: "captured",
            brainId: resolved.brain.id,
            draftId: captured.draftBrainId,
            path: captured.path,
            title: captured.title,
            curation: captured.quotaPaused
              ? "paused_by_plan"
              : captured.enqueued
                ? "queued"
                : "already_queued_or_completed",
          },
        });
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

// --- wiki (preview) ---------------------------------------------------------------------------

const wikiNonEmptyString = z.string().check(z.minLength(1));

// Mirrors WIKI_TOOL_INPUT_JSON_SCHEMA in zod-mini (the MCP SDK wants a zod
// shape), plus an MCP-only `workspace` selector for users in several
// workspaces — chat resolves the workspace from the session instead.
const wikiToolMcpInputSchema = {
  command: z.enum([...WIKI_TOOL_COMMANDS]),
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
      title: "Workspace wiki (preview)",
      description: `${WIKI_TOOL_DESCRIPTION} Available only to users who enabled the wiki preview in Preferences; pass "workspace" (id or slug) when you belong to more than one workspace.`,
      inputSchema: wikiToolMcpInputSchema,
      annotations: WIKI_TOOL_ANNOTATIONS,
    },
    async (
      args: WikiToolInput & { workspace?: string | undefined },
      extra?: { requestId?: string | number },
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
        if (!access.enabled) {
          return mcpTextToolResult({
            ok: false,
            stdout: "",
            stderr: "",
            error:
              "The wiki preview is not enabled for this user. Enable it under Preferences in the app.",
          });
        }
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
        const { workspace: _workspace, ...command } = args;
        // Stable within the authenticated MCP request; distinct requests get
        // distinct keys so intentional repeat calls are not collapsed.
        const idempotencyKey = `mcp-wiki:${ctx.userWorkosId}:${workspace.id}:${extra?.requestId ?? "request"}`;
        const output = await wiki.execute({
          userWorkosId: ctx.userWorkosId,
          workspaceId: workspace.id,
          command,
          idempotencyKey,
        });
        return mcpTextToolResult(
          output.ok
            ? { ok: true, stdout: "", stderr: "", parsed: output.result }
            : { ok: false, stdout: "", stderr: "", error: output.error },
        );
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
