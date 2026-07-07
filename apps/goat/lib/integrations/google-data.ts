import { getDb } from "@opencompany/db/client";
import type { GoatIntegrationProvider, GoatTaskToolName } from "@opencompany/db/goat-schema";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, inArray } from "drizzle-orm";
import type { GoatGoogleProviderState } from "@/lib/integration-state";
import { goatGoogleIntegrationStateFromRows } from "@/lib/integration-state";
import { getGoatGitHubIntegrationState } from "@/lib/integrations/github";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";

const GOOGLE_PROVIDERS: GoatIntegrationProvider[] = ["gmail", "google_calendar"];
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
  return tools;
}

export type { GoatGoogleProviderState };
