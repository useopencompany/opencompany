import type { GoatBrainSourceConfigProvider } from "@opencompany/db/goat-schema";
import type { LucideIcon } from "lucide-react";
import { FileText, GitBranch, ListTodo, Mail, MessageSquare } from "lucide-react";

export type GoatBrainSourceProviderDef = {
  id: GoatBrainSourceConfigProvider;
  name: string;
  description: string;
  icon: LucideIcon;
  connectionKind: "webhook" | "oauth";
  // Unavailable providers render as "Coming soon" cards; making one available
  // means shipping its connector and flipping this flag.
  available: boolean;
  connectHref: string;
};

export const GOAT_BRAIN_SOURCE_PROVIDERS: GoatBrainSourceProviderDef[] = [
  {
    id: "jamie",
    name: "Jamie",
    description: "Meeting notes flow into this brain after every completed meeting.",
    icon: FileText,
    connectionKind: "webhook",
    available: true,
    connectHref: "/settings/jamie",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Ingest sent and received email into this brain, tuned by your instructions.",
    icon: Mail,
    connectionKind: "oauth",
    available: true,
    connectHref: "/api/integrations/gmail/start?returnTo=/settings/integrations",
  },
  {
    id: "github",
    name: "GitHub",
    description: "New and merged pull requests and new issues from repos you choose.",
    icon: GitBranch,
    connectionKind: "oauth",
    available: true,
    connectHref: "/api/integrations/github/start?returnTo=/settings/integrations",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Ingest channel conversations into this brain.",
    icon: MessageSquare,
    connectionKind: "oauth",
    available: true,
    connectHref: "/api/integrations/slack/start?returnTo=/settings/integrations",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Ingest selected issue and comment events from selected teams into this brain.",
    icon: ListTodo,
    connectionKind: "oauth",
    available: true,
    connectHref: "/api/integrations/linear-ingest/start?returnTo=/settings/integrations",
  },
];
