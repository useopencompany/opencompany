import { createMCPClient, type OAuthClientProvider } from "@ai-sdk/mcp";
import type { RemoteMcpServer } from "@opencompany/agent-runtime";
import type { PluginGatewayDiscoveredTool } from "@opencompany/core";
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
  id: PluginGatewayDiscoveredTool["classification"]["capabilityId"];
  label: string;
  defaultMode: CapabilityMode;
  tools: readonly string[];
};

export type RemoteMcpConnectionState = {
  connected: boolean;
  integrationId: string | null;
  capabilityModes: Record<string, unknown>;
  toolModes: Record<string, unknown>;
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
  discoverySnapshot: readonly PluginGatewayDiscoveredTool[];
  getState: (input: {
    userWorkosId: string;
    workspaceId: string;
  }) => Promise<RemoteMcpConnectionState>;
  loadConnection: (input: {
    userWorkosId: string;
    workspaceId: string;
    onAuthorizationRequired: () => never;
  }) => Promise<RemoteMcpWorkerConnection>;
  isEnabled: () => Promise<boolean>;
};

type RemoteMcpDiscoveryRegistration = Omit<
  RemoteMcpGatewayRegistration,
  "discoverySnapshot" | "isEnabled"
>;

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
  toolsFromDefinitions(input: { tools: RemoteToolDefinition[] }): unknown;
  close(): Promise<void>;
};

export type RemoteMcpGatewayDependencies = {
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

// Resolve one registered remote MCP server into the shared action catalog. The catalog is built
// only from the persisted discovery snapshot; execution remains in this server-only adapter, and
// the returned model-facing descriptors contain neither endpoint configuration nor credentials.
export async function resolveRemoteMcpActions(
  identity: { userWorkosId: string; workspaceId: string },
  registration: RemoteMcpGatewayRegistration,
  dependencies: Partial<RemoteMcpGatewayDependencies> = {},
): Promise<ActionProviderCatalog | null> {
  const deps = { ...defaultDependencies, ...dependencies };
  const state = await registration.getState(identity);
  if (!state.connected || !state.integrationId) return null;
  const integrationId = state.integrationId;
  const definitions = registration.discoverySnapshot;

  const actions = definitions.flatMap((definition): ResolvedAction[] => {
    const classification = storedClassification(definition.classification);
    const permissionMode = effectiveRemoteMcpMode(
      definition.name,
      classification,
      state.capabilityModes,
      state.toolModes,
    );
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
            identity,
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

// Discovery is deliberately separate from catalog resolution. Callers persist this classified
// snapshot and every list/execute path serves the stored definitions without a tools/list call.
export async function discoverRemoteMcpSnapshot(
  identity: { userWorkosId: string; workspaceId: string },
  registration: RemoteMcpDiscoveryRegistration,
  dependencies: Partial<RemoteMcpGatewayDependencies> = {},
): Promise<PluginGatewayDiscoveredTool[] | null> {
  const deps = { ...defaultDependencies, ...dependencies };
  const state = await registration.getState(identity);
  if (!state.connected || !state.integrationId) return null;
  const connection = await registration.loadConnection({
    ...identity,
    onAuthorizationRequired: () => {
      throw remoteAuthError(registration, "auth_expired");
    },
  });
  if (!connection.ok || connection.integrationId !== state.integrationId) return null;

  const client = await deps.createClient(
    clientConfig(registration.server, connection.authProvider),
  );
  try {
    const definitions = await discoverRemoteTools({
      client,
      registration,
      connection,
      identity,
      recordDispatch: deps.recordDispatch,
    });
    return definitions.map((definition) => {
      const classification = classifyRemoteTool(definition, registration.capabilities);
      return {
        name: definition.name,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.inputSchema !== undefined ? { inputSchema: definition.inputSchema } : {}),
        ...(definition.annotations !== undefined ? { annotations: definition.annotations } : {}),
        classification: {
          capabilityId: classification.capability.id,
          capabilityLabel: classification.capability.label,
          defaultMode: classification.capability.defaultMode,
          bucket: classification.bucket,
          curated: classification.curated,
        },
      };
    });
  } finally {
    await client.close().catch(() => {});
  }
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
      bucket: capability.id === "write" ? "write" : "read",
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
  toolName: string,
  classification: ToolClassification,
  storedModes: Record<string, unknown>,
  storedToolModes: Record<string, unknown>,
): CapabilityMode {
  const toolMode = storedToolModes[toolName];
  if (isCapabilityMode(toolMode)) return toolMode;
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
  registration: Pick<RemoteMcpGatewayRegistration, "source" | "label">;
  connection: Extract<RemoteMcpWorkerConnection, { ok: true }>;
  identity: { userWorkosId: string; workspaceId: string };
  recordDispatch: RemoteMcpGatewayDependencies["recordDispatch"];
}) {
  const definitions: RemoteToolDefinition[] = [];
  const signal = AbortSignal.timeout(MCP_DISCOVERY_TIMEOUT_MS);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    await input.recordDispatch({
      operation: "tools/list",
      actingAgent: "action_gateway",
      actingUser: input.identity.userWorkosId,
      capability: "read",
      source: input.registration.source,
      tool: null,
      integrationId: input.connection.integrationId,
      workspaceId: input.identity.workspaceId,
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
  identity: { userWorkosId: string; workspaceId: string };
  registration: RemoteMcpGatewayRegistration;
  definition: RemoteToolDefinition;
  classification: ToolClassification;
  catalogPermissionMode: "on" | "ask";
  expectedIntegrationId: string;
  params: Record<string, unknown>;
  context: ActionExecuteContext;
  dependencies: RemoteMcpGatewayDependencies;
}) {
  if (!(await input.registration.isEnabled())) {
    throw new ActionPermissionError(
      input.registration.connectionProvider,
      `${input.registration.label} was disabled before this action could run.`,
    );
  }
  const identity = {
    userWorkosId: input.context.userWorkosId,
    workspaceId: input.context.workspaceId ?? input.identity.workspaceId,
  };
  const current = await input.registration.getState(identity);
  if (!current.connected || !current.integrationId) {
    throw remoteAuthError(input.registration, "not_connected");
  }
  if (current.integrationId !== input.expectedIntegrationId) {
    throw new ActionPermissionError(
      input.registration.connectionProvider,
      `${input.registration.label} changed connections before this action could run. Retry with the current connection.`,
    );
  }
  const currentMode = effectiveRemoteMcpMode(
    input.definition.name,
    input.classification,
    current.capabilityModes,
    current.toolModes,
  );
  if (currentMode === "off" || (input.catalogPermissionMode === "on" && currentMode === "ask")) {
    throw new ActionPermissionError(
      input.registration.connectionProvider,
      `${input.classification.capability.label} permission changed before this action could run. Retry to use the current permission.`,
    );
  }

  const connection = await input.registration.loadConnection({
    ...identity,
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
    // Execution clients do not call tools/list because the gateway serves its persisted discovery
    // snapshot. Preload the selected definition so @ai-sdk/mcp can honor transport metadata such
    // as x-mcp-header and mirror structured arguments into request-specific Mcp-Param-* headers.
    client.toolsFromDefinitions({ tools: [input.definition] });
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

function storedClassification(
  classification: PluginGatewayDiscoveredTool["classification"],
): ToolClassification {
  return {
    capability: {
      id: classification.capabilityId,
      label: classification.capabilityLabel,
      defaultMode: classification.defaultMode,
      tools: [],
    },
    bucket: classification.bucket,
    curated: classification.curated,
  };
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
  registration: Pick<RemoteMcpGatewayRegistration, "connectionProvider" | "label">,
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
