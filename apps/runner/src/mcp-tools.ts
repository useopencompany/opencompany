import { randomUUID } from "node:crypto";
import {
  createMCPClient,
  type MCPClient,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import {
  type AgentConfig,
  MCP_SEARCH_TOOLS_RAW_NAME,
  MCP_USE_TOOL_RAW_NAME,
  mcpSearchToolsName,
  mcpUseToolName,
  newAgentSessionMessageId,
  type ToolArgResolution,
  type WorkspaceToolPolicyMap,
} from "@opencompany/agent-runtime";
import {
  buildAad,
  decryptJson,
  ENCRYPTION_ALGORITHM,
  type EncryptedPayload,
  EncryptionKeyConfigError,
  encryptJson,
} from "@opencompany/crypto";
import { workspaceMcpCredentials, workspaceMcpServers } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { jsonSchema, type ToolSet, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import {
  appendRuntimeEventForLease,
  insertToolMessageForLease,
  requireLeaseWrite,
} from "./lease-writes";
import {
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";
import type { RunControlCheck } from "./run-control";
import { prepareToolArgs, type ToolArgRepairConfig } from "./tool-arg-repair";
import {
  formatRuntimePreview,
  persistDeniedToolResult,
  SUSPENDED_TOOL_OUTPUT,
} from "./tool-dispatcher";
import type { ToolStartCoordinator } from "./tool-start-coordinator";

const LINEAR_MCP_SERVER_KEY = "linear";
const LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const SLACK_MCP_SERVER_KEY = "slack";
const SLACK_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const POSTHOG_MCP_SERVER_KEY = "posthog";
const POSTHOG_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const BETTERSTACK_MCP_SERVER_KEY = "betterstack";
const BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const BRAINTRUST_MCP_SERVER_KEY = "braintrust";
const BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const NOTION_MCP_SERVER_KEY = "notion";
const NOTION_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY = "default";
const SLACK_READ_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "files:read",
  "emoji:read",
  "users:read",
  "users:read.email",
  "channels:read",
  "groups:read",
  "mpim:read",
];
const ENCRYPTION_KEY_VERSION = 1;
const logger = createLogger({ service: "opencompany-runner" });

export type McpProviderKey =
  | typeof LINEAR_MCP_SERVER_KEY
  | typeof SLACK_MCP_SERVER_KEY
  | typeof POSTHOG_MCP_SERVER_KEY
  | typeof BETTERSTACK_MCP_SERVER_KEY
  | typeof BRAINTRUST_MCP_SERVER_KEY
  | typeof NOTION_MCP_SERVER_KEY;

type McpProvider = {
  key: McpProviderKey;
  displayName: string;
  oauthCredentialKind: string;
  supportsBearerToken: boolean;
  staticClientEnv?: {
    clientId: string;
    clientSecret: string;
  };
  scopes?: string[];
};

type LoadedMcpConnection = {
  endpointUrl: string;
  serverId: string;
  accountKey: string;
  accountLabel: string;
  accountEmail: string | null;
  auth: { type: "oauth"; payload: McpOAuthPayload } | { type: "bearer"; bearerToken: string };
};

const MCP_PROVIDER_CATALOG: Record<McpProviderKey, McpProvider> = {
  linear: {
    key: LINEAR_MCP_SERVER_KEY,
    displayName: "Linear",
    oauthCredentialKind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
    supportsBearerToken: true,
  },
  slack: {
    key: SLACK_MCP_SERVER_KEY,
    displayName: "Slack",
    oauthCredentialKind: SLACK_MCP_OAUTH_CREDENTIAL_KIND,
    supportsBearerToken: false,
    staticClientEnv: {
      clientId: "SLACK_MCP_CLIENT_ID",
      clientSecret: "SLACK_MCP_CLIENT_SECRET",
    },
    scopes: SLACK_READ_SCOPES,
  },
  posthog: {
    key: POSTHOG_MCP_SERVER_KEY,
    displayName: "PostHog",
    oauthCredentialKind: POSTHOG_MCP_OAUTH_CREDENTIAL_KIND,
    // OAuth-only with Dynamic Client Registration (no static client) — same as Linear.
    supportsBearerToken: false,
  },
  betterstack: {
    key: BETTERSTACK_MCP_SERVER_KEY,
    displayName: "Better Stack",
    oauthCredentialKind: BETTERSTACK_MCP_OAUTH_CREDENTIAL_KIND,
    // OAuth-only with Dynamic Client Registration (no static client) — same as PostHog.
    supportsBearerToken: false,
  },
  braintrust: {
    key: BRAINTRUST_MCP_SERVER_KEY,
    displayName: "Braintrust",
    oauthCredentialKind: BRAINTRUST_MCP_OAUTH_CREDENTIAL_KIND,
    // OAuth-only with Dynamic Client Registration (no static client) — same as Linear/PostHog.
    supportsBearerToken: false,
  },
  notion: {
    key: NOTION_MCP_SERVER_KEY,
    displayName: "Notion",
    oauthCredentialKind: NOTION_MCP_OAUTH_CREDENTIAL_KIND,
    // OAuth-only with Dynamic Client Registration (no static client) — same as Braintrust.
    supportsBearerToken: false,
  },
};

type McpToolContext = {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId: string;
  agentConfig: AgentConfig;
  integrationCredentialEncryptionKey: Buffer;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  toolStartCoordinator: ToolStartCoordinator;
  policy: WorkspaceToolPolicyMap;
  suspendable: boolean;
  // Config for the model-based argument repair fallback (Layer 3). Deterministic validation +
  // coercion run regardless; this only gates the small-model call. Threaded from the runner env.
  toolArgRepair?: ToolArgRepairConfig | undefined;
  observabilityContext?: {
    workspaceId?: string;
    userId?: string;
    agentId?: string;
    modelProvider?: string;
    modelName?: string;
  };
};

export type McpToolSet = {
  tools: ToolSet;
  close: () => Promise<void>;
  // Execute an MCP tool body directly (bypassing the stream gate) for an approval resume.
  // Returns null when no MCP tool with that prefixed name is connected. Persists the
  // tool-result message + tool.completed/failed event just like the in-stream path.
  runApprovedTool: (input: {
    toolName: string;
    toolCallId: string;
    args: unknown;
  }) => Promise<unknown> | null;
};

export async function createMcpToolSet(input: McpToolContext): Promise<McpToolSet> {
  const requestedProviders = requestedMcpProviders(input.agentConfig);
  if (requestedProviders.length === 0) return emptyMcpToolSet();

  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const usedNames = new Set<string>();
  // Keyed by both meta-tool names (`{server}__search_tools` / `{server}__use_tool`) so
  // an approval resume can re-dispatch either without re-deriving which provider it hit.
  const providerByToolName = new Map<string, ConnectedMcpProvider>();

  // Park on the approval gate, then run the body — shared by both meta-tools. A suspend
  // returns a discarded no-op (body runs in the resume run); a deny persists the
  // permission_denied result; an allow runs `run()`.
  async function runGatedMetaTool(opts: {
    toolName: string;
    toolCallId: string;
    run: () => Promise<unknown>;
  }) {
    const verdict = await input.toolStartCoordinator.waitForStarted(opts.toolCallId, input.signal);
    if (verdict.decision === "suspend") return SUSPENDED_TOOL_OUTPUT;
    if (verdict.decision === "deny") {
      return persistDeniedToolResult({
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        runLeaseId: input.runLeaseId,
        runLeaseOwner: input.runLeaseOwner,
        internalMessages: input.internalMessages,
        toolCallId: opts.toolCallId,
        toolName: opts.toolName,
        verdict,
      });
    }
    return opts.run();
  }

  function recordMetaToolStart(name: string) {
    return async ({ input: toolInput, toolCallId }: { input: unknown; toolCallId: string }) => {
      await input.checkAbort();
      input.toolStartCoordinator.record({ toolCallId, name, input: toolInput });
    };
  }

  try {
    for (const provider of requestedProviders) {
      let connections: LoadedMcpConnection[];
      try {
        connections = await loadMcpConnections(input, provider);
      } catch (error: unknown) {
        // The integration is enabled on the agent but not set up in the workspace
        // (no credential, beta off, etc.). Don't abort the whole turn — register a
        // stub tool that returns the reason to the model so it can ask the user to
        // connect it. The real tool names can't be listed without a live connection,
        // so a single stub per failed provider is the right granularity.
        logMcpConnectionSetupFailure({ error, input, provider });
        const stubName = uniqueToolName(
          `${provider.key}__${NOT_CONNECTED_STUB_RAW_NAME}`,
          usedNames,
        );
        tools[stubName] = buildNotConnectedStubTool({
          provider,
          error,
          checkAbort: input.checkAbort,
        });
        continue;
      }
      const accounts: ConnectedMcpAccount[] = [];
      for (const connection of connections) {
        const client = await createMCPClient({
          clientName: "opencompany-runner",
          version: "0.2.0",
          transport: mcpTransportForConnection({
            workspaceId: input.workspaceId,
            provider,
            integrationCredentialEncryptionKey: input.integrationCredentialEncryptionKey,
            connection,
          }),
        });
        clients.push(client);

        const definitions = await client.listTools({ options: { signal: input.signal } });
        const rawTools = client.toolsFromDefinitions(definitions);

        // The catalog (name + description + JSON input schema) comes straight from the MCP
        // listTools response so `search_tools` returns plain schemas the model can read.
        const catalog: McpToolCatalogEntry[] =
          (definitions as { tools?: McpToolCatalogEntry[] }).tools ?? [];
        const bodyByRawName = new Map<string, McpToolBody>();
        for (const [rawName, rawTool] of Object.entries(rawTools)) {
          bodyByRawName.set(rawName, (rawTool as unknown as { execute?: McpToolBody }).execute);
        }
        accounts.push({
          accountKey: connection.accountKey,
          label: connection.accountLabel,
          email: connection.accountEmail,
          catalog,
          bodyByRawName,
        });
      }

      const connected: ConnectedMcpProvider = { provider, accounts };
      const searchName = uniqueToolName(mcpSearchToolsName(provider.key), usedNames);
      const useName = uniqueToolName(mcpUseToolName(provider.key), usedNames);
      providerByToolName.set(searchName, connected);
      providerByToolName.set(useName, connected);

      tools[searchName] = tool({
        description: searchToolsDescription(provider),
        inputSchema: jsonSchema(MCP_SEARCH_TOOLS_INPUT_SCHEMA as never),
        onInputAvailable: recordMetaToolStart(searchName),
        execute: async (toolInput: unknown, options: { toolCallId: string }) =>
          runGatedMetaTool({
            toolName: searchName,
            toolCallId: options.toolCallId,
            run: () =>
              executeMcpTool({
                ...input,
                mcpServer: provider.key,
                toolCallId: options.toolCallId,
                toolName: searchName,
                rawToolName: MCP_SEARCH_TOOLS_RAW_NAME,
                execute: () => buildMcpCatalogResult(connected, toolInput),
                args: toolInput,
              }),
          }),
      } as never) as ToolSet[string];

      tools[useName] = tool({
        description: useToolDescription(provider),
        inputSchema: jsonSchema(MCP_USE_TOOL_INPUT_SCHEMA as never),
        onInputAvailable: recordMetaToolStart(useName),
        execute: async (toolInput: unknown, options: { toolCallId: string }) =>
          runGatedMetaTool({
            toolName: useName,
            toolCallId: options.toolCallId,
            run: () =>
              dispatchMcpUseTool({
                ...input,
                connected,
                toolCallId: options.toolCallId,
                args: toolInput,
              }),
          }),
      } as never) as ToolSet[string];
    }

    return {
      tools,
      close: () => closeMcpClients(clients),
      runApprovedTool: ({ toolName, toolCallId, args }) => {
        const connected = providerByToolName.get(toolName);
        if (!connected) return null;
        if (toolName === mcpUseToolName(connected.provider.key)) {
          return dispatchMcpUseTool({ ...input, connected, toolCallId, args });
        }
        return executeMcpTool({
          ...input,
          mcpServer: connected.provider.key,
          toolCallId,
          toolName,
          rawToolName: MCP_SEARCH_TOOLS_RAW_NAME,
          execute: () => buildMcpCatalogResult(connected, args),
          args,
        });
      },
    };
  } catch (error) {
    await closeMcpClients(clients);
    throw error;
  }
}

export type WorkspaceMcpToolClient = {
  // Invoke an MCP tool on the connected server by its raw name (e.g. "save_issue").
  callTool: (name: string, args: unknown) => Promise<unknown>;
  // Raw tool names the connected server exposes (for capability checks).
  listToolNames: () => string[];
  close: () => Promise<void>;
};

// Connect to a single workspace-configured MCP provider (e.g. Linear) and return a thin client for
// calling its tools programmatically from a runner-side tool handler — reusing the exact
// credential-decrypt + OAuth transport path that powers the agent's `{server}__use_tool`. Unlike
// createMcpToolSet, this registers no meta-tools and persists no tool messages; the caller owns the
// result. Throws if the provider is not configured/connected for the workspace (the caller turns
// that into a recoverable "connect <provider>" message). Always `close()` it when done.
export async function connectWorkspaceMcpClient(input: {
  workspaceId: string;
  provider: McpProviderKey;
  integrationCredentialEncryptionKey: Buffer;
  signal: AbortSignal;
}): Promise<WorkspaceMcpToolClient> {
  const provider = MCP_PROVIDER_CATALOG[input.provider];
  const connection = await loadMcpConnection(input, provider);
  const client = await createMCPClient({
    clientName: "opencompany-runner",
    version: "0.2.0",
    transport: mcpTransportForConnection({
      workspaceId: input.workspaceId,
      provider,
      integrationCredentialEncryptionKey: input.integrationCredentialEncryptionKey,
      connection,
    }),
  });
  try {
    const definitions = await client.listTools({ options: { signal: input.signal } });
    const rawTools = client.toolsFromDefinitions(definitions);
    // Extract each tool's executable body the same way createMcpToolSet does (cast through unknown,
    // since the SDK's ToolExecutionOptions is wider than the { toolCallId } the body actually uses).
    const bodyByName = new Map<string, McpToolBody>();
    for (const [rawName, rawTool] of Object.entries(rawTools)) {
      bodyByName.set(rawName, (rawTool as unknown as { execute?: McpToolBody }).execute);
    }
    return {
      async callTool(name, args) {
        const body = bodyByName.get(name);
        if (!body) {
          throw new Error(
            `${provider.displayName} MCP tool "${name}" is not available on this connection.`,
          );
        }
        return body(args, { toolCallId: `runner_internal_${name}` });
      },
      listToolNames: () => [...bodyByName.keys()],
      close: () => closeMcpClient(client),
    };
  } catch (error) {
    await closeMcpClient(client);
    throw error;
  }
}

type McpToolBody =
  | ((input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>)
  | undefined;

type McpToolCatalogEntry = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

// A live server connection reduced to what the meta-tools need: the discovery catalog
// and the executable bodies keyed by raw tool name.
type ConnectedMcpAccount = {
  accountKey: string;
  label: string;
  email: string | null;
  catalog: McpToolCatalogEntry[];
  bodyByRawName: Map<string, McpToolBody>;
};

type ConnectedMcpProvider = {
  provider: McpProvider;
  accounts: ConnectedMcpAccount[];
};

const MCP_SEARCH_TOOLS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    account: {
      type: "string",
      description:
        "Optional connected account label or id. Required by use_tool when multiple accounts are connected.",
    },
    query: {
      type: "string",
      description: "Optional case-insensitive substring filter over tool names and descriptions.",
    },
  },
  additionalProperties: false,
} as const;

const MCP_USE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Exact tool name returned by the matching search_tools call.",
    },
    arguments: {
      type: "object",
      description: "Arguments object for the chosen tool, matching its input schema.",
      additionalProperties: true,
    },
    account: {
      type: "string",
      description: "Connected account label or id to use when multiple accounts are connected.",
    },
  },
  required: ["tool"],
  additionalProperties: false,
} as const;

function searchToolsDescription(provider: McpProvider) {
  return (
    `${provider.displayName} MCP — list available ${provider.displayName} tools. ` +
    `Returns each tool's name, description, and input schema. ${provider.displayName} tools ` +
    `are not preloaded, so call this first, then run one with ${mcpUseToolName(provider.key)}. ` +
    `Pass an optional "query" to filter. Read-only.`
  );
}

function useToolDescription(provider: McpProvider) {
  return (
    `${provider.displayName} MCP — run one ${provider.displayName} tool. Set "tool" to a name ` +
    `from ${mcpSearchToolsName(provider.key)} and "arguments" to that tool's input. If multiple ` +
    `${provider.displayName} accounts are connected, also pass "account". Each ` +
    `underlying tool keeps its own permission, so a write or destructive tool may require approval.`
  );
}

function parseUseToolInput(args: unknown): { tool: string; arguments: unknown; account?: string } {
  if (isRecord(args)) {
    const tool = typeof args.tool === "string" ? args.tool.trim() : "";
    const account = typeof args.account === "string" ? args.account.trim() : "";
    return { tool, arguments: args.arguments ?? {}, ...(account ? { account } : {}) };
  }
  return { tool: "", arguments: {} };
}

// The body run when the model names a tool the server didn't list. executeMcpTool
// catches the throw and persists a recoverable failure so the model can recover.
function unknownMcpToolBody(provider: McpProvider, rawName: string): McpToolBody {
  return () => {
    throw new Error(
      rawName
        ? `Unknown ${provider.displayName} tool "${rawName}". Call ${mcpSearchToolsName(provider.key)} to list available tools.`
        : `Missing "tool" argument. Call ${mcpSearchToolsName(provider.key)} to list ${provider.displayName} tools, then pass one as "tool".`,
    );
  };
}

function buildMcpCatalogResult(connected: ConnectedMcpProvider, args: unknown) {
  const query =
    isRecord(args) && typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const accountArg = isRecord(args) && typeof args.account === "string" ? args.account : undefined;
  const account = accountArg
    ? resolveConnectedMcpAccount(connected, accountArg)
    : connected.accounts[0]!;
  const entries = query
    ? account.catalog.filter(
        (entry) =>
          entry.name.toLowerCase().includes(query) ||
          (entry.description ?? "").toLowerCase().includes(query),
      )
    : account.catalog;
  return {
    ok: true as const,
    server: connected.provider.key,
    useTool: mcpUseToolName(connected.provider.key),
    account: account.label,
    ...(connected.accounts.length > 1
      ? {
          accounts: connected.accounts.map((candidate) => ({
            id: candidate.accountKey,
            label: candidate.label,
            ...(candidate.email ? { email: candidate.email } : {}),
          })),
          accountSelection: `Multiple ${connected.provider.displayName} accounts are connected. Pass "account" to ${mcpUseToolName(connected.provider.key)} using one of these ids or labels.`,
        }
      : {}),
    toolCount: entries.length,
    tools: entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    })),
  };
}

function resolveConnectedMcpAccount(
  connected: ConnectedMcpProvider,
  accountArg: string | undefined,
): ConnectedMcpAccount {
  if (connected.accounts.length === 0) {
    throw new Error(`${connected.provider.displayName} has no connected accounts.`);
  }

  const wanted = accountArg?.trim().toLowerCase();
  if (wanted) {
    const match = connected.accounts.find((account) => {
      return (
        account.accountKey.toLowerCase() === wanted ||
        account.label.toLowerCase() === wanted ||
        account.email?.toLowerCase() === wanted
      );
    });
    if (!match) {
      throw new Error(
        `No connected ${connected.provider.displayName} account matches "${accountArg}". Connected: ${connectedMcpAccountList(connected)}.`,
      );
    }
    return match;
  }

  if (connected.accounts.length > 1) {
    throw new Error(
      `Multiple ${connected.provider.displayName} accounts are connected; pass "account" to choose one. Connected: ${connectedMcpAccountList(connected)}.`,
    );
  }

  return connected.accounts[0]!;
}

function connectedMcpAccountList(connected: ConnectedMcpProvider) {
  return connected.accounts.map((account) => account.label).join(", ");
}

// Resolve the named raw tool's body and run it through the shared execution tail. The
// persisted tool-result keeps the invoke tool's name (so it pairs with the model's
// `{server}__use_tool` call) while observability records the real raw tool name.
//
// Before hitting the server, the arguments run through the shared validate → coerce → repair
// pipeline using the tool's input schema from the discovery catalog. This closes the gap where a
// schema-invalid payload would otherwise round-trip to the MCP server and come back as an opaque
// `mcp_tool_execution_failed` — we catch it locally with an actionable, uniform error instead.
async function dispatchMcpUseTool(
  input: McpToolContext & {
    connected: ConnectedMcpProvider;
    toolCallId: string;
    args: unknown;
  },
) {
  const { tool: rawName, arguments: rawArgs, account: accountArg } = parseUseToolInput(input.args);
  const toolName = mcpUseToolName(input.connected.provider.key);
  let account: ConnectedMcpAccount;
  try {
    account = resolveConnectedMcpAccount(input.connected, accountArg);
  } catch (error) {
    return executeMcpTool({
      ...input,
      mcpServer: input.connected.provider.key,
      toolCallId: input.toolCallId,
      toolName,
      rawToolName: rawName || MCP_USE_TOOL_RAW_NAME,
      execute: () => {
        throw error;
      },
      args: rawArgs,
    });
  }
  const body = account.bodyByRawName.get(rawName);

  // Only validate when we have both an executable body and a catalog schema. An unknown tool keeps
  // the existing recoverable-failure path; a missing schema means we can't validate, so pass through.
  const schema = account.catalog.find((entry) => entry.name === rawName)?.inputSchema;
  if (body && schema !== undefined) {
    const prepared = await prepareToolArgs({
      surface: "mcp",
      toolName: rawName,
      schema,
      rawArgs,
      ...(input.toolArgRepair ? { repair: input.toolArgRepair } : {}),
      signal: input.signal,
      observability: {
        sessionId: input.sessionId,
        ...(input.observabilityContext?.workspaceId
          ? { workspaceId: input.observabilityContext.workspaceId }
          : {}),
        ...(input.observabilityContext?.agentId
          ? { agentId: input.observabilityContext.agentId }
          : {}),
        ...(input.observabilityContext?.modelName
          ? { modelName: input.observabilityContext.modelName }
          : {}),
      },
    });
    if (!prepared.ok) {
      return persistMcpUseToolArgError({
        ...input,
        toolName,
        toolCallId: input.toolCallId,
        message: `Invalid arguments for "${rawName}": ${prepared.errors
          .map((error) => error.message)
          .join(
            "; ",
          )}. Call ${mcpSearchToolsName(input.connected.provider.key)} for its input schema, then retry with arguments that match it.`,
        argResolution: prepared.resolution,
      });
    }
    return executeMcpTool({
      ...input,
      mcpServer: input.connected.provider.key,
      toolCallId: input.toolCallId,
      toolName,
      rawToolName: rawName || MCP_USE_TOOL_RAW_NAME,
      execute: body,
      args: prepared.args,
      argResolution: prepared.resolution,
    });
  }

  return executeMcpTool({
    ...input,
    mcpServer: input.connected.provider.key,
    toolCallId: input.toolCallId,
    toolName,
    rawToolName: rawName || MCP_USE_TOOL_RAW_NAME,
    execute: body ?? unknownMcpToolBody(input.connected.provider, rawName),
    args: rawArgs,
  });
}

// Persist a recoverable error tool-result for an MCP `use_tool` call whose arguments failed the
// shared pipeline, without calling the server. Mirrors executeMcpTool's failure tail (and
// persistBuiltinUseToolError) so the model recovers turn-by-turn — but skips captureException since
// a schema-invalid argument payload is an expected recoverable input error, not an exception.
async function persistMcpUseToolArgError(
  input: McpToolContext & {
    toolName: string;
    toolCallId: string;
    message: string;
    argResolution: ToolArgResolution;
  },
) {
  const output = {
    ok: false as const,
    error: { message: input.message, code: "invalid_tool_input", recoverable: true as const },
  };
  const toolMessageId = newAgentSessionMessageId();
  await requireLeaseWrite(
    insertToolMessageForLease({
      id: toolMessageId,
      sessionId: input.sessionId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      content: serializeToolOutputForStorage(output),
      modelMessage: toPersistedModelMessage(
        buildToolModelMessage({
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          output,
        }),
      ),
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      internal: input.internalMessages ?? false,
    }),
  );
  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "tool.failed",
      payload: {
        messageId: input.assistantMessageId,
        toolCallId: input.toolCallId,
        name: input.toolName,
        error: output.error,
        outputPreview: formatRuntimePreview(output),
        argResolution: input.argResolution,
      },
    }),
  );
  return output;
}

function requestedMcpProviders(agentConfig: AgentConfig) {
  const seen = new Set<McpProviderKey>();
  const providers: McpProvider[] = [];
  for (const configTool of agentConfig.tools) {
    if (configTool.type !== "mcp") continue;
    const key = configTool.server as McpProviderKey;
    if (!isMcpProviderKey(key) || seen.has(key)) continue;
    seen.add(key);
    providers.push(MCP_PROVIDER_CATALOG[key]);
  }
  return providers;
}

function isMcpProviderKey(value: string): value is McpProviderKey {
  return (
    value === LINEAR_MCP_SERVER_KEY ||
    value === SLACK_MCP_SERVER_KEY ||
    value === POSTHOG_MCP_SERVER_KEY ||
    value === BETTERSTACK_MCP_SERVER_KEY ||
    value === BRAINTRUST_MCP_SERVER_KEY ||
    value === NOTION_MCP_SERVER_KEY
  );
}

function mcpTransportForConnection(input: {
  workspaceId: string;
  provider: McpProvider;
  integrationCredentialEncryptionKey: Buffer;
  connection: LoadedMcpConnection;
}) {
  if (input.connection.auth.type === "oauth") {
    return {
      type: "http" as const,
      url: input.connection.endpointUrl,
      authProvider: createRunnerMcpOAuthProvider({
        workspaceId: input.workspaceId,
        serverId: input.connection.serverId,
        accountKey: input.connection.accountKey,
        payload: input.connection.auth.payload,
        provider: input.provider,
        encryptionKey: input.integrationCredentialEncryptionKey,
      }),
    };
  }

  return {
    type: "http" as const,
    url: input.connection.endpointUrl,
    headers: {
      Authorization: `Bearer ${input.connection.auth.bearerToken}`,
    },
  };
}

function logMcpConnectionSetupFailure(input: {
  error: unknown;
  input: McpToolContext;
  provider: McpProvider;
}) {
  const diagnostic = mcpConnectionErrorDiagnostic(input.error);
  logger.error(`${input.provider.displayName} MCP connection setup failed`, {
    event: "opencompany.runner_mcp_connection_failed",
    workspace_id: input.input.observabilityContext?.workspaceId ?? input.input.workspaceId,
    user_id: input.input.observabilityContext?.userId,
    agent_id: input.input.observabilityContext?.agentId,
    session_id: input.input.sessionId,
    message_id: input.input.assistantMessageId,
    mcp_server: input.provider.key,
    mcp_failure_reason: diagnostic.reason,
    ...(diagnostic.credentialKind ? { mcp_credential_kind: diagnostic.credentialKind } : {}),
    ...(diagnostic.encryptionKeyVersion
      ? { mcp_credential_key_version: diagnostic.encryptionKeyVersion }
      : {}),
    ...(diagnostic.algorithm ? { mcp_credential_algorithm: diagnostic.algorithm } : {}),
    error: input.error,
  });
  captureException(input.error, {
    event: "opencompany.runner_mcp_connection_failed",
    workspace_id: input.input.observabilityContext?.workspaceId ?? input.input.workspaceId,
    user_id: input.input.observabilityContext?.userId,
    agent_id: input.input.observabilityContext?.agentId,
    session_id: input.input.sessionId,
    message_id: input.input.assistantMessageId,
    mcp_server: input.provider.key,
    mcp_failure_reason: diagnostic.reason,
    ...(diagnostic.credentialKind ? { mcp_credential_kind: diagnostic.credentialKind } : {}),
    ...(diagnostic.encryptionKeyVersion
      ? { mcp_credential_key_version: diagnostic.encryptionKeyVersion }
      : {}),
    ...(diagnostic.algorithm ? { mcp_credential_algorithm: diagnostic.algorithm } : {}),
  });
}

// MCP tool execution is traced by Braintrust's `wrapAISDK` as a tool-call/tool-result pair nested
// under the model's LLM span — no manual span is opened here. Errors are still reported via
// `captureException` for Better Stack.
async function executeMcpTool(
  input: McpToolContext & {
    mcpServer: McpProviderKey;
    toolCallId: string;
    toolName: string;
    rawToolName: string;
    execute:
      | ((input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>)
      | undefined;
    args: unknown;
    // How the deferred-tool arguments were resolved (valid/coerced/repaired) before this ran.
    // Carried onto the tool.completed/failed event for telemetry. Only set on the use_tool path.
    argResolution?: ToolArgResolution | undefined;
  },
) {
  let output: unknown;
  let failed = false;

  try {
    await input.checkAbort();
    throwIfAborted(input.signal);
    if (!input.execute) throw new Error(`MCP tool ${input.rawToolName} is not executable.`);
    output = await input.execute(input.args, { toolCallId: input.toolCallId });
  } catch (error) {
    failed = true;
    captureException(error, {
      event: "opencompany.runner_mcp_tool_failed",
      workspace_id: input.observabilityContext?.workspaceId,
      user_id: input.observabilityContext?.userId,
      agent_id: input.observabilityContext?.agentId,
      session_id: input.sessionId,
      message_id: input.assistantMessageId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      mcp_server: input.mcpServer,
      mcp_tool_name: input.rawToolName,
      model_provider: input.observabilityContext?.modelProvider,
      model_name: input.observabilityContext?.modelName,
    });
    output = buildMcpFailedToolOutput(error);
  }

  const toolMessageId = newAgentSessionMessageId();
  await requireLeaseWrite(
    insertToolMessageForLease({
      id: toolMessageId,
      sessionId: input.sessionId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      content: serializeToolOutputForStorage(output),
      modelMessage: toPersistedModelMessage(
        buildToolModelMessage({
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          output,
        }),
      ),
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      internal: input.internalMessages ?? false,
    }),
  );
  if (failed) {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "tool.failed",
        payload: {
          messageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
          name: input.toolName,
          error: isMcpFailedToolOutput(output)
            ? output.error
            : buildMcpFailedToolOutput(new Error("MCP tool failed.")).error,
          outputPreview: formatRuntimePreview(output),
          ...(input.argResolution ? { argResolution: input.argResolution } : {}),
        },
      }),
    );
  } else {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "tool.completed",
        payload: {
          messageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
          name: input.toolName,
          outputPreview: formatRuntimePreview(output),
          ...(input.argResolution ? { argResolution: input.argResolution } : {}),
        },
      }),
    );
  }

  return output;
}

function buildMcpFailedToolOutput(error: unknown) {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : "MCP tool failed.",
      code: "mcp_tool_execution_failed",
      recoverable: true,
    },
  };
}

// Raw (un-prefixed) name for the not-connected stub tool. The prefixed name
// (`${provider}__${this}`) is classified by the permission system via a read-verb
// heuristic — "get" resolves the stub to the `read` group, which defaults to "allow".
// This is deliberate: the stub has no side effects, so it must never trigger an
// approval gate (an "ask" would suspend the run, or on non-suspendable scheduled
// runs collapse to "deny" — defeating the graceful message). Keep a read verb here.
const NOT_CONNECTED_STUB_RAW_NAME = "get_connection_status";

// A placeholder tool for an integration that is enabled on the agent but not set up
// in the workspace. Calling it performs no action and returns the connection reason
// so the model can ask the user to connect the integration in Settings. It has no
// side effects, so it skips the permission/approval gate entirely.
function buildNotConnectedStubTool(input: {
  provider: McpProvider;
  error: unknown;
  checkAbort: RunControlCheck;
}): ToolSet[string] {
  const reason =
    input.error instanceof Error
      ? input.error.message
      : `${input.provider.displayName} is not connected.`;
  return tool({
    description:
      `${input.provider.displayName} is enabled for this agent but not connected. ` +
      `Calling this performs no action — instead tell the user to connect ` +
      `${input.provider.displayName} in Settings → Integrations.`,
    inputSchema: jsonSchema({ type: "object", properties: {} } as never),
    onInputAvailable: async () => {
      await input.checkAbort();
    },
    execute: async () => ({
      ok: false,
      error: {
        message: reason,
        code: "mcp_not_connected",
        recoverable: true,
      },
    }),
  } as never) as ToolSet[string];
}

function isMcpFailedToolOutput(
  value: unknown,
): value is ReturnType<typeof buildMcpFailedToolOutput> {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.message === "string" &&
    typeof value.error.code === "string" &&
    typeof value.error.recoverable === "boolean"
  );
}

async function loadMcpConnection(
  input: Pick<McpToolContext, "workspaceId" | "integrationCredentialEncryptionKey">,
  provider: McpProvider,
): Promise<LoadedMcpConnection> {
  const connections = await loadMcpConnections(input, provider);
  const [connection] = connections;
  if (!connection) {
    throw new Error(
      `${provider.displayName} MCP is enabled on this agent, but ${provider.displayName} is not configured.`,
    );
  }
  return connection;
}

async function loadMcpConnections(
  input: Pick<McpToolContext, "workspaceId" | "integrationCredentialEncryptionKey">,
  provider: McpProvider,
): Promise<LoadedMcpConnection[]> {
  const db = getDb();
  const { workspaceId } = input;
  const [server] = await db
    .select({
      id: workspaceMcpServers.id,
      endpointUrl: workspaceMcpServers.endpointUrl,
      status: workspaceMcpServers.status,
    })
    .from(workspaceMcpServers)
    .where(
      and(
        eq(workspaceMcpServers.workspaceId, workspaceId),
        eq(workspaceMcpServers.serverKey, provider.key),
      ),
    )
    .limit(1);

  if (!server || server.status !== "configured") {
    throw new Error(
      `${provider.displayName} MCP is enabled on this agent, but ${provider.displayName} is not configured.`,
    );
  }

  const rows = await db
    .select({
      serverId: workspaceMcpCredentials.serverId,
      accountKey: workspaceMcpCredentials.accountKey,
      accountLabel: workspaceMcpCredentials.accountLabel,
      accountEmail: workspaceMcpCredentials.accountEmail,
      connectedByUserId: workspaceMcpCredentials.connectedByUserId,
      encryptedPayload: workspaceMcpCredentials.encryptedPayload,
      encryptionKeyVersion: workspaceMcpCredentials.encryptionKeyVersion,
      credentialKind: workspaceMcpCredentials.kind,
    })
    .from(workspaceMcpCredentials)
    .where(
      and(
        eq(workspaceMcpCredentials.workspaceId, workspaceId),
        eq(workspaceMcpCredentials.serverId, server.id),
      ),
    );

  const oauthRows = rows.filter(
    (candidate) =>
      candidate.credentialKind === provider.oauthCredentialKind &&
      isCompletedMcpCredential(candidate),
  );
  if (oauthRows.length > 0) {
    const connections: LoadedMcpConnection[] = [];
    for (const oauthRow of oauthRows) {
      const payload = parseMcpOAuthPayload(
        decryptPayload(oauthRow.encryptedPayload, {
          workspaceId,
          serverId: oauthRow.serverId,
          kind: oauthRow.credentialKind,
          keyVersion: oauthRow.encryptionKeyVersion,
          encryptionKey: input.integrationCredentialEncryptionKey,
        }),
      );
      if (!(provider.staticClientEnv || payload.clientInformation) || !payload.tokens) {
        throw new Error(
          `${provider.displayName} MCP OAuth credential is incomplete. Reconnect ${provider.displayName}.`,
        );
      }
      connections.push({
        endpointUrl: server.endpointUrl,
        serverId: oauthRow.serverId,
        accountKey: oauthRow.accountKey ?? DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY,
        accountLabel: oauthRow.accountLabel ?? provider.displayName,
        accountEmail: oauthRow.accountEmail,
        auth: { type: "oauth" as const, payload },
      });
    }
    return connections;
  }

  if (!provider.supportsBearerToken) {
    throw new Error(
      `${provider.displayName} MCP is enabled on this agent, but ${provider.displayName} is not configured.`,
    );
  }

  const bearerRow = rows.find((candidate) => candidate.credentialKind === "bearer_token");
  if (!bearerRow)
    throw new Error(
      `${provider.displayName} MCP is enabled on this agent, but ${provider.displayName} is not configured.`,
    );
  const payload = decryptPayload(bearerRow.encryptedPayload, {
    workspaceId,
    serverId: bearerRow.serverId,
    kind: bearerRow.credentialKind,
    keyVersion: bearerRow.encryptionKeyVersion,
    encryptionKey: input.integrationCredentialEncryptionKey,
  });
  const bearerToken = typeof payload.bearerToken === "string" ? payload.bearerToken.trim() : "";
  if (!bearerToken)
    throw new Error(`${provider.displayName} MCP credential is missing a bearer token.`);
  return [
    {
      endpointUrl: server.endpointUrl,
      serverId: bearerRow.serverId,
      accountKey: DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY,
      accountLabel: provider.displayName,
      accountEmail: null,
      auth: { type: "bearer" as const, bearerToken },
    } satisfies LoadedMcpConnection,
  ];
}

function isCompletedMcpCredential(row: {
  accountKey: string | null;
  connectedByUserId: string | null;
}) {
  return (
    (row.accountKey ?? DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY) === DEFAULT_MCP_CREDENTIAL_ACCOUNT_KEY ||
    Boolean(row.connectedByUserId)
  );
}

type McpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

function createRunnerMcpOAuthProvider(input: {
  workspaceId: string;
  serverId: string;
  accountKey: string;
  payload: McpOAuthPayload;
  provider: McpProvider;
  encryptionKey: Buffer;
}): OAuthClientProvider {
  let payload = input.payload;

  async function persist(next: McpOAuthPayload) {
    payload = next;
    const encryptedPayload = encryptPayload(
      { ...next },
      {
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        kind: input.provider.oauthCredentialKind,
        keyVersion: ENCRYPTION_KEY_VERSION,
        encryptionKey: input.encryptionKey,
      },
    );
    const now = new Date();
    await getDb()
      .insert(workspaceMcpCredentials)
      .values({
        id: newWorkspaceMcpCredentialId(),
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        kind: input.provider.oauthCredentialKind,
        accountKey: input.accountKey,
        encryptedPayload,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        lastRotatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceMcpCredentials.serverId,
          workspaceMcpCredentials.kind,
          workspaceMcpCredentials.accountKey,
        ],
        set: {
          workspaceId: input.workspaceId,
          encryptedPayload,
          encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
          lastRotatedAt: now,
          updatedAt: now,
        },
      });
  }

  return {
    get redirectUrl() {
      return mcpCallbackUrl(input.provider);
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany Runner",
        redirect_uris: [mcpCallbackUrl(input.provider)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(input.provider.scopes ? { scope: input.provider.scopes.join(" ") } : {}),
      };
    },
    clientInformation: () =>
      input.provider.staticClientEnv
        ? staticClientInformation(input.provider)
        : payload.clientInformation,
    tokens: () => payload.tokens,
    saveTokens: async (tokens) => persist({ ...payload, tokens }),
    saveClientInformation: async (clientInformation) => {
      if (!input.provider.staticClientEnv) await persist({ ...payload, clientInformation });
    },
    saveCodeVerifier: async (codeVerifier) => persist({ ...payload, codeVerifier }),
    codeVerifier: () => {
      if (!payload.codeVerifier)
        throw new Error(`${input.provider.displayName} MCP OAuth verifier is missing.`);
      return payload.codeVerifier;
    },
    state: () => payload.state ?? "",
    saveState: async (state) => persist({ ...payload, state }),
    storedState: () => payload.state,
    redirectToAuthorization: () => {
      throw new Error(
        `${input.provider.displayName} MCP needs to be reconnected from workspace settings.`,
      );
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all") {
        await persist({});
      } else if (scope === "tokens") {
        await persist(omitOAuthPayload(payload, ["tokens"]));
      } else if (scope === "verifier") {
        await persist(omitOAuthPayload(payload, ["codeVerifier", "state"]));
      } else if (scope === "client" && !input.provider.staticClientEnv) {
        await persist(omitOAuthPayload(payload, ["clientInformation"]));
      }
    },
  };
}

function parseMcpOAuthPayload(payload: Record<string, unknown>): McpOAuthPayload {
  const parsed: McpOAuthPayload = {};
  if (isOAuthClientInformation(payload.clientInformation)) {
    parsed.clientInformation = payload.clientInformation;
  }
  if (isOAuthTokens(payload.tokens)) parsed.tokens = payload.tokens;
  if (typeof payload.codeVerifier === "string") parsed.codeVerifier = payload.codeVerifier;
  if (typeof payload.state === "string") parsed.state = payload.state;
  return parsed;
}

function omitOAuthPayload<TKey extends keyof McpOAuthPayload>(
  payload: McpOAuthPayload,
  keys: TKey[],
) {
  const next = { ...payload };
  for (const key of keys) delete next[key];
  return next;
}

function decryptPayload(
  encryptedPayload: EncryptedPayload,
  context: {
    workspaceId: string;
    serverId: string;
    kind: string;
    keyVersion: number;
    encryptionKey: Buffer;
  },
) {
  if (context.keyVersion !== ENCRYPTION_KEY_VERSION) {
    throw new Error(`Unsupported MCP credential encryption key version ${context.keyVersion}.`);
  }
  if (encryptedPayload.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error(
      `Unsupported MCP credential encryption algorithm ${encryptedPayload.algorithm}.`,
    );
  }

  try {
    return decryptJson(encryptedPayload, {
      key: context.encryptionKey,
      aad: mcpCredentialAuthenticatedData(context),
    });
  } catch {
    throw new McpCredentialDecryptionError({
      kind: context.kind,
      keyVersion: context.keyVersion,
      algorithm: encryptedPayload.algorithm,
    });
  }
}

function encryptPayload(
  payload: Record<string, unknown>,
  context: {
    workspaceId: string;
    serverId: string;
    kind: string;
    keyVersion: number;
    encryptionKey: Buffer;
  },
): EncryptedPayload {
  return encryptJson(payload, {
    key: context.encryptionKey,
    aad: mcpCredentialAuthenticatedData(context),
  });
}

// Field order is significant — it must stay byte-identical to previously stored
// credentials (see buildAad in @opencompany/crypto).
function mcpCredentialAuthenticatedData(context: {
  workspaceId: string;
  serverId: string;
  kind: string;
  keyVersion: number;
}) {
  return buildAad({
    workspaceId: context.workspaceId,
    serverId: context.serverId,
    kind: context.kind,
    keyVersion: context.keyVersion,
  });
}

type McpConnectionErrorDiagnostic = {
  reason: string;
  credentialKind?: string;
  encryptionKeyVersion?: number;
  algorithm?: string;
};

function mcpConnectionErrorDiagnostic(error: unknown): McpConnectionErrorDiagnostic {
  if (isEncryptionKeyConfigurationError(error)) {
    return { reason: "encryption_key_configuration" };
  }
  if (error instanceof McpCredentialDecryptionError) {
    return {
      reason: "credential_decryption_failed",
      credentialKind: error.context.kind,
      encryptionKeyVersion: error.context.keyVersion,
      algorithm: error.context.algorithm,
    };
  }
  if (error instanceof Error && error.message.includes("Unsupported MCP credential")) {
    return { reason: "unsupported_credential_encryption" };
  }
  return { reason: "connection_setup_failed" };
}

class McpCredentialDecryptionError extends Error {
  context: { kind: string; keyVersion: number; algorithm: string };

  constructor(context: { kind: string; keyVersion: number; algorithm: string }) {
    super("MCP credential could not be decrypted.");
    this.name = "McpCredentialDecryptionError";
    this.context = context;
  }
}

function isEncryptionKeyConfigurationError(error: unknown) {
  return error instanceof EncryptionKeyConfigError;
}

function newWorkspaceMcpCredentialId() {
  return `wmcpc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function mcpCallbackUrl(provider: McpProvider) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim().replace(/\/auth\/callback$/, "") ||
    "http://localhost:3000";
  return `${appUrl.replace(/\/$/, "")}/api/mcp/${provider.key}/callback`;
}

function staticClientInformation(provider: McpProvider): OAuthClientInformation {
  if (!provider.staticClientEnv) {
    throw new Error(`${provider.displayName} MCP OAuth client information is missing.`);
  }
  return {
    client_id: requiredEnv(provider.staticClientEnv.clientId),
    client_secret: requiredEnv(provider.staticClientEnv.clientSecret),
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for MCP OAuth.`);
  return value;
}

function isOAuthClientInformation(value: unknown): value is OAuthClientInformation {
  if (!isRecord(value) || typeof value.client_id !== "string") return false;
  return value.client_secret === undefined || typeof value.client_secret === "string";
}

function isOAuthTokens(value: unknown): value is OAuthTokens {
  if (!isRecord(value)) return false;
  return (
    typeof value.access_token === "string" &&
    typeof value.token_type === "string" &&
    (value.expires_in === undefined || typeof value.expires_in === "number") &&
    (value.scope === undefined || typeof value.scope === "string") &&
    (value.refresh_token === undefined || typeof value.refresh_token === "string")
  );
}

function uniqueToolName(base: string, usedNames: Set<string>) {
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function emptyMcpToolSet(): McpToolSet {
  return { tools: {}, close: async () => {}, runApprovedTool: () => null };
}

async function closeMcpClient(client: MCPClient) {
  try {
    await client.close();
  } catch {
    // Best effort cleanup after setup failure.
  }
}

async function closeMcpClients(clients: MCPClient[]) {
  await Promise.all(clients.map((client) => closeMcpClient(client)));
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Run aborted.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
