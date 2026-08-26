import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp";
import type { RemoteMcpServer } from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";
import type { JSONSchema7 } from "ai";
import { type CapabilityId, type CapabilityMode, isCapabilityMode } from "./capabilities";
import {
  ACTION_EFFECTS_READ,
  ACTION_EFFECTS_WRITE,
  ActionAuthError,
  type ActionExecuteContext,
  ActionPermissionError,
  type ActionProviderCatalog,
  type ActionProviderId,
  type ActionSourceId,
  type ResolvedAction,
} from "./types";

const MAX_DISCOVERY_PAGES = 25;
const MAX_DISCOVERED_TOOLS = 500;
const MCP_INITIALIZATION_TIMEOUT_MS = 10_000;
const MCP_DISCOVERY_TIMEOUT_MS = 15_000;

const logger = createLogger({ service: "opencompany-agent", runtime: "remote-mcp-gateway" });

export type RemoteMcpCapabilityDefinition = {
  id: CapabilityId;
  label: string;
  defaultMode: CapabilityMode;
  tools: readonly string[];
};

export type RemoteMcpConnectionState = {
  connected: boolean;
  integrationId: string | null;
  capabilityModes: Record<string, unknown>;
};

export type RemoteMcpWorkerConnection =
  | { ok: false; reason: "not_connected" | "needs_reauth" }
  | { ok: true; integrationId: string; authProvider: OAuthClientProvider };

export type RemoteMcpGatewayRegistration = {
  source: ActionSourceId;
  connectionProvider: ActionProviderId;
  label: string;
  description: string;
  server: RemoteMcpServer;
  capabilities?: readonly RemoteMcpCapabilityDefinition[];
  getState: (userWorkosId: string) => Promise<RemoteMcpConnectionState>;
  loadConnection: (input: {
    userWorkosId: string;
    onAuthorizationRequired: () => never;
  }) => Promise<RemoteMcpWorkerConnection>;
};

export type RemoteMcpDispatchAudit = {
  operation: "tools/list" | "tools/call";
  actingAgent: "action_gateway" | NonNullable<ActionExecuteContext["sourceEngine"]>;
  actingUser: string;
  capability: CapabilityId;
  source: ActionSourceId;
  tool: string | null;
  integrationId: string;
  workspaceId?: string;
  turnId?: string;
  toolCallId?: string;
};

type RemoteToolDefinition = {
  name: string;
  description?: string | undefined;
  inputSchema?:
    | (Record<string, unknown> & {
        type?: unknown;
        properties?: Record<string, unknown> | undefined;
      })
    | undefined;
  annotations?: Record<string, unknown> | undefined;
};

type RemoteMcpClient = {
  listTools(input?: {
    params?: { cursor?: string };
    options?: { signal?: AbortSignal };
  }): Promise<{ tools: RemoteToolDefinition[]; nextCursor?: string | undefined }>;
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
    options?: { signal?: AbortSignal };
  }): Promise<unknown>;
  close(): Promise<void>;
};

type RemoteMcpGatewayDependencies = {
  createClient: (input: {
    clientName: string;
    version: string;
    initializationOptions: { timeout: number; maxTotalTimeout: number };
    transport: {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      authProvider: OAuthClientProvider;
    };
  }) => Promise<RemoteMcpClient>;
  recordDispatch: (audit: RemoteMcpDispatchAudit) => Promise<void>;
};

const defaultDependencies: RemoteMcpGatewayDependencies = {
  createClient: (input) => createMCPClient(input),
  recordDispatch: async (audit) => {
    logger.info("Remote MCP gateway dispatch", {
      event: "opencompany.remote_mcp_gateway_dispatch",
      operation: audit.operation,
      acting_agent: audit.actingAgent,
      acting_user: audit.actingUser,
      capability: audit.capability,
      source: audit.source,
      tool: audit.tool,
      integration_id: audit.integrationId,
      workspace_id: audit.workspaceId,
      turn_id: audit.turnId,
      tool_call_id: audit.toolCallId,
    });
  },
};

// Resolve one registered remote MCP server into the shared action catalog. Discovery and execution
// both happen in this server-only adapter: the returned model-facing descriptors contain neither
// endpoint configuration nor credentials.
export async function resolveRemoteMcpActions(
  userWorkosId: string,
  registration: RemoteMcpGatewayRegistration,
  dependencies: Partial<RemoteMcpGatewayDependencies> = {},
): Promise<ActionProviderCatalog | null> {
  const deps = { ...defaultDependencies, ...dependencies };
  const state = await registration.getState(userWorkosId);
  if (!state.connected || !state.integrationId) return null;
  const integrationId = state.integrationId;

  const connection = await registration.loadConnection({
    userWorkosId,
    onAuthorizationRequired: () => {
      throw remoteAuthError(registration, "auth_expired");
    },
  });
  if (!connection.ok) return null;
  if (connection.integrationId !== integrationId) return null;

  const client = await deps.createClient(
    clientConfig(registration.server, connection.authProvider),
  );
  let definitions: RemoteToolDefinition[];
  try {
    definitions = await discoverRemoteTools({
      client,
      registration,
      connection,
      userWorkosId,
      recordDispatch: deps.recordDispatch,
    });
  } finally {
    await client.close().catch(() => {});
  }

  const actions = definitions.flatMap((definition): ResolvedAction[] => {
    const classification = classifyRemoteTool(definition, registration.capabilities);
    const permissionMode = effectiveRemoteMcpMode(classification, state.capabilityModes);
    if (permissionMode === "off") return [];

    const permission =
      permissionMode === "ask"
        ? {
            provider: registration.connectionProvider,
            capabilityId: classification.capability.id,
            label: classification.capability.label,
            integrationIds: [integrationId],
          }
        : undefined;
    return [
      {
        id: `${registration.source}.${definition.name}`,
        provider: registration.source,
        capability: classification.capability.id,
        effects: classification.bucket === "read" ? ACTION_EFFECTS_READ : ACTION_EFFECTS_WRITE,
        permissionMode,
        ...(permission ? { permission } : {}),
        description:
          definition.description?.trim() || `Call ${definition.name} on ${registration.label}.`,
        params: normalizeInputSchema(definition.inputSchema),
        execute: (params, context) =>
          executeRemoteMcpTool({
            registration,
            definition,
            classification,
            catalogPermissionMode: permissionMode,
            expectedIntegrationId: integrationId,
            params,
            context,
            dependencies: deps,
          }),
      },
    ];
  });

  if (actions.length === 0) return null;
  return {
    id: registration.source,
    label: registration.label,
    description: registration.description,
    actions,
  };
}

type ToolClassification = {
  capability: RemoteMcpCapabilityDefinition;
  bucket: "read" | "write";
  curated: boolean;
};

export function classifyRemoteTool(
  tool: Pick<RemoteToolDefinition, "name" | "annotations">,
  capabilities: readonly RemoteMcpCapabilityDefinition[] | undefined,
): ToolClassification {
  const matches = capabilities?.filter((capability) => capability.tools.includes(tool.name)) ?? [];
  if (matches.length === 1) {
    const capability = matches[0]!;
    return {
      capability,
      bucket: capability.id === "read" ? "read" : "write",
      curated: true,
    };
  }

  const bucket = tool.annotations?.readOnlyHint === true ? "read" : "write";
  return {
    capability: {
      id: bucket,
      label: bucket === "read" ? "Read tools" : "Write & other tools",
      // Vendor annotations classify the generic bucket but can never silently enable a tool.
      defaultMode: "ask",
      tools: [],
    },
    bucket,
    curated: false,
  };
}

function effectiveRemoteMcpMode(
  classification: ToolClassification,
  storedModes: Record<string, unknown>,
): CapabilityMode {
  const stored = storedModes[classification.capability.id];
  if (!classification.curated) {
    // A newly discovered tool must not inherit an existing broad `on` override. It remains Ask
    // until a reviewed map classifies it; `off` is still honored because it can only reduce access.
    return stored === "off" ? "off" : "ask";
  }
  if (isCapabilityMode(stored)) return stored;
  return classification.capability.defaultMode;
}

async function discoverRemoteTools(input: {
  client: RemoteMcpClient;
  registration: RemoteMcpGatewayRegistration;
  connection: Extract<RemoteMcpWorkerConnection, { ok: true }>;
  userWorkosId: string;
  recordDispatch: RemoteMcpGatewayDependencies["recordDispatch"];
}) {
  const definitions: RemoteToolDefinition[] = [];
  const signal = AbortSignal.timeout(MCP_DISCOVERY_TIMEOUT_MS);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    await input.recordDispatch({
      operation: "tools/list",
      actingAgent: "action_gateway",
      actingUser: input.userWorkosId,
      capability: "read",
      source: input.registration.source,
      tool: null,
      integrationId: input.connection.integrationId,
    });
    const result = await input.client.listTools({
      ...(cursor ? { params: { cursor } } : {}),
      options: { signal },
    });
    definitions.push(...result.tools);
    if (definitions.length > MAX_DISCOVERED_TOOLS) {
      throw new Error(
        `${input.registration.label} returned more than ${MAX_DISCOVERED_TOOLS} MCP tools.`,
      );
    }
    cursor = result.nextCursor;
    if (!cursor) return deduplicateToolDefinitions(definitions);
  }
  throw new Error(
    `${input.registration.label} MCP discovery exceeded ${MAX_DISCOVERY_PAGES} pages.`,
  );
}

function deduplicateToolDefinitions(definitions: RemoteToolDefinition[]) {
  const byName = new Map<string, RemoteToolDefinition>();
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || !definition.name.trim()) continue;
    // A repeated name is not a new capability. Keep the first definition from the server's stable
    // page order so pagination cannot mutate an already-catalogued schema.
    if (!byName.has(definition.name)) byName.set(definition.name, definition);
  }
  return [...byName.values()];
}

async function executeRemoteMcpTool(input: {
  registration: RemoteMcpGatewayRegistration;
  definition: RemoteToolDefinition;
  classification: ToolClassification;
  catalogPermissionMode: "on" | "ask";
  expectedIntegrationId: string;
  params: Record<string, unknown>;
  context: ActionExecuteContext;
  dependencies: RemoteMcpGatewayDependencies;
}) {
  const current = await input.registration.getState(input.context.userWorkosId);
  if (!current.connected || !current.integrationId) {
    throw remoteAuthError(input.registration, "not_connected");
  }
  if (current.integrationId !== input.expectedIntegrationId) {
    throw new ActionPermissionError(
      input.registration.connectionProvider,
      `${input.registration.label} changed connections before this action could run. Retry with the current connection.`,
    );
  }
  const currentMode = effectiveRemoteMcpMode(input.classification, current.capabilityModes);
  if (currentMode === "off" || (input.catalogPermissionMode === "on" && currentMode === "ask")) {
    throw new ActionPermissionError(
      input.registration.connectionProvider,
      `${input.classification.capability.label} permission changed before this action could run. Retry to use the current permission.`,
    );
  }

  const connection = await input.registration.loadConnection({
    userWorkosId: input.context.userWorkosId,
    onAuthorizationRequired: () => {
      throw remoteAuthError(input.registration, "auth_expired");
    },
  });
  if (!connection.ok) {
    throw remoteAuthError(
      input.registration,
      connection.reason === "not_connected" ? "not_connected" : "auth_expired",
    );
  }
  if (connection.integrationId !== input.expectedIntegrationId) {
    throw new ActionPermissionError(
      input.registration.connectionProvider,
      `${input.registration.label} changed connections before this action could run. Retry with the current connection.`,
    );
  }

  const client = await input.dependencies.createClient(
    clientConfig(input.registration.server, connection.authProvider),
  );
  try {
    await input.dependencies.recordDispatch({
      operation: "tools/call",
      actingAgent: input.context.sourceEngine ?? "opencompany",
      actingUser: input.context.userWorkosId,
      capability: input.classification.capability.id,
      source: input.registration.source,
      tool: input.definition.name,
      integrationId: connection.integrationId,
      ...(input.context.workspaceId ? { workspaceId: input.context.workspaceId } : {}),
      ...(input.context.sourceTurnId ? { turnId: input.context.sourceTurnId } : {}),
      ...(input.context.toolCallId ? { toolCallId: input.context.toolCallId } : {}),
    });
    const result = await client.callTool({
      name: input.definition.name,
      arguments: input.params,
      options: { signal: input.context.signal },
    });
    return unwrapRemoteMcpResult(result, input.registration.label);
  } finally {
    await client.close().catch(() => {});
  }
}

function clientConfig(server: RemoteMcpServer, authProvider: OAuthClientProvider) {
  return {
    clientName: "opencompany-action-gateway",
    version: "0.1.0",
    initializationOptions: {
      timeout: MCP_INITIALIZATION_TIMEOUT_MS,
      maxTotalTimeout: MCP_INITIALIZATION_TIMEOUT_MS,
    },
    transport: {
      type: server.type === "streamable-http" ? ("http" as const) : ("sse" as const),
      url: server.url,
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
      authProvider,
    },
  };
}

function normalizeInputSchema(value: RemoteToolDefinition["inputSchema"]): JSONSchema7 {
  if (!value || value.type !== "object") {
    return { type: "object", additionalProperties: true, properties: {} };
  }
  return {
    ...value,
    properties: value.properties ?? {},
  } as JSONSchema7;
}

function unwrapRemoteMcpResult(result: unknown, label: string): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const texts = result.content
    .filter(
      (entry): entry is { type: string; text: string } =>
        isRecord(entry) && entry.type === "text" && typeof entry.text === "string",
    )
    .map((entry) => entry.text);
  const joined = texts.join("\n");
  if (result.isError === true) throw new Error(joined || `${label} returned an MCP tool error.`);
  if (texts.length === 0) return result;
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    return joined;
  }
}

function remoteAuthError(
  registration: RemoteMcpGatewayRegistration,
  code: "not_connected" | "auth_expired",
) {
  return new ActionAuthError(
    code,
    registration.connectionProvider,
    `${registration.label} is not usable for this account; reconnect it in Settings.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
