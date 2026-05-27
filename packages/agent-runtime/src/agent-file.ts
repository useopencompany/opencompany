import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { extractAfterSessionConfig } from "./after-session";
import {
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
  AgentGitHubRepositoryConfig,
  AgentModelId,
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
  version?: unknown;
  title?: unknown;
  model?: unknown;
  tools?: unknown;
  brain?: unknown;
  integrations?: unknown;
  triggers?: unknown;
};

export type AgentConfigPatch = {
  tools?: AgentConfigTool[];
  brain?: AgentBrainReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
};

export function parseAgentFile(source: string): AgentFile {
  const { frontmatter, body } = splitFrontmatter(source);
  const title = normalizeTitle(readString(frontmatter.title) ?? "Untitled agent");
  const model = normalizeModelId(readString(frontmatter.model) ?? DEFAULT_MODEL_ID);
  const brain = normalizeBrainReferences(frontmatter.brain);
  const repositories = normalizeGitHubRepositories(frontmatter.integrations);
  const tools = normalizeTools(frontmatter.tools, repositories);
  const triggers = normalizeTriggers(frontmatter.triggers, repositories);

  return {
    title,
    body,
    config: buildAgentConfig({ title, body, model, tools, brain, repositories, triggers }),
  };
}

export function serializeAgentFile(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  tools?: AgentConfigTool[];
  brain?: AgentBrainReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const fromMentions = extractConfigFromMentions(body);
  const model = normalizeModelId(input.model ?? fromMentions.model);
  const brainInput = input.brain && input.brain.length > 0 ? input.brain : fromMentions.brain;
  const brain = normalizeBrainReferences(brainInput);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const toolInput = input.tools && input.tools.length > 0 ? input.tools : fromMentions.tools;
  const tools = normalizeTools(toolInput, repositories);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);

  return [
    serializeAgentFrontmatter({
      title,
      model,
      tools,
      brain,
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
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const model = normalizeModelId(input.model);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const tools = normalizeTools(input.tools, repositories);
  const brain = normalizeBrainReferences(input.brain);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);
  const frontmatter = {
    schemaVersion: "agent.v1",
    title,
    model,
    tools: serializeTools(tools),
    brain: brain.map((reference) => reference.path),
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
  const repositories = normalizeGitHubRepositories(input.config?.integrations);
  const tools = normalizeTools(input.config?.tools ?? mentioned.tools, repositories);
  const triggers = normalizeTriggers(input.config?.triggers ?? [], repositories);

  return {
    title,
    body,
    config: buildAgentConfig({ title, body, model, tools, brain, repositories, triggers }),
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
  return `agents/${slug}.agent`;
}

function buildAgentConfig(input: {
  title: string;
  body: string;
  model: AgentModelId;
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
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

function normalizeTools(value: unknown, repositories: AgentGitHubRepositoryConfig[]) {
  const tools: AgentConfigTool[] = [];
  const seen = new Set<string>();
  const repoIds = new Set(repositories.map((repository) => repository.id));

  for (const item of Array.isArray(value) ? value : []) {
    const id = typeof item === "string" ? item : readString(isRecord(item) ? item.id : undefined);
    if (!id || seen.has(id)) continue;
    const definition = TOOL_BY_ID.get(id as AgentToolId);
    if (!definition) continue;

    if (id === "amp") {
      const record = isRecord(item) ? item : {};
      const repository = normalizeNullableRepositoryId(record.repository);
      tools.push(
        toConfigTool(definition, {
          repository: repository && repoIds.has(repository) ? repository : null,
          prCapable: readBoolean(record.prCapable) ?? true,
        }),
      );
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
        repository: tool.repository,
        prCapable: tool.prCapable,
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
    repositories.push({
      id,
      fullName,
      defaultBranch: normalizeBranch(readString(item.defaultBranch) ?? "main"),
    });
  }

  return repositories;
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
