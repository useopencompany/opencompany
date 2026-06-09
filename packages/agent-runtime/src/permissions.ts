import { BUILTIN_USE_TOOL_NAME, type RuntimeToolName } from "./tools";

// Human-readable permission groups exposed to users, ordered from least to most
// dangerous. Every concrete tool/action a provider exposes maps to exactly one group.
export type PermissionGroup = "read" | "post" | "modify" | "admin";

// Per-group decision a workspace sets for a provider. "ask" pauses the run for an
// in-chat approval; "deny" blocks the tool body from ever running.
export type PolicyDecision = "allow" | "ask" | "deny";

export const PERMISSION_GROUPS: readonly PermissionGroup[] = ["read", "post", "modify", "admin"];

export const PERMISSION_GROUP_LABELS: Record<PermissionGroup, string> = {
  read: "Read",
  post: "Post",
  modify: "Modify",
  admin: "Admin",
};

export const PERMISSION_GROUP_DESCRIPTIONS: Record<PermissionGroup, string> = {
  read: "View and search data",
  post: "Create and send new content",
  modify: "Edit or update existing items",
  admin: "Manage settings, members, or delete",
};

export const POLICY_DECISIONS: readonly PolicyDecision[] = ["allow", "ask", "deny"];

export const TOOL_APPROVAL_BACKSTOP_MS = 7 * 24 * 60 * 60 * 1000;

// Hybrid default stance: reads flow freely, everything with an external side effect
// asks for approval the first time until the workspace opts into "allow".
export const DEFAULT_GROUP_STANCE: Record<PermissionGroup, PolicyDecision> = {
  read: "allow",
  post: "ask",
  modify: "ask",
  admin: "ask",
};

// Unclassifiable actions default to the most restrictive group so an unknown MCP
// tool is treated as dangerous rather than waved through.
export const UNKNOWN_GROUP_FALLBACK: PermissionGroup = "admin";

export type ProviderPermissionSpec = {
  providerKey: string;
  displayName: string;
  // Groups this provider actually exposes (drives the settings UI).
  groups: PermissionGroup[];
  // Whether this provider is subject to the workspace policy gate and shown in the
  // settings UI. Sandbox-internal/built-in tools are mapped but not gated in v1.
  gated: boolean;
  // Static map from a concrete (raw, un-prefixed) tool/action name to its group.
  // Anything not listed falls back to the verb heuristic.
  toolGroups?: Record<string, PermissionGroup>;
  permissionDescriptions?: Partial<Record<PermissionGroup, string>>;
};

// Provider key used for sandbox-internal/built-in tools (file IO, shell). Not gated
// in v1 — the sandbox is ephemeral and isolated, so the blast radius is local.
export const SYSTEM_PROVIDER_KEY = "system";

export const PROVIDER_PERMISSION_REGISTRY: Record<string, ProviderPermissionSpec> = {
  slack: {
    providerKey: "slack",
    displayName: "Slack",
    groups: ["read", "post", "modify", "admin"],
    gated: true,
    toolGroups: {
      search: "read",
      search_messages: "read",
      conversations_history: "read",
      conversations_replies: "read",
      channels_list: "read",
      users_list: "read",
      users_info: "read",
      chat_postMessage: "post",
      chat_post_message: "post",
      reactions_add: "post",
      chat_update: "modify",
      chat_delete: "modify",
      conversations_create: "admin",
      conversations_invite: "admin",
      conversations_kick: "admin",
      conversations_archive: "admin",
    },
  },
  linear: {
    providerKey: "linear",
    displayName: "Linear",
    groups: ["read", "post", "modify", "admin"],
    gated: true,
    permissionDescriptions: {
      post: "Create issues and add comments",
      modify: "Edit existing issues, projects, or comments",
    },
    toolGroups: {
      list_issues: "read",
      get_issue: "read",
      search_issues: "read",
      list_projects: "read",
      get_project: "read",
      list_teams: "read",
      list_comments: "read",
      create_issue: "post",
      create_comment: "post",
      update_issue: "modify",
      update_project: "modify",
      update_comment: "modify",
      // Linear's official MCP server uses a `save_*` upsert convention (create-or-update
      // in one tool). Classify the whole family as `modify` — they can overwrite existing
      // items, so `modify` is the correct write tier. The `save` verb is also in the
      // heuristic below, so any future/unlisted `save_*` tool degrades to `modify` rather
      // than the `admin` fallback.
      save_issue: "modify",
      save_comment: "modify",
      save_document: "modify",
      save_project: "modify",
      save_initiative: "modify",
      save_project_update: "modify",
      save_initiative_update: "modify",
      save_project_milestone: "modify",
      archive_issue: "admin",
      delete_issue: "admin",
    },
  },
  posthog: {
    providerKey: "posthog",
    displayName: "PostHog",
    groups: ["read", "post", "modify", "admin"],
    gated: true,
    permissionDescriptions: {
      post: "Create feature flags, insights, dashboards, or experiments",
      modify: "Edit existing feature flags, insights, dashboards, or experiments",
      admin: "Delete resources or change the active project/organization",
    },
    // PostHog MCP tool names are hyphenated (e.g. "feature-flag-get-all"). Keys here
    // use the snake_case form so they match via classifyMcpTool's normalizeRawToolName
    // fold regardless of whether the runtime delivers hyphenated, underscored, or
    // camelCase names — important so admin actions like "*-set-active" can't slip to
    // the verb heuristic (which would read "set" as modify). Anything not listed falls
    // back to the heuristic. Refine against the live tool list.
    toolGroups: {
      get_sql_insight: "read",
      query_run: "read",
      insights_get_all: "read",
      insight_get: "read",
      dashboards_get_all: "read",
      dashboard_get: "read",
      feature_flag_get_all: "read",
      feature_flag_get_definition: "read",
      experiment_get_all: "read",
      list_errors: "read",
      error_details: "read",
      docs_search: "read",
      organizations_get: "read",
      projects_get: "read",
      create_feature_flag: "post",
      insight_create_from_query: "post",
      dashboard_create: "post",
      add_insight_to_dashboard: "post",
      experiment_create: "post",
      update_feature_flag: "modify",
      insight_update: "modify",
      dashboard_update: "modify",
      experiment_update: "modify",
      delete_feature_flag: "admin",
      insight_delete: "admin",
      dashboard_delete: "admin",
      project_set_active: "admin",
      organization_set_active: "admin",
    },
  },
  betterstack: {
    providerKey: "betterstack",
    displayName: "Better Stack",
    groups: ["read", "post", "modify", "admin"],
    gated: true,
    permissionDescriptions: {
      read: "View telemetry, incidents, monitors, status pages, and documentation",
      post: "Create incidents, comments, status updates, monitors, charts, or telemetry resources",
      modify: "Edit alerts, charts, dashboards, monitors, statuses, or telemetry resources",
      admin: "Delete telemetry resources, monitors, alerts, dashboards, or status resources",
    },
    toolGroups: {
      better_stack_search_documentation_tool: "read",
      telemetry_build_explore_query_tool: "read",
      telemetry_build_metric_query_tool: "read",
      telemetry_chart: "read",
      telemetry_get_application_details_tool: "read",
      telemetry_get_chart_alert_details_tool: "read",
      telemetry_get_chart_alert_instructions_tool: "read",
      telemetry_get_chart_building_instructions_tool: "read",
      telemetry_get_chart_details_tool: "read",
      telemetry_get_dashboard_details_tool: "read",
      telemetry_get_error_details_tool: "read",
      telemetry_get_errors_query_instructions_tool: "read",
      telemetry_get_metric_details_tool: "read",
      telemetry_get_metric_query_instructions_tool: "read",
      telemetry_get_metrics_and_cardinality_tool: "read",
      telemetry_get_query_instructions_tool: "read",
      telemetry_get_replays_query_instructions_tool: "read",
      telemetry_get_source_details_tool: "read",
      telemetry_get_source_fields_tool: "read",
      telemetry_list_applications_tool: "read",
      telemetry_list_chart_alerts_tool: "read",
      telemetry_list_clusters_tool: "read",
      telemetry_list_dashboard_templates_tool: "read",
      telemetry_list_dashboards_tool: "read",
      telemetry_list_data_regions_tool: "read",
      telemetry_list_errors_tool: "read",
      telemetry_list_metric_expressions_tool: "read",
      telemetry_list_releases_tool: "read",
      telemetry_list_sources_tool: "read",
      telemetry_list_teams_tool: "read",
      telemetry_query: "read",
      uptime_get_escalation_policy_tool: "read",
      uptime_get_heartbeat_availability_tool: "read",
      uptime_get_heartbeat_tool: "read",
      uptime_get_incident_comments_tool: "read",
      uptime_get_incident_escalation_options_tool: "read",
      uptime_get_incident_timeline_tool: "read",
      uptime_get_incident_tool: "read",
      uptime_get_monitor_availability_tool: "read",
      uptime_get_monitor_response_times_tool: "read",
      uptime_get_monitor_tool: "read",
      uptime_get_on_call_event_tool: "read",
      uptime_get_on_call_rotation_tool: "read",
      uptime_get_on_call_tool: "read",
      uptime_get_severity_tool: "read",
      uptime_get_status_page_report_update_tool: "read",
      uptime_get_status_page_resources_tool: "read",
      uptime_get_status_page_tool: "read",
      uptime_list_escalation_policies_tool: "read",
      uptime_list_heartbeats_tool: "read",
      uptime_list_incidents_tool: "read",
      uptime_list_monitors_tool: "read",
      uptime_list_on_call_events_tool: "read",
      uptime_list_on_calls_tool: "read",
      uptime_list_severities_tool: "read",
      uptime_list_status_page_report_updates_tool: "read",
      uptime_list_status_page_reports_tool: "read",
      uptime_list_status_pages_tool: "read",
      telemetry_add_chart_to_dashboard_tool: "post",
      telemetry_add_dashboard_section_tool: "post",
      telemetry_create_application_tool: "post",
      telemetry_create_chart_alert_tool: "post",
      telemetry_create_cloud_connection_tool: "post",
      telemetry_create_dashboard_tool: "post",
      telemetry_create_metric_expression_tool: "post",
      telemetry_create_source_tool: "post",
      telemetry_import_dashboard_tool: "post",
      uptime_acknowledge_incident_tool: "post",
      uptime_create_incident_comment_tool: "post",
      uptime_create_incident_tool: "post",
      uptime_create_monitor_tool: "post",
      uptime_create_status_page_report_tool: "post",
      uptime_create_status_page_report_update_tool: "post",
      uptime_escalate_incident_tool: "post",
      uptime_reopen_incident_tool: "post",
      uptime_resolve_incident_tool: "post",
      telemetry_edit_chart_alert_tool: "modify",
      telemetry_edit_chart_tool: "modify",
      telemetry_edit_dashboard_section_tool: "modify",
      telemetry_export_dashboard_tool: "modify",
      telemetry_move_charts_tool: "modify",
      telemetry_rename_dashboard_tool: "modify",
      telemetry_toggle_chart_alert_pause_tool: "modify",
      telemetry_update_error_state_tool: "modify",
      telemetry_update_metric_expression_tool: "modify",
      telemetry_delete_chart_alert_tool: "admin",
      telemetry_delete_metric_expression_tool: "admin",
      telemetry_remove_chart_tool: "admin",
      telemetry_remove_dashboard_section_tool: "admin",
      telemetry_remove_dashboard_tool: "admin",
    },
  },
  github: {
    providerKey: "github",
    displayName: "GitHub",
    groups: ["read", "modify", "admin"],
    gated: true,
    // gh CLI and amp_coder map statically in classifyRuntimeTool; toolGroups is
    // unused for GitHub since it is reached via first-party runtime tools.
  },
  exa: {
    providerKey: "exa",
    displayName: "Exa",
    groups: ["read"],
    gated: false,
  },
  x: {
    providerKey: "x",
    displayName: "X",
    groups: ["read"],
    gated: false,
  },
  youtube: {
    providerKey: "youtube",
    displayName: "YouTube",
    groups: ["read"],
    gated: false,
  },
  tiktok: {
    providerKey: "tiktok",
    displayName: "TikTok",
    groups: ["read"],
    gated: false,
  },
  instagram: {
    providerKey: "instagram",
    displayName: "Instagram",
    groups: ["read"],
    gated: false,
  },
  gmail: {
    providerKey: "gmail",
    displayName: "Gmail",
    // Read-only integration: agents can only read mail.
    groups: ["read"],
    gated: true,
    permissionDescriptions: {
      read: "Read messages, threads, and labels",
    },
  },
  google_calendar: {
    providerKey: "google_calendar",
    displayName: "Google Calendar",
    groups: ["read", "post", "modify", "admin"],
    gated: true,
    permissionDescriptions: {
      read: "List calendars and read events and free/busy",
      post: "Create new events",
      modify: "Edit existing events",
      admin: "Delete events",
    },
  },
  [SYSTEM_PROVIDER_KEY]: {
    providerKey: SYSTEM_PROVIDER_KEY,
    displayName: "Sandbox",
    groups: ["read", "modify", "admin"],
    gated: false,
  },
};

export function permissionDescriptionFor(providerKey: string, group: PermissionGroup) {
  return (
    PROVIDER_PERMISSION_REGISTRY[providerKey]?.permissionDescriptions?.[group] ??
    PERMISSION_GROUP_DESCRIPTIONS[group]
  );
}

// First-party / built-in runtime tools mapped to a provider + group. Returning null
// means the tool is never gated (always allowed) — e.g. delegation and tool help.
const RUNTIME_TOOL_CLASSIFICATION: Partial<
  Record<RuntimeToolName, { providerKey: string; group: PermissionGroup } | null>
> = {
  // Exa hosted research tools — read-only external lookups.
  exa_search: { providerKey: "exa", group: "read" },
  exa_contents: { providerKey: "exa", group: "read" },
  exa_answer: { providerKey: "exa", group: "read" },
  web_fetch: { providerKey: "exa", group: "read" },
  // X hosted social tools — read-only external lookups.
  x_search_posts: { providerKey: "x", group: "read" },
  x_get_profile: { providerKey: "x", group: "read" },
  x_get_user_posts: { providerKey: "x", group: "read" },
  x_get_discussion: { providerKey: "x", group: "read" },
  x_get_trends: { providerKey: "x", group: "read" },
  // Supadata/Apify-backed hosted media tools — read-only external lookups.
  youtube_search: { providerKey: "youtube", group: "read" },
  youtube_get_video: { providerKey: "youtube", group: "read" },
  youtube_get_transcript: { providerKey: "youtube", group: "read" },
  youtube_get_channel: { providerKey: "youtube", group: "read" },
  youtube_list_channel_videos: { providerKey: "youtube", group: "read" },
  tiktok_get_profile: { providerKey: "tiktok", group: "read" },
  tiktok_list_profile_posts: { providerKey: "tiktok", group: "read" },
  tiktok_get_video: { providerKey: "tiktok", group: "read" },
  tiktok_get_comments: { providerKey: "tiktok", group: "read" },
  tiktok_search: { providerKey: "tiktok", group: "read" },
  tiktok_get_metadata: { providerKey: "tiktok", group: "read" },
  tiktok_get_transcript: { providerKey: "tiktok", group: "read" },
  instagram_get_profile: { providerKey: "instagram", group: "read" },
  instagram_list_profile_posts: { providerKey: "instagram", group: "read" },
  instagram_get_post: { providerKey: "instagram", group: "read" },
  instagram_get_comments: { providerKey: "instagram", group: "read" },
  instagram_search_profiles: { providerKey: "instagram", group: "read" },
  instagram_get_metadata: { providerKey: "instagram", group: "read" },
  instagram_get_transcript: { providerKey: "instagram", group: "read" },
  social_get_job: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  // Gmail hosted tools — read-only mailbox access.
  gmail_list_messages: { providerKey: "gmail", group: "read" },
  gmail_get_message: { providerKey: "gmail", group: "read" },
  gmail_search: { providerKey: "gmail", group: "read" },
  gmail_list_threads: { providerKey: "gmail", group: "read" },
  gmail_get_thread: { providerKey: "gmail", group: "read" },
  gmail_list_labels: { providerKey: "gmail", group: "read" },
  // Google Calendar hosted tools — reads vs writes split across groups.
  calendar_list_calendars: { providerKey: "google_calendar", group: "read" },
  calendar_list_events: { providerKey: "google_calendar", group: "read" },
  calendar_get_event: { providerKey: "google_calendar", group: "read" },
  calendar_get_freebusy: { providerKey: "google_calendar", group: "read" },
  calendar_create_event: { providerKey: "google_calendar", group: "post" },
  calendar_update_event: { providerKey: "google_calendar", group: "modify" },
  calendar_delete_event: { providerKey: "google_calendar", group: "admin" },
  // Sandbox-local file IO.
  read_file: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  list_files: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  git_diff: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  write_file: { providerKey: SYSTEM_PROVIDER_KEY, group: "modify" },
  edit_file: { providerKey: SYSTEM_PROVIDER_KEY, group: "modify" },
  // shell can run anything, so it is the most restrictive system group.
  shell: { providerKey: SYSTEM_PROVIDER_KEY, group: "admin" },
  // memory only touches the sandbox-local agent/memory/ tree and the routed Gateway; it is a
  // first-party, parsed-argv tool (no shell breakout), so it stays in the ungated system group.
  memory: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  // GitHub-effecting tools. gh is conservatively admin unless resolveToolDecision
  // can classify the concrete CLI args; amp_coder writes code → modify.
  gh: { providerKey: "github", group: "admin" },
  amp_coder: { providerKey: "github", group: "modify" },
  opencode_coder: { providerKey: "github", group: "modify" },
  // Never gated.
  delegate_to_agent: null,
  tool_help: null,
  // Suspends the run for user input via a dedicated branch, not the policy "ask" gate.
  ask_user_question: null,
};

export type ToolClassification = { providerKey: string; group: PermissionGroup } | null;

export function classifyRuntimeTool(name: string): ToolClassification {
  if (name in RUNTIME_TOOL_CLASSIFICATION) {
    return RUNTIME_TOOL_CLASSIFICATION[name as RuntimeToolName] ?? null;
  }
  // Unknown runtime tool: be conservative but classify under system.
  return { providerKey: SYSTEM_PROVIDER_KEY, group: UNKNOWN_GROUP_FALLBACK };
}

const READ_VERBS = ["get", "list", "search", "read", "fetch", "view", "describe", "find", "query"];
const POST_VERBS = ["create", "post", "send", "add", "comment", "new", "open"];
const MODIFY_VERBS = [
  "update",
  "edit",
  "set",
  "modify",
  "move",
  "assign",
  "rename",
  "patch",
  // Upsert verbs (e.g. Linear's `save_*` MCP tools): create-or-update. Treated as
  // `modify` so an unmapped upsert tool isn't pushed into the `admin` fallback.
  "save",
  "upsert",
];
const ADMIN_VERBS = [
  "delete",
  "remove",
  "manage",
  "invite",
  "kick",
  "admin",
  "archive",
  "destroy",
  "revoke",
];

// Best-effort classification of an unknown MCP tool name by its leading/contained verb.
// Used as a fallback when a provider has no static toolGroups entry.
export function classifyByVerbHeuristic(rawToolName: string): PermissionGroup {
  const tokens = rawToolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const has = (verbs: string[]) => tokens.some((token) => verbs.includes(token));

  // Check destructive/admin first so "delete_message" never reads as "read".
  if (has(ADMIN_VERBS)) return "admin";
  if (has(MODIFY_VERBS)) return "modify";
  if (has(POST_VERBS)) return "post";
  if (has(READ_VERBS)) return "read";
  return UNKNOWN_GROUP_FALLBACK;
}

export const MCP_TOOL_NAME_SEPARATOR = "__";

// Lazy MCP tools. Injecting every server tool into the model's tool set (dozens per
// server) re-sends and re-bills their full schemas on every step. Instead each
// connected server exposes two meta-tools: `{server}__search_tools` lists that
// server's tools and input schemas on demand, and `{server}__use_tool` runs one by
// name. A raw tool's schema only reaches the model when it asks for it.
export const MCP_SEARCH_TOOLS_RAW_NAME = "search_tools";
export const MCP_USE_TOOL_RAW_NAME = "use_tool";

export function mcpSearchToolsName(providerKey: string) {
  return `${providerKey}${MCP_TOOL_NAME_SEPARATOR}${MCP_SEARCH_TOOLS_RAW_NAME}`;
}

export function mcpUseToolName(providerKey: string) {
  return `${providerKey}${MCP_TOOL_NAME_SEPARATOR}${MCP_USE_TOOL_RAW_NAME}`;
}

// `{server}__use_tool` carries the real action in its `tool` argument, so the gate must
// classify by `{server}__{tool}` — the generic invoke name has no verb and would fall to
// the admin-safe heuristic fallback. Returns the effective classification name; any other
// tool (including a use_tool call missing a usable `tool` arg) is returned unchanged, so an
// unparseable invoke stays gated conservatively as `admin`.
export function mcpInvokeEffectiveToolName(toolName: string, toolInput: unknown): string {
  const separatorIndex = toolName.indexOf(MCP_TOOL_NAME_SEPARATOR);
  if (separatorIndex <= 0) return toolName;
  const rawTool = toolName.slice(separatorIndex + MCP_TOOL_NAME_SEPARATOR.length);
  if (rawTool !== MCP_USE_TOOL_RAW_NAME) return toolName;
  const requested =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>).tool
      : undefined;
  if (typeof requested !== "string" || !requested.trim()) return toolName;
  const providerKey = toolName.slice(0, separatorIndex);
  return `${providerKey}${MCP_TOOL_NAME_SEPARATOR}${requested.trim()}`;
}

// The generic built-in `use_tool` dispatcher carries the real action in its `tool` argument, so
// the gate must classify by the underlying runtime tool — the dispatcher name has no verb and is
// `system`/ungated. Returns the requested runtime tool name when present, else the name unchanged
// so an unparseable invoke stays gated by the dispatcher (which returns a recoverable error with
// no side effect).
export function builtinInvokeEffectiveToolName(toolName: string, toolInput: unknown): string {
  if (toolName !== BUILTIN_USE_TOOL_NAME) return toolName;
  const requested =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>).tool
      : undefined;
  if (typeof requested !== "string" || !requested.trim()) return toolName;
  return requested.trim();
}

// MCP tool names are "{serverKey}__{rawTool}". Resolve the provider from the prefix
// and classify the raw tool via the registry's static map, then the verb heuristic.
export function classifyMcpTool(prefixedName: string): ToolClassification {
  const separatorIndex = prefixedName.indexOf(MCP_TOOL_NAME_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const providerKey = prefixedName.slice(0, separatorIndex);
  const rawTool = prefixedName.slice(separatorIndex + MCP_TOOL_NAME_SEPARATOR.length);
  const spec = PROVIDER_PERMISSION_REGISTRY[providerKey];
  const group =
    spec?.toolGroups?.[rawTool] ??
    spec?.toolGroups?.[normalizeRawToolName(rawTool)] ??
    classifyByVerbHeuristic(rawTool);
  return { providerKey, group };
}

function normalizeRawToolName(rawTool: string) {
  // MCP tool names can be sanitized (e.g. dots → underscores) before prefixing.
  // Try a camelCase → snake_case fold so "chatPostMessage" matches "chat_post_message".
  return rawTool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function isMcpToolName(name: string) {
  return name.includes(MCP_TOOL_NAME_SEPARATOR);
}

export function classifyTool(toolName: string): ToolClassification {
  return isMcpToolName(toolName) ? classifyMcpTool(toolName) : classifyRuntimeTool(toolName);
}

const GH_READ_COMMANDS: Record<string, readonly string[]> = {
  pr: ["view", "list", "diff", "status", "checks"],
  issue: ["view", "list", "status"],
  release: ["view", "list"],
  repo: ["view", "list"],
};

const GH_MODIFY_COMMANDS: Record<string, readonly string[]> = {
  pr: ["create", "edit", "comment", "close", "reopen", "merge", "review"],
  issue: ["create", "edit", "comment", "close", "reopen"],
  release: ["create", "edit", "upload"],
  gist: ["create", "edit"],
  repo: ["fork", "clone"],
};

const GH_GLOBAL_OPTIONS_WITH_VALUE = new Set(["--config", "--hostname", "--repo", "-R"]);

const GH_GLOBAL_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["--help", "-h", "--version"]);

export function classifyGitHubCliArgs(args: unknown): PermissionGroup {
  const argv = parseGitHubCliArgs(args);
  if (!argv || argv.length === 0) return "admin";

  const command = readGhCommand(argv);
  if (!command) return "admin";

  const [resource, action] = command;
  if (resource === "api") return classifyGhApi(argv);
  if (!action) return "admin";

  const normalizedResource = resource.toLowerCase();
  const normalizedAction = action.toLowerCase();
  if (GH_READ_COMMANDS[normalizedResource]?.includes(normalizedAction)) return "read";
  if (GH_MODIFY_COMMANDS[normalizedResource]?.includes(normalizedAction)) return "modify";
  return "admin";
}

function readGhCommand(argv: string[]): [string, string | undefined] | null {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--") return null;
    if (!arg.startsWith("-")) {
      return [arg, argv[index + 1]];
    }
    const equalsIndex = arg.indexOf("=");
    const optionName = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (GH_GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
      index += equalsIndex >= 0 ? 1 : 2;
      continue;
    }
    if (GH_GLOBAL_OPTIONS_WITH_OPTIONAL_VALUE.has(optionName)) return [arg, undefined];
    return null;
  }
  return null;
}

function classifyGhApi(argv: string[]): PermissionGroup {
  const method = readGhApiMethod(argv);
  if (!method) return hasGhApiRequestBody(argv) ? "modify" : "read";
  if (method === "GET") return "read";
  if (method === "POST" || method === "PUT" || method === "PATCH") return "modify";
  return "admin";
}

function hasGhApiRequestBody(argv: string[]) {
  return argv.some((arg) => {
    return (
      arg === "-f" ||
      arg === "-F" ||
      arg === "--field" ||
      arg === "--raw-field" ||
      arg === "--input" ||
      arg.startsWith("--field=") ||
      arg.startsWith("--raw-field=") ||
      arg.startsWith("--input=")
    );
  });
}

function readGhApiMethod(argv: string[]): string | undefined {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--method" || arg === "-X") {
      const value = argv[index + 1];
      return value ? value.toUpperCase() : "DELETE";
    }
    if (arg.startsWith("--method=")) {
      return arg.slice("--method=".length).toUpperCase();
    }
  }
  return undefined;
}

export function parseGitHubCliArgs(args: unknown): string[] | null {
  if (typeof args !== "string") return null;

  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of args) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) return null;
  if (current) argv.push(current);
  return argv;
}

// Resolved workspace policy: a flat map keyed by `${providerKey}:${group}` so the
// runner does a single O(1) lookup per tool call. A missing key falls back to the
// default stance.
export type WorkspaceToolPolicyMap = Map<string, PolicyDecision>;

export function policyMapKey(providerKey: string, group: PermissionGroup) {
  return `${providerKey}:${group}`;
}

export function effectivePolicyDecisionForGroup(input: {
  providerKey: string;
  group: PermissionGroup;
  policy: WorkspaceToolPolicyMap;
  suspendable: boolean;
}): PolicyDecision {
  let decision =
    input.policy.get(policyMapKey(input.providerKey, input.group)) ??
    DEFAULT_GROUP_STANCE[input.group];
  if (!input.suspendable && decision === "ask") {
    decision = "deny";
  }
  return decision;
}

export function formatWorkspaceToolPolicyContext(input: {
  providerKeys: Iterable<string>;
  policy: WorkspaceToolPolicyMap;
  suspendable: boolean;
}) {
  const providerKeys = [...new Set(input.providerKeys)].filter((providerKey) => {
    const spec = PROVIDER_PERMISSION_REGISTRY[providerKey];
    return spec?.gated;
  });
  if (providerKeys.length === 0) return null;

  const providerLines = providerKeys.map((providerKey) => {
    const spec = PROVIDER_PERMISSION_REGISTRY[providerKey];
    if (!spec) return null;
    const decisions = spec.groups
      .map((group) => {
        const decision = effectivePolicyDecisionForGroup({
          providerKey,
          group,
          policy: input.policy,
          suspendable: input.suspendable,
        });
        return `${PERMISSION_GROUP_LABELS[group]}=${formatPolicyDecision(decision)}`;
      })
      .join(", ");
    return `- ${spec.displayName}: ${decisions}.`;
  });

  return [
    "Workspace tool permissions:",
    "Follow these permissions before choosing tools. Denied permissions must not be attempted. If the user's requested outcome requires a denied permission, explain that workspace settings block it. Do not call read or ask-first prerequisite tools only to prepare for an action that is already denied.",
    input.suspendable
      ? "Ask-first permissions may pause the visible session for user approval."
      : "Ask-first permissions cannot pause this run and are treated as denied.",
    ...providerLines.filter((line): line is string => Boolean(line)),
  ].join("\n");
}

export function formatPolicyDecision(decision: PolicyDecision) {
  switch (decision) {
    case "allow":
      return "allow";
    case "ask":
      return "ask first";
    case "deny":
      return "deny";
  }
}

export type ToolDecision = {
  decision: PolicyDecision;
  providerKey: string;
  group: PermissionGroup;
};

// The single resolver the runner gate calls per tool call. Ungated tools (system,
// exa, delegation, tool help) short-circuit to "allow". When `suspendable` is false
// (delegated children with a parent blocking on them, or after-session/background runs
// with no resumable user-facing turn), "ask" collapses to "deny" so the run never hangs
// waiting for an approval that can't be resumed. Suspendable runs keep "ask" and pause
// durably (see RunSuspendedError).
export function resolveToolDecision(input: {
  toolName: string;
  // The tool-call arguments. Required to gate the lazy MCP invoke tool
  // (`{server}__use_tool`) by the real action in its `tool` argument rather than the
  // generic invoke name. Omitting it is safe for every other tool.
  toolInput?: unknown;
  policy: WorkspaceToolPolicyMap;
  suspendable: boolean;
}): ToolDecision {
  const classification =
    input.toolName === "gh"
      ? {
          providerKey: "github",
          group: classifyGitHubCliArgs(
            input.toolInput &&
              typeof input.toolInput === "object" &&
              !Array.isArray(input.toolInput)
              ? (input.toolInput as Record<string, unknown>).args
              : undefined,
          ),
        }
      : classifyTool(
          mcpInvokeEffectiveToolName(
            builtinInvokeEffectiveToolName(input.toolName, input.toolInput),
            input.toolInput,
          ),
        );
  if (!classification) {
    return { decision: "allow", providerKey: SYSTEM_PROVIDER_KEY, group: "read" };
  }

  const { providerKey, group } = classification;
  const spec = PROVIDER_PERMISSION_REGISTRY[providerKey];
  if (spec && !spec.gated) {
    return { decision: "allow", providerKey, group };
  }

  const decision = effectivePolicyDecisionForGroup({
    providerKey,
    group,
    policy: input.policy,
    suspendable: input.suspendable,
  });
  return { decision, providerKey, group };
}

export type DeniedToolOutput = {
  ok: false;
  denied: true;
  error: {
    code: "permission_denied";
    recoverable: false;
    message: string;
  };
};

// Tool result returned in place of running a denied tool. Phrased so the model
// understands this is a user/workspace policy decision, not a tool bug, and does
// not retry in a loop.
export function buildDeniedToolOutput(input: {
  toolName: string;
  providerKey: string;
  group: PermissionGroup;
  source?: "policy" | "user" | "timeout" | undefined;
}): DeniedToolOutput {
  const provider =
    PROVIDER_PERMISSION_REGISTRY[input.providerKey]?.displayName ?? input.providerKey;
  const reason =
    input.source === "timeout"
      ? "The approval request timed out without a response"
      : input.source === "user"
        ? "The user denied permission"
        : "The workspace has not granted permission";
  return {
    ok: false,
    denied: true,
    error: {
      code: "permission_denied",
      recoverable: false,
      message: `${reason} to run "${input.toolName}" (${provider} · ${PERMISSION_GROUP_LABELS[input.group]}). Do not retry this tool. Explain what you intended to do and ask the user to enable it in workspace settings, or take a different approach.`,
    },
  };
}
