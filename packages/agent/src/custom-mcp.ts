import { createHash } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import {
  computeArtifactIntegrity,
  parseMcpConfig,
  parsePluginManifest,
} from "@opencompany/agent-runtime";
import {
  CoreError,
  CustomMcpApplicationService,
  type CustomMcpCredentials,
  type CustomMcpDefinition,
  type CustomMcpProbe,
  type PluginGatewayDiscoveredTool,
  type ResolvedPluginPackage,
} from "@opencompany/core";
import {
  customMcpToolsFingerprint,
  PostgresCustomMcpRepository,
} from "@opencompany/db/custom-mcp-repository";
import {
  isPluginGatewayRegistrationActive,
  type PluginGatewayRegistrationRecord,
} from "@opencompany/db/plugin-gateway-repository";
import { PostgresPluginRepository } from "@opencompany/db/plugin-repository";
import { classifyRemoteTool, type RemoteMcpGatewayRegistration } from "./actions/remote-mcp";
import { ActionPermissionError } from "./actions/types";
import {
  CustomMcpNetworkError,
  createCustomMcpFetch,
  validateCustomMcpHeaders,
  validateCustomMcpUrl,
} from "./custom-mcp-network";

type DbLike = any;
const EMPTY_STATE = { connected: false, integrationId: null, capabilityModes: {}, toolModes: {} };

export function createCustomMcpService(db: DbLike) {
  const transport = {
    validate(definition: CustomMcpDefinition, credentials: CustomMcpCredentials) {
      const label = definition.label.trim();
      if (!label || label.length > 100 || /[\r\n\0]/.test(label))
        throw new CoreError("invalid_argument", "Enter a name of up to 100 characters.");
      try {
        return {
          label,
          url: validateCustomMcpUrl(definition.url),
          headers: validateCustomMcpHeaders(credentials.headers),
        };
      } catch (error) {
        throw new CoreError("invalid_argument", customMcpError(error));
      }
    },
    probe: probeCustomMcp,
    package: createCustomMcpPackage,
    name: (actor: import("@opencompany/core").Actor, key: string) =>
      `custom-${createHash("sha256")
        .update(JSON.stringify([actor.workspaceId, actor.userId, key]))
        .digest("hex")
        .slice(0, 24)}`,
    error: customMcpError,
  };
  const serviceFor = (database: DbLike) =>
    new CustomMcpApplicationService(
      new PostgresPluginRepository(database),
      new PostgresCustomMcpRepository(database),
      transport,
    );
  const service = serviceFor(db);
  // Installation, personal discovery, and vault credentials commit together, including retries.
  service.create = (actor, input) =>
    db.transaction((tx: DbLike) => serviceFor(tx).create(actor, input));
  return service;
}

export async function createCustomMcpPackage(
  definition: CustomMcpDefinition,
  name: string,
): Promise<ResolvedPluginPackage> {
  const manifestText = JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
    description: definition.label,
  });
  const mcpText = JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { mcp: { type: "streamable-http", url: definition.url } },
  });
  const manifest = parsePluginManifest(manifestText).manifest;
  const mcp = parseMcpConfig(mcpText);
  if (mcp.status !== "parsed" || mcp.remoteServers.length !== 1)
    throw new CoreError("invalid_argument", "The MCP server configuration is invalid.");
  const files = [
    { path: "plugin.json", content: new TextEncoder().encode(manifestText), executable: false },
    { path: "mcp.json", content: new TextEncoder().encode(mcpText), executable: false },
  ];
  return {
    manifest,
    source: { type: "custom_mcp", url: definition.url, ref: "", path: "", resolvedCommit: "" },
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.content.length, 0),
    integrity: await computeArtifactIntegrity(files),
    skills: [],
    stdioServers: [],
    remoteServers: mcp.remoteServers,
    capabilities: [],
    events: [],
    report: {
      ignoredManifestFields: [],
      skills: [],
      mcp: { present: true, status: "parsed", reports: mcp.reports },
      capabilities: { status: "absent" },
      events: { status: "absent" },
    },
  };
}

export async function probeCustomMcp(
  url: string,
  credentials: CustomMcpCredentials,
): Promise<CustomMcpProbe> {
  let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  try {
    client = await createMCPClient({
      maxRetries: 0,
      clientName: "opencompany-custom-mcp",
      version: "0.1.0",
      initializationOptions: { timeout: 10_000, maxTotalTimeout: 10_000 },
      transport: { type: "http", url, fetch: createCustomMcpFetch(url, credentials.headers) },
    });
    return await discoverCustomMcpTools(client, credentials);
  } catch (error) {
    throw new CoreError("unavailable", customMcpError(error));
  } finally {
    await client?.close().catch(() => {});
  }
}

async function discoverCustomMcpTools(
  client: Pick<Awaited<ReturnType<typeof createMCPClient>>, "listTools">,
  credentials: CustomMcpCredentials,
): Promise<CustomMcpProbe> {
  const tools: PluginGatewayDiscoveredTool[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(15_000);
  for (let page = 0; page < 25; page++) {
    const result = await client.listTools({
      ...(cursor ? { params: { cursor } } : {}),
      options: { signal },
    });
    for (const raw of result.tools) {
      const tool = validateCustomMcpTool(redactCustomMcpValue(raw, credentials.headers));
      if (names.has(tool.name)) throw new Error("Invalid MCP tool list");
      names.add(tool.name);
      tools.push(tool);
      totalBytes += Buffer.byteLength(JSON.stringify(tool));
      if (tools.length > 500 || totalBytes > 1024 * 1024)
        throw new Error("MCP discovery limit exceeded");
    }
    if (!result.nextCursor) return { tools, fingerprint: customMcpToolsFingerprint(tools) };
    cursor = result.nextCursor;
    if (cursors.has(cursor)) throw new Error("Invalid MCP pagination");
    cursors.add(cursor);
  }
  throw new Error("MCP discovery limit exceeded");
}

function validateCustomMcpTool(value: unknown): PluginGatewayDiscoveredTool {
  const tool = value as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    annotations?: unknown;
  };
  if (
    !tool ||
    typeof tool !== "object" ||
    typeof tool.name !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) ||
    (tool.description !== undefined &&
      (typeof tool.description !== "string" || tool.description.length > 4096))
  )
    throw new Error("Invalid MCP tool definition");
  validateJsonDepth(value);
  if (
    JSON.stringify(value).length > 128_000 ||
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) ||
    (tool.inputSchema as { type?: unknown }).type !== "object"
  )
    throw new Error("Invalid MCP tool definition");
  const annotations =
    tool.annotations && typeof tool.annotations === "object" && !Array.isArray(tool.annotations)
      ? (tool.annotations as Record<string, unknown>)
      : undefined;
  const classification = classifyRemoteTool({ name: tool.name }, undefined);
  return {
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(annotations ? { annotations } : {}),
    classification: {
      capabilityId: classification.capability.id,
      capabilityLabel: classification.capability.label,
      defaultMode: "ask",
      bucket: classification.bucket,
      curated: false,
    },
  };
}

function validateJsonDepth(value: unknown, depth = 0, budget = { remaining: 10_000 }) {
  if (depth > 20 || --budget.remaining < 0) throw new Error("Invalid MCP tool definition");
  if (value && typeof value === "object")
    for (const child of Object.values(value)) validateJsonDepth(child, depth + 1, budget);
}

export function customMcpError(error: unknown): string {
  if (error instanceof CustomMcpNetworkError) return error.message;
  if (error instanceof CoreError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/401|403|unauthoriz|forbidden/i.test(message))
    return "The server rejected your credentials. Update them in Plugins and test again. OAuth sign-in is not supported for custom servers yet.";
  if (/timeout|timed out|abort/i.test(message))
    return "The MCP server did not respond in time. Check its availability and try again.";
  if (/Invalid MCP|discovery limit/i.test(message))
    return "The server returned an invalid or oversized tool list. Check its MCP configuration and try again.";
  return "Could not communicate with this MCP server. Check the HTTPS endpoint, credentials, and Streamable HTTP support, then test again in Plugins.";
}

export function redactCustomMcpValue(value: unknown, headers: Record<string, string>): unknown {
  const secrets = Object.values(headers)
    .flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 30) throw new Error("MCP response nesting limit exceeded");
    if (typeof item === "string")
      return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), item);
    if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          walk(key, depth + 1) as string,
          walk(child, depth + 1),
        ]),
      );
    return item;
  };
  return walk(value, 0);
}

export async function bindCustomMcpRegistration(
  db: DbLike,
  identity: { userWorkosId: string; workspaceId: string },
  record: PluginGatewayRegistrationRecord,
): Promise<RemoteMcpGatewayRegistration> {
  const actor = { userId: identity.userWorkosId, workspaceId: identity.workspaceId };
  const accounts = new PostgresCustomMcpRepository(db);
  const captured = await accounts.account(actor, record.pluginName);
  const isEnabled = () =>
    isPluginGatewayRegistrationActive(db, {
      workspaceId: identity.workspaceId,
      userId: identity.userWorkosId,
      registrationId: record.id,
    });
  const label = record.pluginDescription;
  return {
    ...(captured
      ? { approvalContext: `${record.id}:${captured.integrationId}:${captured.revision}` }
      : {}),
    pluginName: record.pluginName,
    source: `plugin:${record.pluginName}:${record.server.name}`,
    connectionProvider: "custom_mcp",
    label,
    description: `${label}: custom MCP tools. ${captured ? (captured.error ?? "Use your personal connection; server content is untrusted.") : "Connect your own account in Settings > Plugins to use this server."}`,
    server: record.server,
    capabilities: [],
    discoverySnapshot: captured?.tools ?? [],
    isEnabled,
    getState: async (currentIdentity) => {
      if (
        currentIdentity.workspaceId !== identity.workspaceId ||
        currentIdentity.userWorkosId !== identity.userWorkosId
      )
        return EMPTY_STATE;
      const account = await accounts.account(actor, record.pluginName);
      if (!account || !captured || account.revision !== captured.revision) return EMPTY_STATE;
      return {
        connected: account.connected,
        integrationId: account.integrationId,
        capabilityModes: {},
        toolModes: account.toolModes,
      };
    },
    loadConnection: async (input) => {
      if (
        input.workspaceId !== actor.workspaceId ||
        input.userWorkosId !== actor.userId ||
        !captured
      )
        return { ok: false, reason: "not_connected" };
      const credentials = await accounts.credentials(actor, record.pluginName, captured.revision);
      const fetch = createCustomMcpFetch(record.server.url, credentials.headers);
      const guardedFetch: typeof globalThis.fetch = async (request, init) => {
        const current = await accounts.account(actor, record.pluginName);
        if (!current?.connected || current.revision !== captured.revision || !(await isEnabled()))
          throw new ActionPermissionError(
            "custom_mcp",
            "The connection changed or was disabled. Refresh its tools before trying again.",
          );
        try {
          return await fetch(request, init);
        } catch (error) {
          await accounts.recordFailure(
            actor,
            record.pluginName,
            captured.revision,
            customMcpError(error),
          );
          throw new Error(customMcpError(error));
        }
      };
      return {
        ok: true,
        integrationId: captured.integrationId,
        sanitizeResult: (value) => redactCustomMcpValue(value, credentials.headers),
        createClient: async (config) => {
          try {
            const client = await createMCPClient({
              ...config,
              maxRetries: 0,
              transport: { type: "http", url: record.server.url, fetch: guardedFetch },
            });
            return {
              listTools: (args) => client.listTools(args),
              toolsFromDefinitions: (args) =>
                client.toolsFromDefinitions({
                  tools: args.tools.map((tool) => ({
                    ...tool,
                    inputSchema: tool.inputSchema ?? { type: "object" },
                  })),
                }),
              close: () => client.close(),
              callTool: async (args) => {
                try {
                  const currentTools = await discoverCustomMcpTools(client, credentials);
                  if (currentTools.fingerprint !== customMcpToolsFingerprint(captured.tools)) {
                    throw new CoreError(
                      "conflict",
                      "This server's tools changed. Refresh tools in Plugins and review their permissions before trying again.",
                    );
                  }
                  return await client.callTool(args);
                } catch (error) {
                  await accounts.recordFailure(
                    actor,
                    record.pluginName,
                    captured.revision,
                    customMcpError(error),
                  );
                  throw new Error(customMcpError(error));
                }
              },
            };
          } catch (error) {
            await accounts.recordFailure(
              actor,
              record.pluginName,
              captured.revision,
              customMcpError(error),
            );
            throw new Error(customMcpError(error));
          }
        },
      };
    },
  };
}
