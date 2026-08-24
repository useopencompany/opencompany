import type { WikiSourceProvider } from "@opencompany/protocol";
import {
  GitHubIcon,
  GmailIcon,
  GranolaIcon,
  LinearIcon,
  type LucideIcon,
  SlackIcon,
} from "@opencompany/ui/icons";

export type WikiSourceProviderDef = {
  id: WikiSourceProvider;
  name: string;
  description: string;
  Icon?: LucideIcon;
  monogram?: string;
  tileClass: string;
  connectionKind: "oauth" | "api_key" | "webhook";
  connectHref: string;
  scopeRequired: boolean;
};

export const WIKI_SOURCE_PROVIDERS: WikiSourceProviderDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Turn important email into durable, linked Wiki knowledge.",
    Icon: GmailIcon,
    tileClass: "bg-[#EA4335] text-white",
    connectionKind: "oauth",
    connectHref: "/api/integrations/gmail/start?returnTo=/wiki/sources",
    scopeRequired: true,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Capture useful decisions and context from Slack conversations.",
    Icon: SlackIcon,
    tileClass: "bg-[#4A154B] text-white",
    connectionKind: "oauth",
    connectHref: "/api/integrations/slack/start?returnTo=/wiki/sources",
    scopeRequired: true,
  },
  {
    id: "jamie",
    name: "Jamie",
    description: "Add completed meeting notes to your workspace Wiki automatically.",
    monogram: "J",
    tileClass: "bg-[#5B5BD6] text-white",
    connectionKind: "webhook",
    connectHref: "/settings/jamie",
    scopeRequired: false,
  },
  {
    id: "granola",
    name: "Granola",
    description: "Feed finished Granola meeting summaries into your workspace Wiki.",
    Icon: GranolaIcon,
    tileClass: "bg-[#F0EBE1] text-[#1A1714]",
    connectionKind: "api_key",
    connectHref: "/settings/granola",
    scopeRequired: false,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Keep project and issue knowledge current from Linear activity.",
    Icon: LinearIcon,
    tileClass: "bg-[#5E6AD2] text-white",
    connectionKind: "oauth",
    connectHref: "/api/integrations/linear-ingest/start?returnTo=/wiki/sources",
    scopeRequired: true,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Bring repository, pull request, and issue context into the Wiki.",
    Icon: GitHubIcon,
    tileClass: "bg-[#181717] text-white",
    connectionKind: "oauth",
    connectHref: "/api/integrations/github/start?returnTo=/wiki/sources",
    scopeRequired: true,
  },
];
