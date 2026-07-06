import type { GoatTaskToolName } from "@opencompany/db/goat-schema";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";

const TOOL_PROVIDER_MAP: Record<string, GoatTaskToolName[]> = {
  gmail: ["gmail_search", "gmail_get_message", "gmail_list_threads", "gmail_get_thread"],
  google_calendar: [
    "calendar_list_calendars",
    "calendar_list_events",
    "calendar_get_event",
    "calendar_get_freebusy",
  ],
  linear: ["linear_search_tools", "linear_use_tool"],
  github: ["github_clone_repository", "github_shell", "github_status", "github_open_pull_request"],
};

const PLANNABLE_PROVIDERS = ["gmail", "google_calendar", "linear", "github"] as const;

export async function getGoatAvailableHarnessToolsForRunner(
  userWorkosId: string,
): Promise<GoatTaskToolName[]> {
  const rows = await getDb()
    .select({ provider: goatIntegrations.provider })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.status, "connected"),
        inArray(goatIntegrations.provider, [...PLANNABLE_PROVIDERS]),
      ),
    );

  const tools = new Set<GoatTaskToolName>(["exa_search"]);
  for (const row of rows) {
    for (const toolName of TOOL_PROVIDER_MAP[row.provider] ?? []) {
      tools.add(toolName);
    }
  }
  return [...tools];
}
