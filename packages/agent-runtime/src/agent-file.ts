import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { extractAfterSessionConfig } from "./after-session";
import {
  agentMentionIdForPath,
  extractConfigFromMentions,
  normalizeAgentBody,
  normalizeAgentModelId,
  repositoryIdForFullName,
  SUPPORTED_AGENT_TOOLS,
  toConfigTool,
} from "./mentions";
import type {
  AgentBrainReference,
  AgentConfig,
  AgentConfigTool,
  AgentFile,
  AgentGitHubRepositoryBinding,
  AgentGitHubRepositoryConfig,
  AgentModelId,
  AgentReference,
  AgentToolId,
  AgentTriggerConfig,
} from "./types";

const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));
const GITHUB_PULL_REQUEST_EVENTS = new Set<AgentTriggerConfig["events"][number]>([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

type Frontmatter = {
  schemaVersion?: unknown;
  title?: unknown;
  model?: unknown;
  tools?: unknown;
  brain?: unknown;
  agents?: unknown;
  integrations?: unknown;
  triggers?: unknown;
};

export type AgentConfigPatch = {
  tools?: AgentConfigTool[];
  brain?: AgentBrainReference[];
  agents?: AgentReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
};

export function parseAgentFile(source: string): AgentFile {
  const { frontmatter, body } = splitFrontmatter(source);
  const title = normalizeTitle(readString(frontmatter.title) ?? "Untitled agent");
  const model = normalizeModelId(readString(frontmatter.model) ?? DEFAULT_MODEL_ID);
  const brain = normalizeBrainReferences(frontmatter.brain);
  const agents = normalizeAgentReferences(frontmatter.agents);
  const repositories = normalizeGitHubRepositories(frontmatter.integrations);
  const tools = normalizeTools(frontmatter.tools);
  const triggers = normalizeTriggers(frontmatter.triggers, repositories);

  return {
    title,
    body,
    config: buildAgentConfig({ title, body, model, tools, brain, agents, repositories, triggers }),
  };
}

export function serializeAgentFile(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  tools?: AgentConfigTool[];
  brain?: AgentBrainReference[];
  agents?: AgentReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const fromMentions = extractConfigFromMentions(body);
  const model = normalizeModelId(input.model ?? fromMentions.model);
  const brainInput = input.brain && input.brain.length > 0 ? input.brain : fromMentions.brain;
  const brain = normalizeBrainReferences(brainInput);
  const agentInput = input.agents && input.agents.length > 0 ? input.agents : fromMentions.agents;
  const agents = normalizeAgentReferences(agentInput);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const toolInput = input.tools && input.tools.length > 0 ? input.tools : fromMentions.tools;
  const tools = normalizeTools(toolInput);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);

  return [
    serializeAgentFrontmatter({
      title,
      model,
      tools,
      brain,
      agents,
      integrations: {
        github: {
          repositories,
        },
      },
      triggers,
    }),
    "",
    body,
  ].join("\n");
}

export function serializeAgentFrontmatter(input: {
  title: string;
  model: AgentModelId;
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
  agents?: AgentReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const model = normalizeModelId(input.model);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const tools = normalizeTools(input.tools);
  const brain = normalizeBrainReferences(input.brain);
  const agents = normalizeAgentReferences(input.agents);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);
  const frontmatter = {
    schemaVersion: "agent.v1",
    title,
    model,
    tools: serializeTools(tools),
    brain: brain.map((reference) => reference.path),
    agents: serializeAgentReferences(agents),
    integrations: {
      github: {
        repositories,
      },
    },
    triggers,
  };

  return ["---", stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd(), "---"].join("\n");
}

export function buildAgentFile(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  config?: AgentConfigPatch;
}): AgentFile {
  const body = normalizeBody(input.body);
  const title = normalizeTitle(input.title);
  const mentioned = extractConfigFromMentions(body);
  const model = normalizeModelId(input.model ?? mentioned.model);
  const brain = normalizeBrainReferences(input.config?.brain ?? mentioned.brain);
  const agents = normalizeAgentReferences(input.config?.agents ?? mentioned.agents);
  const repositories = normalizeGitHubRepositories(input.config?.integrations);
  const tools = normalizeTools(input.config?.tools ?? mentioned.tools);
  const triggers = normalizeTriggers(input.config?.triggers ?? [], repositories);

  return {
    title,
    body,
    config: buildAgentConfig({ title, body, model, tools, brain, agents, repositories, triggers }),
  };
}

export function slugifyAgentTitle(title: string) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "untitled-agent";
}

export function agentPathForSlug(slug: string) {
  return `agents/${slug}/agent.agent`;
}

export function agentBundleDir(path: string) {
  return path.replace(/\/[^/]+$/g, "");
}

function buildAgentConfig(input: {
  title: string;
  body: string;
  model: AgentModelId;
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
  agents: AgentReference[];
  repositories: AgentGitHubRepositoryConfig[];
  triggers: AgentTriggerConfig[];
}): AgentConfig {
  const afterSession = extractAfterSessionConfig(input.body);

  return {
    schemaVersion: "agent.v1",
    title: input.title,
    instructions: input.body,
    model: {
      provider: "vercel-ai-gateway",
      name: input.model,
    },
    tools: input.tools,
    brain: input.brain,
    agents: input.agents,
    ...(afterSession ? { afterSession } : {}),
    integrations: {
      github: {
        repositories: input.repositories,
      },
    },
    triggers: input.triggers,
  };
}

function splitFrontmatter(source: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const yaml = normalized.slice(4, end);
  const bodyStart = normalized.slice(end + 4).replace(/^\n+/, "");
  return {
    frontmatter: parseFrontmatter(yaml),
    body: bodyStart,
  };
}

function parseFrontmatter(yaml: string): Frontmatter {
  try {
    const parsed = parseYaml(yaml);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function normalizeBody(body: string) {
  return normalizeAgentBody(body);
}

function normalizeModelId(id: string): AgentModelId {
  return normalizeAgentModelId(id);
}

function normalizeTools(value: unknown) {
  const tools: AgentConfigTool[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(value) ? value : []) {
    const id = typeof item === "string" ? item : readString(isRecord(item) ? item.id : undefined);
    if (!id || seen.has(id)) continue;
    const definition = TOOL_BY_ID.get(id as AgentToolId);
    if (!definition) continue;

    if (id === "amp") {
      const record = isRecord(item) ? item : {};
      tools.push(
        toConfigTool(definition, {
          prCapable: readBoolean(record.prCapable) ?? true,
        }),
      );
    } else if (definition.type === "mcp") {
      tools.push(toConfigTool(definition));
    } else {
      tools.push(toConfigTool(definition));
    }
    seen.add(id);
  }

  return tools;
}

function serializeTools(tools: AgentConfigTool[]) {
  return tools.map((tool) => {
    if (tool.id === "amp") {
      return {
        id: tool.id,
        type: tool.type,
        provider: tool.provider,
        prCapable: tool.prCapable,
      };
    }
    if (tool.type === "mcp") {
      return {
        id: tool.id,
        type: tool.type,
        server: tool.server,
      };
    }

    return {
      id: tool.id,
      type: tool.type,
    };
  });
}

function normalizeBrainReferences(value: unknown) {
  const references = new Map<string, AgentBrainReference>();
  for (const item of Array.isArray(value) ? value : []) {
    const raw = typeof item === "string" ? item : readString(isRecord(item) ? item.path : item);
    if (!raw) continue;
    const reference = normalizeBrainReference(raw);
    if (reference) references.set(reference.path, reference);
  }
  return Array.from(references.values());
}

function normalizeBrainReference(input: string): AgentBrainReference | null {
  const trimmed = input.trim();
  if (trimmed === "/" || trimmed === "brain/") {
    return { path: "/", type: "folder" };
  }

  const folder = trimmed.endsWith("/");
  const path = trimmed
    .replace(/^brain\//, "")
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

function normalizeAgentReferences(value: unknown) {
  const references = new Map<string, AgentReference>();
  for (const item of Array.isArray(value) ? value : []) {
    const record = isRecord(item) ? item : null;
    const rawPath = typeof item === "string" ? item : readString(record?.path);
    if (!rawPath) continue;
    const path = normalizeAgentPath(rawPath);
    if (!path) continue;
    references.set(path, {
      path,
      name: normalizeAgentName(readString(record?.name) ?? path),
    });
  }
  return Array.from(references.values());
}

function serializeAgentReferences(agents: AgentReference[]) {
  return agents.map((agent) => ({
    path: agent.path,
    name: agent.name,
  }));
}

function normalizeAgentPath(value: string) {
  const trimmed = value.trim().replace(/^@/, "").replace(/^\/+/, "");
  const withoutAgentPrefix = trimmed.startsWith("agent/")
    ? trimmed.slice("agent/".length)
    : trimmed;
  const normalized = withoutAgentPrefix.startsWith("agents/")
    ? withoutAgentPrefix.replace(/\/{2,}/g, "/")
    : `agents/${withoutAgentPrefix.replace(/\/{2,}/g, "/")}/agent.agent`;
  const mentionId = agentMentionIdForPath(normalized);
  if (!mentionId) return null;
  return normalized;
}

function normalizeAgentName(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

function normalizeGitHubRepositories(value: unknown): AgentGitHubRepositoryConfig[] {
  const repositoriesValue = isRecord(value)
    ? isRecord(value.github)
      ? value.github.repositories
      : undefined
    : undefined;
  const rows = Array.isArray(repositoriesValue) ? repositoriesValue : [];
  const repositories: AgentGitHubRepositoryConfig[] = [];
  const seen = new Set<string>();

  for (const item of rows) {
    if (!isRecord(item)) continue;
    const fullName = readString(item.fullName);
    if (!fullName || !isValidGitHubFullName(fullName)) continue;
    const id = normalizeRepositoryId(readString(item.id) ?? repositoryIdForFullName(fullName));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const binding = normalizeGitHubRepositoryBinding(item.binding);
    repositories.push({
      id,
      fullName,
      defaultBranch: normalizeBranch(readString(item.defaultBranch) ?? "main"),
      ...(binding ? { binding } : {}),
    });
  }

  return repositories;
}

function normalizeGitHubRepositoryBinding(value: unknown): AgentGitHubRepositoryBinding | null {
  if (!isRecord(value)) return null;
  const provider = readString(value.provider);
  const resourceType = readString(value.resourceType);
  const externalId = readString(value.externalId);
  const displayName = readString(value.displayName);
  const connection = isRecord(value.connection) ? value.connection : null;
  const connectionExternalId = readString(connection?.externalId);
  if (
    provider !== "github" ||
    resourceType !== "repository" ||
    !externalId ||
    !displayName ||
    !connectionExternalId
  ) {
    return null;
  }

  return {
    provider,
    resourceType,
    externalId,
    displayName,
    connection: {
      externalId: connectionExternalId,
      label: readString(connection?.label) ?? connectionExternalId,
      accountName: readString(connection?.accountName),
      accountType: readString(connection?.accountType),
    },
  };
}

function normalizeTriggers(value: unknown, repositories: AgentGitHubRepositoryConfig[]) {
  const repoIds = new Set(repositories.map((repository) => repository.id));
  const triggers: AgentTriggerConfig[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(value) ? value : []) {
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    const repository = normalizeNullableRepositoryId(item.repository);
    if (type !== "github.pull_request" || !repository || !repoIds.has(repository)) continue;
    const id = normalizeRepositoryId(readString(item.id) ?? `${repository}-pr`);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const events = (Array.isArray(item.events) ? item.events : [])
      .flatMap((event) => (typeof event === "string" ? [event] : []))
      .filter((event): event is AgentTriggerConfig["events"][number] =>
        GITHUB_PULL_REQUEST_EVENTS.has(event as AgentTriggerConfig["events"][number]),
      );
    triggers.push({
      id,
      type,
      repository,
      events: events.length > 0 ? Array.from(new Set(events)) : ["opened", "synchronize"],
      branches: normalizeBranches(item.branches),
      enabled: readBoolean(item.enabled) ?? false,
    });
  }

  return triggers;
}

function normalizeBranches(value: unknown) {
  const branches = (Array.isArray(value) ? value : [])
    .flatMap((branch) => (typeof branch === "string" ? [normalizeBranch(branch)] : []))
    .filter(Boolean);
  return branches.length > 0 ? Array.from(new Set(branches)) : ["main"];
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

function normalizeNullableRepositoryId(value: unknown) {
  const repository = readString(value);
  return repository ? normalizeRepositoryId(repository) : null;
}

function isValidGitHubFullName(value: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
