export type {
  AgentConfig,
  AgentConfigTool,
  AgentModelId,
  AgentToolId,
  TiptapDoc,
} from "@opencompany/db";

import type { AgentConfig } from "@opencompany/db";

export type AgentFile = {
  title: string;
  body: string;
  config: AgentConfig;
};
