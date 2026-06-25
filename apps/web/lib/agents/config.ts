import {
  type AgentConfigDerivationNeonDatabase,
  type AgentConfigDerivationRepository,
  type AgentConfigDerivationSkill,
  deriveAgentConfigFromBody,
  SUPPORTED_AGENT_TOOLS,
} from "@opencompany/agent-runtime";
import type {
  AgentConfig,
  AgentEngine,
  AgentGitHubRepositoryBinding,
  AgentModelId,
  AgentReference,
  AgentTriggerConfig,
  TiptapDoc,
} from "@opencompany/agent-runtime/types";
import { asRecord, sanitizeTiptapDoc, type TiptapNode } from "./tiptap";

const TOOL_ID_BY_LABEL = new Map(
  SUPPORTED_AGENT_TOOLS.map((tool) => [tool.label.toLowerCase(), tool.id]),
);

export { SUPPORTED_AGENT_MODELS, SUPPORTED_AGENT_TOOLS } from "@opencompany/agent-runtime";

export function derivePreviewConfigFromTiptapDoc(input: {
  title: string;
  content: unknown;
  engine?: AgentEngine;
  model?: AgentModelId;
  repositories: AgentConfigDerivationRepository[];
  neonDatabases?: AgentConfigDerivationNeonDatabase[];
  agents?: AgentReference[];
  skills?: AgentConfigDerivationSkill[];
  preferredRepositories?: AgentConfigDerivationRepository[];
  triggers?: AgentTriggerConfig[];
}): { body: string; config: AgentConfig } {
  const content = sanitizeTiptapDoc(input.content);
  const body = extractPlainText(content);
  const preferredRepositories = [
    ...(input.preferredRepositories ?? []),
    ...extractPreferredGitHubRepositoriesFromTiptapDoc(content, input.repositories),
  ];

  return deriveAgentConfigFromBody({
    title: input.title,
    body,
    repositories: input.repositories,
    neonDatabases: input.neonDatabases ?? [],
    agents: input.agents ?? [],
    skills: input.skills ?? [],
    preferredRepositories,
    ...(input.engine ? { engine: input.engine } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.triggers ? { triggers: input.triggers } : {}),
  });
}

export function extractPreferredGitHubRepositoriesFromTiptapDoc(
  content: unknown,
  repositories: AgentConfigDerivationRepository[],
) {
  const doc = sanitizeTiptapDoc(content);
  const preferred = new Map<string, AgentConfigDerivationRepository>();

  walkTiptapNodes(doc, (node) => {
    if (node.type !== "mention") return;
    const attrs = asRecord(node.attrs);
    if (!attrs) return;
    const id = typeof attrs.id === "string" ? attrs.id : "";
    if (!id.startsWith("integration:github:")) return;

    const binding = gitHubRepositoryBindingFromValue(attrs.binding);
    if (!binding) return;

    const matchingRepository = repositories.find(
      (repository) =>
        repository.binding &&
        repository.binding.externalId === binding.externalId &&
        repository.binding.connection.externalId === binding.connection.externalId,
    );
    const fullName =
      matchingRepository?.fullName ??
      stringValue(attrs.fullName) ??
      stringValue(attrs.label) ??
      binding.displayName;
    const defaultBranch =
      matchingRepository?.defaultBranch ?? stringValue(attrs.defaultBranch) ?? "main";
    const repository = matchingRepository ?? { fullName, defaultBranch, binding };

    preferred.set(gitHubRepositoryKey(repository), repository);
  });

  return Array.from(preferred.values());
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
    const display = mentionDisplayText(attrs);
    const char =
      typeof attrs?.mentionSuggestionChar === "string" ? attrs.mentionSuggestionChar : "@";
    return display ? `${char}${display}` : "";
  }
  return (node.content ?? []).map(nodeText).join("");
}

function walkTiptapNodes(node: TiptapNode | TiptapDoc, visit: (node: TiptapNode) => void) {
  if ("type" in node && typeof node.type === "string") {
    visit(node as TiptapNode);
  }
  node.content?.forEach((child) => walkTiptapNodes(child, visit));
}

function mentionDisplayText(attrs: Record<string, unknown> | null) {
  const id = typeof attrs?.id === "string" ? attrs.id.trim() : "";
  if (id.startsWith("tool:")) return id.slice("tool:".length);
  if (id.startsWith("model:")) return id.slice("model:".length);
  if (id.startsWith("brain/")) return id;
  if (id.startsWith("agent/")) return id;
  if (id.startsWith("skill/")) return id;
  if (id.startsWith("integration:github:")) {
    const label = typeof attrs?.label === "string" ? attrs.label.trim() : "";
    return label || id.slice("integration:github:".length);
  }
  if (id === "integration:github") return "github";
  if (id === "after-session") return "after-session";

  const label = typeof attrs?.label === "string" ? attrs.label.trim() : "";
  const normalizedLabel = label.toLowerCase();
  return TOOL_ID_BY_LABEL.get(normalizedLabel) ?? (label || id);
}

function gitHubRepositoryBindingFromValue(value: unknown): AgentGitHubRepositoryBinding | null {
  const binding = asRecord(value);
  const connection = asRecord(binding?.connection);
  if (!binding || !connection) return null;
  if (
    binding.provider !== "github" ||
    binding.resourceType !== "repository" ||
    typeof binding.externalId !== "string" ||
    typeof binding.displayName !== "string" ||
    typeof connection.externalId !== "string" ||
    typeof connection.label !== "string"
  ) {
    return null;
  }

  return {
    provider: "github",
    resourceType: "repository",
    externalId: binding.externalId,
    displayName: binding.displayName,
    connection: {
      externalId: connection.externalId,
      label: connection.label,
      accountName:
        typeof connection.accountName === "string" || connection.accountName === null
          ? connection.accountName
          : null,
      accountType:
        typeof connection.accountType === "string" || connection.accountType === null
          ? connection.accountType
          : null,
    },
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function gitHubRepositoryKey(repository: AgentConfigDerivationRepository) {
  if (!repository.binding) return repository.fullName.toLowerCase();

  return [
    repository.binding.provider,
    repository.binding.resourceType,
    repository.binding.externalId,
    repository.binding.connection.externalId,
  ].join(":");
}
