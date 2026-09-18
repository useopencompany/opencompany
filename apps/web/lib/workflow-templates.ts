import type { PluginListItemDto } from "@opencompany/protocol";
import type { IntegrationAccountView } from "@/lib/integration-state";
import {
  OFFICIAL_MCP_PLUGIN_METADATA,
  type OfficialMcpPluginMetadata,
  type OfficialMcpPluginName,
} from "@/lib/official-plugins";

// Templates answer the blank-editor problem: a founder opens Workflows with nothing to react to and
// has to invent both the job and the prompt. Each one is a complete, running-quality workflow they
// can read, clone, and edit — not a stub.
//
// Every template triggers on a schedule. Schedules need no setup, so cloning a template never
// depends on a plugin being connected first; only the tools the instructions reach for do, and those
// are declared in `requiredPlugins` so the gallery can say what is still missing. Event triggers are
// deliberately out of the first version: only three plugins declare events today, and an event
// trigger cannot be saved without a connected account to bind it to.

export type WorkflowTemplateIcon = "ship" | "inbox" | "revenue";

// The gallery badges an outcome with the service's own mark, so a template may only name a plugin
// that has one. Widening this forces the icon map in the gallery to grow with it.
export type WorkflowTemplateOutcomePlugin = Extract<
  OfficialMcpPluginName,
  "github" | "gmail" | "slack" | "stripe"
>;

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  icon: WorkflowTemplateIcon;
  /** Plugins the instructions call. The clone always succeeds; the run needs all of them connected. */
  requiredPlugins: readonly OfficialMcpPluginName[];
  /** Right half of the card's "trigger → outcome" line. A null plugin means the run's Task is the outcome. */
  outcome: { label: string; plugin: WorkflowTemplateOutcomePlugin | null };
  schedule: { cron: string; prompt: string };
  step: { title: string; instructions: string };
};

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "weekly-shipping-digest",
    name: "Weekly shipping digest",
    description: "Summarize what the team shipped this week from GitHub and post it to Slack.",
    icon: "ship",
    requiredPlugins: ["github", "slack"],
    outcome: { label: "Send Slack", plugin: "slack" },
    schedule: { cron: "0 16 * * 5", prompt: "Write this week's shipping digest." },
    step: {
      title: "Summarize the week and post it",
      instructions: `Write the weekly shipping digest for the team and post it to Slack.

1. Look at every pull request merged into the default branch of our repositories in the last 7 days, plus any releases tagged in that window.
2. Group the work by what it means for users, not by repository: shipped features, fixes, and internal/infrastructure work. Skip dependency bumps and formatting-only changes unless nothing else landed.
3. For each item, write one plain sentence a non-engineer understands, and link the pull request.
4. Note anything that looks stalled: pull requests open more than 7 days with review activity.
5. Post the digest to the team's main Slack channel. Open with a one-line summary ("12 PRs merged, 3 user-facing changes"), then the grouped list, then the stalled items under "Needs attention". Keep it under 300 words.

If a repository or channel is ambiguous, pick the most active one and say which you picked at the end of the message. Never invent work that is not in the commit history.`,
    },
  },
  {
    id: "daily-inbox-triage",
    name: "Daily inbox triage",
    description: "Sort new email into what needs a reply, what's FYI, and what's noise.",
    icon: "inbox",
    requiredPlugins: ["gmail"],
    outcome: { label: "Summary in Tasks", plugin: null },
    schedule: { cron: "0 8 * * 1-5", prompt: "Triage yesterday's inbox." },
    step: {
      title: "Triage the inbox",
      instructions: `Read the email that arrived since the previous weekday morning and turn it into a short triage list. This runs on weekdays, so a Monday run covers the whole weekend, not just Sunday.

Sort every message into exactly one bucket:

- **Needs a reply from you** — a person is waiting on a decision, an answer, or a signature. For each, give the sender, the one-sentence ask, and how long it has been waiting.
- **FYI** — worth knowing, no action. One line each, grouped by topic.
- **Noise** — newsletters, receipts, automated alerts. Just the count and the top senders.

Rules:

- Lead with the "Needs a reply" bucket, ordered by how long the sender has been waiting.
- Quote the actual ask rather than paraphrasing into vagueness.
- Do not send, archive, or reply to anything. This is a read-only summary.
- If the inbox was quiet, say so in one line instead of padding the report.`,
    },
  },
  {
    id: "weekly-revenue-pulse",
    name: "Weekly revenue pulse",
    description:
      "Track new subscriptions, churn, and failed payments, then post the numbers to Slack.",
    icon: "revenue",
    requiredPlugins: ["stripe", "slack"],
    outcome: { label: "Send Slack", plugin: "slack" },
    schedule: { cron: "0 9 * * 1", prompt: "Post this week's revenue pulse." },
    step: {
      title: "Pull the numbers and post them",
      instructions: `Post the weekly revenue pulse to Slack.

Pull from Stripe, for the last 7 days and the 7 days before it so every number has a comparison:

- New subscriptions, and the revenue they add.
- Cancellations, and the revenue they remove. Name the customers, small numbers matter at our size.
- Failed and past-due payments, with the customer and the amount at risk.
- Net movement in recurring revenue.

Post to the team's main Slack channel:

- One headline line: net movement, and whether it is up or down on last week.
- The four numbers with their week-over-week change.
- A "Needs a human" section listing every failed payment and cancellation worth a follow-up.

Report the numbers Stripe actually returns. If a figure is unavailable, say which one and why rather than estimating it.`,
    },
  },
];

export type WorkflowTemplateMissingPlugin = {
  plugin: OfficialMcpPluginName;
  label: string;
  /** The plugin's settings page, which covers both halves of the gap: install/enable, then connect. */
  setupHref: string;
};

// A plugin is only usable by a run once it is installed and enabled *and* has a connected account to
// act through, so both are checked. Personal accounts are keyed by connection provider
// ("github_user"), which is not always the plugin name ("github") — go through the metadata.
export function workflowTemplateMissingPlugins(
  template: WorkflowTemplate,
  workspace: {
    plugins: readonly PluginListItemDto[];
    personalAccounts: Record<string, IntegrationAccountView[] | undefined>;
  },
): WorkflowTemplateMissingPlugin[] {
  return template.requiredPlugins.flatMap((plugin) => {
    const metadata: OfficialMcpPluginMetadata = OFFICIAL_MCP_PLUGIN_METADATA[plugin];
    const enabled = workspace.plugins.some(
      (candidate) => candidate.name === plugin && candidate.status === "enabled",
    );
    const connected = (workspace.personalAccounts[metadata.connectionProvider] ?? []).some(
      (account) => account.connected,
    );
    if (enabled && connected) return [];
    return [
      {
        plugin,
        // "GitHub as you" names the plugin; the account label is what a setup prompt should say.
        label: metadata.accountLabel ?? metadata.label,
        setupHref: `/plugins/${plugin}`,
      },
    ];
  });
}
