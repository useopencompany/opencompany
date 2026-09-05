import type { OAuthClientMetadata, OAuthClientProvider } from "@ai-sdk/mcp";
import { getDb } from "@opencompany/db/client";
import {
  type InfisicalConnectionMetadata,
  loadInfisicalConnectionMetadata,
} from "@opencompany/db/infisical-auth";
import type { RemoteMcpConnectionState, RemoteMcpWorkerConnection } from "../actions/remote-mcp";

export const INFISICAL_DOCS_MCP_ENDPOINT_URL = "https://infisical.com/docs/mcp";

type Identity = { userWorkosId: string; workspaceId: string };

function integrationId(metadata: InfisicalConnectionMetadata) {
  return `infisical:${metadata.workspaceId}:${metadata.credentialGeneration}`;
}

async function loadMetadata(workspaceId: string) {
  return loadInfisicalConnectionMetadata({ db: getDb(), workspaceId });
}

// Infisical's hosted MCP is a public documentation server. The workspace connection gates
// availability so the plugin and sandbox CLI share one visible lifecycle, but its encrypted CLI
// auth bundle is deliberately never loaded or forwarded to the remote endpoint.
export async function getInfisicalDocsMcpIntegrationState(
  input: Identity,
): Promise<RemoteMcpConnectionState> {
  const metadata = await loadMetadata(input.workspaceId);
  const connected = metadata?.status === "connected";
  return {
    connected,
    integrationId: connected ? integrationId(metadata) : null,
    capabilityModes: {},
    toolModes: {},
  };
}

export async function loadInfisicalDocsMcpWorkerConnection(
  input: Identity & { onAuthorizationRequired: () => never },
): Promise<RemoteMcpWorkerConnection> {
  const metadata = await loadMetadata(input.workspaceId);
  if (!metadata || metadata.status === "disconnected") {
    return { ok: false, reason: "not_connected" };
  }
  if (metadata.status !== "connected") return { ok: false, reason: "needs_reauth" };
  return {
    ok: true,
    integrationId: integrationId(metadata),
    authProvider: anonymousMcpAuthProvider(input.onAuthorizationRequired),
  };
}

function anonymousMcpAuthProvider(onAuthorizationRequired: () => never): OAuthClientProvider {
  const authorizationRequired = async (): Promise<never> => onAuthorizationRequired();
  return {
    tokens: () => undefined,
    saveTokens: authorizationRequired,
    redirectToAuthorization: authorizationRequired,
    saveCodeVerifier: authorizationRequired,
    codeVerifier: authorizationRequired,
    redirectUrl: "urn:ietf:wg:oauth:2.0:oob",
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "opencompany anonymous MCP",
        redirect_uris: ["urn:ietf:wg:oauth:2.0:oob"],
      };
    },
    clientInformation: () => undefined,
    saveClientInformation: authorizationRequired,
    invalidateCredentials: authorizationRequired,
  };
}
