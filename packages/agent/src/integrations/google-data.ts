import { getDb } from "@opencompany/db/client";
import type { IntegrationProvider, TaskToolName } from "@opencompany/db/product-schema";
import { integrations } from "@opencompany/db/product-schema";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  type GmailSourceProviderState,
  type GoogleDriveSourceProviderState,
  type GoogleProviderState,
  googleIntegrationStateFromRows,
} from "../integration-state";
import { getGitHubIntegrationState } from "./github";
import { getLatitudeIntegrationState } from "./latitude-mcp";
import { getLinearIntegrationState } from "./linear-mcp";

const GOOGLE_PROVIDERS: IntegrationProvider[] = ["gmail", "google_calendar", "google_drive"];
type DbLike = any;
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
      id: integrations.id,
      provider: integrations.provider,
      workspaceId: integrations.workspaceId,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      status: integrations.status,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
      updatedAt: integrations.updatedAt,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        isNull(integrations.workspaceId),
        inArray(integrations.provider, GOOGLE_PROVIDERS),
        ne(integrations.status, "disconnected"),
      ),
    )
    // integrationStateFromRows keeps the last row for each provider. Ascending
    // order therefore selects the same newest personal account as the MCP
    // loaders below; the id tie-breaker makes equal timestamps deterministic.
    .orderBy(asc(integrations.provider), asc(integrations.updatedAt), asc(integrations.id));

  return googleIntegrationStateFromRows(rows);
}

export async function loadGoogleCalendarIntegration(input: { userWorkosId: string; db?: DbLike }) {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, "google_calendar"),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
}

export async function loadGoogleDriveIntegration(input: { userWorkosId: string; db?: DbLike }) {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      accountEmail: integrations.accountEmail,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, "google_drive"),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);
  return row;
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
    .orderBy(desc(integrations.updatedAt), desc(integrations.id))
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

export async function loadGmailIntegration(input: { userWorkosId: string; db?: DbLike }) {
  const [row] = await (input.db ?? getDb())
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, input.userWorkosId),
        isNull(integrations.workspaceId),
        eq(integrations.provider, "gmail"),
        ne(integrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(integrations.updatedAt), desc(integrations.id))
    .limit(1);
  return row;
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
  if (process.env.RUNNER_OPENCOMPANY_BROWSER_ENABLED?.trim().toLowerCase() === "true") {
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
