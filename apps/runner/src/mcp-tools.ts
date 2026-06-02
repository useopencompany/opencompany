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
  classifyMcpTool,
  effectivePolicyDecisionForGroup,
  formatPolicyDecision,
  newAgentSessionMessageId,
  PERMISSION_GROUP_LABELS,
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
import {
  workspaceExperiments,
  workspaceMcpCredentials,
  workspaceMcpServers,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import {
  logBraintrustCurrentSpan,
  traceBraintrustStep,
} from "@opencompany/observability/braintrust";
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
import {
  formatRuntimePreview,
  persistDeniedToolResult,
  SUSPENDED_TOOL_OUTPUT,
} from "./tool-dispatcher";
import type { ToolStartCoordinator } from "./tool-start-coordinator";

const MCP_EXPERIMENT_KEY = "mcp";
const LINEAR_MCP_SERVER_KEY = "linear";
const LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const SLACK_MCP_SERVER_KEY = "slack";
const SLACK_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
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

type McpProviderKey = typeof LINEAR_MCP_SERVER_KEY | typeof SLACK_MCP_SERVER_KEY;

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
  const bodiesByName = new Map<
    string,
    { server: McpProviderKey; rawName: string; execute: McpToolBody }
  >();
  try {
    for (const provider of requestedProviders) {
      let connection: Awaited<ReturnType<typeof loadMcpConnection>>;
      try {
        connection = await loadMcpConnection(input, provider);
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

      for (const [rawName, rawTool] of Object.entries(rawTools)) {
        const prefixedName = uniqueToolName(
          `${provider.key}__${sanitizeMcpToolName(rawName)}`,
          usedNames,
        );
        const mcpTool = rawTool as {
          description?: string;
          inputSchema?: unknown;
          execute?: (input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>;
        };
        tools[prefixedName] = tool({
          description: mcpToolDescription({
            providerName: provider.displayName,
            rawName,
            description: mcpTool.description,
            prefixedName,
            policy: input.policy,
            suspendable: input.suspendable,
          }),
          inputSchema:
            (mcpTool.inputSchema as never) ??
            jsonSchema({ type: "object", properties: {} } as never),
          onInputAvailable: async ({
            input: toolInput,
            toolCallId,
          }: {
            input: unknown;
            toolCallId: string;
          }) => {
            await input.checkAbort();
            input.toolStartCoordinator.record({
              toolCallId,
              name: prefixedName,
              input: toolInput,
            });
          },
          execute: async (toolInput: unknown, options: { toolCallId: string }) => {
            const verdict = await input.toolStartCoordinator.waitForStarted(
              options.toolCallId,
              input.signal,
            );
            // Suspending at an "ask" gate — return a discarded no-op (the stream is torn
            // down and this result is never persisted). The body runs in the resume run.
            if (verdict.decision === "suspend") {
              return SUSPENDED_TOOL_OUTPUT;
            }
            if (verdict.decision === "deny") {
              return persistDeniedToolResult({
                sessionId: input.sessionId,
                assistantMessageId: input.assistantMessageId,
                runLeaseId: input.runLeaseId,
                runLeaseOwner: input.runLeaseOwner,
                internalMessages: input.internalMessages,
                toolCallId: options.toolCallId,
                toolName: prefixedName,
                verdict,
              });
            }
            return executeMcpTool({
              ...input,
              mcpServer: provider.key,
              toolCallId: options.toolCallId,
              toolName: prefixedName,
              rawToolName: rawName,
              execute: mcpTool.execute,
              args: toolInput,
            });
          },
        } as never) as ToolSet[string];
        bodiesByName.set(prefixedName, {
          server: provider.key,
          rawName,
          execute: mcpTool.execute,
        });
      }
    }

    return {
      tools,
      close: () => closeMcpClients(clients),
      runApprovedTool: ({ toolName, toolCallId, args }) => {
        const body = bodiesByName.get(toolName);
        if (!body) return null;
        return executeMcpTool({
          ...input,
          mcpServer: body.server,
          toolCallId,
          toolName,
          rawToolName: body.rawName,
          execute: body.execute,
          args,
        });
      },
    };
  } catch (error) {
    await closeMcpClients(clients);
    throw error;
  }
}

type McpToolBody =
  | ((input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>)
  | undefined;

function mcpToolDescription(input: {
  providerName: string;
  rawName: string;
  description: string | undefined;
  prefixedName: string;
  policy: WorkspaceToolPolicyMap;
  suspendable: boolean;
}) {
  const base = `${input.providerName} MCP: ${input.description ?? input.rawName}`;
  const classification = classifyMcpTool(input.prefixedName);
  if (!classification) return base;

  const decision = effectivePolicyDecisionForGroup({
    providerKey: classification.providerKey,
    group: classification.group,
    policy: input.policy,
    suspendable: input.suspendable,
  });
  return `${base}\nPermission: ${PERMISSION_GROUP_LABELS[classification.group]} (${formatPolicyDecision(decision)}).`;
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
  return value === LINEAR_MCP_SERVER_KEY || value === SLACK_MCP_SERVER_KEY;
}

function mcpTransportForConnection(input: {
  workspaceId: string;
  provider: McpProvider;
  integrationCredentialEncryptionKey: Buffer;
  connection: Awaited<ReturnType<typeof loadMcpConnection>>;
}) {
  if (input.connection.auth.type === "oauth") {
    return {
      type: "http" as const,
      url: input.connection.endpointUrl,
      authProvider: createRunnerMcpOAuthProvider({
        workspaceId: input.workspaceId,
        serverId: input.connection.serverId,
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
  },
) {
  return traceBraintrustStep(
    `tool.${input.toolName}`,
    () => executeMcpToolWithTracing(input),
    mcpToolTraceMetadata(input),
    { type: "tool", input: input.args },
  );
}

async function executeMcpToolWithTracing(
  input: McpToolContext & {
    mcpServer: McpProviderKey;
    toolCallId: string;
    toolName: string;
    rawToolName: string;
    execute:
      | ((input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>)
      | undefined;
    args: unknown;
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
    logBraintrustCurrentSpan({
      error: braintrustError(error),
      metadata: {
        session_id: input.sessionId,
        message_id: input.assistantMessageId,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        mcp_server: input.mcpServer,
        mcp_tool_name: input.rawToolName,
        model_provider: input.observabilityContext?.modelProvider,
        model_name: input.observabilityContext?.modelName,
      },
    });
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
        },
      }),
    );
  }

  logBraintrustCurrentSpan({
    output,
    metadata: {
      ...mcpToolTraceMetadata(input),
      tool_message_id: toolMessageId,
      failed,
    },
  });

  return output;
}

function mcpToolTraceMetadata(
  input: McpToolContext & {
    mcpServer: McpProviderKey;
    toolCallId: string;
    toolName: string;
    rawToolName: string;
  },
) {
  return {
    session_id: input.sessionId,
    message_id: input.assistantMessageId,
    tool_call_id: input.toolCallId,
    tool_name: input.toolName,
    mcp_server: input.mcpServer,
    mcp_tool_name: input.rawToolName,
    model_provider: input.observabilityContext?.modelProvider,
    model_name: input.observabilityContext?.modelName,
  };
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

function braintrustError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
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

async function loadMcpConnection(input: McpToolContext, provider: McpProvider) {
  const db = getDb();
  const { workspaceId } = input;
  const [[experiment], [server]] = await Promise.all([
    db
      .select({ enabled: workspaceExperiments.enabled })
      .from(workspaceExperiments)
      .where(
        and(
          eq(workspaceExperiments.workspaceId, workspaceId),
          eq(workspaceExperiments.key, MCP_EXPERIMENT_KEY),
        ),
      )
      .limit(1),
    db
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
      .limit(1),
  ]);

  if (!experiment?.enabled) {
    throw new Error(
      `${provider.displayName} MCP is enabled on this agent, but the workspace MCP beta is off.`,
    );
  }
  if (!server || server.status !== "configured") {
    throw new Error(
      `${provider.displayName} MCP is enabled on this agent, but ${provider.displayName} is not configured.`,
    );
  }

  const rows = await db
    .select({
      serverId: workspaceMcpCredentials.serverId,
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

  const oauthRow = rows.find(
    (candidate) => candidate.credentialKind === provider.oauthCredentialKind,
  );
  if (oauthRow) {
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
    return {
      endpointUrl: server.endpointUrl,
      serverId: oauthRow.serverId,
      auth: { type: "oauth" as const, payload },
    };
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
  return {
    endpointUrl: server.endpointUrl,
    serverId: bearerRow.serverId,
    auth: { type: "bearer" as const, bearerToken },
  };
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
        encryptedPayload,
        encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
        lastRotatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceMcpCredentials.serverId, workspaceMcpCredentials.kind],
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

function sanitizeMcpToolName(name: string) {
  const normalized = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
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
