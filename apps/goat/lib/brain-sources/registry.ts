import type { GoatBrainSourceConfigProvider } from "@opencompany/db/goat-schema";
import type { LucideIcon } from "lucide-react";
import {
  Files,
  FileText,
  GitBranch,
  Handshake,
  ListTodo,
  Mail,
  MessageSquare,
  NotebookPen,
} from "lucide-react";

export const GOAT_JAMIE_DOCS_HREF = "/docs/integrations/jamie";

export type GoatBrainSourceProviderDef = {
  id: GoatBrainSourceConfigProvider;
  name: string;
  description: string;
  icon: LucideIcon;
  connectionKind: "webhook" | "oauth" | "api_key";
  // Unavailable providers render as "Coming soon" cards; making one available
  // means shipping its connector and flipping this flag.
  available: boolean;
  connectHref: string;
  onboardingConnectHref?: string;
  docsHref?: string;
};

// Deliberately excludes "slack_bot": those brain_sources rows are answer
// destinations (rendered by the Destinations section in brain settings via
// GoatSlackBotDestinationCard), not ingestion sources.
export const GOAT_BRAIN_SOURCE_PROVIDERS: GoatBrainSourceProviderDef[] = [
  {
    id: "jamie",
    name: "Jamie",
    description: "Meeting notes flow into this brain after every completed meeting.",
    icon: FileText,
    connectionKind: "webhook",
    available: true,
    connectHref: "/settings/jamie",
    onboardingConnectHref: "/onboarding/jamie",
    docsHref: GOAT_JAMIE_DOCS_HREF,
  },
  {
    id: "granola",
    name: "Granola",
    description: "Meeting notes flow into this brain once Granola finishes each summary.",
    icon: NotebookPen,
    connectionKind: "api_key",
    available: true,
    connectHref: "/settings/granola",
    docsHref: "/docs/integrations/granola",
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
    id: "google_drive",
    name: "Google Drive",
    description: "Ingest changes from selected files and folders into this brain.",
    icon: Files,
    connectionKind: "oauth",
    available: true,
    connectHref: "/api/integrations/google-drive/start?returnTo=/settings/integrations",
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
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Ingest CRM activity on contacts, companies, and deals into this brain.",
    icon: Handshake,
    connectionKind: "oauth",
    available: true,
    connectHref: "/api/integrations/hubspot/start?returnTo=/settings/integrations",
  },
];
