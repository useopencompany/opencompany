import type { AdaptiveEvalTask } from "./eval-types";

function pointer(integrationId: string, toolName: string) {
  return `tool://${integrationId}/${toolName}`;
}

export const ADAPTIVE_EVAL_TASKS: readonly AdaptiveEvalTask[] = [
  {
    id: "slack-search-thread",
    category: "single",
    prompt:
      "Search Slack for 'pricing migration rollback' and fetch the full thread for the best match.",
    expectedToolPointers: [pointer("slack", "search_messages"), pointer("slack", "fetch_thread")],
    expectedIntegrationIds: ["slack"],
    notes: "Common two-step read with an opaque ID handoff.",
  },
  {
    id: "gmail-search-read",
    category: "single",
    prompt:
      "Find the latest Gmail message from ada@example.com about launch readiness and read the complete email.",
    expectedToolPointers: [pointer("gmail", "search_emails"), pointer("gmail", "get_email")],
    expectedIntegrationIds: ["gmail"],
    notes: "Common email lookup and fetch.",
  },
  {
    id: "linear-create-issue",
    category: "single",
    prompt:
      "Create a Linear issue in team ENG titled 'OAuth callback loses state' with priority 1.",
    expectedToolPointers: [pointer("linear", "create_issue")],
    expectedIntegrationIds: ["linear"],
    notes: "Single write with required structured arguments.",
  },
  {
    id: "github-review-pr",
    category: "single",
    prompt:
      "On GitHub, inspect pull request 77 in opencompany/goat and submit an APPROVE review saying 'Looks good'.",
    expectedToolPointers: [
      pointer("github", "get_pull_request"),
      pointer("github", "create_review"),
    ],
    expectedIntegrationIds: ["github"],
    notes: "Two-step source-control read and write.",
  },
  {
    id: "notion-create-page",
    category: "single",
    prompt:
      "Create a Notion page under parent pg_architecture titled 'Decision: adaptive tool exposure'.",
    expectedToolPointers: [pointer("notion", "create_page")],
    expectedIntegrationIds: ["notion"],
    notes: "Single document write.",
  },
  {
    id: "calendar-find-availability",
    category: "single",
    prompt: "Find a 30 minute opening with ada@example.com tomorrow afternoon.",
    expectedToolPointers: [pointer("calendar", "find_availability")],
    expectedIntegrationIds: ["calendar"],
    notes: "Calendar routing with an attendee email that should not activate Gmail.",
  },
  {
    id: "slack-schedule-message",
    category: "single",
    prompt: "Schedule a Slack message to #launch for tomorrow at 09:00 saying 'Standup moved'.",
    expectedToolPointers: [pointer("slack", "schedule_message")],
    expectedIntegrationIds: ["slack"],
    notes: "Less common communication operation.",
  },
  {
    id: "gmail-create-draft",
    category: "single",
    prompt:
      "Create a Gmail draft to ada@example.com titled 'Launch follow-up' with body 'Can we sync tomorrow?'. Do not send it.",
    expectedToolPointers: [pointer("gmail", "create_draft")],
    expectedIntegrationIds: ["gmail"],
    notes: "Write versus send disambiguation.",
  },
  {
    id: "gmail-to-slack",
    category: "multi",
    prompt:
      "Find the latest email from Ada about launch readiness, then post a concise summary to Slack #launch.",
    expectedToolPointers: [pointer("gmail", "search_emails"), pointer("slack", "send_message")],
    expectedIntegrationIds: ["gmail", "slack"],
    notes: "Two integrations with a data handoff.",
  },
  {
    id: "slack-to-linear",
    category: "multi",
    prompt:
      "Search Slack for 'mobile login loop', then create a Linear bug in team MOBILE using the findings.",
    expectedToolPointers: [pointer("slack", "search_messages"), pointer("linear", "create_issue")],
    expectedIntegrationIds: ["slack", "linear"],
    notes: "Cross-integration read and write.",
  },
  {
    id: "linear-and-github",
    category: "multi",
    prompt:
      "List open Linear issues for ENG and list open GitHub pull requests in opencompany/goat that might address them.",
    expectedToolPointers: [
      pointer("linear", "list_issues"),
      pointer("github", "list_pull_requests"),
    ],
    expectedIntegrationIds: ["linear", "github"],
    notes: "Parallel structured list operations that fixed curation previously missed.",
  },
  {
    id: "github-to-slack",
    category: "multi",
    prompt:
      "Get GitHub PR #77 from opencompany/goat, then send a concise status update to Slack #eng-release.",
    expectedToolPointers: [pointer("github", "get_pull_request"), pointer("slack", "send_message")],
    expectedIntegrationIds: ["github", "slack"],
    notes: "Cross-integration read and communication.",
  },
  {
    id: "notion-to-gmail",
    category: "multi",
    prompt: "Search Notion for 'Q3 launch plan', then email a concise summary to ada@example.com.",
    expectedToolPointers: [pointer("notion", "search"), pointer("gmail", "send_email")],
    expectedIntegrationIds: ["notion", "gmail"],
    notes: "Document retrieval followed by external communication.",
  },
  {
    id: "calendar-to-slack",
    category: "multi",
    prompt:
      "Find a 30 minute opening with ada@example.com tomorrow afternoon, create a Calendar event titled 'Launch review', then notify Slack #launch.",
    expectedToolPointers: [
      pointer("calendar", "find_availability"),
      pointer("calendar", "create_event"),
      pointer("slack", "send_message"),
    ],
    expectedIntegrationIds: ["calendar", "slack"],
    notes: "Three-step chain with two integrations.",
  },
  {
    id: "six-source-digest",
    category: "multi",
    prompt:
      "Build a delivery-risk digest: list open Linear issues for ENG, search Gmail for 'launch risk', search Slack for 'launch risk', list open GitHub pull requests in opencompany/goat, search Notion for 'Q3 launch', and list tomorrow's Calendar events.",
    expectedToolPointers: [
      pointer("linear", "list_issues"),
      pointer("gmail", "search_emails"),
      pointer("slack", "search_messages"),
      pointer("github", "list_pull_requests"),
      pointer("notion", "search"),
      pointer("calendar", "list_events"),
    ],
    expectedIntegrationIds: ["linear", "gmail", "slack", "github", "notion", "calendar"],
    notes: "Full-registry fan-out and clause association stress test.",
  },
  {
    id: "slack-add-reaction",
    category: "long_tail",
    prompt: "Add the eyes reaction to Slack message 1784282400.000100 in channel C_LAUNCH.",
    expectedToolPointers: [pointer("slack", "add_reaction")],
    expectedIntegrationIds: ["slack"],
    notes: "Long-tail write with timestamp punctuation.",
  },
  {
    id: "gmail-label-email",
    category: "long_tail",
    prompt: "Add the IMPORTANT label to Gmail message email_ada_launch.",
    expectedToolPointers: [pointer("gmail", "label_email")],
    expectedIntegrationIds: ["gmail"],
    notes: "Less common organization operation.",
  },
  {
    id: "linear-create-relation",
    category: "long_tail",
    prompt: "In Linear, make ENG-402 block ENG-417 by creating the appropriate issue relation.",
    expectedToolPointers: [pointer("linear", "create_relation")],
    expectedIntegrationIds: ["linear"],
    notes: "Less common relationship operation.",
  },
  {
    id: "github-compare-tags",
    category: "long_tail",
    prompt: "On GitHub compare tags v2.4.0 and v2.5.0 in opencompany/goat.",
    expectedToolPointers: [pointer("github", "compare_commits")],
    expectedIntegrationIds: ["github"],
    notes: "Less common repository read.",
  },
  {
    id: "notion-duplicate-page",
    category: "long_tail",
    prompt: "In Notion, duplicate page pg_launch beneath parent pg_q4 and title it 'Q4 Launch'.",
    expectedToolPointers: [pointer("notion", "duplicate_page")],
    expectedIntegrationIds: ["notion"],
    notes: "Less common page mutation.",
  },
  {
    id: "calendar-delete-event",
    category: "long_tail",
    prompt: "Delete Calendar event event_launch.",
    expectedToolPointers: [pointer("calendar", "delete_event")],
    expectedIntegrationIds: ["calendar"],
    notes: "Destructive operation disambiguation.",
  },
  {
    id: "implicit-slack-destination",
    category: "implicit",
    prompt:
      "Publish 'The migration is complete' to the announcements destination used by the company.",
    expectedToolPointers: [pointer("slack", "send_message")],
    expectedIntegrationIds: ["slack"],
    notes: "Deliberate deterministic trigger false negative; recovery must use Level 0.",
  },
  {
    id: "implicit-gmail-inbox",
    category: "implicit",
    prompt: "Find the newest note in my inbox from Ada about OAuth.",
    expectedToolPointers: [pointer("gmail", "search_emails")],
    expectedIntegrationIds: ["gmail"],
    notes: "Provider omitted but capability language present.",
  },
  {
    id: "no-tool-summary",
    category: "no_tool",
    prompt:
      "Summarize this sentence in five words: The launch is ready after the mobile fix lands.",
    expectedToolPointers: [],
    expectedIntegrationIds: [],
    notes: "Should answer without any integration call.",
  },
  {
    id: "no-tool-draft-copy",
    category: "no_tool",
    prompt:
      "Write sample email copy announcing the launch, but do not create a draft or send anything.",
    expectedToolPointers: [],
    expectedIntegrationIds: [],
    notes: "Gmail may be activated, but the model should respect the no-action instruction.",
  },
  {
    id: "no-tool-linear-math",
    category: "no_tool",
    prompt:
      "Explain the difference between linear and nonlinear growth without using any integrations.",
    expectedToolPointers: [],
    expectedIntegrationIds: [],
    notes: "Lexical false-positive trap for the Linear integration.",
  },
] as const;

export function selectAdaptiveEvalTasks(ids: readonly string[]) {
  if (ids.length === 0 || ids.includes("all")) return [...ADAPTIVE_EVAL_TASKS];
  const byId = new Map(ADAPTIVE_EVAL_TASKS.map((task) => [task.id, task]));
  return ids.map((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown adaptive evaluation task: ${id}`);
    return task;
  });
}
