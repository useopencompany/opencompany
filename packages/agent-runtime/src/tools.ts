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
  | "read_file"
  | "read_skill"
  | "edit_file"
  | "write_file"
  | "list_files"
  | "git_diff"
  | "delegate_to_agent"
  | "update_agent_file"
  | "amp_coder"
  | "exa_search"
  | "exa_contents"
  | "exa_answer"
  | "x_search_posts"
  | "x_get_profile"
  | "x_get_user_posts"
  | "x_get_discussion"
  | "x_get_trends"
  | "web_fetch"
  | "tool_help";

export type RuntimeToolDefinition = {
  name: RuntimeToolName;
  kind: "sandbox" | "hosted" | "internal";
  configToolId?: AgentToolId;
  requiresAttachedRepository?: boolean;
  description: string;
  parameters: JsonSchema;
  help?: string;
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
  provider?: "amp";
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
];

export const AGENT_TOOL_DEFINITION_BY_ID = new Map(
  AGENT_TOOL_CATALOG.map((tool) => [tool.id, tool]),
);

export const CORE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "shell",
    kind: "sandbox",
    description:
      "Run a shell command from the session workspace root, where ./work and ./brain are visible. When one or more GitHub repositories are attached to the agent, shell commands get repo-scoped git and gh auth automatically; clone on demand into ./work/<repo> and run repository commands there.",
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
      "Use gh pr create / gh pr view / gh issue list / gh api as needed.",
      "Never push to or open a PR against a repository's default branch directly; always use a feature branch.",
    ].join("\n"),
  },
  {
    name: "read_file",
    kind: "sandbox",
    description: "Read a UTF-8 text file from ./work or ./brain.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path starting with work/ or brain/.",
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
      "Apply targeted exact-string replacements to an existing UTF-8 text file inside ./work or ./brain. Use this for partial edits; use write_file only for new files or intentional full overwrites.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path starting with work/ or brain/." },
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
      "Create or overwrite a UTF-8 text file inside ./work or ./brain. Use edit_file for targeted changes to existing files. The path must start with work/ or brain/.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path starting with work/ or brain/." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    kind: "sandbox",
    description: "List files and directories below ./work or ./brain.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path starting with work/ or brain/.",
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
            "Target agent mention or path for a new delegated session, such as agent/research, @agent/research, research, or agents/research.agent. Omit when continuing a prior child session by sessionId.",
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
    description:
      'Update your own .agent definition (your instructions, explicitly selected model, the tools you reference, and your recurring schedule triggers). Submit the COMPLETE new Markdown body, not a diff. The change is validated and applied atomically: on success it is versioned and synced to the workspace repo; on failure it returns errors and nothing is saved, so you can fix and retry. Changes take effect on the next session, not the current one. Required: read the agent-self-edit skill first with read_skill({skillId:"agent-self-edit"}); this tool is rejected until you have.',
    parameters: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "The full new Markdown instructions body. Keep any @mentions for tools and @brain/... paths you still want active; tools and brain follow the mentions in this body.",
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
      "Changes apply on your next session, not the current one — offer to start one.",
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
];

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
          description: "Number of posts to return. Defaults to 20. Maximum 100.",
          default: 20,
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
      'Prefer mode="recent". Use mode="all" only when the token has full-archive search access and older posts are required.',
      "Keep maxResults small unless the user asks for breadth. The X API bills per returned Post.",
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
          description: "Number of posts to return. Defaults to 20. Maximum 100.",
          default: 20,
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
            "Maximum replies and maximum quote posts to return per collection. Defaults to 50. Maximum 100.",
          default: 50,
        },
      },
      required: ["postIdOrUrl"],
      additionalProperties: false,
    },
    help: [
      "Use x_get_discussion when the user provides a post URL/id or asks what people are saying around one post.",
      'Prefer mode="recent". Use mode="all" only when the token has full-archive search access and older replies are required.',
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
          description: "Number of trends to return. Defaults to 25. Maximum 50.",
          default: 25,
        },
      },
      additionalProperties: false,
    },
    help: [
      "Use x_get_trends to answer what is currently trending on X in a broad location.",
      "Common WOEIDs: worldwide=1, United States=23424977, United Kingdom=23424975, New York=2459115, London=44418.",
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
];

export const RUNTIME_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  ...CORE_TOOL_DEFINITIONS,
  ...HOSTED_TOOL_DEFINITIONS,
];

export const RUNTIME_TOOL_DEFINITION_BY_NAME = new Map(
  RUNTIME_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

export function resolveRuntimeToolNamesForConfigTools(input: {
  tools: ReadonlyArray<{ id?: unknown }> | undefined;
  agents?: ReadonlyArray<unknown> | undefined;
  repositories?: ReadonlyArray<unknown> | undefined;
  // Skill-gated tools. `update_agent_file` is only exposed when the self-edit skill is on.
  selfEditEnabled?: boolean;
}) {
  const hasAttachedRepository = (input.repositories ?? []).length > 0;
  const names = new Set<RuntimeToolName>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    // Skill- and reference-gated tools are added below, not unconditionally.
    if (tool.name === "delegate_to_agent" || tool.name === "update_agent_file") continue;
    // Unconditional core tools (no configToolId) are always available, except
    // those gated on an attached repository (e.g. gh).
    if (tool.configToolId) continue;
    if (tool.requiresAttachedRepository && !hasAttachedRepository) continue;
    names.add(tool.name);
  }
  names.add("tool_help");
  if (input.selfEditEnabled) {
    names.add("update_agent_file");
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
  if (!definition.configToolId) return false;
  if (!selectedToolIds.has(definition.configToolId)) return false;
  if (definition.requiresAttachedRepository && !hasAttachedRepository) return false;
  return true;
}

export function getRuntimeToolHelp(toolName: string, enabledTools: readonly RuntimeToolName[]) {
  if (!enabledTools.includes(toolName as RuntimeToolName)) return null;
  const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(toolName as RuntimeToolName);
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
