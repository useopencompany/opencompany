import type {
  AdaptiveIntegrationDefinition,
  AdaptiveSideEffect,
  AdaptiveToolDefinition,
} from "./types";

type Field = {
  name: string;
  description: string;
  type?: "string" | "integer" | "boolean" | "array" | "object";
  optional?: boolean;
};

type ToolSpec = {
  name: string;
  description: string;
  operations: string[];
  objects: string[];
  fields: Field[];
  sideEffect?: AdaptiveSideEffect;
  output: string;
  popularity?: number;
};

type IntegrationSpec = Omit<AdaptiveIntegrationDefinition, "pointer" | "tools"> & {
  tools: ToolSpec[];
};

function exampleValue(field: Field): unknown {
  if (field.type === "integer") return 10;
  if (field.type === "boolean") return true;
  if (field.type === "array") return ["example"];
  if (field.type === "object") return { key: "value" };
  if (field.name.toLowerCase().includes("email")) return "ada@example.com";
  if (field.name.toLowerCase().includes("channel")) return "#launch";
  if (field.name.toLowerCase().includes("query")) return "launch plan";
  if (field.name.toLowerCase().includes("title")) return "Launch follow-up";
  if (field.name.toLowerCase().includes("time")) return "2026-07-20T10:00:00+02:00";
  if (field.name.toLowerCase().includes("id")) return `${field.name.replace(/Id$/i, "")}_123`;
  return "example";
}

function makeTool(integrationId: string, spec: ToolSpec): AdaptiveToolDefinition {
  const properties = Object.fromEntries(
    spec.fields.map((field) => [
      field.name,
      {
        type: field.type ?? "string",
        description: field.description,
        ...(field.type === "array" ? { items: { type: "string" } } : {}),
        ...(field.type === "object" ? { additionalProperties: true } : {}),
      },
    ]),
  );
  const required = spec.fields.filter((field) => !field.optional).map((field) => field.name);
  return {
    name: spec.name,
    pointer: `tool://${integrationId}/${spec.name}`,
    description: spec.description,
    operationAliases: spec.operations,
    objectAliases: spec.objects,
    sideEffect: spec.sideEffect ?? "read",
    outputKind: spec.output,
    popularity: spec.popularity ?? 0.5,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    },
    example: Object.fromEntries(
      spec.fields
        .filter((field) => !field.optional)
        .map((field) => [field.name, exampleValue(field)]),
    ),
  };
}

function makeIntegration(spec: IntegrationSpec): AdaptiveIntegrationDefinition {
  return {
    ...spec,
    pointer: `integration://${spec.id}`,
    tools: spec.tools.map((tool) => makeTool(spec.id, tool)),
  };
}

const slack = makeIntegration({
  id: "slack",
  name: "Slack",
  summary: "Search conversations and manage channels, messages, threads, reactions, and files.",
  aliases: ["slack", "company chat", "team chat"],
  keywords: ["channel", "message", "thread", "emoji", "reaction", "notify", "broadcast", "dm"],
  tools: [
    {
      name: "search_messages",
      description: "Search messages across Slack conversations.",
      operations: ["search", "find", "look up"],
      objects: ["message", "messages", "conversation", "slack"],
      fields: [
        { name: "query", description: "Slack search query." },
        { name: "limit", description: "Maximum matches.", type: "integer", optional: true },
      ],
      output: "SlackMessage[]",
      popularity: 0.95,
    },
    {
      name: "fetch_thread",
      description: "Fetch a root message and all replies in its thread.",
      operations: ["fetch", "get", "read"],
      objects: ["thread", "replies"],
      fields: [
        { name: "channelId", description: "Channel ID." },
        { name: "threadTs", description: "Root message timestamp." },
      ],
      output: "SlackThread",
      popularity: 0.8,
    },
    {
      name: "list_channels",
      description: "List or resolve Slack channels by name.",
      operations: ["list", "find", "resolve"],
      objects: ["channel", "channels"],
      fields: [{ name: "query", description: "Optional channel-name filter.", optional: true }],
      output: "SlackChannel[]",
      popularity: 0.65,
    },
    {
      name: "send_message",
      description: "Send a message to a Slack channel or direct message.",
      operations: ["send", "post", "notify", "broadcast", "tell"],
      objects: ["message", "slack", "channel", "update"],
      fields: [
        { name: "channel", description: "Channel ID or #name." },
        { name: "text", description: "Message text." },
      ],
      sideEffect: "external_communication",
      output: "SentSlackMessage",
      popularity: 1,
    },
    {
      name: "add_reaction",
      description: "Add an emoji reaction to a Slack message.",
      operations: ["add", "react", "mark"],
      objects: ["reaction", "emoji", "message"],
      fields: [
        { name: "channelId", description: "Channel ID." },
        { name: "timestamp", description: "Message timestamp." },
        { name: "emoji", description: "Emoji name without colons." },
      ],
      sideEffect: "write",
      output: "Reaction",
    },
    {
      name: "schedule_message",
      description: "Schedule a Slack message for later delivery.",
      operations: ["schedule", "queue"],
      objects: ["message", "announcement"],
      fields: [
        { name: "channel", description: "Channel ID or #name." },
        { name: "text", description: "Message text." },
        { name: "postAt", description: "ISO-8601 delivery time." },
      ],
      sideEffect: "external_communication",
      output: "ScheduledSlackMessage",
    },
    {
      name: "list_users",
      description: "List or search Slack workspace members.",
      operations: ["list", "find", "search"],
      objects: ["user", "users", "person", "teammate"],
      fields: [{ name: "query", description: "Optional name or email filter.", optional: true }],
      output: "SlackUser[]",
    },
    {
      name: "upload_file",
      description: "Upload a simulated file to a Slack conversation.",
      operations: ["upload", "share", "attach"],
      objects: ["file", "document"],
      fields: [
        { name: "channel", description: "Channel ID or #name." },
        { name: "filename", description: "Filename." },
        { name: "content", description: "Mock text content." },
      ],
      sideEffect: "external_communication",
      output: "SlackFile",
    },
  ],
});

const gmail = makeIntegration({
  id: "gmail",
  name: "Gmail",
  summary: "Search, read, draft, send, reply to, and organize email and threads.",
  aliases: ["gmail", "email", "mail", "inbox"],
  keywords: ["email", "mail", "inbox", "sender", "subject", "draft", "reply"],
  tools: [
    {
      name: "search_emails",
      description: "Search Gmail messages using Gmail query syntax.",
      operations: ["search", "find", "look up"],
      objects: ["email", "emails", "mail", "message", "inbox"],
      fields: [
        { name: "query", description: "Gmail search query." },
        { name: "limit", description: "Maximum results.", type: "integer", optional: true },
      ],
      output: "EmailSummary[]",
      popularity: 1,
    },
    {
      name: "get_email",
      description: "Read a complete Gmail message by ID.",
      operations: ["get", "read", "fetch", "open"],
      objects: ["email", "message"],
      fields: [{ name: "emailId", description: "Gmail message ID." }],
      output: "Email",
      popularity: 0.85,
    },
    {
      name: "list_threads",
      description: "List Gmail threads matching a query.",
      operations: ["list", "search", "find"],
      objects: ["thread", "threads", "conversation"],
      fields: [{ name: "query", description: "Optional Gmail query.", optional: true }],
      output: "EmailThreadSummary[]",
    },
    {
      name: "get_thread",
      description: "Read every message in a Gmail thread.",
      operations: ["get", "read", "fetch"],
      objects: ["thread", "conversation"],
      fields: [{ name: "threadId", description: "Gmail thread ID." }],
      output: "EmailThread",
    },
    {
      name: "create_draft",
      description: "Create an email draft without sending it.",
      operations: ["draft", "prepare", "write"],
      objects: ["email", "mail", "message"],
      fields: [
        { name: "to", description: "Recipient email addresses.", type: "array" },
        { name: "subject", description: "Email subject." },
        { name: "body", description: "Email body." },
      ],
      sideEffect: "write",
      output: "EmailDraft",
      popularity: 0.75,
    },
    {
      name: "send_email",
      description: "Send a new email through Gmail.",
      operations: ["send", "deliver"],
      objects: ["email", "mail", "message"],
      fields: [
        { name: "to", description: "Recipient email addresses.", type: "array" },
        { name: "subject", description: "Email subject." },
        { name: "body", description: "Email body." },
      ],
      sideEffect: "external_communication",
      output: "SentEmail",
      popularity: 0.95,
    },
    {
      name: "reply_to_email",
      description: "Reply to an existing Gmail message or thread.",
      operations: ["reply", "respond", "answer"],
      objects: ["email", "message", "thread"],
      fields: [
        { name: "emailId", description: "Message ID to reply to." },
        { name: "body", description: "Reply body." },
      ],
      sideEffect: "external_communication",
      output: "SentEmail",
    },
    {
      name: "label_email",
      description: "Add or remove labels on an email message.",
      operations: ["label", "organize", "archive", "mark"],
      objects: ["email", "message", "label"],
      fields: [
        { name: "emailId", description: "Gmail message ID." },
        { name: "addLabels", description: "Labels to add.", type: "array", optional: true },
        { name: "removeLabels", description: "Labels to remove.", type: "array", optional: true },
      ],
      sideEffect: "write",
      output: "EmailLabels",
    },
  ],
});

const linear = makeIntegration({
  id: "linear",
  name: "Linear",
  summary: "Manage engineering issues, projects, teams, cycles, comments, and relationships.",
  aliases: ["linear", "issue tracker", "engineering tracker"],
  keywords: ["issue", "ticket", "bug", "cycle", "sprint", "backlog", "project"],
  tools: [
    {
      name: "search_issues",
      description: "Search Linear issues by free text.",
      operations: ["search", "find", "look up"],
      objects: ["issue", "issues", "ticket", "bug"],
      fields: [
        { name: "query", description: "Text search query." },
        { name: "teamKey", description: "Optional team key.", optional: true },
      ],
      output: "LinearIssue[]",
      popularity: 0.9,
    },
    {
      name: "list_issues",
      description: "List Linear issues with structured team and status filters.",
      operations: ["list", "show", "enumerate"],
      objects: ["issue", "issues", "ticket", "backlog"],
      fields: [
        { name: "teamKey", description: "Optional team key.", optional: true },
        { name: "status", description: "Optional status.", optional: true },
        { name: "limit", description: "Maximum results.", type: "integer", optional: true },
      ],
      output: "LinearIssue[]",
      popularity: 0.8,
    },
    {
      name: "get_issue",
      description: "Get a Linear issue by ID or human identifier.",
      operations: ["get", "read", "fetch", "inspect"],
      objects: ["issue", "ticket", "bug"],
      fields: [{ name: "issueId", description: "Issue ID or identifier such as ENG-42." }],
      output: "LinearIssue",
      popularity: 0.85,
    },
    {
      name: "create_issue",
      description: "Create a new Linear issue in a team.",
      operations: ["create", "open", "file", "add"],
      objects: ["issue", "ticket", "bug"],
      fields: [
        { name: "teamKey", description: "Owning team key." },
        { name: "title", description: "Issue title." },
        { name: "description", description: "Markdown description.", optional: true },
        { name: "priority", description: "Priority from 0 to 4.", type: "integer", optional: true },
      ],
      sideEffect: "write",
      output: "LinearIssue",
      popularity: 1,
    },
    {
      name: "update_issue",
      description: "Update fields on an existing Linear issue.",
      operations: ["update", "edit", "change", "move", "assign"],
      objects: ["issue", "ticket", "bug", "status"],
      fields: [
        { name: "issueId", description: "Issue ID." },
        { name: "status", description: "New status.", optional: true },
        { name: "assignee", description: "New assignee.", optional: true },
        { name: "priority", description: "New priority.", type: "integer", optional: true },
      ],
      sideEffect: "write",
      output: "LinearIssue",
      popularity: 0.9,
    },
    {
      name: "add_comment",
      description: "Add a comment to a Linear issue.",
      operations: ["comment", "reply", "add", "post"],
      objects: ["comment", "issue", "ticket"],
      fields: [
        { name: "issueId", description: "Issue ID." },
        { name: "body", description: "Comment text." },
      ],
      sideEffect: "external_communication",
      output: "LinearComment",
    },
    {
      name: "list_projects",
      description: "List Linear projects for a team.",
      operations: ["list", "show"],
      objects: ["project", "projects", "roadmap"],
      fields: [{ name: "teamKey", description: "Optional team key.", optional: true }],
      output: "LinearProject[]",
    },
    {
      name: "create_relation",
      description: "Create a blocks, duplicate, or related relationship between issues.",
      operations: ["link", "relate", "block", "mark duplicate"],
      objects: ["issue", "relation", "dependency", "blocker"],
      fields: [
        { name: "issueId", description: "Source issue ID." },
        { name: "relatedIssueId", description: "Target issue ID." },
        { name: "relationType", description: "blocks, duplicate, or related." },
      ],
      sideEffect: "write",
      output: "LinearRelation",
    },
  ],
});

const github = makeIntegration({
  id: "github",
  name: "GitHub",
  summary: "Work with repositories, issues, pull requests, reviews, commits, Actions, and files.",
  aliases: ["github", "git hub", "repository", "repo"],
  keywords: ["repo", "repository", "pull request", "pr", "commit", "branch", "workflow", "code"],
  tools: [
    {
      name: "search_issues",
      description: "Search GitHub issues and pull requests.",
      operations: ["search", "find", "look up"],
      objects: ["issue", "issues", "pull request", "pr"],
      fields: [{ name: "query", description: "GitHub search query." }],
      output: "GitHubIssue[]",
      popularity: 0.85,
    },
    {
      name: "list_pull_requests",
      description: "List pull requests in a GitHub repository.",
      operations: ["list", "show", "enumerate"],
      objects: ["pull request", "pull requests", "pr", "prs"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "state", description: "open, closed, or all.", optional: true },
      ],
      output: "PullRequest[]",
      popularity: 0.9,
    },
    {
      name: "get_pull_request",
      description: "Get pull-request metadata and changed files.",
      operations: ["get", "inspect", "read", "fetch"],
      objects: ["pull request", "pr", "changes", "diff"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "pullNumber", description: "Pull-request number.", type: "integer" },
      ],
      output: "PullRequest",
      popularity: 1,
    },
    {
      name: "create_issue",
      description: "Create a GitHub repository issue.",
      operations: ["create", "open", "file"],
      objects: ["issue", "bug"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "title", description: "Issue title." },
        { name: "body", description: "Markdown body.", optional: true },
      ],
      sideEffect: "write",
      output: "GitHubIssue",
    },
    {
      name: "create_review",
      description: "Submit a pull-request review.",
      operations: ["review", "approve", "request changes", "comment"],
      objects: ["pull request", "pr", "review"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "pullNumber", description: "Pull-request number.", type: "integer" },
        { name: "event", description: "APPROVE, REQUEST_CHANGES, or COMMENT." },
        { name: "body", description: "Review body.", optional: true },
      ],
      sideEffect: "external_communication",
      output: "PullRequestReview",
    },
    {
      name: "compare_commits",
      description: "Compare two GitHub commits, branches, or tags.",
      operations: ["compare", "diff"],
      objects: ["commit", "commits", "tag", "branch", "release"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "base", description: "Base ref." },
        { name: "head", description: "Head ref." },
      ],
      output: "CommitComparison",
    },
    {
      name: "list_actions_runs",
      description: "List GitHub Actions workflow runs.",
      operations: ["list", "show", "check"],
      objects: ["workflow", "action", "actions", "ci", "build"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "status", description: "Optional run status.", optional: true },
      ],
      output: "WorkflowRun[]",
    },
    {
      name: "get_file",
      description: "Read a file from a GitHub repository.",
      operations: ["get", "read", "fetch", "open"],
      objects: ["file", "code", "source"],
      fields: [
        { name: "owner", description: "Repository owner." },
        { name: "repo", description: "Repository name." },
        { name: "path", description: "Repository-relative path." },
        { name: "ref", description: "Optional branch or SHA.", optional: true },
      ],
      output: "RepositoryFile",
    },
  ],
});

const notion = makeIntegration({
  id: "notion",
  name: "Notion",
  summary: "Search and manage workspace pages, databases, blocks, comments, and templates.",
  aliases: ["notion", "workspace wiki", "team wiki"],
  keywords: ["notion", "wiki", "page", "database", "knowledge base", "decision log", "document"],
  tools: [
    {
      name: "search",
      description: "Search Notion pages and data sources.",
      operations: ["search", "find", "look up"],
      objects: ["page", "pages", "notion", "wiki", "document"],
      fields: [{ name: "query", description: "Search text." }],
      output: "NotionSearchResult[]",
      popularity: 1,
    },
    {
      name: "fetch_page",
      description: "Fetch a Notion page and its properties.",
      operations: ["fetch", "get", "read", "open"],
      objects: ["page", "document"],
      fields: [{ name: "pageId", description: "Page ID." }],
      output: "NotionPage",
      popularity: 0.9,
    },
    {
      name: "create_page",
      description: "Create a Notion page under a parent page or data source.",
      operations: ["create", "write", "add"],
      objects: ["page", "document", "note", "decision"],
      fields: [
        { name: "parentId", description: "Parent page or data-source ID." },
        { name: "title", description: "Page title." },
        { name: "markdown", description: "Initial Markdown content.", optional: true },
      ],
      sideEffect: "write",
      output: "NotionPage",
      popularity: 0.95,
    },
    {
      name: "update_page",
      description: "Update properties on a Notion page.",
      operations: ["update", "edit", "change"],
      objects: ["page", "document", "properties"],
      fields: [
        { name: "pageId", description: "Page ID." },
        { name: "properties", description: "Changed properties.", type: "object" },
      ],
      sideEffect: "write",
      output: "NotionPage",
    },
    {
      name: "query_database",
      description: "Query a Notion database with filters.",
      operations: ["query", "filter", "list", "search"],
      objects: ["database", "records", "rows"],
      fields: [
        { name: "databaseId", description: "Database ID." },
        { name: "filter", description: "Optional filter object.", type: "object", optional: true },
      ],
      output: "NotionPage[]",
    },
    {
      name: "append_blocks",
      description: "Append content blocks to a Notion page.",
      operations: ["append", "add", "write"],
      objects: ["block", "blocks", "content", "page"],
      fields: [
        { name: "pageId", description: "Page ID." },
        { name: "blocks", description: "Markdown block strings.", type: "array" },
      ],
      sideEffect: "write",
      output: "NotionBlock[]",
    },
    {
      name: "create_comment",
      description: "Create a comment on a Notion page.",
      operations: ["comment", "reply", "add"],
      objects: ["comment", "page"],
      fields: [
        { name: "pageId", description: "Page ID." },
        { name: "text", description: "Comment text." },
      ],
      sideEffect: "external_communication",
      output: "NotionComment",
    },
    {
      name: "duplicate_page",
      description: "Duplicate a Notion page beneath another page.",
      operations: ["duplicate", "copy", "clone"],
      objects: ["page", "template"],
      fields: [
        { name: "pageId", description: "Source page ID." },
        { name: "parentId", description: "Destination parent ID." },
        { name: "title", description: "Optional new title.", optional: true },
      ],
      sideEffect: "write",
      output: "NotionPage",
    },
  ],
});

const calendar = makeIntegration({
  id: "calendar",
  name: "Google Calendar",
  summary: "Find availability and search, create, update, or cancel calendar events.",
  aliases: ["google calendar", "calendar", "schedule"],
  keywords: ["calendar", "meeting", "event", "availability", "free", "busy", "schedule", "book"],
  tools: [
    {
      name: "list_events",
      description: "List calendar events in a time range.",
      operations: ["list", "show"],
      objects: ["event", "events", "meeting", "calendar"],
      fields: [
        { name: "start", description: "ISO-8601 range start." },
        { name: "end", description: "ISO-8601 range end." },
        { name: "calendarId", description: "Optional calendar ID.", optional: true },
      ],
      output: "CalendarEvent[]",
      popularity: 0.9,
    },
    {
      name: "search_events",
      description: "Search calendar events by text and date range.",
      operations: ["search", "find", "look up"],
      objects: ["event", "events", "meeting", "calendar"],
      fields: [
        { name: "query", description: "Event text query." },
        { name: "start", description: "Optional range start.", optional: true },
        { name: "end", description: "Optional range end.", optional: true },
      ],
      output: "CalendarEvent[]",
      popularity: 0.85,
    },
    {
      name: "get_event",
      description: "Get complete details for one calendar event.",
      operations: ["get", "read", "fetch", "open"],
      objects: ["event", "meeting"],
      fields: [{ name: "eventId", description: "Calendar event ID." }],
      output: "CalendarEvent",
    },
    {
      name: "create_event",
      description: "Create a calendar event and invite attendees.",
      operations: ["create", "schedule", "book", "set up"],
      objects: ["event", "meeting", "calendar invite"],
      fields: [
        { name: "title", description: "Event title." },
        { name: "start", description: "ISO-8601 start." },
        { name: "end", description: "ISO-8601 end." },
        { name: "attendees", description: "Attendee emails.", type: "array", optional: true },
      ],
      sideEffect: "external_communication",
      output: "CalendarEvent",
      popularity: 1,
    },
    {
      name: "update_event",
      description: "Update an existing calendar event.",
      operations: ["update", "edit", "move", "reschedule", "rename"],
      objects: ["event", "meeting"],
      fields: [
        { name: "eventId", description: "Calendar event ID." },
        { name: "start", description: "Optional new start.", optional: true },
        { name: "end", description: "Optional new end.", optional: true },
        { name: "title", description: "Optional new title.", optional: true },
      ],
      sideEffect: "external_communication",
      output: "CalendarEvent",
    },
    {
      name: "delete_event",
      description: "Cancel and delete a calendar event.",
      operations: ["delete", "cancel", "remove"],
      objects: ["event", "meeting"],
      fields: [{ name: "eventId", description: "Calendar event ID." }],
      sideEffect: "destructive",
      output: "DeletedCalendarEvent",
    },
    {
      name: "find_availability",
      description: "Find shared free time for a set of attendees.",
      operations: ["find", "check", "look for"],
      objects: ["availability", "free time", "slot", "opening"],
      fields: [
        { name: "attendees", description: "Attendee emails.", type: "array" },
        { name: "start", description: "ISO-8601 range start." },
        { name: "end", description: "ISO-8601 range end." },
        { name: "durationMinutes", description: "Slot duration.", type: "integer" },
      ],
      output: "AvailabilitySlot[]",
      popularity: 0.95,
    },
    {
      name: "list_calendars",
      description: "List accessible Google calendars.",
      operations: ["list", "show"],
      objects: ["calendar", "calendars"],
      fields: [],
      output: "Calendar[]",
    },
  ],
});

export const ADAPTIVE_TOOL_REGISTRY_VERSION = "adaptive-mock-registry.v1";

export const ADAPTIVE_TOOL_REGISTRY: readonly AdaptiveIntegrationDefinition[] = [
  slack,
  gmail,
  linear,
  github,
  notion,
  calendar,
];

const INTEGRATION_BY_ID = new Map(
  ADAPTIVE_TOOL_REGISTRY.map((integration) => [integration.id, integration]),
);
const TOOL_BY_POINTER = new Map(
  ADAPTIVE_TOOL_REGISTRY.flatMap((integration) =>
    integration.tools.map((tool) => [tool.pointer, { integration, tool }] as const),
  ),
);

export function adaptiveIntegrationById(id: string) {
  return INTEGRATION_BY_ID.get(id);
}

export function adaptiveToolByPointer(pointer: string) {
  return TOOL_BY_POINTER.get(pointer);
}

export function adaptiveRegistryToolCount() {
  return TOOL_BY_POINTER.size;
}
