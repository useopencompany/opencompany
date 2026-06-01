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
      archive_issue: "admin",
      delete_issue: "admin",
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
  [SYSTEM_PROVIDER_KEY]: {
    providerKey: SYSTEM_PROVIDER_KEY,
    displayName: "Sandbox",
    groups: ["read", "modify", "admin"],
    gated: false,
  },
};

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
  // Never gated.
  delegate_to_agent: null,
  tool_help: null,
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
const MODIFY_VERBS = ["update", "edit", "set", "modify", "move", "assign", "rename", "patch"];
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

export type ToolDecision = {
  decision: PolicyDecision;
  providerKey: string;
  group: PermissionGroup;
};

// The single resolver the runner gate calls per tool call. Ungated tools (system,
// exa, delegation, tool help) short-circuit to "allow". When `interactive` is false
// (autonomous / after-session runs with no user to approve), "ask" collapses to
// "deny" so the run never hangs waiting for an approval that can't come.
export function resolveToolDecision(input: {
  toolName: string;
  policy: WorkspaceToolPolicyMap;
  interactive: boolean;
}): ToolDecision {
  const classification = classifyTool(input.toolName);
  if (!classification) {
    return { decision: "allow", providerKey: SYSTEM_PROVIDER_KEY, group: "read" };
  }

  const { providerKey, group } = classification;
  const spec = PROVIDER_PERMISSION_REGISTRY[providerKey];
  if (spec && !spec.gated) {
    return { decision: "allow", providerKey, group };
  }

  const configured = input.policy.get(policyMapKey(providerKey, group));
  let decision = configured ?? DEFAULT_GROUP_STANCE[group];
  if (!input.interactive && decision === "ask") {
    decision = "deny";
  }
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
