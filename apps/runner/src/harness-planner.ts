import type { TaskToolName } from "@opencompany/db/schema";
import { integrationResources, integrations } from "@opencompany/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";

const TOOL_PROVIDER_MAP: Record<string, TaskToolName[]> = {
  gmail: ["gmail_search", "gmail_get_message", "gmail_list_threads", "gmail_get_thread"],
  google_calendar: [
    "calendar_list_calendars",
    "calendar_list_events",
    "calendar_get_event",
    "calendar_get_freebusy",
  ],
  linear: ["linear_search_tools", "linear_use_tool"],
  latitude: ["latitude_search_tools", "latitude_use_tool"],
  github: ["github_clone_repository", "github_shell", "github_status", "github_open_pull_request"],
};

const PLANNABLE_PROVIDERS = ["gmail", "google_calendar", "linear", "latitude", "github"] as const;
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
] as const satisfies readonly TaskToolName[];
const X_TOOLS: TaskToolName[] = [
  "x_search_posts",
  "x_get_profile",
  "x_get_user_posts",
  "x_get_discussion",
  "social_get_job",
];

export async function getAvailableHarnessToolsForRunner(
  userWorkosId: string,
  options: { browserEnabled?: boolean } = {},
): Promise<TaskToolName[]> {
  const rows = await getDb()
    .select({ provider: integrations.provider })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, userWorkosId),
        eq(integrations.status, "connected"),
        inArray(integrations.provider, [...PLANNABLE_PROVIDERS]),
      ),
    );

  const tools = new Set<TaskToolName>(["exa_search"]);
  if (options.browserEnabled) {
    for (const toolName of GOAT_BROWSER_TOOLS) tools.add(toolName);
  }
  if (process.env.APIFY_API_TOKEN?.trim()) {
    for (const toolName of X_TOOLS) tools.add(toolName);
  }
  for (const row of rows) {
    for (const toolName of TOOL_PROVIDER_MAP[row.provider] ?? []) {
      tools.add(toolName);
    }
  }
  return [...tools];
}

export async function getHarnessPlannerContextForRunner(
  userWorkosId: string,
  options: { browserEnabled?: boolean } = {},
): Promise<{
  availableTools: TaskToolName[];
  githubRepositories: string[];
}> {
  const [availableTools, githubRepositories] = await Promise.all([
    getAvailableHarnessToolsForRunner(userWorkosId, options),
    getAvailableGitHubRepositoryNamesForRunner(userWorkosId),
  ]);
  return { availableTools, githubRepositories };
}

export async function getAvailableGitHubRepositoryNamesForRunner(
  userWorkosId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ name: integrationResources.name })
    .from(integrationResources)
    .innerJoin(
      integrations,
      and(
        eq(integrationResources.integrationId, integrations.id),
        eq(integrationResources.userWorkosId, integrations.userWorkosId),
        eq(integrationResources.provider, integrations.provider),
      ),
    )
    .where(
      and(
        eq(integrationResources.userWorkosId, userWorkosId),
        eq(integrationResources.provider, "github"),
        eq(integrationResources.resourceType, "repository"),
        eq(integrationResources.status, "available"),
        eq(integrations.provider, "github"),
        eq(integrations.status, "connected"),
      ),
    )
    .orderBy(integrationResources.name);

  return [...new Set(rows.map((row) => row.name).filter(Boolean))];
}
