export type {
  AgentAfterSessionConfig,
  AgentBrainReference,
  AgentCodingToolConfig,
  AgentConfig,
  AgentConfigTool,
  AgentGitHubRepositoryConfig,
  AgentHostedToolConfig,
  AgentModelId,
  AgentToolId,
  AgentTriggerConfig,
  TiptapDoc,
} from "@opencompany/db";

import type { AgentConfig } from "@opencompany/db";

export type AgentFile = {
  title: string;
  body: string;
  config: AgentConfig;
};
