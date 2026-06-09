import {
  BarChart3,
  Briefcase,
  CalendarDays,
  GitBranch,
  Inbox,
  LineChart,
  type LucideIcon,
  Mail,
  MessageSquare,
  SquareKanban,
  Telescope,
} from "lucide-react";
import type { PersonalIntegrationId } from "@/lib/personal/actions";

// The catalogs that drive the two middle onboarding screens (/onboarding/personal):
//
//  - ONBOARDING_SETUPS — "what can this agent do for me?" packs shown right after identity. Picking
//    one pre-selects its integrations, prefills the first task, and feeds a "mode" intent into the
//    first message so the onboarding skill tunes the agent's soul to that role.
//  - ONBOARDING_INTEGRATIONS — the integrations/MCPs we support, shown as a connect step. Selecting
//    a row enables it on the agent (writes its @mention at submit); `connectHref` opens the auth
//    flow in a new tab so the in-progress onboarding state survives the round-trip.

export type OnboardingSetup = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  // Integrations to pre-select on the integrations step when this pack is chosen.
  integrations: PersonalIntegrationId[];
  // Prefilled into the prompt box; the user can still edit it.
  starterTask: string;
  // A short, plain-language description of the mode this pack implies. Rides (invisibly) into the
  // first message so the onboarding skill can tune `agent/soul.md` to fit — it is never shown.
  soulIntent: string;
};

export const ONBOARDING_SETUPS: OnboardingSetup[] = [
  {
    id: "chief-of-staff",
    title: "Chief of Staff",
    description: "Stays on top of my calendar, inbox, and priorities so nothing slips.",
    icon: Briefcase,
    integrations: ["google_calendar", "gmail", "linear"],
    starterTask: "Give me a daily brief of what needs my attention",
    soulIntent:
      "A proactive chief of staff who manages my priorities, calendar, and communications, " +
      "surfaces what needs my attention, and keeps things moving without being asked.",
  },
  {
    id: "research-analyst",
    title: "Research Analyst",
    description: "Digs into companies, people, and markets and writes tight memos.",
    icon: Telescope,
    integrations: ["github"],
    starterTask: "Research our top 3 competitors and how we differ",
    soulIntent:
      "A rigorous research analyst who investigates companies, people, and markets from primary " +
      "sources and produces tight, well-cited memos.",
  },
  {
    id: "inbox-and-comms",
    title: "Inbox & Comms",
    description: "Drafts replies in my voice and keeps my messages from piling up.",
    icon: Inbox,
    integrations: ["gmail", "slack"],
    starterTask: "Draft the replies I owe people",
    soulIntent:
      "A communications assistant who drafts email and messages in my voice, keeps my inbox under " +
      "control, and flags what genuinely needs me.",
  },
  {
    id: "product-and-growth",
    title: "Product & Growth",
    description: "Tracks what's shipping, what's blocked, and how it's landing.",
    icon: LineChart,
    integrations: ["linear", "posthog", "github"],
    starterTask: "Summarize what's shipping and what's blocked",
    soulIntent:
      "A product and growth copilot who tracks what's shipping and blocked, ties work to outcomes, " +
      "and reads product analytics to tell me how it's landing.",
  },
];

export type OnboardingIntegration = {
  id: PersonalIntegrationId;
  label: string;
  description: string;
  icon: LucideIcon;
  // Opened in a new tab from the integrations step to authorize the connection.
  connectHref: string;
};

const ONBOARDING_RETURN_TO = "/onboarding/personal";

export const ONBOARDING_INTEGRATIONS: OnboardingIntegration[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Read and edit repositories, open pull requests.",
    icon: GitBranch,
    connectHref: "/settings/integrations",
  },
  {
    id: "gmail",
    label: "Gmail",
    description: "Read your mail to draft, triage, and summarize.",
    icon: Mail,
    connectHref: "/settings/integrations",
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    description: "Read and manage events across your calendars.",
    icon: CalendarDays,
    connectHref: "/settings/integrations",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Track issues, projects, and what's in flight.",
    icon: SquareKanban,
    connectHref: `/api/mcp/linear/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
  {
    id: "slack",
    label: "Slack",
    description: "Search messages and keep up with channels.",
    icon: MessageSquare,
    connectHref: `/api/mcp/slack/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
  {
    id: "posthog",
    label: "PostHog",
    description: "Pull product analytics and usage insights.",
    icon: BarChart3,
    connectHref: `/api/mcp/posthog/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
];
