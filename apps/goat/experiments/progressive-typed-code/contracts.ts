import { MOCK_TOOL_CATALOG } from "../code-tool-interface/catalog";
import type { JsonSchema, MockTool } from "../code-tool-interface/types";
import type { LoadedToolContract, ToolEffect } from "./types";

const OUTPUT_TYPES: Record<string, string> = {
  "linear.search_issues": "LinearIssue[]",
  "linear.list_issues": "LinearIssue[]",
  "linear.get_issue": "LinearIssue | null",
  "linear.create_issue": "LinearIssue",
  "attio.search_records": "AttioRecord[]",
  "attio.list_records": "AttioRecord[]",
  "attio.get_record": "AttioRecord | null",
  "slack.search_messages": "SlackMessage[]",
  "slack.fetch_thread": "SlackThread",
  "slack.list_channels": "SlackChannel[]",
  "slack.get_channel": "SlackChannel | null",
  "github.get_pull_request": "GitHubPullRequest | null",
  "github.list_pull_requests": "GitHubPullRequest[]",
  "notion.search": "NotionPage[]",
  "notion.search_pages": "NotionPage[]",
  "notion.get_page": "NotionPage | null",
};

const INPUT_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  "linear.create_issue": [
    {
      teamKey: "ENG",
      title: "OAuth callback loses state",
      description: "Reproduction notes in Markdown.",
      priority: 1,
    },
  ],
  "linear.list_issues": [{ teamKey: "ENG", status: "open" }],
  "linear.create_relation": [
    { issueId: "ENG-402", relatedIssueId: "ENG-417", relationType: "blocks" },
  ],
  "attio.search_records": [{ object: "companies", query: "Acme Robotics" }],
  "attio.update_record": [
    {
      object: "companies",
      recordId: "rec_123",
      values: { stage: "enterprise" },
    },
  ],
  "attio.add_record_to_list": [{ listId: "list_enterprise", recordId: "rec_acme" }],
  "slack.search_messages": [{ query: "pricing migration rollback" }],
  "slack.fetch_thread": [{ channelId: "CENG123", threadTs: "1712345678.000100" }],
  "slack.send_message": [{ channel: "#eng-release", text: "Deployment is complete." }],
  "slack.add_reaction": [{ channelId: "CENG123", timestamp: "1712345678.000100", emoji: "eyes" }],
  "github.get_pull_request": [{ owner: "opencompany", repo: "goat", pullNumber: 42 }],
  "github.list_pull_requests": [{ owner: "opencompany", repo: "goat", state: "open" }],
  "github.create_review": [
    {
      owner: "opencompany",
      repo: "goat",
      pullNumber: 42,
      event: "APPROVE",
      body: "Looks good",
    },
  ],
  "github.compare_commits": [
    { owner: "opencompany", repo: "goat", base: "v2.4.0", head: "v2.5.0" },
  ],
  "github.merge_pull_request": [
    { owner: "opencompany", repo: "goat", pullNumber: 91, method: "squash" },
  ],
  "notion.create_page": [
    {
      parentId: "pg_architecture",
      title: "Decision",
      markdown: "Concise rationale.",
    },
  ],
  "notion.search": [{ query: "Q3 launch" }],
  "notion.duplicate_page": [
    { pageId: "pg_launch_template", parentId: "pg_q4", title: "Q4 Launch" },
  ],
};

const SHARED_TYPES = `type ToolResult<T> = {
  ok: true;
  data: T;
  nextCursor: string | null;
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  project?: string;
  assignee?: string;
  url: string;
};

type AttioRecord = {
  id: string;
  object: string;
  name: string;
  domain?: string;
  stage?: string;
  renewalDate?: string | null;
  health?: string;
  owner?: string;
};

type SlackMessage = {
  channelId: string;
  threadTs: string;
  timestamp: string;
  user: string;
  text: string;
};

type SlackThread = {
  root: SlackMessage;
  replies: Array<{ user: string; text: string }>;
};

type SlackChannel = { id: string; name: string; topic?: string };

type GitHubPullRequest = {
  number: number;
  repository: string;
  title: string;
  state: string;
  mergeable: boolean;
  checks: string;
  reviewDecision: string;
  url: string;
};

type NotionPage = { id: string; title: string; content?: string; url: string };`;

export function contractFor(path: string): LoadedToolContract {
  const tool = MOCK_TOOL_CATALOG.find((candidate) => candidate.path === path);
  if (!tool) throw new Error(`Unknown tool contract: ${path}`);
  const effect = toolEffect(tool.operation);
  const inputTypeScript = schemaToTypeScript(tool.inputSchema);
  const outputDataType = OUTPUT_TYPES[path] ?? (effect === "write" ? "MutationResult" : "unknown");
  return {
    path,
    summary: tool.summary,
    effect,
    inputSchema: tool.inputSchema,
    inputTypeScript,
    outputTypeScript: `ToolResult<${outputDataType}>`,
    inputExamples: INPUT_EXAMPLES[path] ?? [],
  };
}

export function renderTypeScriptDefinitions(contracts: LoadedToolContract[]) {
  const needsMutationResult = contracts.some((contract) =>
    contract.outputTypeScript.includes("MutationResult"),
  );
  const lines = [SHARED_TYPES];
  if (needsMutationResult) {
    lines.push(
      "type MutationResult = { id?: string; updatedAt?: string; [key: string]: unknown };",
    );
  }
  lines.push("declare const tools: {");
  for (const contract of contracts) {
    const example = contract.inputExamples[0]
      ? ` Example input: ${JSON.stringify(contract.inputExamples[0])}`
      : "";
    lines.push(
      `  /** ${contract.summary} Effect: ${contract.effect}.${example} */`,
      `  ${JSON.stringify(contract.path)}: (input: ${contract.inputTypeScript}) => Promise<${contract.outputTypeScript}>;`,
    );
  }
  lines.push("};");
  return lines.join("\n");
}

export function toolEffect(operation: string): ToolEffect {
  // Fail closed: catalog operations are side effects unless their verb is an
  // explicitly read-only primitive. Production catalogs should carry this as
  // signed metadata rather than infer it from names.
  return /^(search|get|list|fetch|query|retrieve|compare)(_|$)/.test(operation) ? "read" : "write";
}

function schemaToTypeScript(schema: JsonSchema): string {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 1) {
    return types.map((type) => schemaToTypeScript({ ...schema, type })).join(" | ");
  }
  const type = types[0];
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return `Array<${schemaToTypeScript(schema.items ?? {})}>`;
  if (type === "object" || schema.properties) {
    const entries = Object.entries(schema.properties ?? {});
    if (entries.length === 0) return "Record<string, unknown>";
    const required = new Set(schema.required ?? []);
    const fields = entries.map(([name, field]) => {
      const comment = field.description ? `/** ${field.description} */ ` : "";
      return `${comment}${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaToTypeScript(field)}`;
    });
    const tail = schema.additionalProperties === false ? "" : "; [key: string]: unknown";
    return `{ ${fields.join("; ")}${tail} }`;
  }
  return "unknown";
}

export function findCatalogTool(path: string): MockTool | undefined {
  return MOCK_TOOL_CATALOG.find((tool) => tool.path === path);
}
