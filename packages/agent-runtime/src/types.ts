export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentModelId =
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4"
  | "openai/gpt-5.4-nano"
  | "openai/gpt-5.2-codex"
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-4.7"
  | "anthropic/claude-opus-4.8"
  | "anthropic/claude-fable-5"
  | "google/gemini-3-flash"
  | "google/gemini-3.1-flash-lite-preview"
  | "alibaba/qwen3.8-max"
  | "deepseek/deepseek-v4-pro"
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
  | "moonshotai/kimi-k3"
  | "moonshotai/kimi-k2.6"
  | "moonshotai/kimi-k2.5"
  | "moonshotai/kimi-k2-thinking"
  | "moonshotai/kimi-k2-thinking-turbo"
  | "moonshotai/kimi-k2-turbo"
  | "moonshotai/kimi-k2"
  | "xai/grok-4.6"
  | "xai/grok-4.3"
  | "xai/grok-4.20-reasoning"
  | "xai/grok-4.20-non-reasoning"
  | "xai/grok-4.1-fast-reasoning"
  | "xai/grok-4.1-fast-non-reasoning"
  | "xai/grok-build-0.1"
  | "zai/glm-5.1"
  | "zai/glm-5.2"
  | "zai/glm-5-turbo"
  | "zai/glm-5v-turbo"
  | "openrouter/fusion";

export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type AgentSkillFile = {
  path: string;
  content: Uint8Array;
  executable: boolean;
};

export type AgentRemoteSkillSource = {
  type: "github" | "skills.sh";
  url: string;
  ref: string;
  path: string;
};

export type AgentScheduleTriggerConfig = {
  id: string;
  type: "agent.schedule";
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
};

// Migration-only compatibility types used by packages/db/src/schema.ts. The retired
// agent runtime has no parser or execution consumer for these shapes; they remain here
// solely so the preserved Drizzle model can describe historical JSON columns without
// reintroducing the legacy runtime modules.
export type AgentEngine = "opencompany" | "codex";

export type AgentConfig = Record<string, JsonValue>;

export type AgentSessionQuestionPrompt = {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowMultiple: boolean;
  allowOther: boolean;
};

export type AgentSessionQuestionAnswer = {
  selectedLabels: string[];
  otherText?: string;
};

export type TiptapDoc = {
  type: "doc";
  content?: Array<{
    type: string;
    text?: string;
    attrs?: Record<string, JsonValue>;
    content?: TiptapDoc["content"];
  }>;
};
