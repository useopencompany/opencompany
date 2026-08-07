import {
  createMCPClient,
  type MCPClient,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { loadIntegrationCredential, saveIntegrationCredential } from "@opencompany/db/integrations";
import { type IntegrationProvider, integrations } from "@opencompany/db/schema";
import Ajv from "ajv";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

const CREDENTIAL_KIND = "oauth_token" as const;
const remoteMcpSchemaValidator = new Ajv({ allErrors: true, strict: false });

type RemoteMcpOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

type McpToolCatalogEntry = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

type McpToolBody =
  | ((
      input: unknown,
      options: { toolCallId: string; abortSignal?: AbortSignal },
    ) => unknown | Promise<unknown>)
  | undefined;

type RemoteMcpConfig<TProvider extends IntegrationProvider> = {
  provider: TProvider;
  displayName: string;
  endpointUrl: string;
  externalId: string;
  authScope?: string;
};

export function createRemoteMcpTools<const TProvider extends IntegrationProvider>(
  config: RemoteMcpConfig<TProvider>,
) {
  const searchToolName = `${config.provider}_search_tools`;
  const useToolName = `${config.provider}_use_tool`;

  function isToolName(name: string) {
    return name === searchToolName || name === useToolName;
  }

  async function execute(input: {
    name: string;
    args: unknown;
    userWorkosId: string;
    signal: AbortSignal;
  }) {
    if (!isToolName(input.name)) {
      throw new Error(`Unknown ${config.displayName} task tool "${input.name}".`);
    }

    const client = await connect(input.userWorkosId);
    try {
      const { catalog, bodyByName } = await loadToolCatalog(client, input.signal);
      if (input.name === searchToolName) {
        return searchTools(catalog, input.args);
      }
      const { tool, arguments: rawArguments } = parseUseToolInput(input.args);
      const entry = catalog.find((candidate) => candidate.name === tool);
      const body = bodyByName.get(tool);
      if (!tool || !entry || !body) {
        return {
          ok: false,
          error: `Unknown ${config.displayName} MCP tool "${tool}". Call ${searchToolName} to list available tools.`,
        };
      }
      if (entry.inputSchema) {
        const validate = remoteMcpSchemaValidator.compile(entry.inputSchema);
        if (!validate(rawArguments)) {
          return {
            ok: false,
            error: `Arguments for ${config.displayName} MCP tool "${tool}" do not match its current input schema. Call ${searchToolName} and retry with that schema.`,
          };
        }
      }
      return await body(rawArguments, {
        toolCallId: `goat_${config.provider}_${tool}`,
        abortSignal: input.signal,
      });
    } finally {
      await client.close().catch(() => {});
    }
  }

  async function connect(userWorkosId: string) {
    const connection = await loadConnection(userWorkosId);
    return createMCPClient({
      clientName: "opencompany-goat-runner",
      version: "0.1.0",
      transport: {
        type: "http" as const,
        url: config.endpointUrl,
        authProvider: createOAuthProvider({
          userWorkosId,
          integrationId: connection.integrationId,
          payload: connection.payload,
        }),
      },
    });
  }

  async function loadConnection(
    userWorkosId: string,
  ): Promise<{ integrationId: string; payload: RemoteMcpOAuthPayload }> {
    const [integration] = await getDb()
      .select({
        id: integrations.id,
        status: integrations.status,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.userWorkosId, userWorkosId),
          eq(integrations.provider, config.provider),
          eq(integrations.externalId, config.externalId),
        ),
      )
      .limit(1);

    if (!integration || integration.status !== "connected") {
      throw new Error(
        `Connect ${config.displayName} in Settings before using ${config.displayName} MCP tools.`,
      );
    }

    const credential = await loadIntegrationCredential({
      userWorkosId,
      integrationId: integration.id,
      provider: config.provider,
      kind: CREDENTIAL_KIND,
    });
    if (!credential) {
      throw new Error(
        `Reconnect ${config.displayName} in Settings before using ${config.displayName} MCP tools.`,
      );
    }

    const payload = parseOAuthPayload(credential.payload);
    if (!payload.clientInformation || !payload.tokens) {
      throw new Error(
        `${config.displayName} MCP credential is incomplete. Reconnect ${config.displayName} in Settings.`,
      );
    }
    return { integrationId: integration.id, payload };
  }

  function createOAuthProvider(input: {
    userWorkosId: string;
    integrationId: string;
    payload: RemoteMcpOAuthPayload;
  }): OAuthClientProvider {
    let payload = input.payload;

    async function persist(next: RemoteMcpOAuthPayload) {
      payload = next;
      await saveIntegrationCredential({
        userWorkosId: input.userWorkosId,
        integrationId: input.integrationId,
        provider: config.provider,
        kind: CREDENTIAL_KIND,
        payload: { ...next },
      });
    }

    return {
      get redirectUrl() {
        return callbackUrl();
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "opencompany Runner",
          redirect_uris: [callbackUrl()],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          ...(config.authScope ? { scope: config.authScope } : {}),
        };
      },
      clientInformation: () => payload.clientInformation,
      tokens: () => payload.tokens,
      saveTokens: async (tokens) => persist({ ...payload, tokens }),
      saveClientInformation: async (clientInformation) => {
        await persist({ ...payload, clientInformation });
      },
      saveCodeVerifier: async (codeVerifier) => persist({ ...payload, codeVerifier }),
      codeVerifier: () => {
        if (!payload.codeVerifier) {
          throw new Error(`${config.displayName} MCP OAuth verifier is missing.`);
        }
        return payload.codeVerifier;
      },
      state: () => payload.state ?? "",
      saveState: async (state) => persist({ ...payload, state }),
      storedState: () => payload.state,
      redirectToAuthorization: () => {
        throw new Error(`${config.displayName} MCP needs to be reconnected from Settings.`);
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

  function searchTools(catalog: McpToolCatalogEntry[], args: unknown) {
    const query =
      isRecord(args) && typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const tools = query
      ? catalog.filter(
          (entry) =>
            entry.name.toLowerCase().includes(query) ||
            (entry.description ?? "").toLowerCase().includes(query),
        )
      : catalog;

    return {
      ok: true,
      server: config.provider,
      useTool: useToolName,
      toolCount: tools.length,
      tools,
    };
  }

  function callbackUrl() {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000";
    return `${appUrl.replace(/\/$/, "")}/api/integrations/${config.provider.replaceAll("_", "-")}/callback`;
  }

  return { execute, isToolName };
}

async function loadToolCatalog(client: MCPClient, signal: AbortSignal) {
  const definitions = await client.listTools({ options: { signal } });
  const rawTools = client.toolsFromDefinitions(definitions);
  const catalog: McpToolCatalogEntry[] = (
    (definitions as { tools?: McpToolCatalogEntry[] }).tools ?? []
  ).map((entry) => ({
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.inputSchema !== undefined ? { inputSchema: entry.inputSchema } : {}),
    ...(entry.annotations !== undefined ? { annotations: entry.annotations } : {}),
  }));
  const bodyByName = new Map<string, McpToolBody>();
  for (const [rawName, rawTool] of Object.entries(rawTools)) {
    bodyByName.set(rawName, (rawTool as unknown as { execute?: McpToolBody }).execute);
  }
  return { catalog, bodyByName };
}

function parseUseToolInput(args: unknown): { tool: string; arguments: unknown } {
  if (!isRecord(args)) return { tool: "", arguments: {} };
  return {
    tool: typeof args.tool === "string" ? args.tool.trim() : "",
    arguments: args.arguments ?? {},
  };
}

function parseOAuthPayload(payload: Record<string, unknown>): RemoteMcpOAuthPayload {
  const parsed: RemoteMcpOAuthPayload = {};
  if (isOAuthClientInformation(payload.clientInformation)) {
    parsed.clientInformation = payload.clientInformation;
  }
  if (isOAuthTokens(payload.tokens)) parsed.tokens = payload.tokens;
  if (typeof payload.codeVerifier === "string") parsed.codeVerifier = payload.codeVerifier;
  if (typeof payload.state === "string") parsed.state = payload.state;
  return parsed;
}

function omitOAuthPayload<TKey extends keyof RemoteMcpOAuthPayload>(
  payload: RemoteMcpOAuthPayload,
  keys: TKey[],
) {
  const next = { ...payload };
  for (const key of keys) delete next[key];
  return next;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
