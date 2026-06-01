export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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

export type AgentToolId = "exa" | "amp" | "linear" | "slack";
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
  id: "exa";
  type: "tool" | "hosted_tool";
  label: string;
  description: string;
};

export type AgentCodingToolConfig = {
  id: "amp";
  type: "coding_agent";
  provider: "amp";
  label: string;
  description: string;
  prCapable: boolean;
};

export type AgentMcpToolConfig = {
  id: "linear" | "slack";
  type: "mcp";
  server: "linear" | "slack";
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

export type AgentTriggerConfig = {
  id: string;
  type: "github.pull_request";
  repository: string;
  events: Array<"opened" | "reopened" | "synchronize" | "ready_for_review">;
  branches: string[];
  enabled: boolean;
};

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
  afterSession?: AgentAfterSessionConfig;
  integrations: {
    github: {
      repositories: AgentGitHubRepositoryConfig[];
    };
  };
  triggers: AgentTriggerConfig[];
};

export type AgentFile = {
  title: string;
  body: string;
  config: AgentConfig;
};
