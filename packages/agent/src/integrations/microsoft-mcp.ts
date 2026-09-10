import type { RemoteMcpConnectionState, RemoteMcpOperation } from "../actions/remote-mcp";
import { createFirstPartyMcpTicket, verifyFirstPartyMcpTicket } from "./first-party-mcp-ticket";
import { getMicrosoftAccessToken, MicrosoftAccessAuthError } from "./microsoft-access-token";
import { loadMicrosoftIntegration } from "./microsoft-data";
import { type MicrosoftIntegrationProvider, microsoftScopesSatisfied } from "./microsoft-oauth";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

export function microsoftMcpEndpointUrl(provider: MicrosoftIntegrationProvider) {
  return `https://api.opencompany.chat/mcp/plugins/${provider}`;
}

export function microsoftMcpRuntimeEndpointUrl(provider: MicrosoftIntegrationProvider) {
  const configured = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (configured) {
    try {
      const origin = new URL(configured);
      if (
        origin.protocol === "https:" ||
        (origin.protocol === "http:" && origin.hostname === "localhost")
      )
        return new URL(`/mcp/plugins/${provider}`, origin).toString();
    } catch {
      /* An invalid local override cannot change the reviewed endpoint. */
    }
  }
  return microsoftMcpEndpointUrl(provider);
}

export function createMicrosoftMcpTicket(input: {
  provider: MicrosoftIntegrationProvider;
  userWorkosId: string;
  workspaceId: string;
  integrationId: string;
  registrationId: string;
  operation: RemoteMcpOperation;
  secret: string;
  now?: number;
  ttlMs?: number;
}) {
  return createFirstPartyMcpTicket({
    ...input,
    audience: `opencompany-${input.provider}-mcp`,
    signingContext: `opencompany-${input.provider}-mcp-ticket`,
  });
}

export function verifyMicrosoftMcpTicket(input: {
  provider: MicrosoftIntegrationProvider;
  ticket: string;
  secret: string;
  now?: number;
}) {
  return verifyFirstPartyMcpTicket({
    ...input,
    audience: `opencompany-${input.provider}-mcp`,
    signingContext: `opencompany-${input.provider}-mcp-ticket`,
  });
}
export type MicrosoftMcpTicketPayload = NonNullable<ReturnType<typeof verifyMicrosoftMcpTicket>>;

export async function getMicrosoftMcpIntegrationState(
  provider: MicrosoftIntegrationProvider,
  identity: string | { userWorkosId: string },
): Promise<RemoteMcpConnectionState> {
  const row = await loadMicrosoftIntegration({
    provider,
    userWorkosId: typeof identity === "string" ? identity : identity.userWorkosId,
  });
  return {
    connected: Boolean(
      row?.status === "connected" && microsoftScopesSatisfied(provider, row.scopes ?? []),
    ),
    integrationId: row?.id ?? null,
    capabilityModes: row?.capabilityModes ?? {},
    toolModes: row?.toolModes ?? {},
  };
}

export async function loadMicrosoftMcpWorkerConnection(
  provider: MicrosoftIntegrationProvider,
  input: {
    userWorkosId: string;
    workspaceId: string;
    registrationId: string;
    operation: RemoteMcpOperation;
    onAuthorizationRequired: () => never;
  },
) {
  const row = await loadMicrosoftIntegration({ provider, userWorkosId: input.userWorkosId });
  if (!row || row.status === "disconnected") return { ok: false, reason: "not_connected" } as const;
  if (row.status !== "connected" || !microsoftScopesSatisfied(provider, row.scopes ?? []))
    return { ok: false, reason: "needs_reauth" } as const;
  try {
    await getMicrosoftAccessToken({
      provider,
      userWorkosId: input.userWorkosId,
      integrationId: row.id,
    });
  } catch (error) {
    if (error instanceof MicrosoftAccessAuthError)
      return { ok: false, reason: "needs_reauth" } as const;
    throw error;
  }
  const secret = process.env.API_INTERNAL_TOKEN?.trim();
  if (!secret) throw new Error("Microsoft MCP requires API_INTERNAL_TOKEN.");
  const { ticket } = createMicrosoftMcpTicket({
    ...input,
    provider,
    integrationId: row.id,
    secret,
  });
  return {
    ok: true,
    integrationId: row.id,
    authProvider: createRemoteMcpStaticBearerAuthProvider({
      accessToken: ticket,
      onAuthorizationRequired: async () => input.onAuthorizationRequired(),
    }),
  } as const;
}
