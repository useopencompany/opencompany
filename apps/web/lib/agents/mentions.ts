import {
  AGENT_MODEL_CATALOG,
  AGENT_TOOL_CATALOG,
  type AgentToolDefinition,
} from "@opencompany/agent-runtime";
import { extractAfterSessionConfig } from "./after-session";
import type {
  AgentBrainReference,
  AgentCodingToolConfig,
  AgentConfig,
  AgentConfigTool,
  AgentGitHubRepositoryConfig,
  AgentModelId,
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
  model: AgentModelId;
  tools: AgentToolId[];
  brain: AgentBrainReference[];
  afterSession?: AgentConfig["afterSession"];
} {
  const mentions = collectBodyMentions(body, []);
  const afterSession = extractAfterSessionConfig(body);
  return {
    model: mentions.model ?? DEFAULT_MODEL_ID,
    tools: mentions.tools,
    brain: mentions.brain,
    ...(afterSession ? { afterSession } : {}),
  };
}

export function collectBodyRepositoryMentions(body: string) {
  return extractMentionIds(body).filter((id) => isValidGitHubFullName(id));
}

/**
 * Canonical derivation for persisted agent saves. The body is what is written
 * to the .agent file, so runtime config must be derived from this text rather
 * than from the editor's optional Tiptap presentation cache.
 */
export function deriveAgentConfigFromBody(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  repositories: AgentConfigDerivationRepository[];
  triggers?: AgentTriggerConfig[];
}): { body: string; config: AgentConfig } {
  const body = normalizeAgentBody(input.body);
  const mentions = collectBodyMentions(body, input.repositories);
  const afterSession = extractAfterSessionConfig(body);
  const model =
    MODEL_BY_ID.get(mentions.model ?? input.model ?? DEFAULT_MODEL_ID) ??
    MODEL_BY_ID.get(DEFAULT_MODEL_ID)!;
  const tools = bodyToolsToConfig(mentions.tools, mentions.activeRepository?.id ?? null);

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
      repository: overrides.repository ?? null,
      prCapable: overrides.prCapable ?? tool.prCapableDefault ?? true,
    };
  }

  return {
    id: "exa",
    type: "hosted_tool",
    label: tool.label,
    description: tool.description,
  };
}

function collectBodyMentions(body: string, repositories: AgentConfigDerivationRepository[]) {
  const repositoryCatalog = repositoryCatalogForDerivation(repositories);
  let model: AgentModelId | null = null;
  let activeRepository: AgentGitHubRepositoryConfig | null = null;
  const repositoriesById = new Map<string, AgentGitHubRepositoryConfig>();
  const tools = new Set<AgentToolId>();
  const brain = new Map<string, AgentBrainReference>();

  for (const rawId of extractMentionIds(body)) {
    const brainReference = brainReferenceFromMention(rawId);
    if (brainReference) {
      brain.set(brainReference.path, brainReference);
      continue;
    }

    const modelId = modelIdFromMention(rawId);
    if (modelId) {
      model = modelId;
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
    model,
    tools: Array.from(tools),
    brain: Array.from(brain.values()),
    repositories: Array.from(repositoriesById.values()),
    activeRepository,
  };
}

function repositoryCatalogForDerivation(repositories: AgentConfigDerivationRepository[]) {
  const byId = new Map<string, AgentGitHubRepositoryConfig>();
  const byFullName = new Map<string, AgentGitHubRepositoryConfig>();

  for (const repository of repositories) {
    const config = {
      id: repositoryIdForFullName(repository.fullName),
      fullName: repository.fullName,
      defaultBranch: normalizeBranch(repository.defaultBranch),
    };
    byId.set(config.id, config);
    byFullName.set(config.fullName.toLowerCase(), config);
  }

  return { byId, byFullName };
}

function bodyToolsToConfig(toolIds: AgentToolId[], repositoryId: string | null) {
  return toolIds.flatMap((id) => {
    const tool = TOOL_BY_ID.get(id);
    if (!tool) return [];
    return [
      tool.id === "amp" ? toConfigTool(tool, { repository: repositoryId }) : toConfigTool(tool),
    ];
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

function modelIdFromMention(id: string): AgentModelId | null {
  if (id === "default" || id === "fast") return "openai/gpt-5.4-mini";
  if (id === "deep") return "openai/gpt-5.4";
  return MODEL_BY_ID.has(id as AgentModelId) ? (id as AgentModelId) : null;
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
  return triggers.map((trigger) => ({
    ...trigger,
    id: `${repository.id}-pr`,
    repository: repository.id,
    branches: trigger.branches.length > 0 ? trigger.branches : [repository.defaultBranch],
  }));
}

function normalizeTitle(title: string) {
  const trimmed = title.trim();
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
