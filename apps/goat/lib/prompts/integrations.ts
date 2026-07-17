import { promptBlock } from "./blocks";

// Everything the system prompt says about connected-integration tools lives
// here: the Level-0 index block (which providers are readable in chat) and the
// behavior lines for the two-call search/call flow.

export type OpenCompanyChatIntegrationIndexEntry = {
  provider: string;
  label: string;
  summary: string;
  // Connected account identifiers the model may need as arguments: Gmail
  // account emails, Slack workspace names.
  accounts?: readonly string[];
};

export function formatIntegrationsBlock(entries: readonly OpenCompanyChatIntegrationIndexEntry[]) {
  return promptBlock("integrations", [
    "Connected integrations you can read directly in this chat (read-only):",
    ...entries.map((entry) => {
      const accounts = entry.accounts?.length
        ? ` Connected: ${entry.accounts.map((account) => JSON.stringify(account)).join(", ")}.`
        : "";
      return `- ${entry.label} — ${entry.summary}.${accounts}`;
    }),
    "Use search_integration_tools to get tool definitions, then call_integration_tool to run one.",
  ]);
}

export const OPENCOMPANY_CHAT_INTEGRATION_TOOLS_BEHAVIOR_LINES = [
  "To read data from a connected integration listed in the integrations block, first call search_integration_tools with what you need, for example 'linear issues assigned to me' or 'unread email'. It returns full tool definitions. Then call call_integration_tool with the exact tool name and arguments matching its schema.",
  "Never invent integration tool names or arguments; use only definitions returned by search_integration_tools.",
  "Integration tools are read-only in chat. For writes — creating issues, sending messages or email — start a task instead.",
  "Gmail tools require the account argument; use a connected account email from the integrations block.",
  "If an integration tool reports a permission or connection problem, relay its message briefly and point the user to Settings → Integrations.",
] as const;

// Swapped in for the base "Requests to check … are task requests." line when
// integration tools are active: connected providers are read in chat, only
// the rest still routes to tasks.
export const OPENCOMPANY_CHAT_CONNECTED_ACCOUNT_TASK_LINE_WITH_INTEGRATIONS =
  "Requests to check, read, summarize, triage, or monitor connected accounts are task requests, except reads covered by the integrations block above — handle those directly in chat with the integration tools.";
