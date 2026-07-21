import {
  createMCPClient,
  type MCPClient,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import {
  loadGoatIntegrationCredential,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "./db";

export type GoatLinearMcpToolName = "linear_search_tools" | "linear_use_tool";

const LINEAR_ENDPOINT_URL = "https://mcp.linear.app/mcp";
const LINEAR_OAUTH_SCOPE = "read write";
const LINEAR_PROVIDER = "linear" as const;
const LINEAR_CREDENTIAL_KIND = "oauth_token" as const;

type LinearConnection = {
  integrationId: string;
  payload: LinearOAuthPayload;
};

type LinearOAuthPayload = {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

type McpToolCatalogEntry = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type McpToolBody =
  | ((input: unknown, options: { toolCallId: string }) => unknown | Promise<unknown>)
  | undefined;

export function isGoatLinearMcpToolName(name: string): name is GoatLinearMcpToolName {
  return name === "linear_search_tools" || name === "linear_use_tool";
}

export async function executeGoatLinearMcpTool(input: {
  name: GoatLinearMcpToolName;
  args: unknown;
  userWorkosId: string;
  signal: AbortSignal;
}) {
  const client = await connectGoatLinearMcpClient({
    userWorkosId: input.userWorkosId,
    signal: input.signal,
  });
  try {
    const { catalog, bodyByName } = await loadLinearToolCatalog(client, input.signal);
    if (input.name === "linear_search_tools") {
      return searchTools(catalog, input.args);
    }
    const { tool, arguments: rawArguments } = parseUseToolInput(input.args);
    const body = bodyByName.get(tool);
    if (!tool || !body) {
      return {
        ok: false,
        error: `Unknown Linear MCP tool "${tool}". Call linear_search_tools to list available tools.`,
      };
    }
    return await body(rawArguments, { toolCallId: `goat_linear_${tool}` });
  } finally {
    await client.close().catch(() => {});
  }
}

async function connectGoatLinearMcpClient(input: { userWorkosId: string; signal: AbortSignal }) {
  const connection = await loadLinearConnection(input.userWorkosId);
  return createMCPClient({
    clientName: "opencompany-goat-runner",
    version: "0.1.0",
    transport: {
      type: "http" as const,
      url: LINEAR_ENDPOINT_URL,
      authProvider: createLinearOAuthProvider({
        userWorkosId: input.userWorkosId,
        integrationId: connection.integrationId,
        payload: connection.payload,
      }),
    },
  });
}

async function loadLinearToolCatalog(client: MCPClient, signal: AbortSignal) {
  const definitions = await client.listTools({ options: { signal } });
  const rawTools = client.toolsFromDefinitions(definitions);
  const catalog: McpToolCatalogEntry[] = (
    (definitions as { tools?: McpToolCatalogEntry[] }).tools ?? []
  ).map((entry) => ({
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.inputSchema !== undefined ? { inputSchema: entry.inputSchema } : {}),
  }));
  const bodyByName = new Map<string, McpToolBody>();
  for (const [rawName, rawTool] of Object.entries(rawTools)) {
    bodyByName.set(rawName, (rawTool as unknown as { execute?: McpToolBody }).execute);
  }
  return { catalog, bodyByName };
}

async function loadLinearConnection(userWorkosId: string): Promise<LinearConnection> {
  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, LINEAR_PROVIDER),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .limit(1);

  if (!integration || integration.status !== "connected") {
    throw new Error("Connect Linear in Settings before using Linear MCP tools.");
  }

  const credential = await loadGoatIntegrationCredential({
    userWorkosId,
    integrationId: integration.id,
    provider: LINEAR_PROVIDER,
    kind: LINEAR_CREDENTIAL_KIND,
  });
  if (!credential) {
    throw new Error("Reconnect Linear in Settings before using Linear MCP tools.");
  }

  const payload = parseOAuthPayload(credential.payload);
  if (!payload.clientInformation || !payload.tokens) {
    throw new Error("Linear MCP credential is incomplete. Reconnect Linear in Settings.");
  }
  return { integrationId: integration.id, payload };
}

function createLinearOAuthProvider(input: {
  userWorkosId: string;
  integrationId: string;
  payload: LinearOAuthPayload;
}): OAuthClientProvider {
  let payload = input.payload;

  async function persist(next: LinearOAuthPayload) {
    payload = next;
    await saveGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: input.integrationId,
      provider: LINEAR_PROVIDER,
      kind: LINEAR_CREDENTIAL_KIND,
      payload: { ...next },
    });
  }

  return {
    get redirectUrl() {
      return linearCallbackUrl();
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenCompany Goat Runner",
        redirect_uris: [linearCallbackUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: LINEAR_OAUTH_SCOPE,
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
      if (!payload.codeVerifier) throw new Error("Linear MCP OAuth verifier is missing.");
      return payload.codeVerifier;
    },
    state: () => payload.state ?? "",
    saveState: async (state) => persist({ ...payload, state }),
    storedState: () => payload.state,
    redirectToAuthorization: () => {
      throw new Error("Linear MCP needs to be reconnected from Settings.");
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
    server: "linear",
    useTool: "linear_use_tool",
    toolCount: tools.length,
    tools,
  };
}

function parseUseToolInput(args: unknown): { tool: string; arguments: unknown } {
  if (!isRecord(args)) return { tool: "", arguments: {} };
  return {
    tool: typeof args.tool === "string" ? args.tool.trim() : "",
    arguments: args.arguments ?? {},
  };
}

function parseOAuthPayload(payload: Record<string, unknown>): LinearOAuthPayload {
  const parsed: LinearOAuthPayload = {};
  if (isOAuthClientInformation(payload.clientInformation)) {
    parsed.clientInformation = payload.clientInformation;
  }
  if (isOAuthTokens(payload.tokens)) parsed.tokens = payload.tokens;
  if (typeof payload.codeVerifier === "string") parsed.codeVerifier = payload.codeVerifier;
  if (typeof payload.state === "string") parsed.state = payload.state;
  return parsed;
}

function omitOAuthPayload<TKey extends keyof LinearOAuthPayload>(
  payload: LinearOAuthPayload,
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

function linearCallbackUrl() {
  const appUrl =
    process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000";
  return `${appUrl.replace(/\/$/, "")}/api/integrations/linear/callback`;
}
