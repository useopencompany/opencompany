import { toolPointer } from "./registry";
import type { BenchmarkTask } from "./types";

export const BENCHMARK_TASKS: readonly BenchmarkTask[] = [
  {
    id: "linear-create-bug",
    category: "single",
    prompt:
      "Create a Linear issue in team ENG titled 'OAuth callback loses state' with priority 1 and a short reproduction note.",
    expectedTools: [toolPointer("linear", "create_issue")],
    expectedIntegrationIds: ["linear"],
    triggerShouldExpand: ["linear"],
    notes: "Common single-integration write using a curated tool.",
  },
  {
    id: "attio-update-account",
    category: "single",
    prompt:
      "In Attio, search company records for Acme Robotics, then update the matching company record's stage to enterprise.",
    expectedTools: [toolPointer("attio", "search_records"), toolPointer("attio", "update_record")],
    expectedIntegrationIds: ["attio"],
    triggerShouldExpand: ["attio"],
    notes: "Common two-step CRM lookup and mutation using curated tools.",
  },
  {
    id: "slack-find-thread",
    category: "single",
    prompt:
      "Search Slack messages for 'pricing migration rollback' and fetch the full thread for the best match.",
    expectedTools: [toolPointer("slack", "search_messages"), toolPointer("slack", "fetch_thread")],
    expectedIntegrationIds: ["slack"],
    triggerShouldExpand: ["slack"],
    notes: "Common two-step messaging read using curated tools.",
  },
  {
    id: "github-review-pr",
    category: "single",
    prompt:
      "On GitHub, inspect pull request 42 in opencompany/goat and submit an APPROVE review saying 'Looks good'.",
    expectedTools: [
      toolPointer("github", "get_pull_request"),
      toolPointer("github", "create_review"),
    ],
    expectedIntegrationIds: ["github"],
    triggerShouldExpand: ["github"],
    notes: "Common two-step source-control task using curated tools.",
  },
  {
    id: "notion-create-decision",
    category: "single",
    prompt:
      "Create a Notion page under parent page pg_architecture titled 'Decision: tiered tool exposure' with a concise rationale.",
    expectedTools: [toolPointer("notion", "create_page")],
    expectedIntegrationIds: ["notion"],
    triggerShouldExpand: ["notion"],
    notes: "Common single-integration document write using a curated tool.",
  },
  {
    id: "slack-to-linear",
    category: "multi",
    prompt:
      "Search Slack for 'mobile login loop', then create a Linear bug in team MOBILE using the findings in the description.",
    expectedTools: [toolPointer("slack", "search_messages"), toolPointer("linear", "create_issue")],
    expectedIntegrationIds: ["slack", "linear"],
    triggerShouldExpand: ["slack", "linear"],
    notes: "Two integrations with an explicit data handoff.",
  },
  {
    id: "github-to-slack",
    category: "multi",
    prompt:
      "Get GitHub PR #77 from opencompany/goat, then send a concise status update to Slack channel #eng-release.",
    expectedTools: [
      toolPointer("github", "get_pull_request"),
      toolPointer("slack", "send_message"),
    ],
    expectedIntegrationIds: ["github", "slack"],
    triggerShouldExpand: ["github", "slack"],
    notes: "Two integrations, both curated paths.",
  },
  {
    id: "crm-decision-announce",
    category: "multi",
    prompt:
      "Search Attio company records for Northstar, create a Notion page under pg_accounts summarizing the account, then notify Slack #sales.",
    expectedTools: [
      toolPointer("attio", "search_records"),
      toolPointer("notion", "create_page"),
      toolPointer("slack", "send_message"),
    ],
    expectedIntegrationIds: ["attio", "notion", "slack"],
    triggerShouldExpand: ["attio", "notion", "slack"],
    notes: "Three integrations with sequential dependencies.",
  },
  {
    id: "five-source-digest",
    category: "multi",
    prompt:
      "Build a quick delivery-risk digest: list open Linear issues for ENG, search Attio for the Acme account, search Slack for 'launch risk', list open GitHub pull requests in opencompany/goat, and search Notion for 'Q3 launch'.",
    expectedTools: [
      toolPointer("linear", "list_issues"),
      toolPointer("attio", "search_records"),
      toolPointer("slack", "search_messages"),
      toolPointer("github", "list_pull_requests"),
      toolPointer("notion", "search"),
    ],
    expectedIntegrationIds: ["linear", "attio", "slack", "github", "notion"],
    triggerShouldExpand: ["linear", "attio", "slack", "github", "notion"],
    notes: "Five-way fan-out; two requested tools are outside their curated Level-1 set.",
  },
  {
    id: "slack-add-reaction",
    category: "recovery",
    prompt:
      "Add the eyes emoji reaction to Slack message timestamp 1712345678.000100 in channel CENG123.",
    expectedTools: [toolPointer("slack", "add_reaction")],
    expectedIntegrationIds: ["slack"],
    triggerShouldExpand: ["slack"],
    notes: "Integration auto-expands, but the needed tool is outside the curated Level-1 set.",
  },
  {
    id: "github-compare-tags",
    category: "recovery",
    prompt: "On GitHub compare tags v2.4.0 and v2.5.0 in opencompany/goat.",
    expectedTools: [toolPointer("github", "compare_commits")],
    expectedIntegrationIds: ["github"],
    triggerShouldExpand: ["github"],
    notes: "Integration auto-expands, but the needed tool is outside the curated Level-1 set.",
  },
  {
    id: "linear-link-blocker",
    category: "recovery",
    prompt: "In Linear, make ENG-402 block ENG-417 by creating the appropriate issue relation.",
    expectedTools: [toolPointer("linear", "create_relation")],
    expectedIntegrationIds: ["linear"],
    triggerShouldExpand: ["linear"],
    notes: "Integration auto-expands, but the needed tool is outside the curated Level-1 set.",
  },
  {
    id: "notion-duplicate-page",
    category: "recovery",
    prompt:
      "In Notion, duplicate page pg_launch_template beneath parent pg_q4 and title the copy 'Q4 Launch'.",
    expectedTools: [toolPointer("notion", "duplicate_page")],
    expectedIntegrationIds: ["notion"],
    triggerShouldExpand: ["notion"],
    notes: "Integration auto-expands, but the needed tool is outside the curated Level-1 set.",
  },
  {
    id: "attio-add-to-list",
    category: "recovery",
    prompt: "In Attio, add record rec_acme to list list_enterprise.",
    expectedTools: [toolPointer("attio", "add_record_to_list")],
    expectedIntegrationIds: ["attio"],
    triggerShouldExpand: ["attio"],
    notes: "Integration auto-expands, but the needed tool is outside the curated Level-1 set.",
  },
  {
    id: "implicit-slack-broadcast",
    category: "recovery",
    prompt:
      "Broadcast 'The migration is complete' to our company chat destination called announcements.",
    expectedTools: [toolPointer("slack", "send_message")],
    expectedIntegrationIds: ["slack"],
    triggerShouldExpand: [],
    notes: "Deliberate keyword false negative; recovery requires using the Slack lossless pointer.",
  },
];

export const SCALE_TASKS: readonly BenchmarkTask[] = [
  BENCHMARK_TASKS[0]!,
  {
    id: "scale-linear-list",
    category: "single",
    prompt: "List the first 10 open Linear issues for team ENG.",
    expectedTools: [toolPointer("linear", "list_issues")],
    expectedIntegrationIds: ["linear"],
    triggerShouldExpand: ["linear"],
    notes: "Scaling probe using a non-curated read tool.",
  },
  BENCHMARK_TASKS[11]!,
];

export function selectTasks(ids: readonly string[]): BenchmarkTask[] {
  if (ids.length === 0 || ids.includes("all")) return [...BENCHMARK_TASKS];
  const byId = new Map(BENCHMARK_TASKS.map((task) => [task.id, task]));
  return ids.map((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown benchmark task: ${id}`);
    return task;
  });
}
