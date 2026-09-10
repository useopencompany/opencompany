import { getAppUrl } from "@opencompany/agent/app-url";
import { captureConnectionAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import {
  buildMicrosoftAuthorizationUrl,
  createMicrosoftIntegrationState,
  exchangeMicrosoftCode,
  fetchMicrosoftUserInfo,
  isMicrosoftIntegrationConfigured,
  type MicrosoftIntegrationProvider,
  sanitizeMicrosoftReturnTo,
  verifyMicrosoftIntegrationState,
} from "@opencompany/agent/integrations/microsoft-oauth";
import { connectMicrosoftIntegration } from "@opencompany/db/integrations";
import { createLogger } from "@opencompany/observability";
import type { ApiIdentityVerifier } from "./auth";
import { resolveIngressSession, sessionRedirect } from "./ingress-session";

const logger = createLogger({ service: "opencompany-api", runtime: "microsoft-ingress" });
export type MicrosoftIngressService = {
  start(provider: MicrosoftIntegrationProvider, request: Request): Promise<Response>;
  callback(provider: MicrosoftIntegrationProvider, request: Request): Promise<Response>;
};
export function createMicrosoftIngress(input: {
  db: any;
  identify: ApiIdentityVerifier;
  refreshPluginRegistrations?: (input: {
    provider: MicrosoftIntegrationProvider;
    userWorkosId: string;
    workspaceIds: string[];
  }) => Promise<void>;
}): MicrosoftIngressService {
  return {
    async start(provider, request) {
      const session = await resolveIngressSession(input, request);
      if (session.kind === "redirect") return session.response;
      const returnTo = sanitizeMicrosoftReturnTo(
        new URL(request.url).searchParams.get("returnTo") ?? `/settings/plugins/${provider}`,
      );
      if (!isMicrosoftIntegrationConfigured())
        return statusRedirect(session, provider, returnTo, "error", "not_configured");
      const state = createMicrosoftIntegrationState({
        provider,
        userWorkosId: session.userId,
        returnTo,
      });
      return sessionRedirect(session, buildMicrosoftAuthorizationUrl(provider, state));
    },
    async callback(provider, request) {
      const session = await resolveIngressSession(input, request);
      if (session.kind === "redirect") return session.response;
      const url = new URL(request.url);
      const rawState = url.searchParams.get("state") ?? "";
      let state: ReturnType<typeof verifyMicrosoftIntegrationState>;
      try {
        state = verifyMicrosoftIntegrationState(rawState);
      } catch {
        return statusRedirect(
          session,
          provider,
          `/settings/plugins/${provider}`,
          "error",
          "invalid_state",
        );
      }
      if (state.provider !== provider || state.userWorkosId !== session.userId)
        return statusRedirect(session, provider, state.returnTo, "error", "session_mismatch");
      if (!isMicrosoftIntegrationConfigured())
        return statusRedirect(session, provider, state.returnTo, "error", "not_configured");
      if (url.searchParams.has("error"))
        return statusRedirect(session, provider, state.returnTo, "error", "microsoft_denied");
      const code = url.searchParams.get("code");
      if (!code) return statusRedirect(session, provider, state.returnTo, "error", "missing_code");
      try {
        const { tokens, expiresAt } = await exchangeMicrosoftCode(provider, code, rawState);
        const user = await fetchMicrosoftUserInfo(tokens.access_token);
        const connection = await connectMicrosoftIntegration({
          provider,
          userWorkosId: session.userId,
          externalId: user.id,
          accountEmail: user.mail ?? user.userPrincipalName ?? null,
          accountName: user.displayName ?? null,
          tokens,
          expiresAt,
          scopes: tokens.scope.split(/\s+/u),
          db: input.db,
        });
        try {
          await captureConnectionAddedAnalytics({
            connectionId: connection.integrationId,
            userWorkosId: session.userId,
            workspaceId: session.workspaceId,
            provider,
          });
        } catch {
          logger.warn("Microsoft connection analytics failed", {
            event: "opencompany.microsoft_connection_analytics_failed",
            provider,
          });
        }
        try {
          await input.refreshPluginRegistrations?.({
            provider,
            userWorkosId: session.userId,
            workspaceIds: session.workspaces.map((entry) => entry.workspace.id),
          });
        } catch {
          logger.warn("Microsoft plugin discovery refresh failed", {
            event: "opencompany.microsoft_plugin_discovery_failed",
            provider,
          });
        }
        return statusRedirect(session, provider, state.returnTo, "connected");
      } catch {
        logger.warn("Microsoft account connection failed", {
          event: "opencompany.microsoft_connection_failed",
          provider,
        });
        return statusRedirect(session, provider, state.returnTo, "error", "connection_sync_failed");
      }
    },
  };
}
function statusRedirect(
  session: Extract<Awaited<ReturnType<typeof resolveIngressSession>>, { kind: "actor" }>,
  provider: MicrosoftIntegrationProvider,
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeMicrosoftReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", provider);
  url.searchParams.set("setup", status);
  if (reason) url.searchParams.set("reason", reason);
  return sessionRedirect(session, url);
}
