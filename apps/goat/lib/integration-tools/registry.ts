import type {
  IntegrationToolDefinition,
  IntegrationToolDefinitionView,
  IntegrationToolProvider,
} from "./types";

// Curated catalog: the minimal, most-useful read surface per provider — never
// the provider's full API. search_integration_tools returns these complete
// definitions, so schemas here are exactly what the model calls with.

export const INTEGRATION_PROVIDER_LABELS: Record<IntegrationToolProvider, string> = {
  linear: "Linear",
  slack: "Slack",
  gmail: "Gmail",
};

export const INTEGRATION_PROVIDER_SUMMARIES: Record<IntegrationToolProvider, string> = {
  linear: "read issues, projects, and teams in the connected workspace",
  slack: "search and read messages the connected user can see",
  gmail: "search and read email in the connected account(s)",
};

const LIMIT_PROPERTY = (fallback: number, max: number) => ({
  type: "number" as const,
  description: `Maximum results to return. Defaults to ${fallback}, capped at ${max}.`,
});

const LINEAR_TOOL_DEFINITIONS: IntegrationToolDefinition[] = [
  {
    name: "linear_list_issues",
    provider: "linear",
    description:
      "List Linear issues ordered by most recently updated, filterable by team, assignee, workflow state, or a free-text title match. Combine filters to narrow; omit all filters for the latest issues across the workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Free-text match against issue titles (case-insensitive contains).",
        },
        teamKey: {
          type: "string",
          description: 'Team key like "ENG" (the prefix of issue keys such as ENG-123).',
        },
        assignee: {
          type: "string",
          description: "Assignee display name (case-insensitive contains match).",
        },
        state: {
          type: "string",
          description: "Workflow state type to filter by.",
          enum: ["triage", "backlog", "unstarted", "started", "completed", "canceled"],
        },
        limit: LIMIT_PROPERTY(20, 50),
      },
    },
    keywords: ["issue", "issues", "ticket", "tickets", "bug", "task", "sprint", "backlog"],
  },
  {
    name: "linear_get_issue",
    provider: "linear",
    description:
      "Fetch one Linear issue with its description, state, assignee, project, labels, and recent comments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: 'Issue key like "ENG-123" or the issue UUID.',
        },
      },
      required: ["id"],
    },
    keywords: ["issue", "ticket", "detail", "comments", "status"],
  },
  {
    name: "linear_list_my_issues",
    provider: "linear",
    description:
      "List open Linear issues assigned to the connected user, ordered by most recently updated. Completed and canceled issues are excluded.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: LIMIT_PROPERTY(20, 50),
      },
    },
    keywords: ["my", "assigned", "todo", "issues", "workload", "plate"],
  },
  {
    name: "linear_list_projects",
    provider: "linear",
    description:
      "List Linear projects with state, progress, target date, and lead — optionally filtered by team or a free-text name match.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Free-text match against project names (case-insensitive contains).",
        },
        teamKey: {
          type: "string",
          description: 'Team key like "ENG" to only list that team\'s projects.',
        },
        limit: LIMIT_PROPERTY(20, 50),
      },
    },
    keywords: ["project", "projects", "roadmap", "initiative", "milestone"],
  },
  {
    name: "linear_list_teams",
    provider: "linear",
    description: "List the Linear teams in the connected workspace with their keys and names.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    keywords: ["team", "teams", "squad", "key"],
  },
];

const SLACK_TOOL_DEFINITIONS: IntegrationToolDefinition[] = [
  {
    name: "slack_search_messages",
    provider: "slack",
    description:
      "Search Slack messages the connected user can see using Slack search syntax, including modifiers like from:@name, in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD, and quoted phrases. Requires the search:read permission; if the connection predates it, this tool reports how to reconnect while the channel and thread tools keep working.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            'Slack search query, e.g. "launch plan in:#product after:2026-07-01" or "from:@dana pricing".',
        },
        account: {
          type: "string",
          description:
            "Slack workspace name or team id. Only needed when more than one Slack workspace is connected.",
        },
        limit: LIMIT_PROPERTY(20, 50),
      },
      required: ["query"],
    },
    keywords: ["message", "messages", "search", "conversation", "dm", "channel", "said"],
  },
  {
    name: "slack_list_channels",
    provider: "slack",
    description:
      "List Slack channels the connected user is a member of (public and private), optionally filtered by a name fragment. Returns channel ids for use with the history and thread tools.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Channel name fragment to filter by (case-insensitive contains).",
        },
        account: {
          type: "string",
          description:
            "Slack workspace name or team id. Only needed when more than one Slack workspace is connected.",
        },
        limit: LIMIT_PROPERTY(50, 200),
      },
    },
    keywords: ["channel", "channels", "list", "rooms"],
  },
  {
    name: "slack_get_channel_history",
    provider: "slack",
    description:
      "Read the most recent messages in one Slack channel or DM, newest first, with author display names resolved. Threaded replies are not expanded; use slack_get_thread with a message's threadTs for those.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: {
          type: "string",
          description: 'Channel id like "C0123456789" or a channel name like "#product".',
        },
        account: {
          type: "string",
          description:
            "Slack workspace name or team id. Only needed when more than one Slack workspace is connected.",
        },
        limit: LIMIT_PROPERTY(30, 100),
      },
      required: ["channel"],
    },
    keywords: ["history", "channel", "messages", "recent", "catch", "up", "dm"],
  },
  {
    name: "slack_get_thread",
    provider: "slack",
    description:
      "Read one Slack thread: the parent message and its replies in order, with author display names resolved.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: {
          type: "string",
          description: 'Channel id like "C0123456789" or a channel name like "#product".',
        },
        threadTs: {
          type: "string",
          description:
            'Timestamp of the thread\'s parent message, e.g. "1720000000.123456" (the threadTs field on messages).',
        },
        account: {
          type: "string",
          description:
            "Slack workspace name or team id. Only needed when more than one Slack workspace is connected.",
        },
        limit: LIMIT_PROPERTY(50, 100),
      },
      required: ["channel", "threadTs"],
    },
    keywords: ["thread", "replies", "discussion"],
  },
];

const GMAIL_TOOL_DEFINITIONS: IntegrationToolDefinition[] = [
  {
    name: "gmail_search_emails",
    provider: "gmail",
    description:
      "Search email in one connected Gmail account using Gmail query syntax, including operators like from:, to:, subject:, is:unread, has:attachment, newer_than:7d, and label:. Returns compact headers and snippets; use gmail_get_email or gmail_get_thread for full bodies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description:
            "Connected Gmail account email address to search. Always required; the connected accounts are listed in the integrations context.",
        },
        query: {
          type: "string",
          description:
            'Gmail search query, e.g. "is:unread newer_than:2d" or "from:jane@acme.com invoice".',
        },
        maxResults: LIMIT_PROPERTY(10, 25),
      },
      required: ["account", "query"],
    },
    keywords: ["email", "emails", "mail", "inbox", "unread", "search", "message"],
  },
  {
    name: "gmail_get_email",
    provider: "gmail",
    description:
      "Fetch one email message from a connected Gmail account: headers plus the readable body with quoted reply chains stripped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Connected Gmail account email address the message belongs to.",
        },
        messageId: {
          type: "string",
          description: "Gmail message id from a gmail_search_emails result.",
        },
      },
      required: ["account", "messageId"],
    },
    keywords: ["email", "mail", "message", "read", "body"],
  },
  {
    name: "gmail_get_thread",
    provider: "gmail",
    description:
      "Fetch a full email conversation thread from a connected Gmail account, with each message's sender, date, and readable body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Connected Gmail account email address the thread belongs to.",
        },
        threadId: {
          type: "string",
          description: "Gmail thread id from a gmail_search_emails result.",
        },
      },
      required: ["account", "threadId"],
    },
    keywords: ["email", "mail", "thread", "conversation", "correspondence"],
  },
];

export const INTEGRATION_TOOL_DEFINITIONS: readonly IntegrationToolDefinition[] = [
  ...LINEAR_TOOL_DEFINITIONS,
  ...SLACK_TOOL_DEFINITIONS,
  ...GMAIL_TOOL_DEFINITIONS,
];

export function integrationToolDefinitionsForProviders(
  providers: readonly IntegrationToolProvider[],
): IntegrationToolDefinition[] {
  return INTEGRATION_TOOL_DEFINITIONS.filter((definition) =>
    providers.includes(definition.provider),
  );
}

export function findIntegrationToolDefinition(name: string): IntegrationToolDefinition | null {
  return INTEGRATION_TOOL_DEFINITIONS.find((definition) => definition.name === name) ?? null;
}

export function toIntegrationToolDefinitionView(
  definition: IntegrationToolDefinition,
): IntegrationToolDefinitionView {
  return {
    name: definition.name,
    provider: definition.provider,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}
