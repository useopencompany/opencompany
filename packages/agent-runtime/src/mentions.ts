import { extractAfterSessionConfig } from "./after-session";
import { AGENT_MODEL_CATALOG } from "./models";
import { AGENT_TOOL_CATALOG, type AgentToolDefinition } from "./tools";
import type {
  AgentBrainReference,
  AgentCodingToolConfig,
  AgentConfig,
  AgentConfigTool,
  AgentGitHubPullRequestTriggerConfig,
  AgentGitHubRepositoryBinding,
  AgentGitHubRepositoryConfig,
  AgentHostedToolConfig,
  AgentModelId,
  AgentReference,
  AgentToolId,
  AgentTriggerConfig,
} from "./types";

type AgentModelDefinition = {
  id: AgentModelId;
  type: "model";
  label: string;
  description: string;
  category: "Fast" | "Deep";
  supportsReasoning: boolean;
};

export type AgentConfigDerivationRepository = {
  fullName: string;
  defaultBranch: string;
  binding?: AgentGitHubRepositoryBinding;
};

export type AgentConfigDerivationAgent = {
  path: string;
  name: string;
};

export const SUPPORTED_AGENT_TOOLS: AgentToolDefinition[] = AGENT_TOOL_CATALOG;

export const SUPPORTED_AGENT_MODELS: AgentModelDefinition[] = AGENT_MODEL_CATALOG.map((model) => ({
  id: model.id,
  type: model.type,
  label: model.label,
  description: model.description,
  category: model.category,
  supportsReasoning: model.supportsReasoning,
}));

const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));
const TOOL_BY_LABEL = new Map(
  SUPPORTED_AGENT_TOOLS.map((tool) => [tool.label.toLowerCase(), tool]),
);
const MODEL_BY_ID = new Map(SUPPORTED_AGENT_MODELS.map((model) => [model.id, model]));
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

export function normalizeAgentBody(body: string) {
  return body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

export function normalizeAgentModelId(id: string): AgentModelId {
  if (id === "default" || id === "fast") return "openai/gpt-5.4-mini";
  if (id === "deep") return "openai/gpt-5.4";
  return MODEL_BY_ID.has(id as AgentModelId) ? (id as AgentModelId) : DEFAULT_MODEL_ID;
}

export function repositoryIdForFullName(fullName: string) {
  return normalizeRepositoryId(fullName);
}

export function agentMentionIdForPath(path: string) {
  const normalized = normalizeAgentPath(path);
  if (!normalized) return null;
  return `agent/${normalized.slice("agents/".length, -".agent".length)}`;
}

export function extractMentionIds(body: string) {
  const ids: string[] = [];

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "@") continue;
    if (index > 0 && !/[\s([{]/.test(body[index - 1] ?? "")) continue;

    let end = index + 1;
    while (end < body.length && isMentionChar(body[end] ?? "")) end += 1;

    const id = body.slice(index + 1, end).replace(/[.,;:!?)}\]]+$/g, "");
    if (id) ids.push(id);
    index = end;
  }

  return ids;
}

export function extractConfigFromMentions(body: string): {
  tools: AgentToolId[];
  brain: AgentBrainReference[];
  agents: AgentReference[];
  afterSession?: AgentConfig["afterSession"];
} {
  const mentions = collectBodyMentions(body, [], [], []);
  const afterSession = extractAfterSessionConfig(body);
  return {
    tools: mentions.tools,
    brain: mentions.brain,
    agents: mentions.agents,
    ...(afterSession ? { afterSession } : {}),
  };
}

export function collectBodyRepositoryMentions(body: string) {
  return extractMentionIds(body).filter((id) => isValidGitHubFullName(id));
}

/**
 * Canonical derivation for persisted agent saves. The body is what is written
 * to the .agent file, so mention-backed runtime config must be derived from
 * this text rather than from the editor's optional Tiptap presentation cache.
 */
export function deriveAgentConfigFromBody(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  repositories: AgentConfigDerivationRepository[];
  agents?: AgentConfigDerivationAgent[];
  preferredRepositories?: AgentConfigDerivationRepository[];
  triggers?: AgentTriggerConfig[];
}): { body: string; config: AgentConfig } {
  const body = normalizeAgentBody(input.body);
  const mentions = collectBodyMentions(
    body,
    input.repositories,
    input.preferredRepositories ?? [],
    input.agents ?? [],
  );
  const afterSession = extractAfterSessionConfig(body);
  const model =
    MODEL_BY_ID.get(input.model ?? DEFAULT_MODEL_ID) ?? MODEL_BY_ID.get(DEFAULT_MODEL_ID)!;
  const tools = bodyToolsToConfig(mentions.tools);

  return {
    body,
    config: {
      schemaVersion: "agent.v1",
      title: normalizeTitle(input.title),
      instructions: body,
      model: {
        provider: "vercel-ai-gateway",
        name: model.id,
      },
      tools,
      brain: mentions.brain,
      agents: mentions.agents,
      ...(afterSession ? { afterSession } : {}),
      integrations: {
        github: {
          repositories: mentions.repositories,
        },
      },
      triggers: mentions.activeRepository
        ? syncTriggersToRepository(input.triggers ?? [], mentions.activeRepository)
        : [],
    },
  };
}

export function toConfigTool(
  tool: AgentToolDefinition,
  overrides: Partial<AgentCodingToolConfig> = {},
): AgentConfigTool {
  if (tool.id === "amp") {
    return {
      id: "amp",
      type: "coding_agent",
      provider: "amp",
      label: tool.label,
      description: tool.description,
      prCapable: overrides.prCapable ?? tool.prCapableDefault ?? true,
    };
  }

  if (tool.type === "mcp") {
    if (!tool.server) throw new Error(`MCP tool ${tool.id} is missing a server binding.`);
    return {
      id: tool.server,
      type: "mcp",
      server: tool.server,
      label: tool.label,
      description: tool.description,
    };
  }

  return {
    id: tool.id as AgentHostedToolConfig["id"],
    type: "hosted_tool",
    label: tool.label,
    description: tool.description,
  };
}

function collectBodyMentions(
  body: string,
  repositories: AgentConfigDerivationRepository[],
  preferredRepositories: AgentConfigDerivationRepository[] = [],
  agents: AgentConfigDerivationAgent[] = [],
) {
  const repositoryCatalog = repositoryCatalogForDerivation(repositories, preferredRepositories);
  const agentCatalog = agentCatalogForDerivation(agents);
  let activeRepository: AgentGitHubRepositoryConfig | null = null;
  const repositoriesById = new Map<string, AgentGitHubRepositoryConfig>();
  const tools = new Set<AgentToolId>();
  const brain = new Map<string, AgentBrainReference>();
  const agentReferences = new Map<string, AgentReference>();

  for (const rawId of extractMentionIds(body)) {
    const agentReference = agentCatalog.byMentionId.get(normalizeAgentMentionId(rawId));
    if (agentReference) {
      agentReferences.set(agentReference.path, agentReference);
      continue;
    }

    const brainReference = brainReferenceFromMention(rawId);
    if (brainReference) {
      brain.set(brainReference.path, brainReference);
      continue;
    }

    const tool = toolIdFromMention(rawId);
    if (tool) {
      tools.add(tool);
      continue;
    }

    const repositoryById = repositoryCatalog.byId.get(repositoryIdForFullName(rawId));
    if (repositoryById) {
      repositoriesById.set(repositoryById.id, repositoryById);
      activeRepository = repositoryById;
      continue;
    }

    const repositoryByFullName = repositoryCatalog.byFullName.get(rawId.toLowerCase());
    if (repositoryByFullName) {
      repositoriesById.set(repositoryByFullName.id, repositoryByFullName);
      activeRepository = repositoryByFullName;
    }
  }

  return {
    tools: Array.from(tools),
    brain: Array.from(brain.values()),
    agents: Array.from(agentReferences.values()),
    repositories: Array.from(repositoriesById.values()),
    activeRepository,
  };
}

function agentCatalogForDerivation(agents: AgentConfigDerivationAgent[]) {
  const byMentionId = new Map<string, AgentReference>();

  for (const agent of agents) {
    const path = normalizeAgentPath(agent.path);
    if (!path) continue;
    const mentionId = agentMentionIdForPath(path);
    if (!mentionId) continue;
    byMentionId.set(normalizeAgentMentionId(mentionId), {
      path,
      name: normalizeAgentName(agent.name),
    });
  }

  return { byMentionId };
}

function repositoryCatalogForDerivation(
  repositories: AgentConfigDerivationRepository[],
  preferredRepositories: AgentConfigDerivationRepository[] = [],
) {
  const byId = new Map<string, AgentGitHubRepositoryConfig>();
  const byFullName = new Map<string, AgentGitHubRepositoryConfig>();
  const grouped = new Map<string, AgentGitHubRepositoryConfig[]>();
  const preferredByFullName = new Map<string, AgentGitHubRepositoryConfig>();

  for (const repository of repositories) {
    const config = repositoryConfigForDerivation(repository);
    const key = config.fullName.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), config]);
  }

  for (const repository of preferredRepositories) {
    const config = repositoryConfigForDerivation(repository);
    preferredByFullName.set(config.fullName.toLowerCase(), config);
  }

  for (const [fullNameKey, configs] of grouped) {
    const config = preferredByFullName.get(fullNameKey) ?? resolveRepositoryGroup(configs);
    byId.set(config.id, config);
    byFullName.set(config.fullName.toLowerCase(), config);
  }

  return { byId, byFullName };
}

function repositoryConfigForDerivation(
  repository: AgentConfigDerivationRepository,
): AgentGitHubRepositoryConfig {
  return {
    id: repositoryIdForFullName(repository.fullName),
    fullName: repository.fullName,
    defaultBranch: normalizeBranch(repository.defaultBranch),
    ...(repository.binding ? { binding: repository.binding } : {}),
  };
}

function resolveRepositoryGroup(
  configs: AgentGitHubRepositoryConfig[],
): AgentGitHubRepositoryConfig {
  if (configs.length === 1) return configs[0]!;

  const boundConfigs = configs.filter((config) => config.binding);
  if (boundConfigs.length <= 1) return boundConfigs[0] ?? configs[0]!;

  const unboundConfig = configs.find((config) => !config.binding);
  if (unboundConfig) return unboundConfig;

  const first = configs[0]!;
  return {
    id: first.id,
    fullName: first.fullName,
    defaultBranch: first.defaultBranch,
  };
}

function bodyToolsToConfig(toolIds: AgentToolId[]) {
  return toolIds.flatMap((id) => {
    const tool = TOOL_BY_ID.get(id);
    if (!tool) return [];
    return [toConfigTool(tool)];
  });
}

function brainReferenceFromMention(id: string): AgentBrainReference | null {
  if (id === "brain/") return { path: "/", type: "folder" };
  if (!id.startsWith("brain/")) return null;
  const folder = id.endsWith("/");
  const path = id
    .slice("brain/".length)
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  const normalized = folder ? `${path.replace(/\/+$/g, "")}/` : path.replace(/\/+$/g, "");
  if (
    !normalized ||
    normalized === "/" ||
    normalized.includes("..") ||
    normalized.startsWith(".")
  ) {
    return null;
  }

  return {
    path: normalized,
    type: normalized.endsWith("/") ? "folder" : "file",
  };
}

function toolIdFromMention(id: string): AgentToolId | null {
  if (TOOL_BY_ID.has(id as AgentToolId)) return id as AgentToolId;
  const tool = TOOL_BY_LABEL.get(id.toLowerCase());
  return tool?.id ?? null;
}

function syncTriggersToRepository(
  triggers: AgentTriggerConfig[],
  repository: AgentGitHubRepositoryConfig,
) {
  return triggers.map((trigger) => {
    if (trigger.type !== "github.pull_request") return trigger;
    return {
      ...trigger,
      id: `${repository.id}-pr`,
      repository: repository.id,
      branches: trigger.branches.length > 0 ? trigger.branches : [repository.defaultBranch],
    } satisfies AgentGitHubPullRequestTriggerConfig;
  });
}

function normalizeTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function normalizeAgentMentionId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.agent$/i, "");
}

function normalizeAgentPath(value: string) {
  const trimmed = value.trim().replace(/^\/+/, "");
  const path = trimmed.startsWith("agents/") ? trimmed : `agents/${trimmed}`;
  const withExtension = path.endsWith(".agent") ? path : `${path}.agent`;
  const normalized = withExtension.replace(/\/{2,}/g, "/");
  const slug = normalized.slice("agents/".length, -".agent".length);

  if (
    !normalized.startsWith("agents/") ||
    !normalized.endsWith(".agent") ||
    !slug ||
    slug.includes("/") ||
    slug.includes("..") ||
    slug.startsWith(".")
  ) {
    return null;
  }

  return normalized;
}

function normalizeAgentName(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function normalizeBranch(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "main";
}

function normalizeRepositoryId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isValidGitHubFullName(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isMentionChar(char: string) {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "." ||
    char === "/" ||
    char === "-"
  );
}
