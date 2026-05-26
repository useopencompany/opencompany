import { Bot, Brain, FileText, Folder, type LucideIcon, Search } from "lucide-react";
import { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "@/lib/agents/config";
import type { AgentModelId, AgentToolId } from "@/lib/agents/types";

type AgentMentionKind = "model" | "tool" | "brain";

export type AgentMentionItem = {
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

export type AgentTool = AgentMentionItem & {
  id: AgentToolId;
  kind: "tool";
};

export type AgentModel = AgentMentionItem & {
  id: AgentModelId;
  kind: "model";
};

export type AgentBrainMention = AgentMentionItem & {
  id: string;
  kind: "brain";
  path: string;
};

const TOOL_ICONS: Record<AgentToolId, LucideIcon> = {
  exa: Search,
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

export function buildBrainMentionItems(paths: string[]): AgentBrainMention[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(`${parts.slice(0, index).join("/")}/`);
    }
  }

  const root: AgentBrainMention = {
    id: "brain/",
    mentionId: "brain/",
    kind: "brain",
    path: "/",
    label: "brain/",
    displayLabel: "brain/",
    description: "Brain root folder",
    icon: Folder,
  };

  const children = [...Array.from(folders), ...paths].sort().map((path) => ({
    id: `brain/${path}`,
    mentionId: `brain/${path}`,
    kind: "brain" as const,
    path,
    label: `brain/${path}`,
    displayLabel: `brain/${path}`,
    description: path.endsWith("/") ? "Brain folder" : "Brain file",
    icon: path.endsWith("/") ? Folder : FileText,
  }));

  return [root, ...children];
}

export function findMentionItem(id: string): AgentMentionItem | undefined {
  return (
    AGENT_MENTION_ITEMS.find((item) => item.mentionId === id) ??
    AGENT_MENTION_ITEMS.find((item) => item.id === id)
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
