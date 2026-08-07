import type { GoatTaskToolName } from "@opencompany/db/schema";
import { goatIntegrationResources, goatIntegrations } from "@opencompany/db/schema";
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
] as const satisfies readonly GoatTaskToolName[];
const X_TOOLS: GoatTaskToolName[] = [
  "x_search_posts",
  "x_get_profile",
  "x_get_user_posts",
  "x_get_discussion",
  "social_get_job",
];

export async function getGoatAvailableHarnessToolsForRunner(
  userWorkosId: string,
  options: { browserEnabled?: boolean } = {},
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

export async function getGoatHarnessPlannerContextForRunner(
  userWorkosId: string,
  options: { browserEnabled?: boolean } = {},
): Promise<{
  availableTools: GoatTaskToolName[];
  githubRepositories: string[];
}> {
  const [availableTools, githubRepositories] = await Promise.all([
    getGoatAvailableHarnessToolsForRunner(userWorkosId, options),
    getGoatAvailableGitHubRepositoryNamesForRunner(userWorkosId),
  ]);
  return { availableTools, githubRepositories };
}

export async function getGoatAvailableGitHubRepositoryNamesForRunner(
  userWorkosId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ name: goatIntegrationResources.name })
    .from(goatIntegrationResources)
    .innerJoin(
      goatIntegrations,
      and(
        eq(goatIntegrationResources.integrationId, goatIntegrations.id),
        eq(goatIntegrationResources.userWorkosId, goatIntegrations.userWorkosId),
        eq(goatIntegrationResources.provider, goatIntegrations.provider),
      ),
    )
    .where(
      and(
        eq(goatIntegrationResources.userWorkosId, userWorkosId),
        eq(goatIntegrationResources.provider, "github"),
        eq(goatIntegrationResources.resourceType, "repository"),
        eq(goatIntegrationResources.status, "available"),
        eq(goatIntegrations.provider, "github"),
        eq(goatIntegrations.status, "connected"),
      ),
    )
    .orderBy(goatIntegrationResources.name);

  return [...new Set(rows.map((row) => row.name).filter(Boolean))];
}
