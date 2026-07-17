import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { OpenCompanyChatIntegrationIndexEntry } from "@/lib/prompts/integrations";
import { INTEGRATION_PROVIDER_LABELS, INTEGRATION_PROVIDER_SUMMARIES } from "./registry";
import type { IntegrationToolProvider } from "./types";

// Request-time resolution of which integrations the chat can read. This is a
// hint for tool registration and the system-prompt index; executors re-resolve
// credentials on every call.

// The user-level Linear MCP connector rows share provider "linear" with the
// ingest OAuth rows; external_id distinguishes them.
const LINEAR_MCP_EXTERNAL_ID = "linear_mcp";

export type ResolvedGmailAccount = { integrationId: string; email: string };

export type ResolvedSlackAccount = {
  integrationId: string;
  teamId: string | null;
  teamName: string | null;
  scopes: string[];
};

export type ResolvedLinearCredentialSource = {
  integrationId: string;
  kind: "ingest" | "mcp";
};

export type ResolvedIntegrationConnections = {
  providers: IntegrationToolProvider[];
  gmailAccounts: ResolvedGmailAccount[];
  slackAccounts: ResolvedSlackAccount[];
  linearCredentialSources: ResolvedLinearCredentialSource[];
};

export function isIntegrationToolsKillSwitchEnabled(): boolean {
  const value = process.env.GOAT_MAIN_CHAT_INTEGRATION_TOOLS_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function resolveIntegrationToolConnections(input: {
  userWorkosId: string;
}): Promise<ResolvedIntegrationConnections> {
  const rows = await getDb()
    .select({
      id: goatIntegrations.id,
      provider: goatIntegrations.provider,
      externalId: goatIntegrations.externalId,
      accountEmail: goatIntegrations.accountEmail,
      connectionLabel: goatIntegrations.connectionLabel,
      scopes: goatIntegrations.scopes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, input.userWorkosId),
        isNull(goatIntegrations.workspaceId),
        inArray(goatIntegrations.provider, ["gmail", "slack", "linear"]),
        eq(goatIntegrations.status, "connected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  const gmailAccounts: ResolvedGmailAccount[] = [];
  const slackAccounts: ResolvedSlackAccount[] = [];
  const linearCredentialSources: ResolvedLinearCredentialSource[] = [];

  for (const row of rows) {
    if (row.provider === "gmail") {
      const email = row.accountEmail?.trim();
      if (email) gmailAccounts.push({ integrationId: row.id, email });
    } else if (row.provider === "slack") {
      slackAccounts.push({
        integrationId: row.id,
        teamId: row.externalId ?? null,
        teamName: row.connectionLabel?.trim() || null,
        scopes: Array.isArray(row.scopes) ? row.scopes : [],
      });
    } else if (row.provider === "linear") {
      linearCredentialSources.push({
        integrationId: row.id,
        kind: row.externalId === LINEAR_MCP_EXTERNAL_ID ? "mcp" : "ingest",
      });
    }
  }

  // Ingest tokens are plain GraphQL access tokens; prefer them over the MCP
  // connector's tokens when both exist.
  linearCredentialSources.sort((left, right) =>
    left.kind === right.kind ? 0 : left.kind === "ingest" ? -1 : 1,
  );

  const providers: IntegrationToolProvider[] = [];
  if (linearCredentialSources.length > 0) providers.push("linear");
  if (slackAccounts.length > 0) providers.push("slack");
  if (gmailAccounts.length > 0) providers.push("gmail");

  return { providers, gmailAccounts, slackAccounts, linearCredentialSources };
}

export function integrationIndexEntriesFromConnections(
  connections: ResolvedIntegrationConnections,
): OpenCompanyChatIntegrationIndexEntry[] {
  return connections.providers.map((provider) => {
    const accounts =
      provider === "gmail"
        ? connections.gmailAccounts.map((account) => account.email)
        : provider === "slack"
          ? connections.slackAccounts.map(
              (account) => account.teamName ?? account.teamId ?? "Slack workspace",
            )
          : [];
    return {
      provider,
      label: INTEGRATION_PROVIDER_LABELS[provider],
      summary: INTEGRATION_PROVIDER_SUMMARIES[provider],
      ...(accounts.length > 0 ? { accounts } : {}),
    };
  });
}
