// One place that turns an action id into the words a user reads: the service the action runs
// against, and what the action does. Every surface that shows a connected action — chat tool
// rows, coding-session tool rows, approval cards, task run traces — names it the same way.
//
// Action ids come in three shapes:
//   plugin:linear:linear.create_issue   an installed plugin's gateway tool
//   linear.create_issue                 a first-party provider action
//   lead.search_prospects               a managed capability action
// The part before the first "." is the source; the part after it is the action.

import {
  OFFICIAL_MANAGED_PLUGIN_METADATA,
  OFFICIAL_MCP_PLUGIN_METADATA,
  OFFICIAL_SKILL_PLUGIN_METADATA,
} from "@/lib/official-plugins";

export type ActionIdentity = {
  /** Normalized source slug, usable as a lookup key for the service's brand mark. */
  source: string;
  /** The service as a user knows it: "Linear", "Google Calendar", "Custom integration". */
  sourceLabel: string;
  /** What the action does, in sentence case: "Create issue". Null when the id carries no action. */
  actionLabel: string | null;
};

// Managed capabilities are opencompany-run services with no plugin catalog entry, so their brand
// names live here. Keep them to the service name; the settings panel owns the longer copy.
const MANAGED_SOURCE_LABELS: Readonly<Record<string, string>> = {
  image: "Image generation",
  instagram: "Instagram",
  lead: "Lead research",
  linkedin: "LinkedIn",
  seo: "SEO",
  tiktok: "TikTok",
  x: "X",
  youtube: "YouTube",
};

// A plugin label distinguishes plugins from each other in the catalog; a tool row names the
// service the call reached. "GitHub as you" is the right catalog label and the wrong row label.
const SOURCE_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  github: "GitHub",
  github_user: "GitHub",
  session_history: "Session history",
};

const OFFICIAL_SOURCE_LABELS = officialSourceLabels();

/** The service and action a connected-action id names. */
export function actionIdentity(action: string): ActionIdentity {
  const source = actionSource(action);
  return {
    source,
    sourceLabel: actionSourceLabel(action),
    actionLabel: actionLabel(action),
  };
}

/**
 * The action id's source slug, normalized: plugin ids yield the plugin name, provider ids drop
 * the `_account` suffix the gateway adds to personal connections.
 */
export function actionSource(action: string): string {
  const pluginMatch = /^plugin:([^:]+):/u.exec(action);
  const slug = pluginMatch?.[1] ?? action.split(".", 1)[0] ?? "";
  return slug.replace(/_account$/u, "").toLowerCase();
}

/** The service an action runs against, as a user knows it. */
export function actionSourceLabel(action: string): string {
  const source = actionSource(action);
  if (!source) return "Action";
  // Custom MCP plugins are named by the user, and that name is not ours to render as a brand.
  if (source === "custom_mcp" || source.startsWith("custom-")) return "Custom integration";
  return (
    SOURCE_LABEL_OVERRIDES[source] ??
    OFFICIAL_SOURCE_LABELS[source] ??
    MANAGED_SOURCE_LABELS[source] ??
    humanize(source)
  );
}

/**
 * What the action does, as lowercase words: "create issue". Gateways namespace their tools after
 * the service ("slack.slack_search_messages"), and the source is always named alongside the
 * action, so a repeated service name is dropped rather than read twice.
 */
export function actionVerb(action: string): string | null {
  if (!action.includes(".")) return null;
  const words = (action.split(".").at(-1) ?? "").split("_").filter(Boolean);
  const sourceWords = actionSource(action).split(/[_-]+/u).filter(Boolean);
  while (words.length > 1 && sourceWords.length > 0 && words[0] === sourceWords[0]) {
    words.shift();
    sourceWords.shift();
  }
  return words.join(" ") || null;
}

/** What the action does, in sentence case: "Create issue". */
export function actionLabel(action: string): string | null {
  const verb = actionVerb(action);
  return verb ? sentenceCase(verb) : null;
}

/** "Linear · Create issue", falling back to the service alone when the id carries no action. */
export function actionRowLabel(action: string): string {
  const { sourceLabel, actionLabel: name } = actionIdentity(action);
  return name ? `${sourceLabel} · ${name}` : sourceLabel;
}

function officialSourceLabels() {
  const labels: Record<string, string> = {};
  const catalog = [
    ...Object.values(OFFICIAL_MCP_PLUGIN_METADATA),
    ...Object.values(OFFICIAL_SKILL_PLUGIN_METADATA),
    ...Object.values(OFFICIAL_MANAGED_PLUGIN_METADATA),
  ];
  for (const plugin of catalog) {
    // A plugin is reachable by its own name and by the connection its actions authenticate with.
    labels[plugin.name] = plugin.label;
    if ("connectionProvider" in plugin) {
      labels[plugin.connectionProvider.replace(/_account$/u, "")] = plugin.label;
    }
  }
  return labels;
}

function humanize(value: string) {
  return (
    sentenceCase(
      value
        .split(/[._-]+/u)
        .filter(Boolean)
        .join(" "),
    ) || "Action"
  );
}

function sentenceCase(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
