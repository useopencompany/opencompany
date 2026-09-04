import type { BrainSourceConfigProvider } from "@opencompany/protocol";
import type { LucideIcon } from "lucide-react";
import {
  Contact,
  Files,
  FileText,
  GitBranch,
  Handshake,
  ListTodo,
  Mail,
  NotebookPen,
  Video,
} from "lucide-react";

const DOCS_ORIGIN = "https://docs.opencompany.cloud";

export const JAMIE_DOCS_HREF = `${DOCS_ORIGIN}/docs/integrations/jamie`;

export type BrainSourceProviderDef = {
  id: BrainSourceConfigProvider;
  name: string;
  description: string;
  icon: LucideIcon;
  connectionKind: "webhook" | "oauth" | "api_key";
  // Unavailable providers render as "Coming soon" cards; making one available
  // means shipping its connector and flipping this flag.
  available: boolean;
  connectHref: string;
  docsHref?: string;
};

// Deliberately excludes "slack_bot": those brain_sources rows are answer
// destinations (rendered by the Destinations section in brain settings via
// SlackBotDestinationCard), not ingestion sources.
export const BRAIN_SOURCE_PROVIDERS: BrainSourceProviderDef[] = [
  {
    id: "jamie",
    name: "Jamie",
    description: "Meeting notes flow into this brain after every completed meeting.",
    icon: FileText,
    connectionKind: "webhook",
    available: true,
    connectHref: "/settings/jamie",
    docsHref: JAMIE_DOCS_HREF,
  },
  {
    id: "granola",
    name: "Granola",
    description: "Meeting notes flow into this brain once Granola finishes each summary.",
    icon: NotebookPen,
    connectionKind: "api_key",
    available: true,
    connectHref: "/settings/granola",
    docsHref: `${DOCS_ORIGIN}/docs/integrations/granola`,
  },
  {
    id: "fathom",
    name: "Fathom",
    description: "Meeting recordings flow into this brain once Fathom finishes each summary.",
    icon: Video,
    connectionKind: "api_key",
    available: true,
    connectHref: "/settings/fathom",
    docsHref: `${DOCS_ORIGIN}/docs/integrations/fathom`,
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
  {
    id: "attio",
    name: "Attio",
    description: "Ingest CRM activity and notes on people, companies, and deals into this brain.",
    icon: Contact,
    connectionKind: "api_key",
    available: true,
    connectHref: "/settings/attio",
    docsHref: `${DOCS_ORIGIN}/docs/integrations/attio`,
  },
];

// Providers whose ingestion scope must be chosen after the account connects —
// teams, repos, CRM objects, Drive files, or (for Gmail) confirmed
// email events. Authorizing the account is not enough for these: nothing feeds
// the brain until the user picks what to ingest, so onboarding opens a focused
// config surface right after connect.
//
// The meeting-note providers (Jamie, Granola, Fathom) have nothing to scope —
// once connected, every meeting flows in — so onboarding auto-enables them on
// connect instead of prompting for config.
export function brainSourceNeedsConfig(id: BrainSourceConfigProvider): boolean {
  return (
    id === "linear" ||
    id === "github" ||
    id === "gmail" ||
    id === "google_drive" ||
    id === "hubspot" ||
    id === "attio"
  );
}
