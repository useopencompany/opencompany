import {
  BarChart3,
  CalendarDays,
  Files,
  FlaskConical,
  GitBranch,
  type LucideIcon,
  Mail,
  MessageSquare,
  Monitor,
  Rocket,
  SquareKanban,
  UserRoundCog,
} from "lucide-react";
import type { PersonalIntegrationId } from "@/lib/personal/actions";

// The catalogs that drive personal-agent setup surfaces:
//
//  - ONBOARDING_SETUPS — the preset "starting points" shown on the agent-setup step. Picking one
//    pre-selects its integrations, gives the first session a starter task, and feeds a "mode" intent
//    into the first message so the onboarding skill tunes the agent's soul to that role. "Start from
//    scratch" is offered alongside these in the UI (it simply selects no preset).
//  - ONBOARDING_INTEGRATIONS — the integrations/MCPs we support, shown as a connect step. Each row's
//    checkbox enables it on the agent (writes its @mention at submit); `connectHref` is opened in a
//    popup (target /onboarding/connected) so the user can authorize inline without the current page
//    ever navigating away.

export type OnboardingSetup = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  // Integrations to pre-select on the integrations step when this preset is chosen.
  integrations: PersonalIntegrationId[];
  // The first task the seeded session opens with (the user no longer types one).
  starterTask: string;
  // A short, plain-language description of the mode this preset implies. Rides (invisibly) into the
  // first message so the onboarding skill can tune `agent/soul.md` to fit — it is never shown.
  soulIntent: string;
};

export const ONBOARDING_SETUPS: OnboardingSetup[] = [
  {
    id: "co-founder",
    title: "Co-founder",
    description:
      "A thinking partner for strategy, product, and the hard calls — moves fast with me.",
    icon: Rocket,
    integrations: ["linear", "github", "slack"],
    starterTask: "Help me think through the most important thing I should be working on right now",
    soulIntent:
      "A co-founder-like partner who thinks strategically about the business and product, pushes " +
      "back on my thinking, connects the dots across what's happening, and helps me move fast on " +
      "what matters most.",
  },
  {
    id: "executive-assistant",
    title: "Executive Assistant",
    description: "Runs my calendar, inbox, and follow-ups so my time goes to the right things.",
    icon: UserRoundCog,
    integrations: ["google_calendar", "gmail", "slack"],
    starterTask: "Get me on top of my inbox and calendar for today",
    soulIntent:
      "A sharp executive assistant who manages my calendar, inbox, and communications, protects " +
      "my time, drafts replies in my voice, and makes sure nothing slips through the cracks.",
  },
];

// postMessage contract between the inline-connect popup (/onboarding/connected) and the onboarding
// window. The popup reads the OAuth status params, posts this, and closes; the onboarding window
// listens and flips the row to "connected".
export const ONBOARDING_CONNECTED_MESSAGE = "oc-integration-connected" as const;

export type OnboardingConnectedMessage = {
  type: typeof ONBOARDING_CONNECTED_MESSAGE;
  // Equals a PersonalIntegrationId (github, gmail, google_calendar, google_drive, linear, slack,
  // posthog, betterstack).
  provider: string | null;
  status: string | null;
  reason: string | null;
};

export type OnboardingIntegration = {
  id: PersonalIntegrationId;
  label: string;
  description: string;
  icon: LucideIcon;
  // OAuth start route, opened in a popup window from the integrations step. Every start route lands
  // back on /onboarding/connected (a tiny page that messages the opener and closes itself), so the
  // user authorizes inline without the current page navigating.
  connectHref: string;
};

// All OAuth flows accept an arbitrary relative `returnTo` and redirect back to it with a status
// param on completion (integrations: `?integration=<id>&setup=…`, MCPs: `?mcp=<id>&setup=…`). We
// point them all at this popup-closer page.
const ONBOARDING_RETURN_TO = "/onboarding/connected";

export const ONBOARDING_INTEGRATIONS: OnboardingIntegration[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Read and edit repositories, open pull requests.",
    icon: GitBranch,
    connectHref: `/api/integrations/github/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
  {
    id: "gmail",
    label: "Gmail",
    description: "Read your mail to draft, triage, and summarize.",
    icon: Mail,
    connectHref: `/api/integrations/gmail/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    description: "Read and manage events across your calendars.",
    icon: CalendarDays,
    connectHref: `/api/integrations/google-calendar/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
  {
    id: "google_drive",
    label: "Google Drive",
    description: "Find, read, and update docs in Drive.",
    icon: Files,
    connectHref: `/api/integrations/google-drive/start?returnTo=${ONBOARDING_RETURN_TO}`,
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
  {
    id: "betterstack",
    label: "Better Stack",
    description: "Pull observability, incidents, and uptime context.",
    icon: Monitor,
    connectHref: `/api/mcp/betterstack/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
  {
    id: "braintrust",
    label: "Braintrust",
    description: "Query evals, experiments, datasets, and logs.",
    icon: FlaskConical,
    connectHref: `/api/mcp/braintrust/start?returnTo=${ONBOARDING_RETURN_TO}`,
  },
];
