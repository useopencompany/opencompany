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

export type AgentToolId = "exa" | "amp";
export type AgentModelId =
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4"
  | "openai/gpt-5.4-nano"
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-opus-4.7"
  | "google/gemini-3-flash"
  | "google/gemini-3.1-flash-lite-preview"
  | "deepseek/deepseek-v4-flash"
  | "mistral/mistral-medium-3.5"
  | "moonshotai/kimi-k2.6"
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
  repository: string | null;
  prCapable: boolean;
};

export type AgentConfigTool = AgentHostedToolConfig | AgentCodingToolConfig;

export type AgentBrainReference = {
  path: string;
  type: "file" | "folder";
};

export type AgentAfterSessionConfig = {
  enabled: boolean;
  prompt: string;
  idleDelaySeconds: number;
};

export type AgentGitHubRepositoryConfig = {
  id: string;
  fullName: string;
  defaultBranch: string;
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
  version?: 2;
  title: string;
  instructions: string;
  model: {
    provider: "vercel-ai-gateway";
    name: AgentModelId;
  };
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
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
