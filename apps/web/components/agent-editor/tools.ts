import { AFTER_SESSION_TAG, repositoryIdForFullName } from "@opencompany/agent-runtime";
import type {
  AgentGitHubRepositoryBinding,
  AgentModelId,
  AgentReference,
  AgentToolId,
} from "@opencompany/agent-runtime/types";
import {
  Bot,
  Brain,
  Clock3,
  Code2,
  FileText,
  Folder,
  GitBranch,
  ListTodo,
  type LucideIcon,
  MessageSquare,
  MessagesSquare,
  Search,
} from "lucide-react";
import { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "@/lib/agents/config";

type AgentMentionKind = "model" | "tool" | "integration" | "brain" | "hook" | "agent";

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
  binding?: AgentGitHubRepositoryBinding;
};

export type AgentBrainMention = BaseAgentMentionItem & {
  id: string;
  kind: "brain";
  path: string;
};

export type AgentHookMention = BaseAgentMentionItem & {
  id: string;
  kind: "hook";
};

export type AgentWorkspaceMention = BaseAgentMentionItem & {
  id: string;
  kind: "agent";
  path: string;
};

export type AgentMentionItem =
  | AgentModel
  | AgentTool
  | AgentIntegration
  | AgentBrainMention
  | AgentHookMention
  | AgentWorkspaceMention;

const TOOL_ICONS: Record<AgentToolId, LucideIcon> = {
  exa: Search,
  amp: Code2,
  linear: ListTodo,
  slack: MessageSquare,
};

const MODEL_ICONS: Record<AgentModelId, LucideIcon> = {
  "openai/gpt-5.4-mini": Bot,
  "openai/gpt-5.4": Brain,
  "openai/gpt-5.4-nano": Bot,
  "openai/gpt-5.2-codex": Code2,
  "anthropic/claude-haiku-4.5": Bot,
  "anthropic/claude-sonnet-4.6": Brain,
  "anthropic/claude-opus-4.7": Brain,
  "anthropic/claude-opus-4.8": Brain,
  "google/gemini-3-flash": Bot,
  "google/gemini-3.1-flash-lite-preview": Bot,
  "deepseek/deepseek-v4-flash": Bot,
  "mistral/mistral-medium-3.5": Brain,
  "moonshotai/kimi-k2.6": Brain,
  "zai/glm-5.1": Brain,
  "zai/glm-5-turbo": Bot,
  "zai/glm-5v-turbo": Brain,
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
  label: tool.id,
  displayLabel: tool.id,
  description: tool.description,
  icon: TOOL_ICONS[tool.id],
}));

export const AGENT_MENTION_ITEMS: AgentMentionItem[] = [...AGENT_MODELS, ...AGENT_TOOLS];
export const AGENT_TOOL_MENTION_ITEMS: AgentMentionItem[] = AGENT_TOOLS;
export const AGENT_AFTER_SESSION_MENTION_ITEMS: AgentHookMention[] = [
  {
    id: AFTER_SESSION_TAG.slice(1),
    mentionId: AFTER_SESSION_TAG.slice(1),
    kind: "hook",
    label: AFTER_SESSION_TAG.slice(1),
    displayLabel: AFTER_SESSION_TAG,
    description: "Run the prompt after the session goes idle",
    icon: Clock3,
  },
];

export function buildAgentMentionItems(
  repositories: Array<{
    fullName: string;
    defaultBranch: string;
    binding?: AgentGitHubRepositoryBinding;
    status?: "available" | "permission_lost" | "archived" | "sync_failed";
    statusReason?: string | null;
  }> = [],
  brainPaths: string[] = [],
  options: {
    enabledMcpToolIds?: AgentToolId[];
    includeMcpTools?: boolean;
    agents?: AgentReference[];
  } = {},
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
      mentionId: repositoryMentionId(repository),
      kind: "integration",
      provider: "github",
      label: repository.fullName,
      displayLabel: repository.fullName,
      description: repositoryDescription(repository),
      icon: GitBranch,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      ...(repository.binding ? { binding: repository.binding } : {}),
    };
  });

  return [
    ...AGENT_MODELS,
    ...AGENT_TOOLS.filter(
      (tool) =>
        tool.kind !== "tool" ||
        !isMcpToolId(tool.id) ||
        options.includeMcpTools ||
        Boolean(options.enabledMcpToolIds?.includes(tool.id)),
    ),
    ...buildWorkspaceAgentMentionItems(options.agents ?? []),
    githubItem,
    ...repositoryItems,
    ...buildBrainMentionItems(brainPaths),
  ];
}

export function buildWorkspaceAgentMentionItems(agents: AgentReference[]): AgentWorkspaceMention[] {
  return agents.flatMap((agent) => {
    const mentionId = agentMentionId(agent.path);
    if (!mentionId) return [];
    return [
      {
        id: mentionId,
        mentionId,
        kind: "agent" as const,
        path: agent.path,
        label: mentionId,
        displayLabel: agent.name,
        description: agent.path,
        icon: MessagesSquare,
      },
    ];
  });
}

function agentMentionId(path: string) {
  const normalized = path.trim();
  if (!normalized.startsWith("agents/") || !normalized.endsWith(".agent")) return null;
  const slug = normalized.slice("agents/".length, -".agent".length);
  if (!slug || slug.includes("/")) return null;
  return `agent/${slug}`;
}

function isMcpToolId(id: AgentToolId) {
  return id === "linear" || id === "slack";
}

function repositoryMentionId(repository: {
  fullName: string;
  binding?: AgentGitHubRepositoryBinding;
}) {
  const repositoryId = repositoryIdForFullName(repository.fullName);
  if (!repository.binding) return `integration:github:${repositoryId}`;

  return [
    "integration",
    "github",
    repositoryId,
    repository.binding.connection.externalId,
    repository.binding.externalId,
  ].join(":");
}

function repositoryDescription(repository: {
  binding?: AgentGitHubRepositoryBinding;
  status?: "available" | "permission_lost" | "archived" | "sync_failed";
  statusReason?: string | null;
}) {
  if (!repository.status || repository.status === "available") {
    return repository.binding?.connection.label
      ? `GitHub repository in ${repository.binding.connection.label}`
      : "GitHub repository";
  }
  if (repository.statusReason?.trim()) return `Unavailable: ${repository.statusReason.trim()}`;
  if (repository.status === "permission_lost") return "Unavailable: permission lost";
  if (repository.status === "archived") return "Unavailable: archived";
  return "Unavailable: sync failed";
}

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
