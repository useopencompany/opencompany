import { MCP_TOOL_NAME_SEPARATOR } from "@opencompany/agent-runtime";
import {
  BetterStackIcon,
  BraintrustIcon,
  GitHubIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  InstagramIcon,
  LinearIcon,
  type LucideIcon,
  NeonIcon,
  NotionIcon,
  PostHogIcon,
  SlackIcon,
  TikTokIcon,
  XIcon,
  YouTubeIcon,
} from "@opencompany/ui/icons";

// Resolve the brand glyph for the external service an agent tool call touches, so
// the chat can badge each tool with its service instead of a generic wrench.
// Returns null for internal/generic tools (shell, read_file, memory, web_fetch, …)
// and for services we have no clean brand glyph for (e.g. Exa) — the caller falls
// back to the wrench in those cases.
//
// Two shapes of tool name reach the UI (see runtime-events.ts):
//  - MCP tools are unwrapped to "{provider}__{tool}", e.g. "linear__create_issue".
//    The provider key before the "__" separator is the service.
//  - Hosted tools are flat with a per-service prefix, e.g. "gmail_list_messages",
//    plus the "gh" CLI which stands in for GitHub work.

const MCP_PROVIDER_ICONS: Record<string, LucideIcon> = {
  linear: LinearIcon,
  slack: SlackIcon,
  posthog: PostHogIcon,
  notion: NotionIcon,
  betterstack: BetterStackIcon,
  braintrust: BraintrustIcon,
};

// Exact tool names that carry a service identity without a shared prefix.
const EXACT_TOOL_ICONS: Record<string, LucideIcon> = {
  gh: GitHubIcon,
};

// Flat hosted-tool prefixes → service glyph. First match wins; the prefixes are
// mutually exclusive, so order only matters for readability.
const HOSTED_PREFIX_ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["gmail_", GmailIcon],
  ["calendar_", GoogleCalendarIcon],
  ["drive_", GoogleDriveIcon],
  ["x_", XIcon],
  ["youtube_", YouTubeIcon],
  ["tiktok_", TikTokIcon],
  ["instagram_", InstagramIcon],
  ["neon_", NeonIcon],
];

export function toolServiceIcon(toolName: string): LucideIcon | null {
  if (!toolName) return null;

  const separatorIndex = toolName.indexOf(MCP_TOOL_NAME_SEPARATOR);
  if (separatorIndex > 0) {
    const provider = toolName.slice(0, separatorIndex);
    return MCP_PROVIDER_ICONS[provider] ?? null;
  }

  const exact = EXACT_TOOL_ICONS[toolName];
  if (exact) return exact;

  for (const [prefix, icon] of HOSTED_PREFIX_ICONS) {
    if (toolName.startsWith(prefix)) return icon;
  }

  return null;
}
