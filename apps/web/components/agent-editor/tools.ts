import { Bot, Brain, Code2, FileText, GitBranch, type LucideIcon, Search } from "lucide-react";
import { repositoryIdForFullName } from "@/lib/agents/agent-file";
import { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "@/lib/agents/config";
import type { AgentModelId, AgentToolId } from "@/lib/agents/types";

type AgentMentionKind = "model" | "tool" | "integration" | "brain";

type BaseAgentMentionItem = {
  id: AgentToolId | AgentModelId | string;
  mentionId: string;
  kind: AgentMentionKind;
  label: string;
  displayLabel: string;
  description: string;
  icon: LucideIcon;
  category?: "Fast" | "Deep";
  supportsReasoning?: boolean;
};

export type AgentTool = BaseAgentMentionItem & {
  id: AgentToolId;
  kind: "tool";
};

export type AgentModel = BaseAgentMentionItem & {
  id: AgentModelId;
  kind: "model";
};

export type AgentIntegration = Omit<
  BaseAgentMentionItem,
  "id" | "category" | "supportsReasoning"
> & {
  id: string;
  kind: "integration";
  provider: "github";
  fullName?: string;
  defaultBranch?: string;
};

export type AgentBrainMention = BaseAgentMentionItem & {
  id: string;
  kind: "brain";
  path: string;
};

export type AgentMentionItem = AgentModel | AgentTool | AgentIntegration | AgentBrainMention;

const TOOL_ICONS: Record<AgentToolId, LucideIcon> = {
  exa: Search,
  amp: Code2,
};

const MODEL_ICONS: Record<AgentModelId, LucideIcon> = {
  "openai/gpt-5.4-mini": Bot,
  "openai/gpt-5.4": Brain,
  "anthropic/claude-haiku-4.5": Bot,
  "anthropic/claude-sonnet-4.6": Brain,
};

export const AGENT_MODELS: AgentModel[] = SUPPORTED_AGENT_MODELS.map((model) => ({
  id: model.id,
  mentionId: `model:${model.id}`,
  kind: "model",
  label: model.label,
  displayLabel: model.id,
  description: model.description,
  category: model.category,
  supportsReasoning: model.supportsReasoning,
  icon: MODEL_ICONS[model.id],
}));

export const AGENT_TOOLS: AgentTool[] = SUPPORTED_AGENT_TOOLS.map((tool) => ({
  id: tool.id,
  mentionId: `tool:${tool.id}`,
  kind: "tool",
  label: tool.label,
  displayLabel: tool.label,
  description: tool.description,
  icon: TOOL_ICONS[tool.id],
}));

export const AGENT_MENTION_ITEMS: AgentMentionItem[] = [...AGENT_MODELS, ...AGENT_TOOLS];
export const AGENT_TOOL_MENTION_ITEMS: AgentMentionItem[] = AGENT_TOOLS;

export function buildAgentMentionItems(
  repositories: Array<{ fullName: string; defaultBranch: string }> = [],
  brainPaths: string[] = [],
): AgentMentionItem[] {
  const githubItem: AgentIntegration = {
    id: "github",
    mentionId: "integration:github",
    kind: "integration",
    provider: "github",
    label: "github",
    displayLabel: "GitHub",
    description: "Workspace GitHub integration.",
    icon: GitBranch,
  };
  const repositoryItems: AgentIntegration[] = repositories.map((repository) => {
    const repositoryId = repositoryIdForFullName(repository.fullName);
    return {
      id: repositoryId,
      mentionId: `integration:github:${repositoryId}`,
      kind: "integration",
      provider: "github",
      label: repository.fullName,
      displayLabel: repository.fullName,
      description: "GitHub repository",
      icon: GitBranch,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
    };
  });

  return [
    ...AGENT_MODELS,
    ...AGENT_TOOLS,
    githubItem,
    ...repositoryItems,
    ...buildBrainMentionItems(brainPaths),
  ];
}

export function buildBrainMentionItems(paths: string[]): AgentBrainMention[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(`${parts.slice(0, index).join("/")}/`);
    }
  }

  return [...Array.from(folders), ...paths].sort().map((path) => ({
    id: `brain/${path}`,
    mentionId: `brain/${path}`,
    kind: "brain" as const,
    path,
    label: `brain/${path}`,
    displayLabel: `brain/${path}`,
    description: path.endsWith("/") ? "Brain folder" : "Brain file",
    icon: FileText,
  }));
}

export function findMentionItem(
  id: string,
  items: AgentMentionItem[] = AGENT_MENTION_ITEMS,
): AgentMentionItem | undefined {
  const normalized = id.toLowerCase();
  return (
    items.find((item) => item.mentionId === id) ??
    items.find((item) => item.id === id) ??
    items.find((item) => item.label === id) ??
    items.find((item) => item.displayLabel === id) ??
    items.find((item) => item.id.toLowerCase() === normalized) ??
    items.find((item) => item.label.toLowerCase() === normalized) ??
    items.find((item) => item.displayLabel.toLowerCase() === normalized)
  );
}

export function findTool(id: string): AgentTool | undefined {
  return (
    AGENT_TOOLS.find((item) => item.mentionId === id) ?? AGENT_TOOLS.find((item) => item.id === id)
  );
}

export function findModel(id: string): AgentModel | undefined {
  return (
    AGENT_MODELS.find((item) => item.mentionId === id) ??
    AGENT_MODELS.find((item) => item.id === id)
  );
}
