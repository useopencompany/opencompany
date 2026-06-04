import type { RuntimeToolName } from "./tools";

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
  // Sandbox-local file IO.
  read_file: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  list_files: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  git_diff: { providerKey: SYSTEM_PROVIDER_KEY, group: "read" },
  write_file: { providerKey: SYSTEM_PROVIDER_KEY, group: "modify" },
  edit_file: { providerKey: SYSTEM_PROVIDER_KEY, group: "modify" },
  // shell can run anything, so it is the most restrictive system group.
  shell: { providerKey: SYSTEM_PROVIDER_KEY, group: "admin" },
  // GitHub-effecting tools. gh is an unbounded CLI → admin; amp_coder writes code → modify.
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
  const classification = classifyTool(mcpInvokeEffectiveToolName(input.toolName, input.toolInput));
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
