import type { GoatTaskToolName } from "@opencompany/db/schema";

export const GOAT_TASK_TOOL_NAMES = [
  "exa_search",
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
  "x_search_posts",
  "x_get_profile",
  "x_get_user_posts",
  "x_get_discussion",
  "social_get_job",
  "gmail_search",
  "gmail_get_message",
  "gmail_list_threads",
  "gmail_get_thread",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_get_freebusy",
  "linear_search_tools",
  "linear_use_tool",
  "latitude_search_tools",
  "latitude_use_tool",
  "github_clone_repository",
  "github_shell",
  "github_status",
  "github_open_pull_request",
] as const satisfies readonly GoatTaskToolName[];

const GOAT_TASK_TOOL_SET = new Set<GoatTaskToolName>(GOAT_TASK_TOOL_NAMES);

export function normalizeGoatTaskToolNames(value: unknown): GoatTaskToolName[] {
  const selected = new Set<GoatTaskToolName>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && GOAT_TASK_TOOL_SET.has(item as GoatTaskToolName)) {
        selected.add(item as GoatTaskToolName);
      }
    }
  }
  if (selected.size === 0) {
    selected.add("exa_search");
  }
  return GOAT_TASK_TOOL_NAMES.filter((name) => selected.has(name));
}
