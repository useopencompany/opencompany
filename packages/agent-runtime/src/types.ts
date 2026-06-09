export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Shapes for the ask_user_question tool. A question prompt is what the model asks; an
// answer is what the user submits back, one entry per question, in the same order.
export type AgentSessionQuestionOption = {
  label: string;
  description?: string;
};

export type AgentSessionQuestionPrompt = {
  header: string;
  question: string;
  options: AgentSessionQuestionOption[];
  allowMultiple: boolean;
  allowOther: boolean;
};

export type AgentSessionQuestionAnswer = {
  // Labels of the options the user selected (empty when only a free-text "other" was given).
  selectedLabels: string[];
  // Free-text answer when the question allowed "other"; undefined otherwise.
  otherText?: string;
};

export type AgentSessionQuestionResolutionSource = "user" | "abort" | "timeout" | "superseded";

export type TiptapMark = {
  type: string;
  attrs?: Record<string, JsonValue>;
};

export type TiptapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, JsonValue>;
  marks?: TiptapMark[];
  content?: TiptapNode[];
};

export type TiptapDoc = {
  type: "doc";
  content?: TiptapNode[];
};

export type AgentToolId =
  | "exa"
  | "x"
  | "youtube"
  | "tiktok"
  | "instagram"
  | "neon"
  | "amp"
  | "opencode"
  | "linear"
  | "slack"
  | "posthog"
  | "betterstack"
  | "gmail"
  | "google_calendar";
export type AgentModelId =
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4"
  | "openai/gpt-5.4-nano"
  | "openai/gpt-5.2-codex"
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-opus-4.7"
  | "anthropic/claude-opus-4.8"
  | "google/gemini-3-flash"
  | "google/gemini-3.1-flash-lite-preview"
  | "deepseek/deepseek-v4-flash"
  | "mistral/mistral-medium-3.5"
  | "minimax/minimax-m3"
  | "minimax/minimax-m2.7"
  | "minimax/minimax-m2.7-highspeed"
  | "minimax/minimax-m2.5"
  | "minimax/minimax-m2.5-highspeed"
  | "minimax/minimax-m2.1"
  | "minimax/minimax-m2.1-lightning"
  | "minimax/minimax-m2"
  | "moonshotai/kimi-k2.6"
  | "moonshotai/kimi-k2.5"
  | "moonshotai/kimi-k2-thinking"
  | "moonshotai/kimi-k2-thinking-turbo"
  | "moonshotai/kimi-k2-turbo"
  | "moonshotai/kimi-k2"
  | "xai/grok-4.3"
  | "xai/grok-4.20-reasoning"
  | "xai/grok-4.20-non-reasoning"
  | "xai/grok-4.1-fast-reasoning"
  | "xai/grok-4.1-fast-non-reasoning"
  | "xai/grok-build-0.1"
  | "zai/glm-5.1"
  | "zai/glm-5-turbo"
  | "zai/glm-5v-turbo";

export type AgentHostedToolConfig = {
  id: "exa" | "x" | "youtube" | "tiktok" | "instagram" | "neon" | "gmail" | "google_calendar";
  type: "tool" | "hosted_tool";
  label: string;
  description: string;
};

export type AgentCodingToolConfig = {
  id: "amp" | "opencode";
  type: "coding_agent";
  provider: "amp" | "opencode";
  label: string;
  description: string;
  prCapable: boolean;
};

export type AgentMcpToolConfig = {
  id: "linear" | "slack" | "posthog" | "betterstack";
  type: "mcp";
  server: "linear" | "slack" | "posthog" | "betterstack";
  label: string;
  description: string;
};

export type AgentConfigTool = AgentHostedToolConfig | AgentCodingToolConfig | AgentMcpToolConfig;

export type AgentBrainReference = {
  path: string;
  type: "file" | "folder";
};

export type AgentReference = {
  path: string;
  name: string;
};

export type AgentSkillFile = {
  // Path relative to the skill folder, e.g. "SKILL.md" or "references/format.md".
  path: string;
  content: string;
};

export type AgentSkillSource = {
  // `github`: a public GitHub repository. `skills.sh`: a skills.sh page, resolved through
  // its backing GitHub repository. Both ultimately fetch from GitHub in V1.
  type: "github" | "skills.sh";
  // Canonical https repository url, e.g. https://github.com/owner/repo.
  url: string;
  // The branch or tag the user requested. We track its latest HEAD (not a pinned commit).
  ref: string;
  // Skill directory within the repository, "" = repository root.
  path: string;
};

// A built-in skill shipped in code (serialized as a bare string id in YAML).
export type AgentBuiltinSkillReference = {
  id: string;
};

// An external skill resolved from a web source. Serialized as a YAML object. The file
// contents live in `workspace_skill_snapshots`; the frontmatter only carries provenance
// plus a denormalized name/description for the pure prompt-advertisement path.
export type AgentExternalSkillReference = {
  id: string;
  name: string;
  description: string;
  source: AgentSkillSource;
};

export type AgentSkillReference = AgentBuiltinSkillReference | AgentExternalSkillReference;

export function isExternalSkillReference(
  reference: AgentSkillReference,
): reference is AgentExternalSkillReference {
  return (
    "source" in reference &&
    !!(reference as AgentExternalSkillReference).source &&
    typeof (reference as AgentExternalSkillReference).source === "object"
  );
}

export type AgentAfterSessionConfig = {
  enabled: boolean;
  prompt: string;
  idleDelaySeconds: number;
};

export type AgentGitHubRepositoryBinding = {
  provider: "github";
  resourceType: "repository";
  externalId: string;
  displayName: string;
  connection: {
    externalId: string;
    label: string;
    accountName: string | null;
    accountType: string | null;
  };
};

export type AgentGitHubRepositoryConfig = {
  id: string;
  fullName: string;
  defaultBranch: string;
  binding?: AgentGitHubRepositoryBinding;
};

export type AgentNeonDatabaseBinding = {
  provider: "neon";
  resourceType: "database";
  externalId: string;
  displayName: string;
  connection: {
    externalId: string;
    label: string;
    accountName: string | null;
    accountType: string | null;
  };
};

export type AgentNeonDatabaseConfig = {
  id: string;
  projectId: string;
  branchId: string;
  databaseName: string;
  roleName: string;
  displayName: string;
  binding?: AgentNeonDatabaseBinding;
};

export type AgentGitHubPullRequestTriggerConfig = {
  id: string;
  type: "github.pull_request";
  repository: string;
  events: Array<"opened" | "reopened" | "synchronize" | "ready_for_review">;
  branches: string[];
  enabled: boolean;
};

export type AgentScheduleTriggerConfig = {
  id: string;
  type: "agent.schedule";
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
};

export type AgentTriggerConfig = AgentGitHubPullRequestTriggerConfig | AgentScheduleTriggerConfig;

export type AgentConfig = {
  schemaVersion: "agent.v1";
  title: string;
  instructions: string;
  model: {
    provider: "vercel-ai-gateway";
    name: AgentModelId;
  };
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
  agents?: AgentReference[];
  skills?: AgentSkillReference[];
  afterSession?: AgentAfterSessionConfig;
  integrations: {
    github: {
      repositories: AgentGitHubRepositoryConfig[];
    };
    neon?: {
      databases: AgentNeonDatabaseConfig[];
    };
  };
  triggers: AgentTriggerConfig[];
};

export type AgentFile = {
  title: string;
  body: string;
  config: AgentConfig;
};
