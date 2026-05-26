import { AGENT_MODEL_CATALOG } from "@opencompany/agent-runtime";
import { asRecord, sanitizeTiptapDoc, type TiptapNode } from "./tiptap";
import type {
  AgentBrainReference,
  AgentCodingToolConfig,
  AgentConfig,
  AgentConfigTool,
  AgentGitHubRepositoryConfig,
  AgentModelId,
  AgentToolId,
  AgentTriggerConfig,
  TiptapDoc,
} from "./types";

type AgentToolDefinition = {
  id: AgentToolId;
  type: AgentConfigTool["type"];
  label: string;
  description: string;
  provider?: "amp";
};

type AgentModelDefinition = {
  id: AgentModelId;
  type: "model";
  label: string;
  description: string;
  category: "Fast" | "Deep";
  supportsReasoning: boolean;
};

export const SUPPORTED_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    id: "exa",
    type: "hosted_tool",
    label: "exa",
    description: "Deep research on the web and people.",
  },
  {
    id: "amp",
    type: "coding_agent",
    provider: "amp",
    label: "AMP",
    description: "Delegate coding work to Amp inside an E2B sandbox.",
  },
];

export const SUPPORTED_AGENT_MODELS: AgentModelDefinition[] = AGENT_MODEL_CATALOG.map((model) => ({
  id: model.id,
  type: model.type,
  label: model.label,
  description: model.description,
  category: model.category,
  supportsReasoning: model.supportsReasoning,
}));

const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));
const MODEL_BY_ID = new Map(SUPPORTED_AGENT_MODELS.map((model) => [model.id, model]));
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

export type AgentConfigDerivationRepository = {
  fullName: string;
  defaultBranch: string;
};

export function extractAgentConfig(input: { name: string; content: TiptapDoc }): AgentConfig {
  return deriveAgentConfigFromContent({
    title: input.name,
    content: input.content,
    repositories: [],
  }).config;
}

export function deriveAgentConfigFromContent(input: {
  title: string;
  content: unknown;
  model?: AgentModelId;
  repositories: AgentConfigDerivationRepository[];
  triggers?: AgentTriggerConfig[];
}): { body: string; config: AgentConfig } {
  const content = sanitizeTiptapDoc(input.content);
  const body = extractPlainText(content);
  const model = collectMentionedModel(content, input.model);
  const repository = collectLastMentionedRepository(content, input.repositories);
  const tools = collectMentionedTools(content, repository?.id ?? null);
  const brain = collectMentionedBrain(content);

  return {
    body,
    config: {
      schemaVersion: "agent.v1",
      title: normalizeName(input.title),
      instructions: body,
      model: {
        provider: "vercel-ai-gateway",
        name: model.id,
      },
      tools,
      brain,
      integrations: {
        github: {
          repositories: repository ? [repository] : [],
        },
      },
      triggers: repository ? syncTriggersToRepository(input.triggers ?? [], repository) : [],
    },
  };
}

function normalizeName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function collectMentionedTools(
  doc: TiptapDoc,
  repositoryId: string | null = null,
): AgentConfigTool[] {
  const seen = new Set<string>();
  const tools: AgentConfigTool[] = [];

  walk(doc as TiptapNode, (node) => {
    const mention = parseMention(node);
    if (mention?.type !== "tool") return;
    const tool = TOOL_BY_ID.get(mention.id as AgentToolId);
    if (!tool || seen.has(tool.id)) return;
    seen.add(tool.id);
    tools.push(
      tool.id === "amp" ? toConfigTool(tool, { repository: repositoryId }) : toConfigTool(tool),
    );
  });

  return tools;
}

function collectMentionedModel(doc: TiptapDoc, fallbackModel?: AgentModelId) {
  let selected =
    MODEL_BY_ID.get(fallbackModel ?? DEFAULT_MODEL_ID) ?? MODEL_BY_ID.get(DEFAULT_MODEL_ID)!;

  walk(doc as TiptapNode, (node) => {
    const mention = parseMention(node);
    if (mention?.type !== "model") return;
    selected = MODEL_BY_ID.get(mention.id as AgentModelId) ?? selected;
  });

  return selected;
}

function collectMentionedBrain(doc: TiptapDoc) {
  const references = new Map<string, AgentBrainReference>();

  walk(doc as TiptapNode, (node) => {
    const mention = parseMention(node);
    if (mention?.type !== "brain") return;
    references.set(mention.path, {
      path: mention.path,
      type: mention.path.endsWith("/") ? "folder" : "file",
    });
  });

  return Array.from(references.values());
}

function collectLastMentionedRepository(
  doc: TiptapDoc,
  repositories: AgentConfigDerivationRepository[],
): AgentGitHubRepositoryConfig | null {
  const repositoriesById = new Map(
    repositories.map((repository) => [
      repositoryIdForFullName(repository.fullName),
      {
        id: repositoryIdForFullName(repository.fullName),
        fullName: repository.fullName,
        defaultBranch: normalizeBranch(repository.defaultBranch),
      },
    ]),
  );
  const repositoriesByFullName = new Map(
    Array.from(repositoriesById.values()).map((repository) => [
      repository.fullName.toLowerCase(),
      repository,
    ]),
  );
  let selected: AgentGitHubRepositoryConfig | null = null;

  walk(doc as TiptapNode, (node) => {
    const mention = parseMention(node);
    if (mention?.type !== "github_repository") return;
    selected =
      repositoriesById.get(mention.id) ??
      repositoriesByFullName.get(mention.id.toLowerCase()) ??
      null;
  });

  return selected;
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
      prCapable: overrides.prCapable ?? true,
    };
  }

  return {
    id: "exa",
    type: "hosted_tool",
    label: tool.label,
    description: tool.description,
  };
}

function parseMention(node: TiptapNode) {
  if (node.type !== "mention") return null;
  const attrs = asRecord(node.attrs);
  const rawId = typeof attrs?.id === "string" ? attrs.id : null;
  if (!rawId) return null;

  if (rawId.startsWith("tool:")) {
    return { type: "tool" as const, id: rawId.slice("tool:".length) };
  }

  if (rawId.startsWith("model:")) {
    return { type: "model" as const, id: normalizeModelId(rawId.slice("model:".length)) };
  }

  if (rawId.startsWith("brain/")) {
    const path = rawId.slice("brain/".length);
    if (path && !path.includes("..")) return { type: "brain" as const, path };
  }

  if (rawId.startsWith("integration:github:")) {
    return { type: "github_repository" as const, id: rawId.slice("integration:github:".length) };
  }

  if (rawId === "integration:github" || rawId === "github") {
    return { type: "github" as const, id: "github" };
  }

  if (TOOL_BY_ID.has(rawId as AgentToolId)) {
    return { type: "tool" as const, id: rawId };
  }

  const modelId = normalizeModelId(rawId);
  if (MODEL_BY_ID.has(modelId as AgentModelId)) {
    return { type: "model" as const, id: modelId };
  }

  const label = typeof attrs?.label === "string" ? attrs.label : null;
  if (label?.includes("/")) {
    return { type: "github_repository" as const, id: label };
  }

  return null;
}

function normalizeModelId(id: string) {
  if (id === "default" || id === "fast") return "openai/gpt-5.4-mini";
  if (id === "deep") return "openai/gpt-5.4";
  return id;
}

function extractPlainText(doc: TiptapDoc) {
  const blocks = (doc.content ?? [])
    .map((node) => nodeText(node as TiptapNode).trim())
    .filter(Boolean);

  return blocks.join("\n\n");
}

function nodeText(node: TiptapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const attrs = asRecord(node.attrs);
    const label = typeof attrs?.label === "string" ? attrs.label : null;
    const id = typeof attrs?.id === "string" ? attrs.id : null;
    return `@${label ?? id ?? ""}`;
  }
  return (node.content ?? []).map(nodeText).join("");
}

function walk(node: TiptapNode, visit: (node: TiptapNode) => void) {
  visit(node);
  node.content?.forEach((child) => walk(child, visit));
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

function repositoryIdForFullName(fullName: string) {
  return fullName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeBranch(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "main";
}
