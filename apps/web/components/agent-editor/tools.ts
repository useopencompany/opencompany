import {
  AFTER_SESSION_TAG,
  agentMentionIdForPath,
  repositoryIdForFullName,
} from "@opencompany/agent-runtime";
import type {
  AgentGitHubRepositoryBinding,
  AgentModelId,
  AgentReference,
  AgentToolId,
} from "@opencompany/agent-runtime/types";
import {
  AtSign,
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
  Sparkles,
  SquarePlay,
} from "lucide-react";
import {
  AnthropicIcon,
  DeepSeekIcon,
  GeminiIcon,
  MinimaxIcon,
  MistralIcon,
  MoonshotIcon,
  OpenAIIcon,
  XaiIcon,
  ZaiIcon,
} from "@/components/icons/model-provider-icons";
import { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "@/lib/agents/config";

type AgentMentionKind = "model" | "tool" | "integration" | "brain" | "hook" | "agent" | "schedule";

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
  // Set on integrations that are enabled on the agent but not yet set up in the
  // workspace. The mention stays selectable; the UI shows a "Needs setup" badge
  // linking to `connectUrl` (Settings → Integrations connect flow).
  needsSetup?: boolean;
  connectUrl?: string;
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

export type AgentScheduleMention = BaseAgentMentionItem & {
  id: "run-every";
  kind: "schedule";
};

export type AgentMentionItem =
  | AgentModel
  | AgentTool
  | AgentIntegration
  | AgentBrainMention
  | AgentHookMention
  | AgentWorkspaceMention
  | AgentScheduleMention;

const TOOL_ICONS: Record<AgentToolId, LucideIcon> = {
  exa: Search,
  x: AtSign,
  youtube: SquarePlay,
  amp: Code2,
  linear: ListTodo,
  slack: MessageSquare,
};

// Real brand logos keyed by the provider prefix of the model id (the part
// before the first "/"). Providers without a shipped logo fall back to a
// neutral model icon. Resolving by provider keeps new models working without
// touching this file as long as their provider is already listed.
const FALLBACK_MODEL_ICON: LucideIcon = Sparkles;

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  google: GeminiIcon,
  deepseek: DeepSeekIcon,
  mistral: MistralIcon,
  moonshotai: MoonshotIcon,
  zai: ZaiIcon,
  xai: XaiIcon,
  minimax: MinimaxIcon,
};

function modelIconFor(id: AgentModelId): LucideIcon {
  const provider = id.split("/")[0] ?? "";
  return PROVIDER_ICONS[provider] ?? FALLBACK_MODEL_ICON;
}

export const AGENT_MODELS: AgentModel[] = SUPPORTED_AGENT_MODELS.map((model) => ({
  id: model.id,
  mentionId: `model:${model.id}`,
  kind: "model",
  label: model.label,
  displayLabel: model.id,
  description: model.description,
  category: model.category,
  supportsReasoning: model.supportsReasoning,
  icon: modelIconFor(model.id),
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

export const AGENT_SCHEDULE_MENTION_ITEMS: AgentScheduleMention[] = [
  {
    id: "run-every",
    mentionId: "schedule:run-every",
    kind: "schedule",
    label: "run-every",
    displayLabel: "Run every...",
    description: "Create a recurring scheduled run",
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
    mcpEnabled?: boolean;
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
    ...AGENT_SCHEDULE_MENTION_ITEMS,
    ...buildToolMentionItems(options),
    ...buildWorkspaceAgentMentionItems(options.agents ?? []),
    githubItem,
    ...repositoryItems,
    ...buildBrainMentionItems(brainPaths),
  ];
}

// Non-MCP tools are always available. MCP-backed tools (Linear, Slack) are shown
// whenever the workspace MCP beta is on: connected ones behave normally, while
// not-yet-connected ones stay selectable but carry `needsSetup`/`connectUrl` so
// the UI can flag them and link to the connect flow. With the beta off they are
// hidden entirely (matching the runtime's "beta is off" guard).
function buildToolMentionItems(options: {
  enabledMcpToolIds?: AgentToolId[];
  includeMcpTools?: boolean;
  mcpEnabled?: boolean;
}): AgentTool[] {
  return AGENT_TOOLS.flatMap((tool) => {
    if (tool.kind !== "tool" || !isMcpToolId(tool.id)) return [tool];
    const connected = Boolean(options.enabledMcpToolIds?.includes(tool.id));
    const visible = options.includeMcpTools || options.mcpEnabled || connected;
    if (!visible) return [];
    if (connected) return [tool];
    return [
      {
        ...tool,
        description: "Not connected — set up in Settings → Integrations.",
        needsSetup: true,
        connectUrl: mcpConnectUrl(tool.id),
      },
    ];
  });
}

function mcpConnectUrl(toolId: AgentToolId) {
  return `/api/mcp/${toolId}/start?returnTo=/settings`;
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
  return agentMentionIdForPath(path);
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
