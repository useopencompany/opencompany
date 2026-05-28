import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  createMCPClient,
  type MCPClient,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { type AgentConfig, newAgentSessionMessageId } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  workspaceExperiments,
  workspaceMcpCredentials,
  workspaceMcpServers,
} from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { jsonSchema, type ToolSet, tool } from "ai";
import { and, eq } from "drizzle-orm";
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

const MCP_EXPERIMENT_KEY = "mcp";
const LINEAR_MCP_SERVER_KEY = "linear";
const LINEAR_MCP_OAUTH_CREDENTIAL_KIND = "oauth";
const ENCRYPTION_KEY_ENV = "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_VERSION = 1;
const ENCRYPTION_KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;

type McpToolContext = {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  internalMessages?: boolean;
  workspaceId: string;
  agentConfig: AgentConfig;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
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
};

export async function createMcpToolSet(input: McpToolContext): Promise<McpToolSet> {
  const wantsLinear = input.agentConfig.tools.some(
    (configTool) => configTool.id === "linear" && configTool.type === "mcp",
  );
  if (!wantsLinear) return emptyMcpToolSet();

  const linear = await loadLinearMcpConnection(input.workspaceId);
  const transport =
    linear.auth.type === "oauth"
      ? {
          type: "http" as const,
          url: linear.endpointUrl,
          authProvider: createRunnerLinearMcpOAuthProvider({
            workspaceId: input.workspaceId,
            serverId: linear.serverId,
            payload: linear.auth.payload,
          }),
        }
      : {
          type: "http" as const,
          url: linear.endpointUrl,
          headers: {
            Authorization: `Bearer ${linear.auth.bearerToken}`,
          },
        };
  const client = await createMCPClient({
    clientName: "opencompany-runner",
    version: "0.2.0",
    transport,
  });

  try {
    const definitions = await client.listTools({ options: { signal: input.signal } });
    const rawTools = client.toolsFromDefinitions(definitions);
    const tools: ToolSet = {};
    const usedNames = new Set<string>();

    for (const [rawName, rawTool] of Object.entries(rawTools)) {
      const prefixedName = uniqueToolName(`linear__${sanitizeMcpToolName(rawName)}`, usedNames);
      const mcpTool = rawTool as {
        description?: string;
        inputSchema?: unknown;
        execute?: (input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>;
      };
      tools[prefixedName] = tool({
        description: `Linear MCP: ${mcpTool.description ?? rawName}`,
        inputSchema:
          (mcpTool.inputSchema as never) ?? jsonSchema({ type: "object", properties: {} } as never),
        onInputAvailable: async ({
          input: toolInput,
          toolCallId,
        }: {
          input: unknown;
          toolCallId: string;
        }) => {
          await input.checkAbort();
          await requireLeaseWrite(
            appendRuntimeEventForLease({
              sessionId: input.sessionId,
              messageId: input.assistantMessageId,
              leaseId: input.runLeaseId,
              leaseOwner: input.runLeaseOwner,
              type: "tool.started",
              payload: {
                messageId: input.assistantMessageId,
                toolCallId,
                name: prefixedName,
                input: toolInput,
              },
            }),
          );
        },
        execute: async (toolInput: unknown, options: { toolCallId: string }) =>
          executeMcpTool({
            ...input,
            toolCallId: options.toolCallId,
            toolName: prefixedName,
            rawToolName: rawName,
            execute: mcpTool.execute,
            args: toolInput,
          }),
      } as never) as ToolSet[string];
    }

    return { tools, close: () => client.close() };
  } catch (error) {
    await closeMcpClient(client);
    throw error;
  }
}

async function executeMcpTool(
  input: McpToolContext & {
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
    captureException(error, {
      event: "opencompany.runner_mcp_tool_failed",
      workspace_id: input.observabilityContext?.workspaceId,
      user_id: input.observabilityContext?.userId,
      agent_id: input.observabilityContext?.agentId,
      session_id: input.sessionId,
      message_id: input.assistantMessageId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      mcp_server: LINEAR_MCP_SERVER_KEY,
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
          output,
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
          output,
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

async function loadLinearMcpConnection(workspaceId: string) {
  const db = getDb();
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
          eq(workspaceMcpServers.serverKey, LINEAR_MCP_SERVER_KEY),
        ),
      )
      .limit(1),
  ]);

  if (!experiment?.enabled) {
    throw new Error("Linear MCP is enabled on this agent, but the workspace MCP beta is off.");
  }
  if (!server || server.status !== "configured") {
    throw new Error("Linear MCP is enabled on this agent, but Linear is not configured.");
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
    (candidate) => candidate.credentialKind === LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
  );
  if (oauthRow) {
    const payload = parseLinearMcpOAuthPayload(
      decryptPayload(oauthRow.encryptedPayload, {
        workspaceId,
        serverId: oauthRow.serverId,
        kind: oauthRow.credentialKind,
        keyVersion: oauthRow.encryptionKeyVersion,
      }),
    );
    if (!payload.clientInformation || !payload.tokens) {
      throw new Error("Linear MCP OAuth credential is incomplete. Reconnect Linear.");
    }
    return {
      endpointUrl: server.endpointUrl,
      serverId: oauthRow.serverId,
      auth: { type: "oauth" as const, payload },
    };
  }

  const bearerRow = rows.find((candidate) => candidate.credentialKind === "bearer_token");
  if (!bearerRow)
    throw new Error("Linear MCP is enabled on this agent, but Linear is not configured.");
  const payload = decryptPayload(bearerRow.encryptedPayload, {
    workspaceId,
    serverId: bearerRow.serverId,
    kind: bearerRow.credentialKind,
    keyVersion: bearerRow.encryptionKeyVersion,
  });
  const bearerToken = typeof payload.bearerToken === "string" ? payload.bearerToken.trim() : "";
  if (!bearerToken) throw new Error("Linear MCP credential is missing a bearer token.");
  return {
    endpointUrl: server.endpointUrl,
    serverId: bearerRow.serverId,
    auth: { type: "bearer" as const, bearerToken },
  };
}

type LinearMcpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

function createRunnerLinearMcpOAuthProvider(input: {
  workspaceId: string;
  serverId: string;
  payload: LinearMcpOAuthPayload;
}): OAuthClientProvider {
  let payload = input.payload;

  async function persist(next: LinearMcpOAuthPayload) {
    payload = next;
    const encryptedPayload = encryptPayload(
      { ...next },
      {
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        kind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
        keyVersion: ENCRYPTION_KEY_VERSION,
      },
    );
    const now = new Date();
    await getDb()
      .insert(workspaceMcpCredentials)
      .values({
        id: newWorkspaceMcpCredentialId(),
        workspaceId: input.workspaceId,
        serverId: input.serverId,
        kind: LINEAR_MCP_OAUTH_CREDENTIAL_KIND,
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
      return linearMcpCallbackUrl();
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany Runner",
        redirect_uris: [linearMcpCallbackUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
    clientInformation: () => payload.clientInformation,
    tokens: () => payload.tokens,
    saveTokens: async (tokens) => persist({ ...payload, tokens }),
    saveClientInformation: async (clientInformation) => persist({ ...payload, clientInformation }),
    saveCodeVerifier: async (codeVerifier) => persist({ ...payload, codeVerifier }),
    codeVerifier: () => {
      if (!payload.codeVerifier) throw new Error("Linear MCP OAuth verifier is missing.");
      return payload.codeVerifier;
    },
    state: () => payload.state ?? "",
    saveState: async (state) => persist({ ...payload, state }),
    storedState: () => payload.state,
    redirectToAuthorization: () => {
      throw new Error("Linear MCP needs to be reconnected from workspace settings.");
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all") {
        await persist({});
      } else if (scope === "tokens") {
        await persist(omitOAuthPayload(payload, ["tokens"]));
      } else if (scope === "verifier") {
        await persist(omitOAuthPayload(payload, ["codeVerifier", "state"]));
      } else if (scope === "client") {
        await persist(omitOAuthPayload(payload, ["clientInformation"]));
      }
    },
  };
}

function parseLinearMcpOAuthPayload(payload: Record<string, unknown>): LinearMcpOAuthPayload {
  const parsed: LinearMcpOAuthPayload = {};
  if (isOAuthClientInformation(payload.clientInformation)) {
    parsed.clientInformation = payload.clientInformation;
  }
  if (isOAuthTokens(payload.tokens)) parsed.tokens = payload.tokens;
  if (typeof payload.codeVerifier === "string") parsed.codeVerifier = payload.codeVerifier;
  if (typeof payload.state === "string") parsed.state = payload.state;
  return parsed;
}

function omitOAuthPayload<TKey extends keyof LinearMcpOAuthPayload>(
  payload: LinearMcpOAuthPayload,
  keys: TKey[],
) {
  const next = { ...payload };
  for (const key of keys) delete next[key];
  return next;
}

function decryptPayload(
  encryptedPayload: {
    algorithm: string;
    iv: string;
    ciphertext: string;
    authTag: string;
  },
  context: { workspaceId: string; serverId: string; kind: string; keyVersion: number },
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
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      loadEncryptionKey(),
      Buffer.from(encryptedPayload.iv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(
        JSON.stringify({
          workspaceId: context.workspaceId,
          serverId: context.serverId,
          kind: context.kind,
          keyVersion: context.keyVersion,
        }),
        "utf8",
      ),
    );
    decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as unknown;
    if (!isRecord(payload)) throw new Error("Decrypted MCP credential payload is invalid.");
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unsupported MCP credential")) {
      throw error;
    }
    throw new Error("MCP credential could not be decrypted.");
  }
}

function encryptPayload(
  payload: Record<string, unknown>,
  context: { workspaceId: string; serverId: string; kind: string; keyVersion: number },
) {
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, loadEncryptionKey(), iv);
  cipher.setAAD(mcpCredentialAuthenticatedData(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    algorithm: ENCRYPTION_ALGORITHM as "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function mcpCredentialAuthenticatedData(context: {
  workspaceId: string;
  serverId: string;
  kind: string;
  keyVersion: number;
}) {
  return Buffer.from(
    JSON.stringify({
      workspaceId: context.workspaceId,
      serverId: context.serverId,
      kind: context.kind,
      keyVersion: context.keyVersion,
    }),
    "utf8",
  );
}

function loadEncryptionKey() {
  const raw = process.env[ENCRYPTION_KEY_ENV]?.trim();
  if (!raw) throw new Error(`${ENCRYPTION_KEY_ENV} is required for MCP credential storage.`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte key.`);
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== ENCRYPTION_KEY_BYTE_LENGTH) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must be a base64-encoded 32-byte key.`);
  }
  return key;
}

function newWorkspaceMcpCredentialId() {
  return `wmcpc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function linearMcpCallbackUrl() {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim().replace(/\/auth\/callback$/, "") ||
    "http://localhost:3000";
  return `${appUrl.replace(/\/$/, "")}/api/mcp/linear/callback`;
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
  return { tools: {}, close: async () => {} };
}

async function closeMcpClient(client: MCPClient) {
  try {
    await client.close();
  } catch {
    // Best effort cleanup after setup failure.
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Run aborted.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
