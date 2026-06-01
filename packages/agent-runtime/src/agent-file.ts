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
import { isSupportedScheduleCron, normalizeScheduleTimezone } from "./schedules";
import { normalizeAgentSkills } from "./skills";
import type {
  AgentBrainReference,
  AgentConfig,
  AgentConfigTool,
  AgentFile,
  AgentGitHubPullRequestTriggerConfig,
  AgentGitHubRepositoryBinding,
  AgentGitHubRepositoryConfig,
  AgentModelId,
  AgentReference,
  AgentScheduleTriggerConfig,
  AgentSkillReference,
  AgentToolId,
  AgentTriggerConfig,
} from "./types";

const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));
const GITHUB_PULL_REQUEST_EVENTS = new Set<AgentGitHubPullRequestTriggerConfig["events"][number]>([
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
  skills?: unknown;
  integrations?: unknown;
  triggers?: unknown;
};

export type AgentConfigPatch = {
  tools?: AgentConfigTool[];
  brain?: AgentBrainReference[];
  agents?: AgentReference[];
  skills?: AgentSkillReference[];
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
  const skills = normalizeAgentSkills(frontmatter.skills);
  const triggers = normalizeTriggers(frontmatter.triggers, repositories);

  return {
    title,
    body,
    config: buildAgentConfig({
      title,
      body,
      model,
      tools,
      brain,
      agents,
      skills,
      repositories,
      triggers,
    }),
  };
}

// Upper bound on a serialized .agent file. Generous for prose instructions while still
// rejecting runaway content that would bloat the system prompt or a GitHub commit.
const MAX_AGENT_FILE_BYTES = 128 * 1024;

export type AgentFileValidationResult =
  | { ok: true; parsed: AgentFile }
  | { ok: false; errors: string[] };

/**
 * Strict validation for a serialized `.agent` file. `parseAgentFile` is intentionally
 * lenient — it never throws and silently falls back to defaults — which is the right
 * behavior for loading hand-edited files but dangerous for programmatic self-edits, where a
 * malformed change would quietly degrade the agent. This validator rejects those degenerate
 * cases so a bad self-edit surfaces an error instead of being applied.
 */
export function validateAgentFileSource(source: string): AgentFileValidationResult {
  const errors: string[] = [];
  const normalized = source.replace(/\r\n/g, "\n");

  if (new TextEncoder().encode(normalized).length > MAX_AGENT_FILE_BYTES) {
    errors.push(
      `Agent file is too large (max ${Math.floor(MAX_AGENT_FILE_BYTES / 1024)} KB). Shorten the instructions.`,
    );
  }

  if (!normalized.startsWith("---\n")) {
    errors.push("Missing YAML frontmatter: the file must start with a '---' fence.");
    return { ok: false, errors };
  }
  const fenceEnd = normalized.indexOf("\n---", 4);
  if (fenceEnd === -1) {
    errors.push("Unterminated YAML frontmatter: expected a closing '---' line.");
    return { ok: false, errors };
  }

  const yaml = normalized.slice(4, fenceEnd);
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(yaml);
  } catch (error) {
    errors.push(`Frontmatter is not valid YAML: ${error instanceof Error ? error.message : error}`);
    return { ok: false, errors };
  }
  if (!isRecord(frontmatter)) {
    errors.push("Frontmatter must be a YAML mapping of fields.");
    return { ok: false, errors };
  }

  const rawTitle = readString(frontmatter.title);
  if (!rawTitle) {
    errors.push("`title` is required and must be a non-empty string.");
  }

  // `model:` must resolve to a known model id without falling back. Aliases are not valid
  // raw `model:` values.
  const rawModel = readString(frontmatter.model);
  if (!rawModel) {
    errors.push("`model` is required and must be a known model id.");
  } else if (normalizeAgentModelId(rawModel) !== rawModel) {
    errors.push(`Unknown model "${rawModel}". Use one of the supported model ids.`);
  }

  const body = normalized.slice(fenceEnd + 4).replace(/^\n+/, "");
  if (!normalizeBody(body)) {
    errors.push("The instructions body must not be empty.");
  }

  if (errors.length > 0) return { ok: false, errors };

  const parsed = parseAgentFile(normalized);
  // Round-trip guard: re-serializing the parsed result and parsing again must reproduce the
  // same essentials. Catches any silent drift the lenient parser might introduce.
  const reparsed = parseAgentFile(
    serializeAgentFile({
      title: parsed.title,
      body: parsed.body,
      model: parsed.config.model.name,
      tools: parsed.config.tools,
      brain: parsed.config.brain,
      agents: parsed.config.agents ?? [],
      skills: parsed.config.skills ?? [],
      integrations: parsed.config.integrations,
      triggers: parsed.config.triggers,
    }),
  );
  if (
    reparsed.title !== parsed.title ||
    reparsed.config.model.name !== parsed.config.model.name ||
    reparsed.config.instructions !== parsed.config.instructions
  ) {
    return {
      ok: false,
      errors: ["The agent file did not round-trip cleanly; the change may be malformed."],
    };
  }

  return { ok: true, parsed };
}

export function serializeAgentFile(input: {
  title: string;
  body: string;
  model?: AgentModelId;
  tools?: AgentConfigTool[];
  brain?: AgentBrainReference[];
  agents?: AgentReference[];
  skills?: AgentSkillReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const body = normalizeBody(input.body);
  const fromMentions = extractConfigFromMentions(body);
  const model = normalizeModelId(input.model ?? DEFAULT_MODEL_ID);
  const brainInput = input.brain && input.brain.length > 0 ? input.brain : fromMentions.brain;
  const brain = normalizeBrainReferences(brainInput);
  const agentInput = input.agents && input.agents.length > 0 ? input.agents : fromMentions.agents;
  const agents = normalizeAgentReferences(agentInput);
  const skills = normalizeAgentSkills(input.skills);
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
      skills,
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
  skills?: AgentSkillReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const model = normalizeModelId(input.model ?? DEFAULT_MODEL_ID);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const tools = normalizeTools(input.tools);
  const brain = normalizeBrainReferences(input.brain);
  const agents = normalizeAgentReferences(input.agents);
  const skills = normalizeAgentSkills(input.skills);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);
  const frontmatter = {
    schemaVersion: "agent.v1",
    title,
    model,
    tools: serializeTools(tools),
    brain: brain.map((reference) => reference.path),
    agents: serializeAgentReferences(agents),
    // Omit `skills:` entirely when empty so existing agent files don't gain a noisy
    // empty key on re-serialize. The built-in default skill is implicit, not persisted.
    ...(skills.length > 0 ? { skills: skills.map((skill) => skill.id) } : {}),
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
  const model = normalizeModelId(input.model ?? DEFAULT_MODEL_ID);
  const brain = normalizeBrainReferences(input.config?.brain ?? mentioned.brain);
  const agents = normalizeAgentReferences(input.config?.agents ?? mentioned.agents);
  const skills = normalizeAgentSkills(input.config?.skills);
  const repositories = normalizeGitHubRepositories(input.config?.integrations);
  const tools = normalizeTools(input.config?.tools ?? mentioned.tools);
  const triggers = normalizeTriggers(input.config?.triggers ?? [], repositories);

  return {
    title,
    body,
    config: buildAgentConfig({
      title,
      body,
      model,
      tools,
      brain,
      agents,
      skills,
      repositories,
      triggers,
    }),
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
  agents: AgentReference[];
  skills: AgentSkillReference[];
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
    ...(input.skills.length > 0 ? { skills: input.skills } : {}),
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
  const trimmed = value.trim().replace(/^\/+/, "");
  const path = trimmed.startsWith("agents/") ? trimmed : `agents/${trimmed}`;
  const withExtension = path.endsWith(".agent") ? path : `${path}.agent`;
  const normalized = withExtension.replace(/\/{2,}/g, "/");
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
  let scheduleIndex = 1;

  for (const item of Array.isArray(value) ? value : []) {
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    if (type === "agent.schedule") {
      const trigger = normalizeScheduleTrigger(item, scheduleIndex);
      if (!trigger || seen.has(trigger.id)) continue;
      scheduleIndex += 1;
      seen.add(trigger.id);
      triggers.push(trigger);
      continue;
    }

    const repository = normalizeNullableRepositoryId(item.repository);
    if (type !== "github.pull_request" || !repository || !repoIds.has(repository)) continue;
    const id = normalizeTriggerId(readString(item.id) ?? `${repository}-pr`);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const events = (Array.isArray(item.events) ? item.events : [])
      .flatMap((event) => (typeof event === "string" ? [event] : []))
      .filter((event): event is AgentGitHubPullRequestTriggerConfig["events"][number] =>
        GITHUB_PULL_REQUEST_EVENTS.has(
          event as AgentGitHubPullRequestTriggerConfig["events"][number],
        ),
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

function normalizeScheduleTrigger(
  item: Record<string, unknown>,
  scheduleIndex: number,
): AgentScheduleTriggerConfig | null {
  const cron = readString(item.cron);
  const prompt = readString(item.prompt);
  if (!cron || !isSupportedScheduleCron(cron) || !prompt) return null;

  const id = normalizeTriggerId(readString(item.id) ?? `schedule-${scheduleIndex}`);
  if (!id) return null;

  return {
    id,
    type: "agent.schedule",
    cron,
    timezone: normalizeScheduleTimezone(readString(item.timezone)),
    prompt,
    enabled: readBoolean(item.enabled) ?? false,
  };
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

function normalizeTriggerId(value: string) {
  return normalizeRepositoryId(value);
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
