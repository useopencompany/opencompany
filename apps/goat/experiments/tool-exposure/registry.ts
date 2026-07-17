import type {
  JsonSchema,
  JsonSchemaProperty,
  MockIntegration,
  MockToolDefinition,
  ToolPointer,
} from "./types";

type FieldSpec = [
  name: string,
  description: string,
  required?: boolean,
  type?: JsonSchemaProperty["type"],
];
type ToolSpec = [name: string, description: string, fields: FieldSpec[]];

const commonConventions = [
  "IDs are opaque strings returned by lookup tools; do not invent them when a lookup is available.",
  "Omit optional fields instead of sending null.",
];

function makeSchema(fields: FieldSpec[]): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const [name, description, isRequired = true, type = "string"] of fields) {
    properties[name] = {
      type,
      description,
      ...(type === "array" ? { items: { type: "string" as const } } : {}),
      ...(type === "object" ? { additionalProperties: true } : {}),
    };
    if (isRequired) required.push(name);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function exampleValue(name: string, type: JsonSchemaProperty["type"]): unknown {
  if (type === "array") return ["example"];
  if (type === "object") return { key: "value" };
  if (type === "boolean") return true;
  if (type === "integer" || type === "number") return 10;
  if (name.includes("email")) return "ada@example.com";
  if (name.includes("channel")) return "C012345";
  if (name.includes("team")) return "ENG";
  if (name.includes("owner")) return "usr_123";
  if (name.endsWith("Id") || name === "id") return `${name.replace(/Id$/, "")}_123`;
  if (name.includes("url")) return "https://example.com/resource";
  if (name.includes("title")) return "Example title";
  if (name.includes("query")) return "example query";
  return "example";
}

function makeTool([name, shortDescription, fields]: ToolSpec): MockToolDefinition {
  return {
    name,
    shortDescription,
    inputSchema: makeSchema(fields),
    example: Object.fromEntries(
      fields
        .filter(([, , required = true]) => required)
        .map(([fieldName, , , type = "string"]) => [fieldName, exampleValue(fieldName, type)]),
    ),
    conventions: commonConventions,
  };
}

function integration(
  input: Omit<MockIntegration, "pointer" | "tools"> & { tools: ToolSpec[] },
): MockIntegration {
  return {
    ...input,
    pointer: `integration://${input.id}`,
    tools: input.tools.map(makeTool),
  };
}

const linear = integration({
  id: "linear",
  name: "Linear",
  summary: "Manage engineering issues, projects, cycles, teams, labels, and comments.",
  curatedToolNames: ["search_issues", "get_issue", "create_issue", "update_issue"],
  triggerPatterns: [
    { label: "explicit integration mention", regex: /\blinear\b/i },
    { label: "issue vocabulary", regex: /\b(?:issue|issues|ticket|tickets|bug|bugs)\b/i },
    { label: "planning vocabulary", regex: /\b(?:cycle|cycles|sprint|project backlog)\b/i },
    { label: "Linear issue identifier", regex: /\b[A-Z]{2,8}-\d+\b/ },
  ],
  tools: [
    [
      "search_issues",
      "Search issues by text and optional team or status.",
      [
        ["query", "Text to search for."],
        ["teamKey", "Optional team key.", false],
        ["status", "Optional status name.", false],
      ],
    ],
    ["get_issue", "Get one issue by identifier.", [["issueId", "Issue ID or human identifier."]]],
    [
      "create_issue",
      "Create an issue in a team.",
      [
        ["teamKey", "Owning team key."],
        ["title", "Issue title."],
        ["description", "Markdown description.", false],
        ["priority", "Priority from 0 to 4.", false, "integer"],
      ],
    ],
    [
      "update_issue",
      "Update fields on an existing issue.",
      [
        ["issueId", "Issue ID."],
        ["title", "Replacement title.", false],
        ["status", "Replacement status.", false],
        ["assigneeId", "Replacement assignee ID.", false],
      ],
    ],
    [
      "list_issues",
      "List issues using structured filters.",
      [
        ["teamKey", "Optional team key.", false],
        ["status", "Optional status.", false],
        ["limit", "Maximum results.", false, "integer"],
      ],
    ],
    ["list_projects", "List accessible projects.", [["teamKey", "Optional team key.", false]]],
    ["get_project", "Get a project by ID.", [["projectId", "Project ID."]]],
    [
      "create_project",
      "Create a project for one or more teams.",
      [
        ["name", "Project name."],
        ["teamIds", "Owning team IDs.", true, "array"],
        ["summary", "Short project summary.", false],
      ],
    ],
    ["list_teams", "List accessible teams.", [["query", "Optional name filter.", false]]],
    ["get_team", "Get a team by ID or key.", [["teamId", "Team ID or key."]]],
    [
      "add_comment",
      "Add a comment to an issue.",
      [
        ["issueId", "Issue ID."],
        ["body", "Markdown comment body."],
      ],
    ],
    ["list_comments", "List comments on an issue.", [["issueId", "Issue ID."]]],
    [
      "create_label",
      "Create an issue label.",
      [
        ["teamId", "Team ID."],
        ["name", "Label name."],
        ["color", "Hex color.", false],
      ],
    ],
    ["list_labels", "List issue labels.", [["teamId", "Optional team ID.", false]]],
    [
      "assign_issue",
      "Assign an issue to a user.",
      [
        ["issueId", "Issue ID."],
        ["assigneeId", "User ID."],
      ],
    ],
    ["archive_issue", "Archive an issue.", [["issueId", "Issue ID."]]],
    [
      "list_cycles",
      "List cycles for a team.",
      [
        ["teamId", "Team ID."],
        ["status", "Optional cycle status.", false],
      ],
    ],
    ["get_cycle", "Get a cycle by ID.", [["cycleId", "Cycle ID."]]],
    [
      "create_relation",
      "Create a relationship between two issues.",
      [
        ["issueId", "Source issue ID."],
        ["relatedIssueId", "Target issue ID."],
        ["relationType", "blocks, blocked_by, duplicate, or related."],
      ],
    ],
    ["list_users", "List workspace users.", [["query", "Optional name or email filter.", false]]],
  ],
});

const attio = integration({
  id: "attio",
  name: "Attio",
  summary: "Manage CRM companies, people, deals, lists, notes, tasks, and custom records.",
  curatedToolNames: ["search_records", "get_record", "create_record", "update_record"],
  triggerPatterns: [
    { label: "explicit integration mention", regex: /\battio\b/i },
    {
      label: "CRM vocabulary",
      regex: /\b(?:crm|pipeline|deal|deals|account|accounts|contact|contacts)\b/i,
    },
    { label: "customer company vocabulary", regex: /\b(?:customer company|prospect company)\b/i },
  ],
  tools: [
    [
      "search_records",
      "Search records in an Attio object.",
      [
        ["object", "Object slug such as companies or people."],
        ["query", "Search text."],
      ],
    ],
    [
      "get_record",
      "Get one record by object and record ID.",
      [
        ["object", "Object slug."],
        ["recordId", "Record ID."],
      ],
    ],
    [
      "create_record",
      "Create a record in an object.",
      [
        ["object", "Object slug."],
        ["values", "Attribute values keyed by slug.", true, "object"],
      ],
    ],
    [
      "update_record",
      "Update attributes on an existing record.",
      [
        ["object", "Object slug."],
        ["recordId", "Record ID."],
        ["values", "Changed attribute values.", true, "object"],
      ],
    ],
    [
      "list_objects",
      "List CRM object definitions.",
      [["limit", "Maximum results.", false, "integer"]],
    ],
    ["list_attributes", "List attributes for an object.", [["object", "Object slug."]]],
    [
      "create_attribute",
      "Create a custom attribute.",
      [
        ["object", "Object slug."],
        ["title", "Attribute title."],
        ["type", "Attio attribute type."],
      ],
    ],
    ["list_lists", "List Attio lists.", [["query", "Optional title filter.", false]]],
    [
      "add_record_to_list",
      "Add a record to a list.",
      [
        ["listId", "List ID."],
        ["recordId", "Record ID."],
      ],
    ],
    [
      "remove_record_from_list",
      "Remove a record from a list.",
      [
        ["listId", "List ID."],
        ["recordId", "Record ID."],
      ],
    ],
    [
      "list_entries",
      "List entries in an Attio list.",
      [
        ["listId", "List ID."],
        ["limit", "Maximum results.", false, "integer"],
      ],
    ],
    [
      "create_entry",
      "Create a list entry.",
      [
        ["listId", "List ID."],
        ["recordId", "Parent record ID."],
        ["values", "Entry attribute values.", false, "object"],
      ],
    ],
    [
      "update_entry",
      "Update a list entry.",
      [
        ["listId", "List ID."],
        ["entryId", "Entry ID."],
        ["values", "Changed entry values.", true, "object"],
      ],
    ],
    [
      "delete_entry",
      "Delete a list entry.",
      [
        ["listId", "List ID."],
        ["entryId", "Entry ID."],
      ],
    ],
    ["list_notes", "List notes attached to a record.", [["recordId", "Record ID."]]],
    [
      "create_note",
      "Create a note on a record.",
      [
        ["recordId", "Record ID."],
        ["title", "Note title."],
        ["content", "Plain-text note content."],
      ],
    ],
    [
      "list_tasks",
      "List CRM tasks.",
      [
        ["assigneeId", "Optional assignee ID.", false],
        ["isCompleted", "Optional completion filter.", false, "boolean"],
      ],
    ],
    [
      "create_task",
      "Create a CRM follow-up task.",
      [
        ["content", "Task content."],
        ["deadline", "ISO-8601 deadline.", false],
        ["recordId", "Related record ID.", false],
      ],
    ],
    [
      "update_task",
      "Update a CRM task.",
      [
        ["taskId", "Task ID."],
        ["isCompleted", "Completion state.", false, "boolean"],
        ["deadline", "ISO-8601 deadline.", false],
      ],
    ],
    [
      "list_users",
      "List Attio workspace members.",
      [["query", "Optional name or email filter.", false]],
    ],
  ],
});

const slack = integration({
  id: "slack",
  name: "Slack",
  summary:
    "Search conversations and manage channels, messages, threads, reactions, files, and canvases.",
  curatedToolNames: ["search_messages", "fetch_thread", "send_message", "reply_to_thread"],
  triggerPatterns: [
    { label: "explicit integration mention", regex: /\bslack\b/i },
    { label: "channel mention", regex: /#[a-z][\w-]*/i },
    {
      label: "messaging vocabulary",
      regex: /\b(?:channel|thread|message|notify|direct message|dm|emoji|reaction)\b/i,
    },
  ],
  tools: [
    [
      "search_messages",
      "Search messages across accessible conversations.",
      [
        ["query", "Slack search query."],
        ["limit", "Maximum matches.", false, "integer"],
      ],
    ],
    [
      "fetch_thread",
      "Fetch a root message and all thread replies.",
      [
        ["channelId", "Channel ID."],
        ["threadTs", "Root message timestamp."],
      ],
    ],
    [
      "send_message",
      "Send a message to a channel or DM.",
      [
        ["channel", "Channel ID or resolvable #name."],
        ["text", "Message text using Slack mrkdwn."],
      ],
    ],
    [
      "reply_to_thread",
      "Reply in an existing thread.",
      [
        ["channelId", "Channel ID."],
        ["threadTs", "Root message timestamp."],
        ["text", "Reply text."],
      ],
    ],
    [
      "list_channels",
      "List accessible channels.",
      [
        ["query", "Optional name filter.", false],
        ["includeArchived", "Include archived channels.", false, "boolean"],
      ],
    ],
    ["get_channel", "Get channel metadata.", [["channelId", "Channel ID."]]],
    ["list_users", "List workspace users.", [["query", "Optional name or email filter.", false]]],
    ["get_user", "Get a user profile.", [["userId", "User ID."]]],
    [
      "add_reaction",
      "Add an emoji reaction to a message.",
      [
        ["channelId", "Channel ID."],
        ["timestamp", "Message timestamp."],
        ["emoji", "Emoji name without colons."],
      ],
    ],
    [
      "remove_reaction",
      "Remove an emoji reaction from a message.",
      [
        ["channelId", "Channel ID."],
        ["timestamp", "Message timestamp."],
        ["emoji", "Emoji name without colons."],
      ],
    ],
    [
      "schedule_message",
      "Schedule a message for later delivery.",
      [
        ["channel", "Channel ID."],
        ["text", "Message text."],
        ["postAt", "Unix timestamp.", true, "integer"],
      ],
    ],
    ["list_scheduled", "List scheduled messages.", [["channelId", "Optional channel ID.", false]]],
    [
      "cancel_scheduled",
      "Cancel a scheduled message.",
      [
        ["channelId", "Channel ID."],
        ["scheduledMessageId", "Scheduled message ID."],
      ],
    ],
    [
      "upload_file",
      "Upload a file to a conversation.",
      [
        ["channelId", "Channel ID."],
        ["filename", "Filename."],
        ["content", "Text content for the mock upload."],
      ],
    ],
    [
      "list_files",
      "List shared files.",
      [
        ["channelId", "Optional channel ID.", false],
        ["query", "Optional filename filter.", false],
      ],
    ],
    [
      "create_canvas",
      "Create a Slack canvas.",
      [
        ["title", "Canvas title."],
        ["markdown", "Initial canvas content."],
      ],
    ],
    [
      "update_canvas",
      "Replace canvas content.",
      [
        ["canvasId", "Canvas ID."],
        ["markdown", "Replacement content."],
      ],
    ],
    [
      "set_topic",
      "Set a channel topic.",
      [
        ["channelId", "Channel ID."],
        ["topic", "New topic."],
      ],
    ],
    [
      "open_dm",
      "Open or retrieve a direct-message conversation.",
      [["userIds", "One or more user IDs.", true, "array"]],
    ],
    ["list_bookmarks", "List channel bookmarks.", [["channelId", "Channel ID."]]],
  ],
});

const github = integration({
  id: "github",
  name: "GitHub",
  summary:
    "Manage repositories, code, issues, pull requests, reviews, commits, branches, and Actions.",
  curatedToolNames: ["search_issues", "get_issue", "get_pull_request", "create_review"],
  triggerPatterns: [
    { label: "explicit integration mention", regex: /\bgithub\b/i },
    {
      label: "source-control vocabulary",
      regex: /\b(?:repository|repo|pull request|commit|branch|workflow)\b/i,
    },
    { label: "pull-request identifier", regex: /\bPR\s*#?\d+\b/i },
  ],
  tools: [
    [
      "search_issues",
      "Search repository issues and pull requests.",
      [
        ["query", "GitHub search query."],
        ["owner", "Optional repository owner.", false],
        ["repo", "Optional repository name.", false],
      ],
    ],
    [
      "get_issue",
      "Get a repository issue.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["issueNumber", "Issue number.", true, "integer"],
      ],
    ],
    [
      "create_issue",
      "Create a repository issue.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["title", "Issue title."],
        ["body", "Markdown body.", false],
      ],
    ],
    [
      "update_issue",
      "Update a repository issue.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["issueNumber", "Issue number.", true, "integer"],
        ["state", "open or closed.", false],
      ],
    ],
    [
      "list_pull_requests",
      "List pull requests in a repository.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["state", "open, closed, or all.", false],
      ],
    ],
    [
      "get_pull_request",
      "Get pull-request metadata and changed files.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["pullNumber", "Pull-request number.", true, "integer"],
      ],
    ],
    [
      "create_pull_request",
      "Open a pull request.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["title", "Pull-request title."],
        ["head", "Head branch."],
        ["base", "Base branch."],
        ["body", "Markdown body.", false],
      ],
    ],
    [
      "merge_pull_request",
      "Merge a pull request.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["pullNumber", "Pull-request number.", true, "integer"],
        ["method", "merge, squash, or rebase.", false],
      ],
    ],
    [
      "list_reviews",
      "List reviews on a pull request.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["pullNumber", "Pull-request number.", true, "integer"],
      ],
    ],
    [
      "create_review",
      "Submit a pull-request review.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["pullNumber", "Pull-request number.", true, "integer"],
        ["event", "APPROVE, REQUEST_CHANGES, or COMMENT."],
        ["body", "Review body.", false],
      ],
    ],
    [
      "list_commits",
      "List repository commits.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["sha", "Optional branch or SHA.", false],
      ],
    ],
    [
      "get_commit",
      "Get one commit.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["ref", "Commit SHA or ref."],
      ],
    ],
    [
      "compare_commits",
      "Compare two commits or tags.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["base", "Base ref."],
        ["head", "Head ref."],
      ],
    ],
    [
      "list_branches",
      "List repository branches.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
      ],
    ],
    [
      "create_branch",
      "Create a branch from a ref.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["branch", "New branch name."],
        ["fromRef", "Source SHA or ref."],
      ],
    ],
    [
      "get_file",
      "Read a repository file.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["path", "Repository-relative path."],
        ["ref", "Optional branch or SHA.", false],
      ],
    ],
    [
      "update_file",
      "Create or update a repository file.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["path", "Repository-relative path."],
        ["content", "UTF-8 file content."],
        ["message", "Commit message."],
        ["branch", "Target branch."],
      ],
    ],
    ["search_code", "Search code across repositories.", [["query", "GitHub code search query."]]],
    [
      "list_actions_runs",
      "List GitHub Actions workflow runs.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["status", "Optional run status.", false],
      ],
    ],
    [
      "rerun_workflow",
      "Rerun a GitHub Actions run.",
      [
        ["owner", "Repository owner."],
        ["repo", "Repository name."],
        ["runId", "Workflow run ID."],
      ],
    ],
  ],
});

const notion = integration({
  id: "notion",
  name: "Notion",
  summary:
    "Search and manage workspace pages, databases, blocks, comments, templates, and data sources.",
  curatedToolNames: ["search", "fetch_page", "create_page", "update_page"],
  triggerPatterns: [
    { label: "explicit integration mention", regex: /\bnotion\b/i },
    {
      label: "workspace-document vocabulary",
      regex: /\b(?:wiki|workspace page|decision log|notion page)\b/i,
    },
    { label: "database vocabulary", regex: /\b(?:notion database|knowledge base)\b/i },
  ],
  tools: [
    [
      "search",
      "Search workspace pages and data sources.",
      [
        ["query", "Text to search for."],
        ["filter", "Optional page or data_source filter.", false],
      ],
    ],
    ["fetch_page", "Fetch a page and its properties.", [["pageId", "Page ID."]]],
    [
      "create_page",
      "Create a page under a page or data source.",
      [
        ["parentId", "Parent page or data-source ID."],
        ["title", "Page title."],
        ["markdown", "Initial Markdown content.", false],
      ],
    ],
    [
      "update_page",
      "Update page properties.",
      [
        ["pageId", "Page ID."],
        ["properties", "Properties keyed by name.", true, "object"],
      ],
    ],
    ["archive_page", "Archive a page.", [["pageId", "Page ID."]]],
    [
      "query_database",
      "Query a database with filters and sorts.",
      [
        ["databaseId", "Database ID."],
        ["filter", "Optional filter object.", false, "object"],
        ["sorts", "Optional sort objects.", false, "array"],
      ],
    ],
    [
      "create_database",
      "Create a database under a page.",
      [
        ["parentPageId", "Parent page ID."],
        ["title", "Database title."],
        ["properties", "Property schema.", true, "object"],
      ],
    ],
    [
      "update_database",
      "Update database title or properties.",
      [
        ["databaseId", "Database ID."],
        ["title", "Replacement title.", false],
        ["properties", "Changed property schema.", false, "object"],
      ],
    ],
    ["list_users", "List workspace users.", [["limit", "Maximum results.", false, "integer"]]],
    ["get_user", "Get a workspace user.", [["userId", "User ID."]]],
    [
      "append_blocks",
      "Append blocks to a page or block.",
      [
        ["blockId", "Parent block or page ID."],
        ["blocks", "Block payloads.", true, "array"],
      ],
    ],
    [
      "fetch_block_children",
      "Fetch child blocks.",
      [
        ["blockId", "Block ID."],
        ["limit", "Maximum results.", false, "integer"],
      ],
    ],
    [
      "update_block",
      "Update a block's content.",
      [
        ["blockId", "Block ID."],
        ["content", "Changed block data.", true, "object"],
      ],
    ],
    ["delete_block", "Archive a block.", [["blockId", "Block ID."]]],
    ["retrieve_comments", "List comments on a page or block.", [["blockId", "Page or block ID."]]],
    [
      "create_comment",
      "Create a comment on a page.",
      [
        ["pageId", "Page ID."],
        ["text", "Comment text."],
      ],
    ],
    ["list_templates", "List database templates.", [["databaseId", "Database ID."]]],
    [
      "duplicate_page",
      "Duplicate a page beneath another page.",
      [
        ["pageId", "Source page ID."],
        ["parentId", "Destination parent page ID."],
        ["title", "Optional copy title.", false],
      ],
    ],
    [
      "move_page",
      "Move a page to a new parent.",
      [
        ["pageId", "Page ID."],
        ["parentId", "New parent ID."],
      ],
    ],
    ["list_data_sources", "List data sources in a database.", [["databaseId", "Database ID."]]],
  ],
});

export const BASE_INTEGRATIONS: readonly MockIntegration[] = [linear, attio, slack, github, notion];

export function toolPointer(integrationId: string, toolName: string): ToolPointer {
  return { integrationId, toolName, pointer: `tool://${integrationId}/${toolName}` };
}

export function resolveTool(
  integrations: readonly MockIntegration[],
  integrationId: string,
  toolName: string,
): MockToolDefinition | undefined {
  return integrations
    .find((item) => item.id === integrationId)
    ?.tools.find((tool) => tool.name === toolName);
}

export function registryToolCount(integrations: readonly MockIntegration[]): number {
  return integrations.reduce((total, item) => total + item.tools.length, 0);
}

export function createScaledRegistry(integrationCount: number): MockIntegration[] {
  if (!Number.isInteger(integrationCount) || integrationCount < 1) {
    throw new Error("integrationCount must be a positive integer.");
  }
  if (integrationCount <= BASE_INTEGRATIONS.length)
    return BASE_INTEGRATIONS.slice(0, integrationCount);

  const integrations = [...BASE_INTEGRATIONS];
  for (let index = BASE_INTEGRATIONS.length; index < integrationCount; index += 1) {
    const source = BASE_INTEGRATIONS[index % BASE_INTEGRATIONS.length]!;
    const ordinal = index + 1;
    const id = `synthetic_${source.id}_${ordinal}`;
    integrations.push({
      ...source,
      id,
      name: `Synthetic ${source.name} ${ordinal}`,
      summary: `Synthetic distractor ${ordinal}: ${source.summary}`,
      pointer: `integration://${id}`,
      triggerPatterns: [],
      synthetic: true,
    });
  }
  return integrations;
}
