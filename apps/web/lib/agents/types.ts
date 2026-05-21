export type TiptapDoc = {
  type: "doc";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any[];
};

export type AgentToolId = "exa";
export type AgentModelId =
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4"
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-4.6";

export type AgentConfigTool = {
  id: AgentToolId;
  type: "tool";
  label: string;
  description: string;
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
};

export type AgentFile = {
  title: string;
  body: string;
  config: AgentConfig;
};
