export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

import { AGENT_MODEL_CATALOG } from "./models";
import type { AgentConfigTool, AgentMcpToolConfig, AgentToolId } from "./types";

export type RuntimeToolName =
  | "shell"
  | "gh"
  | "memory"
  | "recall"
  | "inbox_list"
  | "inbox_add"
  | "inbox_update"
  | "fetch_transcript"
  | "create_linear_issue"
  | "read_file"
  | "read_skill"
  | "edit_file"
  | "write_file"
  | "list_files"
  | "git_diff"
  | "run_subagent"
  | "delegate_to_agent"
  | "update_agent_file"
  | "ask_user_question"
  | "amp_coder"
  | "opencode_coder"
  | "exa_search"
  | "exa_contents"
  | "exa_answer"
  | "x_search_posts"
  | "x_get_profile"
  | "x_get_user_posts"
  | "x_get_discussion"
  | "x_get_trends"
  | "youtube_search"
  | "youtube_get_video"
  | "youtube_get_transcript"
  | "youtube_get_channel"
  | "youtube_list_channel_videos"
  | "tiktok_get_profile"
  | "tiktok_list_profile_posts"
  | "tiktok_get_video"
  | "tiktok_get_comments"
  | "tiktok_search"
  | "tiktok_get_metadata"
  | "tiktok_get_transcript"
  | "instagram_get_profile"
  | "instagram_list_profile_posts"
  | "instagram_get_post"
  | "instagram_get_comments"
  | "instagram_search_profiles"
  | "instagram_get_metadata"
  | "instagram_get_transcript"
  | "social_get_job"
  | "neon_list_databases"
  | "neon_describe_schema"
  | "neon_run_sql"
  | "neon_explain_sql"
  | "neon_create_branch"
  | "neon_delete_branch"
  | "neon_reset_branch"
  | "gmail_list_messages"
  | "gmail_get_message"
  | "gmail_search"
  | "gmail_list_threads"
  | "gmail_get_thread"
  | "gmail_list_labels"
  | "calendar_list_calendars"
  | "calendar_list_events"
  | "calendar_get_event"
  | "calendar_get_freebusy"
  | "calendar_create_event"
  | "calendar_update_event"
  | "calendar_delete_event"
  | "web_fetch"
  | "tool_help"
  | "find_tools"
  | "discover_capabilities";

export type RuntimeToolDefinition = {
  name: RuntimeToolName;
  kind: "sandbox" | "hosted" | "internal";
  configToolId?: AgentToolId;
  sharedConfigToolIds?: AgentToolId[];
  requiresAttachedRepository?: boolean;
  description: string;
  parameters: JsonSchema;
  help?: string;
};

export type RuntimeToolDefinitionContext = {
  personalAgent?: boolean;
};

export type AgentToolCredentialSource = "platform" | "workspace" | "mixed" | "none";

export type AgentToolWorkspaceResourceRequirement = {
  provider: "github";
  resourceType: "repository";
  binding: "required";
};

export type AgentToolDefinition = {
  id: AgentToolId;
  type: AgentConfigTool["type"];
  provider?: "amp" | "opencode";
  server?: AgentMcpToolConfig["server"];
  label: string;
  description: string;
  runtimeTools: RuntimeToolName[];
  defaultEnabled: true;
  credentialSource: AgentToolCredentialSource;
  requiredPlatformEnvVars?: string[];
  requiredWorkspaceResource?: AgentToolWorkspaceResourceRequirement;
  prCapableDefault?: boolean;
};

export const AGENT_TOOL_CATALOG: AgentToolDefinition[] = [
  {
    id: "exa",
    type: "hosted_tool",
    label: "exa",
    description: "Web research with search, content extraction, people lookup, and cited answers.",
    runtimeTools: ["exa_search", "exa_contents", "exa_answer", "web_fetch"],
    defaultEnabled: true,
    credentialSource: "platform",
    requiredPlatformEnvVars: ["EXA_API_KEY"],
  },
  {
    id: "x",
    type: "hosted_tool",
    label: "x",
    description:
      "Read public X posts, profiles, timelines, discussions, and trends through the official X API.",
    runtimeTools: [
      "x_search_posts",
      "x_get_profile",
      "x_get_user_posts",
      "x_get_discussion",
      "x_get_trends",
    ],
    defaultEnabled: true,
    credentialSource: "platform",
    requiredPlatformEnvVars: ["X_API_BEARER_TOKEN"],
  },
  {
    id: "youtube",
    type: "hosted_tool",
    label: "youtube",
    description:
      "Search YouTube and read video transcripts, plus video and channel metadata, via Supadata.",
    runtimeTools: [
      "youtube_search",
      "youtube_get_video",
      "youtube_get_transcript",
      "youtube_get_channel",
      "youtube_list_channel_videos",
    ],
    defaultEnabled: true,
    credentialSource: "platform",
    requiredPlatformEnvVars: ["SUPADATA_API_KEY"],
  },
  {
    id: "tiktok",
    type: "hosted_tool",
    label: "tiktok",
    description:
      "Read public TikTok profiles, recent videos, comments, and search results via Apify, plus direct video metadata and transcripts via Supadata.",
    runtimeTools: [
      "tiktok_get_profile",
      "tiktok_list_profile_posts",
      "tiktok_get_video",
      "tiktok_get_comments",
      "tiktok_search",
      "social_get_job",
      "tiktok_get_metadata",
      "tiktok_get_transcript",
    ],
    defaultEnabled: true,
    credentialSource: "platform",
    requiredPlatformEnvVars: ["APIFY_API_TOKEN", "SUPADATA_API_KEY"],
  },
  {
    id: "instagram",
    type: "hosted_tool",
    label: "instagram",
    description:
      "Read public Instagram profiles, recent posts/reels, comments, and profile search via Apify, plus direct media metadata and transcripts via Supadata.",
    runtimeTools: [
      "instagram_get_profile",
      "instagram_list_profile_posts",
      "instagram_get_post",
      "instagram_get_comments",
      "instagram_search_profiles",
      "social_get_job",
      "instagram_get_metadata",
      "instagram_get_transcript",
    ],
    defaultEnabled: true,
    credentialSource: "platform",
    requiredPlatformEnvVars: ["APIFY_API_TOKEN", "SUPADATA_API_KEY"],
  },
  {
    id: "neon",
    type: "hosted_tool",
    label: "neon",
    description:
      "Inspect and administer workspace-connected Neon Postgres databases with hard permission gates for SQL, branch, and migration operations.",
    runtimeTools: [
      "neon_list_databases",
      "neon_describe_schema",
      "neon_run_sql",
      "neon_explain_sql",
      "neon_create_branch",
      "neon_delete_branch",
      "neon_reset_branch",
    ],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "amp",
    type: "coding_agent",
    provider: "amp",
    label: "AMP",
    description: "Delegate coding work to Amp inside an E2B sandbox.",
    runtimeTools: ["amp_coder"],
    defaultEnabled: true,
    credentialSource: "mixed",
    requiredPlatformEnvVars: ["AMP_API_KEY"],
    requiredWorkspaceResource: {
      provider: "github",
      resourceType: "repository",
      binding: "required",
    },
    prCapableDefault: true,
  },
  {
    id: "opencode",
    type: "coding_agent",
    provider: "opencode",
    label: "opencode",
    description:
      "Delegate coding work to opencode inside an E2B sandbox, using attached repositories or public GitHub repositories.",
    runtimeTools: ["opencode_coder"],
    defaultEnabled: true,
    credentialSource: "mixed",
    requiredPlatformEnvVars: ["VERCEL_AI_GATEWAY_API_KEY"],
    prCapableDefault: true,
  },
  {
    id: "linear",
    type: "mcp",
    server: "linear",
    label: "linear",
    description: "Use workspace-configured Linear MCP tools.",
    runtimeTools: [],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "slack",
    type: "mcp",
    server: "slack",
    label: "slack",
    description: "Use workspace-configured Slack MCP tools.",
    runtimeTools: [],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "posthog",
    type: "mcp",
    server: "posthog",
    label: "posthog",
    description: "Use workspace-configured PostHog MCP tools.",
    runtimeTools: [],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "betterstack",
    type: "mcp",
    server: "betterstack",
    label: "betterstack",
    description: "Use workspace-configured Better Stack MCP tools.",
    runtimeTools: [],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "braintrust",
    type: "mcp",
    server: "braintrust",
    label: "braintrust",
    description: "Use workspace-configured Braintrust MCP tools.",
    runtimeTools: [],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "notion",
    type: "mcp",
    server: "notion",
    label: "notion",
    description: "Use workspace-configured Notion MCP tools.",
    runtimeTools: [],
    defaultEnabled: true,
    credentialSource: "workspace",
  },
  {
    id: "gmail",
    type: "hosted_tool",
    label: "gmail",
    description:
      "Read mail from workspace-connected Google accounts (read-only): list, search, and read messages, threads, and labels.",
    runtimeTools: [
      "gmail_list_messages",
      "gmail_get_message",
      "gmail_search",
      "gmail_list_threads",
      "gmail_get_thread",
      "gmail_list_labels",
    ],
    defaultEnabled: true,
    credentialSource: "workspace",
    requiredPlatformEnvVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  },
  {
    id: "google_calendar",
    type: "hosted_tool",
    label: "google_calendar",
    description:
      "Read and manage events on workspace-connected Google Calendars: list calendars/events, check free/busy, and create, update, or delete events.",
    runtimeTools: [
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_get_event",
      "calendar_get_freebusy",
      "calendar_create_event",
      "calendar_update_event",
      "calendar_delete_event",
    ],
    defaultEnabled: true,
    credentialSource: "workspace",
    requiredPlatformEnvVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  },
];

export const AGENT_TOOL_DEFINITION_BY_ID = new Map(
  AGENT_TOOL_CATALOG.map((tool) => [tool.id, tool]),
);

export const CORE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "shell",
    kind: "sandbox",
    description:
      "Run a shell command from the session workspace root, where ./work and ./brain are visible. Use the gh tool, not shell, for authenticated GitHub operations.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "gh",
    kind: "sandbox",
    requiresAttachedRepository: true,
    description:
      "Run the GitHub CLI (gh) against the attached GitHub repositories. Repo-scoped auth is injected automatically; never handle tokens yourself. Use for pull requests, issues, reviews, releases, and cloning (gh repo clone). All work happens under ./work; never push to a repository's default branch.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "string",
          description:
            'Arguments passed to the gh CLI, without the leading "gh". Example: "pr create --fill --base main --head my-branch".',
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
    help: [
      "Run gh subcommands against the attached repositories; authentication is pre-injected.",
      "When exactly one repository is attached, commands default to it even before it is cloned. When multiple repositories are attached, pass --repo owner/repo for repository-scoped commands.",
      "Commands run from ./work. Clone a repository first (git clone or gh repo clone <owner>/<repo> work/<repo>) when you need its code or files.",
      "Use this tool for gh pr create / gh pr view / gh issue list / gh api as needed.",
      "Never push to or open a PR against a repository's default branch directly; always use a feature branch.",
    ].join("\n"),
  },
  {
    name: "memory",
    kind: "sandbox",
    description:
      "Run the structured `memory` CLI over agent/memory/ — create canonical objects, append cited evidence, rewrite compiled truth, and run hybrid retrieval. This is the only way to read or write structured memory; never edit files under agent/memory/ directly. Pass the subcommand and flags via args (e.g. 'query \"acme blockers\"').",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "string",
          description:
            'Arguments passed to the memory CLI, without the leading "memory". Example: \'query "acme enterprise blockers" --limit 5\'.',
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
    help: [
      "Run memory subcommands; the agent never sees retrieval credentials — they are injected only into this subprocess.",
      "Commands: create, get, query, append-evidence, rewrite, alias, link, merge, delete, doctor. Add --json for machine-readable output.",
      "Status lifecycle: objects start as draft (uncited scratch) and become active once rewrite backs their compiled truth with evidence citations. create --status active requires the truth to already be cited; the normal path is create → append-evidence → rewrite.",
      'Capture evidence first, then rewrite an object\'s compiled truth citing it (e.g. append-evidence --kind meeting --id acme-call --subject acme --source-ref "..." --summary "...", then rewrite acme --truth "... [^ev:acme-call]").',
      'Query before answering questions about people, companies, projects, or past decisions: query "topic" --type company --limit 5. Results include capped compiled truth; use the shown `memory get <id>` hint when you need the full record or timeline. For relationship questions add --hops 1 to pull in linked objects. query hides merged stubs and invalid records by default.',
      'For "what\'s recent" recaps, query with no text and a --since window: query --since 24h lists everything updated in the last day, newest first. --since takes a relative window (30m, 24h, 7d, 2w) or an ISO-8601 timestamp — prefer the relative form over computing timestamps yourself. It matches updated_at (the last write, not when the fact was first learned).',
      "get renders a structured record with compiled truth and recent timeline entries by default; get --section truth|timeline|frontmatter|all scopes both the text and the --json payload to that part.",
      "Writes are last-write-wins — do not issue two memory writes against the same object in parallel.",
      "Do not pass file paths under agent/memory/ to edit_file/write_file; the CLI is the only safe path and enforces structure, provenance, and links.",
    ].join("\n"),
  },
  {
    name: "recall",
    kind: "internal",
    description:
      'Recall your own past sessions with this user from the raw transcript. Use query for topic searches. For broad time-bounded recap questions like "what did we discuss today?", "what happened yesterday?", or "catch me up on this week", omit query and pass only time_window so results come back newest-first instead of keyword-filtered. The live session is excluded. This searches conversation history; use the memory tool for curated, structured knowledge.',
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Topic, entity, or decision to search for, in natural language or keywords. Omit when the user asks for a broad recap of a time period, such as today, yesterday, this morning, this week, or recent conversations. Typo-tolerant. Examples: 'pricing decision for acme', 'launch date'.",
        },
        time_window: {
          type: "object",
          properties: {
            amount: {
              type: "integer",
              description:
                "Positive number of hours or days to look back. Max 720 hours or 30 days.",
            },
            unit: {
              type: "string",
              enum: ["hours", "days"],
              description: "Whether amount is measured in hours or days.",
            },
          },
          required: ["amount", "unit"],
          additionalProperties: false,
        },
        limit: {
          type: "number",
          description: "Maximum number of matching exchanges to return (default 5, max 20).",
        },
      },
      additionalProperties: false,
    },
    help: [
      "Searches the raw transcript of your previous sessions with this user (this agent only); the current session is excluded.",
      "Use exactly one mode unless the user gives both a real topic and a time bound.",
      "Mode 1, topic search: pass query only to search all indexed history.",
      "Mode 2, topic search within a recent period: pass query plus time_window only when the user names a topic/entity/decision and also bounds time, e.g. 'what did we decide about Acme today?'.",
      "Mode 3, time-bounded recap: pass time_window without query for broad recap requests like 'what did we discuss today?', 'what happened yesterday?', or 'catch me up on this week'. Results are newest first.",
      "Returns each hit as a short window: the matching message plus the one before and after it for context.",
      "Combines keyword relevance with fuzzy/typo matching — you do not need exact wording.",
      "Use recall for 'what did we say/decide/do' questions; use the memory tool for curated facts about people, companies, and projects.",
    ].join("\n"),
  },
  {
    name: "inbox_list",
    kind: "internal",
    description:
      "List the items currently in this user's personal inbox (the attention items you and other runs have posted for them). Returns open and snoozed items, plus recently resolved ones when include_resolved is set. Call this BEFORE inbox_add so you can reuse a dedup_key and avoid posting a duplicate of something already there.",
    parameters: {
      type: "object",
      properties: {
        include_resolved: {
          type: "boolean",
          description:
            "Also include recently done/dismissed items (default false). Useful to check whether the user already dealt with something before re-raising it.",
        },
      },
      additionalProperties: false,
    },
    help: [
      "Items are scoped to the current user; the live session's agent posts on their behalf.",
      "status is one of open | snoozed | done | dismissed. A snoozed item is hidden from the user's inbox until snoozed_until passes, but you still see it here.",
      "Match on dedup_key (or title) to decide whether to skip an inbox_add.",
    ].join("\n"),
  },
  {
    name: "inbox_add",
    kind: "internal",
    description:
      "Post a new attention item to the user's personal inbox — an FYI, a finished result, or something that needs their decision. Use this when, during your run (including scheduled runs), you produce something the user should see but you should not interrupt them for synchronously. Keep the title short and action-oriented; put detail in body and the play-by-play in steps. Pass a stable dedup_key (e.g. a slug for the underlying thing) so re-running on a schedule does not create duplicates.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, action-oriented headline shown on the card. Required.",
        },
        body: {
          type: "string",
          description: "Optional markdown summary / FYI detail shown under the title.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional 'what happened' — the few steps you took that led to this item, newest-relevant last. Shown when the user expands the card.",
        },
        priority: {
          type: "string",
          enum: ["urgent", "high", "med", "low"],
          description: "Optional priority. Omit if it's a routine FYI.",
        },
        due_at: {
          type: "string",
          description: "Optional ISO-8601 timestamp for when this is due or time-sensitive.",
        },
        source: {
          type: "string",
          description:
            "Optional short origin label shown on the card (e.g. your name or the schedule that produced this). Defaults to your agent name.",
        },
        dedup_key: {
          type: "string",
          description:
            "Optional stable key. If a live (open/snoozed) item with this key already exists, this call is a no-op and returns that item — use it to make scheduled posts idempotent.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    help: [
      "Call inbox_list first and reuse a dedup_key to avoid duplicates across scheduled runs.",
      "The item links back to this session automatically, so the user can open the conversation from the card.",
      "Use inbox_add for asynchronous attention items; use ask_user_question only when you must block the current run on the user's answer.",
    ].join("\n"),
  },
  {
    name: "inbox_update",
    kind: "internal",
    description:
      "Update an existing inbox item you posted — typically to mark it done once you've resolved it, or to revise its title/body/priority. Pass the item id from inbox_list.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The inbox item id (from inbox_list). Required." },
        status: {
          type: "string",
          enum: ["open", "done", "dismissed"],
          description:
            "New status. Set 'done' when you've resolved the item so it leaves the user's inbox.",
        },
        title: { type: "string", description: "Optional new title." },
        body: { type: "string", description: "Optional new markdown body." },
        priority: {
          type: "string",
          enum: ["urgent", "high", "med", "low"],
          description: "Optional new priority.",
        },
        due_at: { type: "string", description: "Optional new ISO-8601 due timestamp." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    help: [
      "Only items in the current user's inbox can be updated.",
      "Marking an item done/dismissed stamps it resolved and removes it from the user's inbox view.",
    ].join("\n"),
  },
  {
    name: "create_linear_issue",
    kind: "internal",
    description:
      "Create an issue in this workspace's connected Linear from the current chat. Use when the user asks to open/file a Linear issue, including from a screenshot they dropped into the chat. Posts to the workspace's OWN Linear (Settings → Integrations), not to OpenCompany's internal feedback tracker. Provide a concise title and a markdown description; pass `team` (a Linear team name or key) when the user names one, or when the workspace has more than one team. IMPORTANT: any image(s) the user attached to their most recent message are uploaded and attached to the new issue AUTOMATICALLY — you do NOT need a file, path, or URL, and you cannot upload the image yourself; just call this tool and the screenshot is included.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short issue title. Required.",
        },
        description: {
          type: "string",
          description:
            "Issue body in Markdown. Include the user's report. Any attached screenshot is added separately.",
        },
        team: {
          type: "string",
          description:
            'Linear team name or key (e.g. "Engineering" or "ENG"). Optional when the workspace has a single team; required to disambiguate when several exist.',
        },
        include_attachments: {
          type: "boolean",
          description:
            "Whether to attach the image(s) the user dropped onto their most recent message. Defaults to true. Set false only if the user explicitly wants a text-only issue.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    help: [
      "Targets the workspace's connected Linear, not OpenCompany's internal feedback Linear.",
      "Dropped screenshots are attached automatically by the runner (it reads the bytes from secure storage) — never tell the user you can't attach the image, and never ask them for a file or URL.",
      "If Linear is not connected, this returns a recoverable error — tell the user to connect Linear in Settings → Integrations.",
      "If the workspace has multiple Linear teams and none was given, it returns the available team names so you can pass `team` and retry (or ask the user which team).",
    ].join("\n"),
  },
  {
    name: "fetch_transcript",
    kind: "internal",
    description:
      "Fetch the full, ordered transcript of one of your past sessions by its session id. Use after `recall` surfaces a relevant session and you want the complete conversation, not just the matching snippets. Read-only; you can only fetch your own sessions (or the session you were asked to review).",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The id of the session whose transcript to fetch.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    help: [
      "Returns every visible user and assistant message in the session, in chronological order.",
      "Scoped to your own sessions with this user; internal/background messages are excluded.",
      "Pair with recall: recall finds the relevant session, fetch_transcript reads it in full.",
    ].join("\n"),
  },
  {
    name: "read_file",
    kind: "sandbox",
    description:
      "Read a UTF-8 text file from ./work, ./brain, or ./agent. The path must start with work/, brain/, or agent/.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path starting with work/, brain/, or agent/.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_skill",
    kind: "sandbox",
    description:
      "Read a UTF-8 text file from a mounted read-only skill directory. Use this instead of read_file for SKILL.md and supporting skill files.",
    parameters: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "Mounted skill id, such as agent-self-edit.",
        },
        path: {
          type: "string",
          description: "Path inside the skill directory. Defaults to SKILL.md.",
          default: "SKILL.md",
        },
      },
      required: ["skillId"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    kind: "sandbox",
    description:
      "Apply targeted exact-string replacements to an existing UTF-8 text file inside ./work, ./brain, or ./agent. Use this for partial edits; use write_file only for new files or intentional full overwrites.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path starting with work/, brain/, or agent/.",
        },
        instructions: {
          type: "string",
          description:
            "Brief human-readable summary of the intended change. Used for auditability and model planning.",
        },
        edits: {
          type: "array",
          description:
            "Ordered exact replacements applied to an in-memory copy of the file. Each edit's oldString is matched against the content as mutated by prior edits in the same call. The file is only written if every edit succeeds.",
          items: {
            type: "object",
            properties: {
              oldString: {
                type: "string",
                description:
                  "Exact existing text to replace. Include enough surrounding context to make it unique.",
              },
              newString: { type: "string", description: "Replacement text." },
              replaceAll: {
                type: "boolean",
                description:
                  "When true, replace every exact occurrence of oldString. Defaults to false.",
                default: false,
              },
            },
            required: ["oldString", "newString"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "instructions", "edits"],
      additionalProperties: false,
    },
    help: [
      "Use edit_file for targeted changes to existing text files.",
      "The tool performs deterministic exact string replacement. It does not use regex, fuzzy matching, line numbers, or a hidden apply model.",
      "Each oldString must match the current file exactly, including indentation and whitespace.",
      "By default, oldString must appear exactly once. If the same replacement should happen everywhere, set replaceAll=true.",
      "All edits in one call are applied in order to an in-memory copy and written once. Each oldString is matched against the content as mutated by prior edits in the same call, not against the original file. If any edit fails, no changes are written.",
      "For simple line changes, set oldString to the exact current line plus enough surrounding context to make the match unique.",
      "Use write_file for creating new files or intentionally replacing a whole file.",
    ].join("\n"),
  },
  {
    name: "write_file",
    kind: "sandbox",
    description:
      "Create or overwrite a UTF-8 text file inside ./work, ./brain, or ./agent. Use edit_file for targeted changes to existing files. The path must start with work/, brain/, or agent/.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path starting with work/, brain/, or agent/.",
        },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    kind: "sandbox",
    description:
      "List files and directories below ./work, ./brain, or ./agent. The path must start with work/, brain/, or agent/.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path starting with work/, brain/, or agent/.",
          default: "work",
        },
        depth: { type: "number", description: "Maximum traversal depth.", default: 2 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    kind: "sandbox",
    description: "Return the current git diff for the session work directory.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "run_subagent",
    kind: "internal",
    description:
      "Run a focused, temporary subagent for a bounded task. Grant only the tools it needs; it returns one distilled answer and streams its progress inside this tool call.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short label for the subagent task, shown in the UI.",
        },
        prompt: {
          type: "string",
          description:
            "Self-contained task prompt for the subagent. Include relevant context and the exact answer shape needed.",
        },
        tools: {
          type: "array",
          description:
            'Optional tools to grant: underlying runtime tool names (e.g. "exa_search") and/or capability ids (e.g. "exa") that expand to their tools. Never use_tool or find_tools — the subagent calls its granted tools directly. Omit for the default read/research set.',
          items: { type: "string" },
        },
        model: {
          type: "string",
          enum: AGENT_MODEL_CATALOG.map((model) => model.id),
          description: "Optional model override. Defaults to your current model.",
        },
        max_steps: {
          type: "number",
          description: "Maximum inner model steps. Clamped from 4 to 24. Defaults to 16.",
          default: 16,
        },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    help: [
      "Use run_subagent when a focused parallel-style investigation would keep your own context cleaner.",
      "The subagent is temporary and does not ask the user questions. Its final answer is returned as this tool's result.",
      "Only grant tools needed for the task. If tools is omitted, a safe read/research-oriented set is used.",
      'Grant a whole capability by its id (e.g. "exa", "youtube") or individual underlying tool names. The subagent calls its granted tools directly — never grant use_tool, find_tools, or tool_help.',
      "The subagent cannot spawn other agents, delegate, edit your agent file, use MCP tools, or use user-interaction tools.",
    ].join("\n"),
  },
  {
    name: "delegate_to_agent",
    kind: "internal",
    description:
      "Delegate a focused task to another workspace agent referenced in this agent's instructions, or continue a prior delegated child session by sessionId. The delegated agent runs in an inspectable child session that is hidden from sidebar history, and this tool returns its final answer.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            "Target agent mention or path for a new delegated session, such as agent/research, @agent/research, research, or agents/research/research.agent. Omit when continuing a prior child session by sessionId.",
        },
        sessionId: {
          type: "string",
          description:
            "Existing child session id returned by an earlier delegate_to_agent call. Use this instead of agent when continuing that delegated session.",
        },
        prompt: {
          type: "string",
          description:
            "Specific task for the target agent. Include the relevant context and the output shape you need back.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    help: [
      "Use delegate_to_agent when another configured workspace agent is better suited to a focused subtask.",
      "To start a new delegated session, pass one target agent from the configured agent references and a self-contained prompt.",
      "To continue a prior delegated child session, pass its childSessionId back as sessionId with the next prompt, and omit agent.",
      "The tool blocks until the child session completes or fails, then returns the child answer and session id.",
      "Resume a child session only when continuity matters; start a new delegated session for independent subtasks.",
      "Keep delegated prompts bounded; do not delegate recursively unless the user's task clearly requires it.",
    ].join("\n"),
  },
  {
    name: "update_agent_file",
    kind: "internal",
    description: `Update your own .agent definition (your instructions, explicitly selected model, the tools you reference, and your recurring schedule triggers). Submit the COMPLETE new Markdown body, not a diff. The change is validated and applied atomically: on success it is versioned and synced to the workspace repo; on failure it returns errors and nothing is saved, so you can fix and retry. Changes take effect from your next turn in this same session (no new session needed); only the in-flight reply keeps its current configuration. Required: read the agent-self-edit skill first with read_skill({skillId:"agent-self-edit"}); this tool is rejected until you have.`,
    parameters: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "The full new Markdown instructions body. Keep any @mentions for tools and @brain/... paths you still want active; tools and brain follow the mentions in this body.",
        },
        title: {
          type: "string",
          description:
            "Optional new display name for yourself (e.g. a name the user picked). If omitted, your current name is kept. This is your shown name, not your file path.",
        },
        model: {
          type: "string",
          enum: AGENT_MODEL_CATALOG.map((model) => model.id),
          description: "Optional model id to switch to. If omitted, your current model is kept.",
        },
        triggers: {
          type: "array",
          description:
            "Optional. The COMPLETE list of your recurring schedule triggers — this replaces all current schedules. Omit to keep your current schedules unchanged; pass [] to remove them all. Only schedule (cron) triggers can be set here; any GitHub PR triggers are preserved automatically.",
          items: {
            type: "object",
            properties: {
              cron: {
                type: "string",
                description:
                  "Cron expression. Supported shapes only: '*/N * * * *' (every N minutes, N=1-59), '0 */N * * *' (every N hours, N in {1,2,3,4,6,8,12}), 'M H * * *' (daily at H:M), 'M H * * 1-5' (weekdays at H:M), or 'M H * * D' (weekly on day D=0-6 at H:M).",
              },
              prompt: {
                type: "string",
                description:
                  "The kickoff message for each scheduled run; a fresh session starts with this as its first user message.",
              },
              timezone: {
                type: "string",
                description: "Optional IANA timezone (e.g. 'America/New_York'). Defaults to UTC.",
              },
              enabled: {
                type: "boolean",
                description: "Whether the schedule is active. Defaults to false.",
              },
              id: {
                type: "string",
                description:
                  "Optional stable id. Auto-assigned (schedule-1, schedule-2, …) if omitted.",
              },
            },
            required: ["cron", "prompt"],
            additionalProperties: false,
          },
        },
        summary: {
          type: "string",
          description: "One-line description of what changed and why, for the activity log.",
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
    help: [
      'Read the full protocol first: read_skill({skillId:"agent-self-edit"}). It is the source of truth for how to self-edit, and this tool is rejected until you have read it.',
      "Pass the COMPLETE new Markdown body, not a diff.",
      "Changes apply from your next turn in this same session — no new session needed; just continue.",
    ].join("\n"),
  },
  {
    name: "ask_user_question",
    kind: "internal",
    description:
      'Pause and ask the user one or more structured questions when you genuinely cannot proceed without their input — a real decision, a missing requirement, or an ambiguity that changes the outcome. The run suspends until the user answers, so do not use this for things you can reasonably decide yourself, and never use it to narrate progress or ask for permission to use a tool. Prefer a single round of questions over many sequential pauses: batch everything you need now. Each question presents selectable options, plus a free-text "Other" answer that is always offered automatically — so you never need to add your own "other"/"something else" option, and you can give focused options knowing the user can always type their own. Set allowMultiple when several options can be chosen together. Keep headers to two or three words and questions to one clear sentence.',
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Between 1 and 4 questions to ask in a single pause.",
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                description: "Two or three word label for this question, shown as its title.",
              },
              question: {
                type: "string",
                description: "The full question, phrased as one clear sentence.",
              },
              options: {
                type: "array",
                description: "Between 2 and 6 selectable options.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Short option label shown to the user.",
                    },
                    description: {
                      type: "string",
                      description: "Optional one-line clarification of this option.",
                    },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
              allowMultiple: {
                type: "boolean",
                description: "Whether the user may select more than one option. Defaults to false.",
                default: false,
              },
            },
            required: ["header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    help: [
      "Use ask_user_question only when user input is genuinely required to proceed correctly.",
      "Batch every question you need into one call; the run pauses until the user answers.",
      'Set allowMultiple for multi-select questions; a free-text "Other" answer is always offered automatically, so do not add your own "other" option.',
      "Do not use it to narrate progress or to ask permission to run a tool.",
    ].join("\n"),
  },
  {
    name: "amp_coder",
    kind: "sandbox",
    configToolId: "amp",
    requiresAttachedRepository: true,
    description:
      "Delegate coding work to Amp in an attached GitHub repository. Amp clones the repository into ./work on demand. Use for multi-file implementation, debugging, refactors, and PR-ready code changes. When more than one repository is attached, set the repository argument.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Specific coding task for Amp to perform in the target repository.",
        },
        repository: {
          type: "string",
          description:
            "Target repository full name (owner/repo) or id. Required when more than one repository is attached; optional when exactly one is attached.",
        },
        createPullRequest: {
          type: "boolean",
          description:
            "Whether to commit changes to a generated branch and open a draft pull request after Amp finishes.",
          default: false,
        },
        pullRequestTitle: {
          type: "string",
          description: "Optional draft pull request title when createPullRequest is true.",
        },
        ampThreadId: {
          type: "string",
          description:
            "Existing ampThreadId from a previous amp_coder result to continue instead of starting a new Amp thread.",
        },
        mode: {
          type: "string",
          enum: ["smart", "large", "rush", "deep"],
          description:
            "Amp execution mode. Defaults to smart. Use large or deep for harder long-running coding tasks, and rush for latency-sensitive tasks.",
          default: "smart",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    help: [
      "Use amp_coder for substantial codebase work that benefits from Amp's coding-agent loop.",
      "Give Amp a concrete task and any constraints from the user or agent instructions.",
      "Set the repository argument (owner/repo or id) when more than one repository is attached so Amp targets the right one. Amp clones it into ./work on demand.",
      "When the user asks for a follow-up to prior Amp work, pass the previous ampThreadId so Amp continues that thread with its existing context.",
      "The tool output includes ampResult, ampStatus, ampThreadId, diffStat, diffPreview, and optional pullRequestUrl. Base your final response on ampResult when present.",
      "Amp has repository-scoped GitHub CLI and git push access for the attached repositories.",
      "Set createPullRequest=true only when the instructions call for a reviewable PR. Amp may create the PR itself; if it leaves publishable local work behind, the runner creates the draft PR after Amp finishes.",
      "The tool works on non-default branches and must never push directly to the default branch.",
    ].join("\n"),
  },
  {
    name: "opencode_coder",
    kind: "sandbox",
    configToolId: "opencode",
    description:
      "Delegate coding work to opencode in an attached GitHub repository or a public GitHub repository. opencode clones the repository into ./work on demand. Use for multi-file implementation, debugging, refactors, and PR-ready code changes. When more than one repository is attached, set the repository argument.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Specific coding task for opencode to perform in the target repository.",
        },
        repository: {
          type: "string",
          description:
            "Target attached repository full name/id, public GitHub owner/repo, or public https://github.com/owner/repo URL. Required when no repository is attached or more than one repository is attached; optional when exactly one repository is attached.",
        },
        model: {
          type: "string",
          description:
            "Optional model id (provider/model, e.g. anthropic/claude-sonnet-4.6) for opencode to use. Must be one of the platform's supported models. Defaults to the platform's opencode default when omitted.",
        },
        createPullRequest: {
          type: "boolean",
          description:
            "Whether to commit changes to a generated branch and open a draft pull request after opencode finishes.",
          default: false,
        },
        pullRequestTitle: {
          type: "string",
          description: "Optional draft pull request title when createPullRequest is true.",
        },
        opencodeSessionId: {
          type: "string",
          description:
            "Existing opencodeSessionId from a previous opencode_coder result to continue instead of starting a new opencode session.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    help: [
      "Use opencode_coder for substantial codebase work that benefits from opencode's coding-agent loop.",
      "Give opencode a concrete task and any constraints from the user or agent instructions.",
      "Set the repository argument (owner/repo or id) when more than one repository is attached so opencode targets the right one. If no repository is attached, set repository to a public GitHub owner/repo or https://github.com/owner/repo URL.",
      "Pass model only when the user or instructions call for a specific model; otherwise omit it to use the platform default.",
      "When the user asks for a follow-up to prior opencode work, pass the previous opencodeSessionId so opencode continues that session with its existing context.",
      "The tool output includes opencodeResult, opencodeStatus, opencodeSessionId, diffStat, diffPreview, and optional pullRequestUrl. Base your final response on opencodeResult when present.",
      "opencode has repository-scoped GitHub CLI and git push access for attached repositories. Public repositories are cloned without workspace GitHub credentials and return sandbox diffs only.",
      "Set createPullRequest=true only when the instructions call for a reviewable PR. opencode may create the PR itself for attached repositories; if it leaves publishable local work behind, the runner creates the draft PR after opencode finishes. Public repositories do not support platform-created pull requests.",
      "The tool works on non-default branches and must never push directly to the default branch.",
    ].join("\n"),
  },
];

// Shared parameter fragments for the Google (Gmail + Calendar) hosted tools.
const GOOGLE_ACCOUNT_PARAMETER = {
  type: "string",
  description:
    "Email of the connected Google account to act as. Omit when only one account is connected; required to disambiguate when several are connected.",
} as const;

const GOOGLE_CALENDAR_ID_PARAMETER = {
  type: "string",
  description: 'Calendar id. Defaults to "primary". Must be a workspace-selected calendar.',
  default: "primary",
} as const;

const GOOGLE_EVENT_TIME_PARAMETER = {
  type: "object",
  description:
    "Event time. Provide either dateTime (RFC3339, for timed events) or date (YYYY-MM-DD, for all-day events).",
  properties: {
    dateTime: { type: "string", description: "RFC3339 timestamp, e.g. 2026-06-05T15:00:00-07:00." },
    date: { type: "string", description: "All-day date in YYYY-MM-DD." },
    timeZone: { type: "string", description: "IANA time zone, e.g. America/Los_Angeles." },
  },
  additionalProperties: false,
} as const;

const GOOGLE_SEND_UPDATES_PARAMETER = {
  type: "string",
  enum: ["all", "externalOnly", "none"],
  description: "Who gets email notifications about the change. Defaults to none.",
  default: "none",
} as const;

export const HOSTED_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "exa_search",
    kind: "hosted",
    configToolId: "exa",
    description:
      "Search the live web with Exa. Start with one broad source-seeking query, then refine from results. For category=people/company, do not use date filters or excludeDomains; category=people includeDomains must be LinkedIn-only.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query. Use specific, source-seeking phrasing.",
        },
        numResults: {
          type: "number",
          description: "Number of results to return. Defaults to 5. Maximum 10 in this harness.",
          default: 5,
        },
        type: {
          type: "string",
          enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"],
          description: "Search mode. Defaults to auto.",
          default: "auto",
        },
        category: {
          type: "string",
          enum: [
            "company",
            "people",
            "research paper",
            "news",
            "personal site",
            "financial report",
          ],
          description:
            'Optional Exa vertical. Use "people" for professional profiles, founders, investors, executives, authors, or experts; use "company" for company homepages and profiles. People/company searches cannot combine with date filters or excludeDomains.',
        },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description:
            "Only return results from these domains. With category=people, use LinkedIn domains only.",
        },
        excludeDomains: {
          type: "array",
          items: { type: "string" },
          description:
            "Exclude results from these domains. Not supported with category=people or category=company.",
        },
        startPublishedDate: {
          type: "string",
          description:
            "ISO 8601 lower bound for published date. Not supported with category=people or category=company.",
        },
        endPublishedDate: {
          type: "string",
          description:
            "ISO 8601 upper bound for published date. Not supported with category=people or category=company.",
        },
        fresh: {
          type: "boolean",
          description: "Force fresh live-crawled content. Increases latency and cost.",
          default: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use exa_search when you need current web evidence, source discovery, company/person/news/research lookup, or citation-ready URLs.",
      "Defaults are type=auto, numResults=5, and highlights-only content to keep context small.",
      "Avoid launching many search calls at once. Inspect results before deciding whether more searches are useful.",
      "Use type=fast or instant only when latency matters more than depth. Use deep/deep-lite/deep-reasoning only for complex multi-source synthesis.",
      "Set fresh=true only for time-sensitive facts; it forces live crawling and can be slower.",
      'For people lookup, set category="people" and use queries like "Jane Doe investor fintech LinkedIn" or "founders at Acme AI"; do not use published-date filters or excludeDomains.',
      "For company and people categories, avoid excludeDomains and published date filters because Exa does not support those combinations. For people, includeDomains is only valid for LinkedIn domains.",
      'Prefer includeDomains for official-source lookups, for example includeDomains: ["sec.gov", "company.com"].',
      "After finding promising URLs, use exa_contents to extract clean page text, highlights, summaries, PDFs, JavaScript-rendered pages, or selected subpages.",
    ].join("\n"),
  },
  {
    name: "exa_contents",
    kind: "hosted",
    configToolId: "exa",
    description:
      "Extract clean LLM-ready content from known URLs with Exa. Use it after search or when the user provides URLs; it handles complex pages, JavaScript-rendered pages, PDFs, summaries, highlights, and subpage crawling better than a raw HTTP fetch.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description:
            "URLs to extract. Maximum 10 per call in this harness; keep batches small and focused.",
        },
        mode: {
          type: "string",
          enum: ["highlights", "text", "summary"],
          description:
            "Extraction mode. Use highlights for efficient evidence, text for full-page reading, and summary for source-level synthesis or structured extraction.",
          default: "highlights",
        },
        query: {
          type: "string",
          description:
            "Optional focus query for highlights or summary, such as the fact, section, or extraction target you care about.",
        },
        maxCharacters: {
          type: "number",
          description:
            "Character budget per URL for highlights or text. Defaults are conservative; raise only when full context matters.",
        },
        summarySchema: {
          type: "object",
          description:
            "Optional JSON Schema Draft 7 object for structured summary extraction. Only used with mode=summary.",
        },
        maxAgeHours: {
          type: "number",
          description:
            "Content freshness. Omit for Exa default cache with livecrawl fallback; 0 always livecrawls; -1 uses cache only; positive values use cache if newer than that many hours.",
        },
        subpages: {
          type: "number",
          description:
            "Number of linked subpages to crawl per URL. Start small, such as 3-5, when reading docs, company pages, or site sections.",
        },
        subpageTarget: {
          type: "array",
          items: { type: "string" },
          description:
            'Keywords that guide subpage selection, such as ["pricing", "docs", "careers", "api"].',
        },
        includeLinks: {
          type: "boolean",
          description: "Whether to ask Exa for extracted page links. Defaults to false.",
          default: false,
        },
      },
      required: ["urls"],
      additionalProperties: false,
    },
    help: [
      "Use exa_contents when you already have one or more URLs and need reliable page content, especially PDFs, docs pages, JavaScript-rendered pages, or pages where direct HTTP extraction may be poor.",
      "Use mode=highlights first for agent workflows; it returns source excerpts that are much more token-efficient than full text.",
      "Use mode=text when you must inspect the full page. Set maxCharacters to a bounded value such as 8000 or 15000.",
      "Use mode=summary for page-level synthesis or structured extraction. Add query to say what to summarize; add summarySchema only when you need JSON-shaped output.",
      "Use maxAgeHours=0 only when freshness is critical because livecrawl is slower and can cost more. Use maxAgeHours=-1 for static pages when speed matters.",
      "Use subpages with subpageTarget for docs, company sites, pricing pages, careers pages, or support sections. Start with 3-5 subpages before expanding.",
      "Check statuses in the output: Exa can return HTTP 200 while individual URLs fail to crawl.",
    ].join("\n"),
  },
  {
    name: "exa_answer",
    kind: "hosted",
    configToolId: "exa",
    description:
      "Ask Exa for a direct cited answer or short cited synthesis. Use it for quick factual questions or concise research answers when you want Exa to search and synthesize sources in one call.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language question or instruction. Ask a specific, answerable question and include constraints such as date, geography, or source preference.",
        },
        includeText: {
          type: "boolean",
          description:
            "Whether citations should include page text. Defaults to false to keep output compact.",
          default: false,
        },
        outputSchema: {
          type: "object",
          description:
            "Optional JSON Schema Draft 7 object for a structured answer instead of plain text.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use exa_answer for fast cited answers when the user asks a specific web-backed question and does not need you to manually inspect every source first.",
      "Prefer exa_search plus exa_contents when source selection, detailed evidence review, or multi-step investigation matters.",
      "Set includeText=true only when you need snippets from the cited pages; citation URLs and metadata are returned by default.",
      "Use outputSchema only for small structured answers. For larger extraction tasks across known URLs, use exa_contents mode=summary with summarySchema.",
    ].join("\n"),
  },
  {
    name: "x_search_posts",
    kind: "hosted",
    configToolId: "x",
    description:
      'Search public X posts through the official X API. Use recent search first for current conversations; mode="all" uses full-archive search and requires elevated X API access.',
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'X search query using X operators, such as "AI agents lang:en -is:retweet" or "from:openai".',
        },
        mode: {
          type: "string",
          enum: ["recent", "all"],
          description:
            'Search recent posts or the full archive. Defaults to recent. mode="all" requires elevated X API access and may fail with standard bearer tokens.',
          default: "recent",
        },
        maxResults: {
          type: "number",
          description:
            "Number of posts to return. Defaults to 10; ask the user before using larger values. Maximum 100.",
          default: 10,
        },
        paginationToken: {
          type: "string",
          description: "Optional next_token from a previous search result.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use x_search_posts to discover current public X conversations, hashtags, mentions, links, and posts from specific users.",
      'Start with maxResults=10 and mode="recent". Use larger values, pagination, or mode="all" only when the user explicitly asks for broader coverage and the token has needed access.',
      "The X API bills per returned Post and expanded User.",
      "The output includes normalized posts, author profiles, result count, and an optional nextToken for pagination.",
    ].join("\n"),
  },
  {
    name: "x_get_profile",
    kind: "hosted",
    configToolId: "x",
    description: "Look up a public X profile by username through the official X API.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "X username, with or without a leading @.",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    help: [
      "Use x_get_profile to inspect a public X account's bio, verification flags, profile images, and public metrics.",
      "Protected or suspended accounts may return limited data or provider errors.",
    ].join("\n"),
  },
  {
    name: "x_get_user_posts",
    kind: "hosted",
    configToolId: "x",
    description: "Fetch recent public posts from an X user timeline by username.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "X username, with or without a leading @.",
        },
        maxResults: {
          type: "number",
          description:
            "Number of posts to return. Defaults to 10; ask the user before using larger values. Maximum 100.",
          default: 10,
        },
        paginationToken: {
          type: "string",
          description: "Optional pagination_token from a previous timeline result.",
        },
        excludeReplies: {
          type: "boolean",
          description: "Whether to exclude reply posts. Defaults to false.",
          default: false,
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    help: [
      "Use x_get_user_posts to understand what a public profile has been posting recently.",
      "Start with maxResults=10. Use larger values or pagination only when the user explicitly asks for broader coverage.",
      "Set excludeReplies=true for a cleaner top-level timeline.",
      "The tool first resolves the username to a user id, then fetches that user's public posts.",
    ].join("\n"),
  },
  {
    name: "x_get_discussion",
    kind: "hosted",
    configToolId: "x",
    description:
      'Inspect a public X post discussion by fetching the target post, replies in its conversation, and quote posts. mode="all" requires elevated X API access for full-archive reply search.',
    parameters: {
      type: "object",
      properties: {
        postIdOrUrl: {
          type: "string",
          description: "X post ID or URL, such as https://x.com/user/status/123.",
        },
        mode: {
          type: "string",
          enum: ["recent", "all"],
          description:
            'Search recent replies or the full archive. Defaults to recent. mode="all" requires elevated X API access and may fail with standard bearer tokens.',
          default: "recent",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum replies and maximum quote posts to return per collection. Defaults to 10; ask the user before using larger values. Maximum 100.",
          default: 10,
        },
      },
      required: ["postIdOrUrl"],
      additionalProperties: false,
    },
    help: [
      "Use x_get_discussion when the user provides a post URL/id or asks what people are saying around one post.",
      'Start with maxResults=10 per collection and mode="recent". Use larger values or mode="all" only when the user explicitly asks for broader coverage and the token has needed access.',
      "The result includes the target post, replies from the same conversation, quote posts, and author profiles.",
      "This can be more expensive than a simple lookup because it may return many Posts.",
    ].join("\n"),
  },
  {
    name: "x_get_trends",
    kind: "hosted",
    configToolId: "x",
    description: "Fetch current X trending topics for a WOEID location.",
    parameters: {
      type: "object",
      properties: {
        woeid: {
          type: "number",
          description:
            "Yahoo Where On Earth ID. Defaults to 1 for worldwide; United States is 23424977.",
          default: 1,
        },
        maxResults: {
          type: "number",
          description:
            "Number of trends to return. Defaults to 10; ask the user before using larger values. Maximum 50.",
          default: 10,
        },
      },
      additionalProperties: false,
    },
    help: [
      "Use x_get_trends to answer what is currently trending on X in a broad location.",
      "Start with maxResults=10. Use larger values only when the user explicitly asks for broader coverage.",
      "Common WOEIDs: worldwide=1, United States=23424977, United Kingdom=23424975, New York=2459115, London=44418.",
    ].join("\n"),
  },
  {
    name: "youtube_search",
    kind: "hosted",
    configToolId: "youtube",
    description:
      "Search YouTube for videos, channels, and playlists by keyword, with optional filters for upload date, duration, and sort order.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query, e.g. 'transformer architecture explained'.",
        },
        type: {
          type: "string",
          enum: ["all", "video", "channel", "playlist", "movie"],
          description: "Restrict results to a content type. Defaults to video.",
          default: "video",
        },
        uploadDate: {
          type: "string",
          enum: ["all", "hour", "today", "week", "month", "year"],
          description: "Filter videos by upload recency. Only applies to videos.",
        },
        duration: {
          type: "string",
          enum: ["short", "medium", "long"],
          description:
            "Filter videos by length: short (<4min), medium (4-20min), long (>20min). Only applies to videos.",
        },
        sortBy: {
          type: "string",
          enum: ["relevance", "rating", "date", "views"],
          description: "Sort order of results. Defaults to relevance.",
          default: "relevance",
        },
        limit: {
          type: "number",
          description:
            "Number of results to return. Defaults to 10; ask the user before requesting larger values. Maximum 50.",
          default: 10,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use youtube_search to discover videos, channels, or playlists for a topic before fetching transcripts or metadata.",
      "Start with type='video' and limit=10. Narrow with uploadDate and duration when the user wants recent or long-form content.",
      "Each result includes its id, title, channel, and (for videos) viewCount and uploadDate. Pass a video id to youtube_get_transcript or youtube_get_video next.",
    ].join("\n"),
  },
  {
    name: "youtube_get_video",
    kind: "hosted",
    configToolId: "youtube",
    description:
      "Get metadata for a single YouTube video: title, description, channel, duration, view and like counts, tags, and available transcript languages.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "YouTube video URL or 11-character video id (e.g. dQw4w9WgXcQ).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    help: [
      "Use youtube_get_video to inspect a single video's metadata before deciding whether to read its transcript.",
      "transcriptLanguages lists the languages available to youtube_get_transcript.",
    ].join("\n"),
  },
  {
    name: "youtube_get_transcript",
    kind: "hosted",
    configToolId: "youtube",
    description:
      "Get the full transcript of a YouTube video as text so you can read what was said. Falls back to AI-generated transcription when no captions exist.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "YouTube video URL. Provide either url or videoId.",
        },
        videoId: {
          type: "string",
          description: "YouTube video id. Provide either url or videoId.",
        },
        lang: {
          type: "string",
          description:
            "Preferred transcript language as an ISO 639-1 code (e.g. 'en'). Defaults to the first available language.",
        },
        text: {
          type: "boolean",
          description:
            "When true (default), return one plain-text transcript. When false, return timestamped chunks.",
          default: true,
        },
      },
      required: [],
      additionalProperties: false,
    },
    help: [
      "Use youtube_get_transcript to read the spoken content of a video. This is the main way to 'watch' a video as text.",
      "Provide either url or videoId (one is required). Use lang when you need a specific language; check transcriptLanguages from youtube_get_video first.",
      "Keep text=true for summarization. Set text=false only when you need timestamps to cite specific moments.",
      "When the video has no captions, Supadata generates a transcript, which costs more and may take longer.",
    ].join("\n"),
  },
  {
    name: "youtube_get_channel",
    kind: "hosted",
    configToolId: "youtube",
    description:
      "Get metadata for a YouTube channel: name, description, subscriber count, video count, total views, and thumbnails.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "YouTube channel URL, @handle, or channel id.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    help: [
      "Use youtube_get_channel to look up a creator's audience size and focus.",
      "Pair with youtube_list_channel_videos to see what the channel has published recently.",
    ].join("\n"),
  },
  {
    name: "youtube_list_channel_videos",
    kind: "hosted",
    configToolId: "youtube",
    description:
      "List recent video ids for a YouTube channel so you can fetch their metadata or transcripts.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "YouTube channel URL, @handle, or channel id.",
        },
        limit: {
          type: "number",
          description:
            "Number of video ids to return. Defaults to 20; ask the user before requesting larger values. Maximum 50.",
          default: 20,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    help: [
      "Use youtube_list_channel_videos to enumerate a channel's latest uploads, then pass each id to youtube_get_video or youtube_get_transcript.",
      "This returns ids only; call youtube_get_video for titles and metadata.",
    ].join("\n"),
  },
  {
    name: "tiktok_get_profile",
    kind: "hosted",
    configToolId: "tiktok",
    description:
      "Get a normalized public TikTok profile by handle, username, or profile URL, including bio, avatar, verification, and public stats.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description:
            "TikTok username, @handle, or profile URL. Public profiles only; no login or private profile access.",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_get_profile when the user mentions a TikTok handle or profile URL.",
      "This returns a normalized public Profile object with sourceProvider, sourceUrl, and fetchedAt.",
      "It does not scrape follower/following lists, private profiles, login-gated data, emails, or phone numbers.",
    ].join("\n"),
  },
  {
    name: "tiktok_list_profile_posts",
    kind: "hosted",
    configToolId: "tiktok",
    description:
      "List recent public TikTok videos for a profile, normalized as posts with caption, author, media URL, stats, hashtags, and publish time.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "TikTok username, @handle, or profile URL.",
        },
        limit: {
          type: "number",
          description: "Number of videos to return. Defaults to 12. Maximum 50.",
          default: 12,
        },
        runMode: {
          type: "string",
          enum: ["sync", "async"],
          description:
            "Use sync for small bounded calls. Use async to start a provider job and poll with social_get_job.",
          default: "sync",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_list_profile_posts for recent videos from a public profile.",
      "Default limit is 12 and hard cap is 50. For bigger or slower jobs, set runMode=async and poll social_get_job.",
      "Pass returned video URLs to tiktok_get_transcript when you need spoken content.",
    ].join("\n"),
  },
  {
    name: "tiktok_get_video",
    kind: "hosted",
    configToolId: "tiktok",
    description:
      "Get normalized metadata for one public TikTok video URL using the social scraping provider.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public TikTok video URL, e.g. https://www.tiktok.com/@user/video/123.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_get_video for one public video when you want the normalized social Post shape.",
      "Use tiktok_get_transcript for spoken transcript content; transcripts remain backed by Supadata.",
    ].join("\n"),
  },
  {
    name: "tiktok_get_comments",
    kind: "hosted",
    configToolId: "tiktok",
    description: "Get top public comments for one public TikTok video URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public TikTok video URL." },
        limit: {
          type: "number",
          description: "Number of comments to return. Defaults to 25. Maximum 50.",
          default: 25,
        },
        runMode: {
          type: "string",
          enum: ["sync", "async"],
          description:
            "Use sync for small bounded calls. Use async to start a provider job and poll with social_get_job.",
          default: "sync",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_get_comments to inspect public discussion on a specific video.",
      "Default limit is 25 and hard cap is 50. The tool does not bypass login gates or private content.",
    ].join("\n"),
  },
  {
    name: "tiktok_search",
    kind: "hosted",
    configToolId: "tiktok",
    description: "Search public TikTok content by keyword and return normalized public videos.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: {
          type: "number",
          description: "Number of results to return. Defaults to 10. Maximum 50.",
          default: 10,
        },
        runMode: {
          type: "string",
          enum: ["sync", "async"],
          description:
            "Use sync for small bounded calls. Use async to start a provider job and poll with social_get_job.",
          default: "sync",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_search for public TikTok keyword discovery.",
      "Default limit is 10 and hard cap is 50. Search results are normalized as public Post objects.",
    ].join("\n"),
  },
  {
    name: "tiktok_get_metadata",
    kind: "hosted",
    configToolId: "tiktok",
    description:
      "Get unified metadata for a public TikTok video: title or caption, author, engagement stats, media details, tags, and publish time.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public TikTok video URL, e.g. https://www.tiktok.com/@user/video/123.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_get_metadata to inspect a public TikTok video's creator, caption, media details, and engagement before reading its transcript.",
      "This tool needs a direct video URL. TikTok profile handles and profile URLs are not supported by the Supadata integration.",
      "Only public URLs that can be viewed without signing in are supported.",
    ].join("\n"),
  },
  {
    name: "tiktok_get_transcript",
    kind: "hosted",
    configToolId: "tiktok",
    description:
      "Get or poll for the transcript of a public TikTok video as text or timestamped chunks via Supadata.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public TikTok video URL. Provide either url or jobId.",
        },
        jobId: {
          type: "string",
          description: "Supadata transcript job id returned by an earlier transcript request.",
        },
        lang: {
          type: "string",
          description:
            "Preferred transcript language as an ISO 639-1 code (e.g. 'en'). Ignored when polling by jobId.",
        },
        text: {
          type: "boolean",
          description:
            "When true (default), return one plain-text transcript. When false, return timestamped chunks.",
          default: true,
        },
        mode: {
          type: "string",
          enum: ["native", "auto", "generate"],
          description:
            "Transcript mode. Defaults to auto; use native to avoid AI-generated transcript cost.",
          default: "auto",
        },
        chunkSize: {
          type: "number",
          description:
            "Maximum characters per transcript chunk when text=false. Defaults to Supadata's setting; valid range 50-10000.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    help: [
      "Use tiktok_get_transcript to read what is said in a public TikTok video.",
      "Provide either url or jobId. URL requests may return a jobId for longer generated transcripts; call this tool again with jobId to poll.",
      "This tool needs a direct video URL. TikTok profile handles and profile URLs are not supported by the Supadata integration.",
      "Keep text=true for summarization. Set text=false only when timestamps matter.",
    ].join("\n"),
  },
  {
    name: "instagram_get_profile",
    kind: "hosted",
    configToolId: "instagram",
    description:
      "Get a normalized public Instagram profile by username, handle, or profile URL, including bio, avatar, verification, public links, and public stats.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description:
            "Instagram username, @handle, or profile URL. Public profiles only; no login or private profile access.",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    help: [
      "Use instagram_get_profile when the user mentions an Instagram handle or profile URL.",
      "This returns a normalized public Profile object with sourceProvider, sourceUrl, and fetchedAt.",
      "It does not scrape follower/following lists, private profiles, login-gated data, emails, or phone numbers.",
    ].join("\n"),
  },
  {
    name: "instagram_list_profile_posts",
    kind: "hosted",
    configToolId: "instagram",
    description:
      "List recent public Instagram posts and reels for a profile, normalized as posts with caption, author, media, stats, hashtags, and publish time.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Instagram username, @handle, or profile URL.",
        },
        limit: {
          type: "number",
          description: "Number of posts/reels to return. Defaults to 12. Maximum 50.",
          default: 12,
        },
        runMode: {
          type: "string",
          enum: ["sync", "async"],
          description:
            "Use sync for small bounded calls. Use async to start a provider job and poll with social_get_job.",
          default: "sync",
        },
      },
      required: ["username"],
      additionalProperties: false,
    },
    help: [
      "Use instagram_list_profile_posts for recent public posts or reels from a profile.",
      "Default limit is 12 and hard cap is 50. For bigger or slower jobs, set runMode=async and poll social_get_job.",
      "Pass returned reel/video URLs to instagram_get_transcript when you need spoken content.",
    ].join("\n"),
  },
  {
    name: "instagram_get_post",
    kind: "hosted",
    configToolId: "instagram",
    description:
      "Get normalized metadata for one public Instagram post, reel, video, or carousel URL using the social scraping provider.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Public Instagram post, reel, or video URL, e.g. https://www.instagram.com/reel/ABC123/.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Use instagram_get_post for one public Instagram media URL when you want the normalized social Post shape.",
      "Use instagram_get_transcript for spoken transcript content; transcripts remain backed by Supadata.",
    ].join("\n"),
  },
  {
    name: "instagram_get_comments",
    kind: "hosted",
    configToolId: "instagram",
    description: "Get top public comments for one public Instagram post, reel, or video URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public Instagram post, reel, or video URL." },
        limit: {
          type: "number",
          description: "Number of comments to return. Defaults to 25. Maximum 50.",
          default: 25,
        },
        runMode: {
          type: "string",
          enum: ["sync", "async"],
          description:
            "Use sync for small bounded calls. Use async to start a provider job and poll with social_get_job.",
          default: "sync",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Use instagram_get_comments to inspect public discussion on a specific post or reel.",
      "Default limit is 25 and hard cap is 50. The tool does not bypass login gates or private content.",
    ].join("\n"),
  },
  {
    name: "instagram_search_profiles",
    kind: "hosted",
    configToolId: "instagram",
    description: "Search public Instagram profiles by keyword and return normalized profiles.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Profile search query." },
        limit: {
          type: "number",
          description: "Number of profiles to return. Defaults to 10. Maximum 50.",
          default: 10,
        },
        runMode: {
          type: "string",
          enum: ["sync", "async"],
          description:
            "Use sync for small bounded calls. Use async to start a provider job and poll with social_get_job.",
          default: "sync",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    help: [
      "Use instagram_search_profiles for public Instagram profile discovery.",
      "Default limit is 10 and hard cap is 50. Results are normalized Profile objects.",
    ].join("\n"),
  },
  {
    name: "instagram_get_metadata",
    kind: "hosted",
    configToolId: "instagram",
    description:
      "Get unified metadata for a public Instagram reel, video, post, or carousel: caption, author, engagement stats, media details, tags, and publish time.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Public Instagram post, reel, or video URL, e.g. https://www.instagram.com/reel/ABC123/.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Use instagram_get_metadata to inspect a public Instagram post, reel, or video before reading its transcript.",
      "This tool needs a direct post, reel, or video URL. Instagram profile handles and profile URLs are not supported by the Supadata integration.",
      "Only public URLs that can be viewed without signing in are supported.",
    ].join("\n"),
  },
  {
    name: "instagram_get_transcript",
    kind: "hosted",
    configToolId: "instagram",
    description:
      "Get or poll for the transcript of a public Instagram reel or video as text or timestamped chunks via Supadata.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public Instagram reel or video URL. Provide either url or jobId.",
        },
        jobId: {
          type: "string",
          description: "Supadata transcript job id returned by an earlier transcript request.",
        },
        lang: {
          type: "string",
          description:
            "Preferred transcript language as an ISO 639-1 code (e.g. 'en'). Ignored when polling by jobId.",
        },
        text: {
          type: "boolean",
          description:
            "When true (default), return one plain-text transcript. When false, return timestamped chunks.",
          default: true,
        },
        mode: {
          type: "string",
          enum: ["native", "auto", "generate"],
          description:
            "Transcript mode. Defaults to auto; use native to avoid AI-generated transcript cost.",
          default: "auto",
        },
        chunkSize: {
          type: "number",
          description:
            "Maximum characters per transcript chunk when text=false. Defaults to Supadata's setting; valid range 50-10000.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    help: [
      "Use instagram_get_transcript to read what is said in a public Instagram reel or video.",
      "Provide either url or jobId. URL requests may return a jobId for longer generated transcripts; call this tool again with jobId to poll.",
      "This tool needs a direct reel or video URL. Instagram profile handles and profile URLs are not supported by the Supadata integration.",
      "Keep text=true for summarization. Set text=false only when timestamps matter.",
    ].join("\n"),
  },
  {
    name: "social_get_job",
    kind: "hosted",
    sharedConfigToolIds: ["instagram", "tiktok"],
    description:
      "Poll an async Instagram or TikTok social scraping job started by a profile, feed, comments, or search tool.",
    parameters: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job id returned by a prior Instagram or TikTok social scraping tool.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    help: [
      "Use social_get_job only for job ids returned by Instagram/TikTok tools with runMode=async.",
      "When status is processing, wait before polling again. When completed, results are returned in the same normalized shape as the original tool.",
    ].join("\n"),
  },
  {
    name: "web_fetch",
    kind: "hosted",
    configToolId: "exa",
    description:
      "Fetch a single web page URL and return compact readable text plus absolute links found on the page.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTP or HTTPS page URL to fetch.",
        },
        maxCharacters: {
          type: "number",
          description:
            "Maximum readable text characters to return. Defaults to 12000. Maximum 20000.",
          default: 12000,
        },
        includeLinks: {
          type: "boolean",
          description: "Whether to include normalized links from the page. Defaults to true.",
          default: true,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    help: [
      "Prefer exa_contents for robust extraction from known URLs when @exa is enabled. Use web_fetch as a free direct-HTTP fallback for simple HTML/text pages, or when you specifically need raw page links from a normal HTTP fetch.",
      "It does not run a browser. It performs a direct HTTP fetch, extracts readable text from HTML, and returns absolute links so you can fetch a follow-up page.",
      "Use it for articles, docs pages, company pages, and other mostly-readable pages. It may not work for JavaScript-rendered apps, PDFs, login-gated pages, or pages that block automated HTTP clients.",
      "Keep maxCharacters modest unless you need more context. The default is designed to avoid flooding the model context.",
    ].join("\n"),
  },
  {
    name: "gmail_list_messages",
    kind: "hosted",
    configToolId: "gmail",
    description:
      "List recent Gmail messages (id + snippet) from a connected Google account. Read-only.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        maxResults: {
          type: "number",
          description: "How many messages to return. Defaults to 20. Maximum 100.",
          default: 20,
        },
        labelIds: {
          type: "array",
          items: { type: "string" },
          description: 'Only include messages with these Gmail label ids (e.g. "INBOX", "UNREAD").',
        },
        query: {
          type: "string",
          description: "Optional Gmail search query (same syntax as the Gmail search box).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gmail_search",
    kind: "hosted",
    configToolId: "gmail",
    description:
      "Search Gmail with the standard Gmail query syntax (e.g. 'from:jane after:2026/01/01 invoice'). Read-only.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        query: { type: "string", description: "Gmail search query string." },
        maxResults: {
          type: "number",
          description: "How many messages to return. Defaults to 20. Maximum 100.",
          default: 20,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_get_message",
    kind: "hosted",
    configToolId: "gmail",
    description:
      "Fetch a single Gmail message by id, returning headers, snippet, and decoded plain-text body. Read-only.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        messageId: { type: "string", description: "Gmail message id." },
        format: {
          type: "string",
          enum: ["full", "metadata"],
          description: "full returns the body; metadata returns only headers. Defaults to full.",
          default: "full",
        },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_list_threads",
    kind: "hosted",
    configToolId: "gmail",
    description: "List Gmail threads (id + snippet), optionally filtered by a query. Read-only.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        query: { type: "string", description: "Optional Gmail search query." },
        maxResults: {
          type: "number",
          description: "How many threads to return. Defaults to 20. Maximum 100.",
          default: 20,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gmail_get_thread",
    kind: "hosted",
    configToolId: "gmail",
    description:
      "Fetch a Gmail thread by id, returning each message's headers and body. Read-only.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        threadId: { type: "string", description: "Gmail thread id." },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_list_labels",
    kind: "hosted",
    configToolId: "gmail",
    description: "List the Gmail labels available on the connected account. Read-only.",
    parameters: {
      type: "object",
      properties: { account: GOOGLE_ACCOUNT_PARAMETER },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_list_calendars",
    kind: "hosted",
    configToolId: "google_calendar",
    description:
      "List the calendars agents may use on the connected Google account (only workspace-selected calendars are accessible).",
    parameters: {
      type: "object",
      properties: { account: GOOGLE_ACCOUNT_PARAMETER },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_list_events",
    kind: "hosted",
    configToolId: "google_calendar",
    description: "List events on a calendar within an optional time window.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        calendarId: GOOGLE_CALENDAR_ID_PARAMETER,
        timeMin: {
          type: "string",
          description: "RFC3339 lower bound for event start (e.g. 2026-06-01T00:00:00Z).",
        },
        timeMax: { type: "string", description: "RFC3339 upper bound for event start." },
        query: { type: "string", description: "Free-text search over event fields." },
        maxResults: {
          type: "number",
          description: "How many events to return. Defaults to 25. Maximum 250.",
          default: 25,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_get_event",
    kind: "hosted",
    configToolId: "google_calendar",
    description: "Fetch a single calendar event by id.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        calendarId: GOOGLE_CALENDAR_ID_PARAMETER,
        eventId: { type: "string", description: "Calendar event id." },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_get_freebusy",
    kind: "hosted",
    configToolId: "google_calendar",
    description: "Return busy time ranges for one or more calendars within a window.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        timeMin: { type: "string", description: "RFC3339 start of the window." },
        timeMax: { type: "string", description: "RFC3339 end of the window." },
        calendarIds: {
          type: "array",
          items: { type: "string" },
          description: 'Calendar ids to query. Defaults to ["primary"].',
        },
      },
      required: ["timeMin", "timeMax"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event",
    kind: "hosted",
    configToolId: "google_calendar",
    description: "Create a calendar event. Writes to the connected Google account.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        calendarId: GOOGLE_CALENDAR_ID_PARAMETER,
        summary: { type: "string", description: "Event title." },
        description: { type: "string", description: "Event description / notes." },
        location: { type: "string", description: "Event location." },
        start: GOOGLE_EVENT_TIME_PARAMETER,
        end: GOOGLE_EVENT_TIME_PARAMETER,
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses to invite.",
        },
        sendUpdates: GOOGLE_SEND_UPDATES_PARAMETER,
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_update_event",
    kind: "hosted",
    configToolId: "google_calendar",
    description:
      "Update fields on an existing calendar event (only provided fields change). Writes to the connected account.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        calendarId: GOOGLE_CALENDAR_ID_PARAMETER,
        eventId: { type: "string", description: "Calendar event id to update." },
        summary: { type: "string", description: "New event title." },
        description: { type: "string", description: "New description." },
        location: { type: "string", description: "New location." },
        start: GOOGLE_EVENT_TIME_PARAMETER,
        end: GOOGLE_EVENT_TIME_PARAMETER,
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Replacement attendee email addresses.",
        },
        sendUpdates: GOOGLE_SEND_UPDATES_PARAMETER,
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_delete_event",
    kind: "hosted",
    configToolId: "google_calendar",
    description: "Delete a calendar event by id. Writes to the connected account.",
    parameters: {
      type: "object",
      properties: {
        account: GOOGLE_ACCOUNT_PARAMETER,
        calendarId: GOOGLE_CALENDAR_ID_PARAMETER,
        eventId: { type: "string", description: "Calendar event id to delete." },
        sendUpdates: GOOGLE_SEND_UPDATES_PARAMETER,
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "neon_list_databases",
    kind: "hosted",
    configToolId: "neon",
    description:
      "List the Neon project/branch/database resources connected to this workspace. Read-only.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    help: [
      "Use this first when you need to choose a Neon database resource.",
      "The returned database id is the stable resource id to pass to other Neon tools.",
      "Connection strings and API keys are never returned.",
    ].join("\n"),
  },
  {
    name: "neon_describe_schema",
    kind: "hosted",
    configToolId: "neon",
    description:
      "Describe schemas, tables, columns, primary keys, foreign keys, and indexes for a connected Neon database. Read-only.",
    parameters: {
      type: "object",
      properties: {
        databaseId: {
          type: "string",
          description: "Connected Neon database resource id from neon_list_databases.",
        },
        schema: {
          type: "string",
          description: "Optional schema name filter. Defaults to all non-system schemas.",
        },
      },
      required: ["databaseId"],
      additionalProperties: false,
    },
  },
  {
    name: "neon_run_sql",
    kind: "hosted",
    configToolId: "neon",
    description:
      "Run one SQL statement against a connected Neon database. The runner classifies SQL before execution: SELECT/SHOW/WITH reads are read permission; INSERT/UPDATE/DELETE/MERGE/CALL are modify; DDL, transaction control, role/security, COPY, VACUUM, and other admin statements require admin approval.",
    parameters: {
      type: "object",
      properties: {
        databaseId: {
          type: "string",
          description: "Connected Neon database resource id from neon_list_databases.",
        },
        sql: {
          type: "string",
          description:
            "Exactly one SQL statement. Do not include secrets. Multi-statement input is blocked.",
        },
        limit: {
          type: "number",
          description:
            "Maximum returned rows for read queries. Defaults to 100 and is capped by the runner.",
          default: 100,
        },
      },
      required: ["databaseId", "sql"],
      additionalProperties: false,
    },
    help: [
      "Use neon_run_sql for direct SQL after selecting a database id with neon_list_databases.",
      "Submit exactly one statement. The runner rejects multi-statement input.",
      "Read queries return a capped number of rows. Mutating and admin statements return row count / command metadata only.",
      "Never ask for or print connection strings; this tool resolves them internally.",
    ].join("\n"),
  },
  {
    name: "neon_explain_sql",
    kind: "hosted",
    configToolId: "neon",
    description:
      "Run EXPLAIN for one SQL statement against a connected Neon database. Read-only by default; EXPLAIN ANALYZE is blocked because it can execute the statement.",
    parameters: {
      type: "object",
      properties: {
        databaseId: {
          type: "string",
          description: "Connected Neon database resource id from neon_list_databases.",
        },
        sql: {
          type: "string",
          description:
            "Exactly one SQL statement to explain. Do not include the leading EXPLAIN keyword.",
        },
      },
      required: ["databaseId", "sql"],
      additionalProperties: false,
    },
  },
  {
    name: "neon_create_branch",
    kind: "hosted",
    configToolId: "neon",
    description:
      "Create a Neon branch in a connected project. Admin operation; approval is required unless workspace policy explicitly allows Neon admin actions.",
    parameters: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Neon project id visible in a connected database resource.",
        },
        name: { type: "string", description: "New branch name." },
        parentBranchId: {
          type: "string",
          description: "Optional parent branch id. Defaults to Neon's project default branch.",
        },
      },
      required: ["projectId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "neon_delete_branch",
    kind: "hosted",
    configToolId: "neon",
    description:
      "Delete a Neon branch in a connected project. Admin operation; approval is required unless workspace policy explicitly allows Neon admin actions.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Connected Neon project id." },
        branchId: { type: "string", description: "Branch id to delete." },
      },
      required: ["projectId", "branchId"],
      additionalProperties: false,
    },
  },
  {
    name: "neon_reset_branch",
    kind: "hosted",
    configToolId: "neon",
    description:
      "Reset a Neon branch from its parent. Admin operation; approval is required unless workspace policy explicitly allows Neon admin actions.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Connected Neon project id." },
        branchId: { type: "string", description: "Branch id to reset from its parent." },
      },
      required: ["projectId", "branchId"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_help",
    kind: "hosted",
    description:
      "Return detailed instructions for an enabled runtime tool without bloating context.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Enabled tool name to get help for, such as exa_search.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
  {
    name: "find_tools",
    kind: "hosted",
    description:
      "List the tools available for a capability — their names, descriptions, and input schemas — so you can then run one with use_tool. Tools beyond the core file/shell set are not preloaded; discover them here first. For a single tool's detailed usage instructions, call tool_help({ tool }) before invoking it. Read-only.",
    parameters: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description:
            'Optional capability id to list, as shown in the Tools index (e.g. "instagram", "exa", "amp"). Omit to list every available tool.',
        },
        query: {
          type: "string",
          description:
            "Optional case-insensitive substring filter over tool names and descriptions — NOT a search topic. Ignored when `capability` is set (that already lists the capability's tools).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "discover_capabilities",
    kind: "hosted",
    description:
      "List capabilities you could add to yourself but have not enabled yet — the opinionated tools beyond what is already in your ## Tools index. Each result reports whether it is already enabled, available to enable now, or needs setup first, plus how to enable it. Use this when a task needs something you cannot currently do; then confirm with the user and enable it via self-edit. Read-only — discovering a capability does not enable it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Optional case-insensitive substring filter over capability ids, labels, and descriptions (e.g. "web", "video", "email"). Omit to list every capability.',
        },
      },
      additionalProperties: false,
    },
  },
];

export const RUNTIME_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  ...CORE_TOOL_DEFINITIONS,
  ...HOSTED_TOOL_DEFINITIONS,
];

export const RUNTIME_TOOL_DEFINITION_BY_NAME = new Map(
  RUNTIME_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

export function getRuntimeToolDefinition(
  name: RuntimeToolName,
  context: RuntimeToolDefinitionContext = {},
): RuntimeToolDefinition | undefined {
  const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(name);
  if (!definition) return undefined;
  return renderRuntimeToolDefinition(definition, context);
}

export function getRuntimeToolDefinitions(
  context: RuntimeToolDefinitionContext = {},
): RuntimeToolDefinition[] {
  return RUNTIME_TOOL_DEFINITIONS.map((definition) =>
    renderRuntimeToolDefinition(definition, context),
  );
}

function renderRuntimeToolDefinition(
  definition: RuntimeToolDefinition,
  context: RuntimeToolDefinitionContext,
): RuntimeToolDefinition {
  if (!context.personalAgent) return definition;

  if (definition.name === "shell") {
    return {
      ...definition,
      description:
        "Run a shell command from the session workspace root, where ./work, ./personal-brain, ./agent, and ./skills are visible. Personal shell commands cannot access memory/; use the memory tool for structured memory. Use the gh tool, not shell, for authenticated GitHub operations.",
    };
  }

  if (
    definition.name === "read_file" ||
    definition.name === "edit_file" ||
    definition.name === "write_file" ||
    definition.name === "list_files"
  ) {
    return renderPersonalFileToolDefinition(definition);
  }

  if (definition.name === "memory") {
    const help = definition.help?.replaceAll("agent/memory/", "memory/");
    return {
      ...definition,
      description:
        "Run the structured `memory` CLI over memory/ — create canonical objects, append cited evidence, rewrite compiled truth, and run hybrid retrieval. This is the only way to read or write structured memory; never edit files under memory/ directly. Pass the subcommand and flags via args (e.g. 'query \"acme blockers\"').",
      ...(help ? { help } : {}),
    };
  }

  return definition;
}

function renderPersonalFileToolDefinition(
  definition: RuntimeToolDefinition,
): RuntimeToolDefinition {
  const pathDescription = "Relative path starting with work/, personal-brain/, or agent/.";
  const parameters = {
    ...definition.parameters,
    properties: {
      ...definition.parameters.properties,
      path: {
        ...(definition.parameters.properties.path as Record<string, unknown>),
        description: pathDescription,
      },
    },
  };

  if (definition.name === "read_file") {
    return {
      ...definition,
      description:
        "Read a UTF-8 text file from ./work, ./personal-brain, or ./agent. The path must start with work/, personal-brain/, or agent/. Use the memory tool for structured memory; generic file tools cannot access memory/.",
      parameters,
    };
  }
  if (definition.name === "edit_file") {
    return {
      ...definition,
      description:
        "Apply targeted exact-string replacements to an existing UTF-8 text file inside ./work, ./personal-brain, or ./agent. Use this for partial edits; use write_file only for new files or intentional full overwrites. Use the memory tool for structured memory; generic file tools cannot access memory/.",
      parameters,
    };
  }
  if (definition.name === "write_file") {
    return {
      ...definition,
      description:
        "Create or overwrite a UTF-8 text file inside ./work, ./personal-brain, or ./agent. Use edit_file for targeted changes to existing files. The path must start with work/, personal-brain/, or agent/. Use the memory tool for structured memory; generic file tools cannot access memory/.",
      parameters,
    };
  }
  return {
    ...definition,
    description:
      "List files and directories below ./work, ./personal-brain, or ./agent. The path must start with work/, personal-brain/, or agent/. Use the memory tool for structured memory; generic file tools cannot access memory/.",
    parameters,
  };
}

export function resolveRuntimeToolNamesForConfigTools(input: {
  tools: ReadonlyArray<{ id?: unknown }> | undefined;
  agents?: ReadonlyArray<unknown> | undefined;
  repositories?: ReadonlyArray<unknown> | undefined;
  // Live `@github` all-repositories scope: counts as having an attached repository, so it
  // unlocks the same repo-gated runtime tools (e.g. gh) as an explicit attachment.
  allRepositories?: boolean;
  // Skill-gated tools. `update_agent_file` is only exposed when the self-edit skill is on;
  // `memory` only when the memory skill is on.
  selfEditEnabled?: boolean;
  memorySkillEnabled?: boolean;
  // The inbox tools are hard-gated to the user's personal/default agent so team agents never
  // post to a personal inbox. The runner passes `row.agent.isDefault`.
  personalInboxEnabled?: boolean;
}) {
  const hasAttachedRepository =
    (input.repositories ?? []).length > 0 || input.allRepositories === true;
  const names = new Set<RuntimeToolName>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    // Skill- and reference-gated tools are added below, not unconditionally.
    if (
      tool.name === "delegate_to_agent" ||
      tool.name === "update_agent_file" ||
      tool.name === "memory" ||
      tool.name === "recall" ||
      tool.name === "inbox_list" ||
      tool.name === "inbox_add" ||
      tool.name === "inbox_update" ||
      tool.name === "fetch_transcript"
    ) {
      continue;
    }
    // Unconditional core tools (no configToolId) are always available, except
    // those gated on an attached repository (e.g. gh).
    if (tool.configToolId) continue;
    if (tool.requiresAttachedRepository && !hasAttachedRepository) continue;
    names.add(tool.name);
  }
  names.add("tool_help");
  names.add("find_tools");
  names.add("discover_capabilities");
  if (input.selfEditEnabled) {
    names.add("update_agent_file");
  }
  if (input.memorySkillEnabled) {
    names.add("memory");
    names.add("recall");
    names.add("fetch_transcript");
  }
  if (input.personalInboxEnabled) {
    names.add("inbox_list");
    names.add("inbox_add");
    names.add("inbox_update");
  }

  const selectedToolIds = new Set(
    (input.tools ?? []).flatMap((tool) => (typeof tool.id === "string" ? [tool.id] : [])),
  );
  for (const selectedToolId of selectedToolIds) {
    const agentTool = AGENT_TOOL_DEFINITION_BY_ID.get(selectedToolId as AgentToolId);
    if (!agentTool) continue;
    for (const runtimeToolName of agentTool.runtimeTools) {
      const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(runtimeToolName);
      if (
        definition &&
        isRuntimeToolEnabledByConfig(definition, selectedToolIds, hasAttachedRepository)
      ) {
        names.add(definition.name);
      }
    }
  }

  if ((input.agents ?? []).length > 0) {
    names.add("delegate_to_agent");
  }

  return Array.from(names);
}

function isRuntimeToolEnabledByConfig(
  definition: RuntimeToolDefinition,
  selectedToolIds: Set<string>,
  hasAttachedRepository: boolean,
) {
  const configuredBy =
    (definition.configToolId ? selectedToolIds.has(definition.configToolId) : false) ||
    (definition.sharedConfigToolIds ?? []).some((toolId) => selectedToolIds.has(toolId));
  if (!configuredBy) return false;
  if (definition.requiresAttachedRepository && !hasAttachedRepository) return false;
  return true;
}

export function getRuntimeToolHelp(
  toolName: string,
  enabledTools: readonly RuntimeToolName[],
  context: RuntimeToolDefinitionContext = {},
) {
  if (!enabledTools.includes(toolName as RuntimeToolName)) return null;
  const definition = getRuntimeToolDefinition(toolName as RuntimeToolName, context);
  if (!definition) return null;

  return {
    tool: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    help:
      definition.help ??
      "No extended help is available. Use the schema and description for this tool.",
  };
}

// The generic built-in dispatcher tool. The model never sees deferred tool schemas in the
// system prompt or tool set; it lists them with `find_tools` and runs one by passing its name
// and arguments here. Mirrors the per-server MCP `{server}__use_tool` pattern for built-in tools.
export const BUILTIN_USE_TOOL_NAME = "use_tool";

// Human display name for each runtime tool — a terse noun phrase shown in the session UI in place
// of the snake_case programmatic `name`. This is the static fallback; the UI may still derive a
// richer one-liner from the call input (e.g. "Searching the web for …"). Typed as an exhaustive
// Record so adding a RuntimeToolName fails the build until a title is supplied here — the title
// lives with the registry, not in a separate frontend switch that drifts out of sync.
export const RUNTIME_TOOL_TITLES: Record<RuntimeToolName, string> = {
  shell: "Run command",
  gh: "GitHub CLI",
  memory: "Memory",
  recall: "Recall past sessions",
  inbox_list: "List inbox",
  inbox_add: "Add to inbox",
  inbox_update: "Update inbox item",
  fetch_transcript: "Fetch transcript",
  create_linear_issue: "Create Linear issue",
  read_file: "Read file",
  read_skill: "Read skill",
  edit_file: "Edit file",
  write_file: "Write file",
  list_files: "List files",
  git_diff: "Review changes",
  run_subagent: "Run subagent",
  delegate_to_agent: "Delegate to agent",
  update_agent_file: "Update agent config",
  ask_user_question: "Ask a question",
  amp_coder: "Code with Amp",
  opencode_coder: "Code with opencode",
  exa_search: "Web search",
  exa_contents: "Read web pages",
  exa_answer: "Web answer",
  x_search_posts: "Search X",
  x_get_profile: "X profile",
  x_get_user_posts: "X posts",
  x_get_discussion: "X discussion",
  x_get_trends: "X trends",
  youtube_search: "Search YouTube",
  youtube_get_video: "YouTube video",
  youtube_get_transcript: "YouTube transcript",
  youtube_get_channel: "YouTube channel",
  youtube_list_channel_videos: "YouTube channel videos",
  tiktok_get_profile: "TikTok profile",
  tiktok_list_profile_posts: "TikTok posts",
  tiktok_get_video: "TikTok video",
  tiktok_get_comments: "TikTok comments",
  tiktok_search: "Search TikTok",
  tiktok_get_metadata: "TikTok metadata",
  tiktok_get_transcript: "TikTok transcript",
  instagram_get_profile: "Instagram profile",
  instagram_list_profile_posts: "Instagram posts",
  instagram_get_post: "Instagram post",
  instagram_get_comments: "Instagram comments",
  instagram_search_profiles: "Search Instagram",
  instagram_get_metadata: "Instagram metadata",
  instagram_get_transcript: "Instagram transcript",
  social_get_job: "Social job status",
  neon_list_databases: "List Neon databases",
  neon_describe_schema: "Describe database schema",
  neon_run_sql: "Run SQL",
  neon_explain_sql: "Explain SQL",
  neon_create_branch: "Create Neon branch",
  neon_delete_branch: "Delete Neon branch",
  neon_reset_branch: "Reset Neon branch",
  gmail_list_messages: "List emails",
  gmail_search: "Search email",
  gmail_get_message: "Read email",
  gmail_list_threads: "List email threads",
  gmail_get_thread: "Read email thread",
  gmail_list_labels: "List email labels",
  calendar_list_calendars: "List calendars",
  calendar_list_events: "List events",
  calendar_get_event: "Read event",
  calendar_get_freebusy: "Check availability",
  calendar_create_event: "Create event",
  calendar_update_event: "Update event",
  calendar_delete_event: "Delete event",
  web_fetch: "Fetch web page",
  tool_help: "Tool help",
  find_tools: "Find tools",
  discover_capabilities: "Discover capabilities",
};

// Resolve the display title for any tool name the UI may encounter. The `use_tool` dispatcher
// envelope should normally be unwrapped to its inner tool before display (see effectiveToolCall);
// the fallback here only shows if that unwrap could not find an inner tool name.
export function toolDisplayTitle(name: string): string | undefined {
  if (name === BUILTIN_USE_TOOL_NAME) return "Running a tool";
  return RUNTIME_TOOL_TITLES[name as RuntimeToolName];
}

// Unwrap the `use_tool` dispatcher envelope to the inner tool it runs. A `use_tool` call carries
// the real tool in `input.tool` and its arguments in `input.arguments`; for display we want the
// inner tool, not the wrapper. Any other call passes through unchanged.
export function effectiveToolCall(name: string, input: unknown): { name: string; input: unknown } {
  if (
    name === BUILTIN_USE_TOOL_NAME &&
    input &&
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    const record = input as Record<string, unknown>;
    const inner = typeof record.tool === "string" ? record.tool.trim() : "";
    if (inner) return { name: inner, input: record.arguments };
  }
  return { name, input };
}

// Tools whose full schema is registered eagerly (always directly callable). These are the
// core file/shell/ask tools used constantly and always relevant — deferring them behind a
// `find_tools` round-trip would add latency with no token win — plus the conditional core
// tools (gh, delegation) that are not capability-catalog entries and are advertised by their
// own system-prompt guidance. Everything else (capability tools, plus standalone deferrables
// like update_agent_file) is deferred.
export const ALWAYS_DIRECT_TOOL_NAMES: readonly RuntimeToolName[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "git_diff",
  "run_subagent",
  "shell",
  "read_skill",
  "gh",
  "memory",
  "recall",
  "inbox_list",
  "inbox_add",
  "inbox_update",
  "fetch_transcript",
  "ask_user_question",
  "delegate_to_agent",
  "tool_help",
  "find_tools",
  "discover_capabilities",
];

// Deferrable runtime tools that are not capability-catalog entries but are still loaded on demand
// rather than registered eagerly. `update_agent_file` carries a heavy agent-definition schema yet is
// almost never called, and is already gated behind a mandatory read of the agent-self-edit skill —
// so the `find_tools`/`use_tool` round-trip adds no latency the gate did not already impose, while
// the schema leaves the eager tool set. ask_user_question is intentionally NOT here: its durable
// turn-suspend is keyed on the literal tool-call name in the model stream runner, so wrapping it in
// `use_tool` would stop it from suspending.
const STANDALONE_DEFERRABLE_RUNTIME_TOOL_NAMES: readonly RuntimeToolName[] = ["update_agent_file"];

// Runtime tools whose full schema is loaded on demand via `find_tools` and executed via `use_tool`,
// rather than being registered eagerly in the model's tool set. Capability tools (hosted tools +
// coding agents) are derived from the catalog so the index and the deferral stay in sync; a few
// standalone tools (see STANDALONE_DEFERRABLE_RUNTIME_TOOL_NAMES) are deferred individually.
export const DEFERRABLE_RUNTIME_TOOL_NAMES: ReadonlySet<RuntimeToolName> = new Set([
  ...AGENT_TOOL_CATALOG.filter(
    (capability) => capability.type === "hosted_tool" || capability.type === "coding_agent",
  ).flatMap((capability) => capability.runtimeTools),
  ...STANDALONE_DEFERRABLE_RUNTIME_TOOL_NAMES,
]);

export function isDeferrableRuntimeTool(name: string): name is RuntimeToolName {
  return DEFERRABLE_RUNTIME_TOOL_NAMES.has(name as RuntimeToolName);
}

// Split an agent's enabled runtime tools into the set registered directly (full schemas) and
// the set deferred behind `find_tools` / `use_tool`.
export function partitionRuntimeToolNames(enabledTools: readonly RuntimeToolName[]): {
  direct: RuntimeToolName[];
  deferred: RuntimeToolName[];
} {
  const direct: RuntimeToolName[] = [];
  const deferred: RuntimeToolName[] = [];
  for (const name of enabledTools) {
    if (isDeferrableRuntimeTool(name)) deferred.push(name);
    else direct.push(name);
  }
  return { direct, deferred };
}

export type RuntimeToolSearchResult = {
  name: RuntimeToolName;
  description: string;
  parameters: JsonSchema;
};

// Back the `find_tools` tool: return the deferred, enabled runtime tools matching an optional
// capability id and/or substring query, with their full input schemas. This is the load-on-demand
// expansion injected as a tool_result — the model's only path to a deferred tool's schema. Results
// are compact (name + description + schema); the verbose per-tool `help` is fetched separately via
// `tool_help` so listing a multi-tool capability does not flood context.
export function searchRuntimeTools(
  input: { capability?: string; query?: string },
  enabledTools: readonly RuntimeToolName[],
  context: RuntimeToolDefinitionContext = {},
): RuntimeToolSearchResult[] {
  const enabledSet = new Set(enabledTools);
  const capabilityId = typeof input.capability === "string" ? input.capability.trim() : undefined;
  const candidateNames = capabilityId
    ? (AGENT_TOOL_DEFINITION_BY_ID.get(capabilityId as AgentToolId)?.runtimeTools ?? [])
    : RUNTIME_TOOL_DEFINITIONS.map((definition) => definition.name);

  // The `query` is a name/description filter for browsing the whole catalog. When a capability is
  // named, the model already narrowed the set, so a query (often misused as a search topic, e.g.
  // "Louis Morgner") would wrongly filter out every tool — ignore it and list the capability.
  const query = capabilityId
    ? ""
    : typeof input.query === "string"
      ? input.query.trim().toLowerCase()
      : "";
  const results: RuntimeToolSearchResult[] = [];
  const seen = new Set<RuntimeToolName>();
  for (const name of candidateNames) {
    if (seen.has(name)) continue;
    if (!enabledSet.has(name) || !isDeferrableRuntimeTool(name)) continue;
    const definition = getRuntimeToolDefinition(name, context);
    if (!definition) continue;
    if (
      query &&
      !definition.name.toLowerCase().includes(query) &&
      !definition.description.toLowerCase().includes(query)
    ) {
      continue;
    }
    seen.add(name);
    // Compact by design: name + description + input schema only. The verbose per-tool `help` is
    // deliberately omitted so listing a multi-tool capability stays cheap — the model fetches a
    // single tool's full help on demand via `tool_help` (getRuntimeToolHelp) instead.
    results.push({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    });
  }
  return results;
}

export type CapabilityDiscoveryStatus = "enabled" | "available" | "needs_setup";

export type CapabilityDiscoveryResult = {
  id: AgentToolId;
  label: string;
  description: string;
  status: CapabilityDiscoveryStatus;
  // Present only when status is "needs_setup": a short human reason for what's missing.
  reason?: string;
  // What the agent should do to enable it — the @-mention to add to its behavior.
  howToEnable: string;
};

// Capabilities whose eligibility this v1 can determine honestly and synchronously: those gated only
// on a platform secret (`"platform"`) or a platform secret plus an attached repo (`"mixed"`).
// `"workspace"`-credentialed capabilities (MCP servers like Linear/Slack, and the Google tools
// Gmail/Calendar) are intentionally excluded — their eligibility needs per-workspace/per-account
// OAuth connection state that isn't available in this pure path, and the agent cannot self-connect
// them anyway. They're a clean phase-2 follow-up once that state is threaded into the session.
const DISCOVERABLE_CREDENTIAL_SOURCES = new Set<AgentToolDefinition["credentialSource"]>([
  "platform",
  "mixed",
]);

// Back the `discover_capabilities` tool: list the opinionated capability catalog (the same entries
// surfaced as @-mentions in the editor) with an eligibility verdict, so the agent can find a tool it
// has not enabled yet and offer to add it. Unlike `searchRuntimeTools` (which only expands the
// agent's already-enabled set), this advertises the *not-yet-enabled* shop.
//
// `credentialAvailable` is supplied by the caller (the runner) so the platform-secret check reuses
// the exact same validation that gates execution — discovery and execution can never disagree.
export function buildCapabilityDiscovery(input: {
  enabledTools: readonly RuntimeToolName[];
  hasAttachedRepository: boolean;
  credentialAvailable: (entry: AgentToolDefinition) => boolean;
  query?: string;
}): CapabilityDiscoveryResult[] {
  const enabledSet = new Set(input.enabledTools);
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const results: CapabilityDiscoveryResult[] = [];

  for (const entry of AGENT_TOOL_CATALOG) {
    if (entry.type !== "hosted_tool" && entry.type !== "coding_agent") continue;
    if (!DISCOVERABLE_CREDENTIAL_SOURCES.has(entry.credentialSource)) continue;
    if (
      query &&
      !entry.id.toLowerCase().includes(query) &&
      !entry.label.toLowerCase().includes(query) &&
      !entry.description.toLowerCase().includes(query)
    ) {
      continue;
    }

    let status: CapabilityDiscoveryStatus;
    let reason: string | undefined;
    if (entry.runtimeTools.some((name) => enabledSet.has(name))) {
      status = "enabled";
    } else if (!input.credentialAvailable(entry)) {
      status = "needs_setup";
      reason = entry.requiredPlatformEnvVars?.length
        ? `requires ${entry.requiredPlatformEnvVars.join(", ")}`
        : "missing platform credentials";
    } else if (
      entry.requiredWorkspaceResource?.provider === "github" &&
      !input.hasAttachedRepository
    ) {
      status = "needs_setup";
      reason = "attach a GitHub repository first";
    } else {
      status = "available";
    }

    results.push({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      status,
      ...(reason ? { reason } : {}),
      howToEnable: `add @${entry.id} to your behavior`,
    });
  }

  return results;
}
