import { getDb } from "@opencompany/db/client";
import type { GoatHarnessToolId, GoatIntegrationProvider } from "@opencompany/db/goat-schema";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, inArray } from "drizzle-orm";

export type GoatGoogleProviderState = {
  provider: GoatIntegrationProvider;
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  accountEmail: string | null;
  accountName: string | null;
};

const GOOGLE_PROVIDERS: GoatIntegrationProvider[] = ["gmail", "google_calendar"];

type GoogleIntegrationRow = {
  provider: GoatIntegrationProvider;
  accountEmail: string | null;
  accountName: string | null;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
};

export async function getGoatGoogleIntegrationState(userWorkosId: string) {
  const rows = await getDb()
    .select({
      provider: goatIntegrations.provider,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
      updatedAt: goatIntegrations.updatedAt,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        inArray(goatIntegrations.provider, GOOGLE_PROVIDERS),
      ),
    )
    .orderBy(goatIntegrations.provider, goatIntegrations.updatedAt);

  const byProvider = new Map<GoatIntegrationProvider, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.status === "disconnected") continue;
    byProvider.set(row.provider, row);
  }

  return {
    gmail: providerState("gmail", byProvider.get("gmail")),
    google_calendar: providerState("google_calendar", byProvider.get("google_calendar")),
  };
}

export async function getGoatAvailableHarnessTools(
  userWorkosId: string,
): Promise<GoatHarnessToolId[]> {
  const state = await getGoatGoogleIntegrationState(userWorkosId);
  const tools: GoatHarnessToolId[] = ["exa"];
  if (state.gmail.connected) tools.push("gmail");
  if (state.google_calendar.connected) tools.push("google_calendar");
  tools.push("goat_result");
  return tools;
}

function providerState(
  provider: GoatIntegrationProvider,
  row: GoogleIntegrationRow | undefined,
): GoatGoogleProviderState {
  if (!row) {
    return {
      provider,
      connected: false,
      status: "not_connected",
      accountEmail: null,
      accountName: null,
    };
  }

  return {
    provider,
    connected: row.status === "connected",
    status: row.status,
    accountEmail: row.accountEmail,
    accountName: row.accountName,
  };
}
