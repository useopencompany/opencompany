import { getDb } from "@opencompany/db/client";
import type { IntegrationProvider, TaskToolName } from "@opencompany/db/schema";
import { integrations } from "@opencompany/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  GmailSourceProviderState,
  GoogleDriveSourceProviderState,
  GoogleProviderState,
} from "@/lib/integration-state";
import { googleIntegrationStateFromRows } from "@/lib/integration-state";
import { getGitHubIntegrationState } from "@/lib/integrations/github";
import { getLatitudeIntegrationState } from "@/lib/integrations/latitude-mcp";
import { getLinearIntegrationState } from "@/lib/integrations/linear-mcp";

const GOOGLE_PROVIDERS: IntegrationProvider[] = ["gmail", "google_calendar", "google_drive"];
const BROWSER_TOOLS = [
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
] as const satisfies readonly TaskToolName[];

export async function getGoogleIntegrationState(userWorkosId: string) {
  const rows = await getDb()
    .select({
      provider: integrations.provider,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      status: integrations.status,
      updatedAt: integrations.updatedAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        inArray(integrations.provider, GOOGLE_PROVIDERS),
      ),
    )
    .orderBy(integrations.provider, integrations.updatedAt);

  return googleIntegrationStateFromRows(rows);
}

// Gmail-as-a-brain-source state: same integration rows as the Gmail tool
// connection, but exposed with the integration id the brain-source picker and
// save action key config rows on.
export async function getGmailSourceIntegrationState(
  userWorkosId: string,
): Promise<GmailSourceProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(and(eq(integrations.userWorkosId, userWorkosId), eq(integrations.provider, "gmail")))
    .orderBy(desc(integrations.updatedAt))
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

export async function getGoogleDriveSourceIntegrationState(
  userWorkosId: string,
): Promise<GoogleDriveSourceProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(eq(integrations.userWorkosId, userWorkosId), eq(integrations.provider, "google_drive")),
    )
    .orderBy(desc(integrations.updatedAt))
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

export async function getAvailableHarnessTools(userWorkosId: string): Promise<TaskToolName[]> {
  const [state, linear, latitude, github] = await Promise.all([
    getGoogleIntegrationState(userWorkosId),
    getLinearIntegrationState(userWorkosId),
    getLatitudeIntegrationState(userWorkosId),
    getGitHubIntegrationState(userWorkosId),
  ]);
  const tools: TaskToolName[] = ["exa_search"];
  if (process.env.RUNNER_BROWSER_ENABLED?.trim().toLowerCase() === "true") {
    tools.push(...BROWSER_TOOLS);
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
  if (latitude.connected) {
    tools.push("latitude_search_tools", "latitude_use_tool");
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

export type { GoogleProviderState };
