export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

import type { AgentConfigTool, AgentToolId } from "./types";

export type RuntimeToolName =
  | "shell"
  | "read_file"
  | "write_file"
  | "list_files"
  | "git_diff"
  | "amp_coder"
  | "exa_search"
  | "exa_contents"
  | "exa_answer"
  | "web_fetch"
  | "tool_help";

export type RuntimeToolDefinition = {
  name: RuntimeToolName;
  kind: "sandbox" | "hosted";
  configToolId?: AgentToolId;
  requiresRepositoryBinding?: boolean;
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
];

export const AGENT_TOOL_DEFINITION_BY_ID = new Map(
  AGENT_TOOL_CATALOG.map((tool) => [tool.id, tool]),
);

export const CORE_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "shell",
    kind: "sandbox",
    description:
      "Run a shell command from the session workspace root, where ./work and ./brain are visible.",
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
    name: "read_file",
    kind: "sandbox",
    description:
      "Read a UTF-8 text file from ./work or ./brain. The path must start with work/ or brain/.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path starting with work/ or brain/." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    kind: "sandbox",
    description:
      "Write a UTF-8 text file inside ./work or ./brain. The path must start with work/ or brain/.",
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
    description:
      "List files and directories below ./work or ./brain. The path must start with work/ or brain/.",
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
    name: "amp_coder",
    kind: "sandbox",
    configToolId: "amp",
    requiresRepositoryBinding: true,
    description:
      "Delegate coding work to Amp in the connected GitHub repository. Use for multi-file implementation, debugging, refactors, and PR-ready code changes.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Specific coding task for Amp to perform in the connected repository.",
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
      },
      required: ["task"],
      additionalProperties: false,
    },
    help: [
      "Use amp_coder for substantial codebase work that benefits from Amp's coding-agent loop.",
      "Give Amp a concrete task and any constraints from the user or agent instructions.",
      "When the user asks for a follow-up to prior Amp work, pass the previous ampThreadId so Amp continues that thread with its existing context.",
      "The tool output includes ampResult, ampStatus, ampThreadId, diffStat, diffPreview, and optional pullRequestUrl. Base your final response on ampResult when present.",
      "Set createPullRequest=true only when the instructions call for a reviewable PR.",
      "The tool works on a generated branch and never pushes directly to the default branch.",
    ].join("\n"),
  },
];

export const HOSTED_TOOL_DEFINITIONS: RuntimeToolDefinition[] = [
  {
    name: "exa_search",
    kind: "hosted",
    configToolId: "exa",
    description:
      "Search the live web with Exa, including vertical searches for people, companies, news, research papers, personal sites, and financial reports. Returns compact citation-friendly results with highlights.",
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
            'Optional Exa vertical. Use "people" for finding professional profiles, founders, investors, executives, authors, or experts; use "company" for company homepages and profiles.',
        },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Only return results from these domains.",
        },
        excludeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Exclude results from these domains.",
        },
        startPublishedDate: {
          type: "string",
          description: "ISO 8601 lower bound for published date.",
        },
        endPublishedDate: {
          type: "string",
          description: "ISO 8601 upper bound for published date.",
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

export function resolveRuntimeToolNamesForConfigTools(
  tools: ReadonlyArray<{ id?: unknown }> | undefined,
) {
  const names = new Set<RuntimeToolName>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    if (!tool.configToolId) names.add(tool.name);
  }
  names.add("tool_help");

  const selectedToolIds = new Set(
    (tools ?? []).flatMap((tool) => (typeof tool.id === "string" ? [tool.id] : [])),
  );
  for (const selectedToolId of selectedToolIds) {
    const agentTool = AGENT_TOOL_DEFINITION_BY_ID.get(selectedToolId as AgentToolId);
    if (!agentTool) continue;
    for (const runtimeToolName of agentTool.runtimeTools) {
      const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(runtimeToolName);
      if (definition && isRuntimeToolEnabledByConfig(definition, tools, selectedToolIds)) {
        names.add(definition.name);
      }
    }
  }

  return Array.from(names);
}

function isRuntimeToolEnabledByConfig(
  definition: RuntimeToolDefinition,
  tools: ReadonlyArray<{ id?: unknown }> | undefined,
  selectedToolIds: Set<string>,
) {
  if (!definition.configToolId) return false;
  if (!selectedToolIds.has(definition.configToolId)) return false;
  if (!definition.requiresRepositoryBinding) return true;

  const configTool = tools?.find((tool) => tool?.id === definition.configToolId);
  if (!configTool) return false;
  return (
    "repository" in configTool &&
    typeof configTool.repository === "string" &&
    configTool.repository.trim().length > 0
  );
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
