import { getDb } from "@opencompany/db/client";
import type { GoatIntegrationProvider, GoatTaskToolName } from "@opencompany/db/goat-schema";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  GoatGmailSourceProviderState,
  GoatGoogleDriveSourceProviderState,
  GoatGoogleProviderState,
} from "@/lib/integration-state";
import { goatGoogleIntegrationStateFromRows } from "@/lib/integration-state";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";

const GOOGLE_PROVIDERS: GoatIntegrationProvider[] = ["gmail", "google_calendar", "google_drive"];
const GOAT_BROWSER_TOOLS = [
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_wait",
  "browser_read",
  "browser_get",
  "browser_find",
  "browser_scroll",
  "browser_screenshot",
  "browser_close",
] as const satisfies readonly GoatTaskToolName[];

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

  return goatGoogleIntegrationStateFromRows(rows);
}

// Gmail-as-a-brain-source state: same integration rows as the Gmail tool
// connection, but exposed with the integration id the brain-source picker and
// save action key config rows on.
export async function getGoatGmailSourceIntegrationState(
  userWorkosId: string,
): Promise<GoatGmailSourceProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountEmail: goatIntegrations.accountEmail,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(eq(goatIntegrations.userWorkosId, userWorkosId), eq(goatIntegrations.provider, "gmail")),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: "gmail",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      statusReason: null,
    };
  }

  return {
    provider: "gmail",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountEmail: row.accountEmail,
    statusReason: row.statusReason,
  };
}

export async function getGoatGoogleDriveSourceIntegrationState(
  userWorkosId: string,
): Promise<GoatGoogleDriveSourceProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountEmail: goatIntegrations.accountEmail,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "google_drive"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: "google_drive",
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountEmail: null,
      statusReason: null,
    };
  }

  return {
    provider: "google_drive",
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountEmail: row.accountEmail,
    statusReason: row.statusReason,
  };
}

export async function getGoatAvailableHarnessTools(
  userWorkosId: string,
): Promise<GoatTaskToolName[]> {
  const [state, linear, github] = await Promise.all([
    getGoatGoogleIntegrationState(userWorkosId),
    getGoatLinearIntegrationState(userWorkosId),
    getGoatGitHubIntegrationState(userWorkosId),
  ]);
  const tools: GoatTaskToolName[] = ["exa_search"];
  if (process.env.RUNNER_GOAT_BROWSER_ENABLED?.trim().toLowerCase() === "true") {
    tools.push(...GOAT_BROWSER_TOOLS);
  }
  if (state.gmail.connected) {
    tools.push("gmail_search", "gmail_get_message", "gmail_list_threads", "gmail_get_thread");
  }
  if (state.google_calendar.connected) {
    tools.push(
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_get_event",
      "calendar_get_freebusy",
    );
  }
  if (linear.connected) {
    tools.push("linear_search_tools", "linear_use_tool");
  }
  if (github.connected) {
    tools.push(
      "github_clone_repository",
      "github_shell",
      "github_status",
      "github_open_pull_request",
    );
  }
  if (process.env.APIFY_API_TOKEN?.trim()) {
    tools.push(
      "x_search_posts",
      "x_get_profile",
      "x_get_user_posts",
      "x_get_discussion",
      "social_get_job",
    );
  }
  return tools;
}

export type { GoatGoogleProviderState };
