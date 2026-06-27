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
  AgentEngine,
  AgentFile,
  AgentGitHubPullRequestTriggerConfig,
  AgentGitHubRepositoryBinding,
  AgentGitHubRepositoryConfig,
  AgentModelId,
  AgentNeonDatabaseBinding,
  AgentNeonDatabaseConfig,
  AgentReference,
  AgentScheduleTriggerConfig,
  AgentSkillReference,
  AgentToolId,
  AgentTriggerConfig,
} from "./types";
import { isExternalSkillReference } from "./types";

const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const DEFAULT_ENGINE: AgentEngine = "opencompany";
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
  engine?: unknown;
  model?: unknown;
  tools?: unknown;
  brain?: unknown;
  agents?: unknown;
  skills?: unknown;
  integrations?: unknown;
  triggers?: unknown;
};

export type AgentConfigPatch = {
  engine?: AgentEngine;
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
  const engine = normalizeEngine(readString(frontmatter.engine));
  const model = normalizeModelId(readString(frontmatter.model) ?? DEFAULT_MODEL_ID);
  const brain = normalizeBrainReferences(frontmatter.brain);
  const agents = normalizeAgentReferences(frontmatter.agents);
  const repositories = normalizeGitHubRepositories(frontmatter.integrations);
  const githubAllRepositories = normalizeGitHubAllRepositories(frontmatter.integrations);
  const neonDatabases = normalizeNeonDatabases(frontmatter.integrations);
  const tools = normalizeTools(frontmatter.tools);
  const skills = normalizeAgentSkills(frontmatter.skills);
  const triggers = normalizeTriggers(frontmatter.triggers, repositories);

  return {
    title,
    body,
    config: buildAgentConfig({
      title,
      body,
      engine,
      model,
      tools,
      brain,
      agents,
      skills,
      repositories,
      githubAllRepositories,
      neonDatabases,
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

  const rawEngine = readString(frontmatter.engine);
  if (rawEngine && rawEngine !== "opencompany" && rawEngine !== "codex") {
    errors.push('`engine` must be either "opencompany" or "codex".');
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
      engine: parsed.config.engine,
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
    reparsed.config.engine !== parsed.config.engine ||
    reparsed.config.model.name !== parsed.config.model.name ||
    reparsed.config.instructions !== parsed.config.instructions ||
    JSON.stringify(reparsed.config.skills ?? []) !== JSON.stringify(parsed.config.skills ?? [])
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
  engine?: AgentEngine;
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
  const engine = normalizeEngine(input.engine);
  const model = normalizeModelId(input.model ?? DEFAULT_MODEL_ID);
  const brainInput = input.brain && input.brain.length > 0 ? input.brain : fromMentions.brain;
  const brain = normalizeBrainReferences(brainInput);
  const agentInput = input.agents && input.agents.length > 0 ? input.agents : fromMentions.agents;
  const agents = normalizeAgentReferences(agentInput);
  const skills = normalizeAgentSkills(input.skills);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const neonDatabases = normalizeNeonDatabases(input.integrations);
  const toolInput = input.tools && input.tools.length > 0 ? input.tools : fromMentions.tools;
  const tools = normalizeTools(toolInput);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);

  return [
    serializeAgentFrontmatter({
      title,
      engine,
      model,
      tools,
      brain,
      agents,
      skills,
      integrations: {
        github: {
          repositories,
          // Body-derived, not taken from input.integrations: the body is the source of truth
          // for the @github mention, so stale persisted integrations (e.g. the self-edit path)
          // can never keep the flag alive after the mention is removed.
          ...(fromMentions.githubAllRepositories ? { allRepositories: true } : {}),
        },
        ...(neonDatabases.length > 0 ? { neon: { databases: neonDatabases } } : {}),
      },
      triggers,
    }),
    "",
    body,
  ].join("\n");
}

function serializeSkillReference(skill: AgentSkillReference): string | Record<string, unknown> {
  if (!isExternalSkillReference(skill)) return skill.id;
  if (skill.source.type === "workspace") {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: {
        type: skill.source.type,
        path: skill.source.path,
      },
    };
  }
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: {
      type: skill.source.type,
      url: skill.source.url,
      ref: skill.source.ref,
      path: skill.source.path,
    },
  };
}

export function serializeAgentFrontmatter(input: {
  title: string;
  model: AgentModelId;
  engine?: AgentEngine;
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
  agents?: AgentReference[];
  skills?: AgentSkillReference[];
  integrations?: AgentConfig["integrations"];
  triggers?: AgentTriggerConfig[];
}) {
  const title = normalizeTitle(input.title);
  const engine = normalizeEngine(input.engine);
  const model = normalizeModelId(input.model ?? DEFAULT_MODEL_ID);
  const repositories = normalizeGitHubRepositories(input.integrations);
  const githubAllRepositories = normalizeGitHubAllRepositories(input.integrations);
  const neonDatabases = normalizeNeonDatabases(input.integrations);
  const tools = normalizeTools(input.tools);
  const brain = normalizeBrainReferences(input.brain);
  const agents = normalizeAgentReferences(input.agents);
  const skills = normalizeAgentSkills(input.skills);
  const triggers = normalizeTriggers(input.triggers ?? [], repositories);
  const frontmatter = {
    schemaVersion: "agent.v1",
    title,
    engine,
    model,
    tools: serializeTools(tools),
    brain: brain.map((reference) => reference.path),
    agents: serializeAgentReferences(agents),
    // Omit `skills:` entirely when empty so existing agent files don't gain a noisy
    // empty key on re-serialize. The built-in default skill is implicit, not persisted.
    // Built-ins serialize as bare string ids (back-compat); external skills serialize as
    // objects in a fixed key order so the YAML output (and GitHub-sync hash) is deterministic.
    ...(skills.length > 0 ? { skills: skills.map(serializeSkillReference) } : {}),
    integrations: {
      github: {
        repositories,
        // Omit when false so existing agent files don't gain a noisy key on re-serialize.
        ...(githubAllRepositories ? { allRepositories: true } : {}),
      },
      ...(neonDatabases.length > 0 ? { neon: { databases: neonDatabases } } : {}),
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
  const engine = normalizeEngine(input.config?.engine);
  const model = normalizeModelId(input.model ?? DEFAULT_MODEL_ID);
  const brain = normalizeBrainReferences(input.config?.brain ?? mentioned.brain);
  const agents = normalizeAgentReferences(input.config?.agents ?? mentioned.agents);
  const skills = normalizeAgentSkills(input.config?.skills);
  const repositories = normalizeGitHubRepositories(input.config?.integrations);
  const neonDatabases = normalizeNeonDatabases(input.config?.integrations);
  const tools = normalizeTools(input.config?.tools ?? mentioned.tools);
  const triggers = normalizeTriggers(input.config?.triggers ?? [], repositories);

  return {
    title,
    body,
    config: buildAgentConfig({
      title,
      body,
      engine,
      model,
      tools,
      brain,
      agents,
      skills,
      repositories,
      // Body-derived (like serializeAgentFile): the @github mention is the source of truth.
      githubAllRepositories: mentioned.githubAllRepositories,
      neonDatabases,
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
  return `agents/${slug}/${slug}.agent`;
}

export function agentBundleDir(path: string) {
  return path.replace(/\/[^/]+$/g, "");
}

export function agentSlugFromPath(path: string) {
  const normalized = path
    .trim()
    .replace(/^@/, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  const parts = normalized.split("/");
  if (parts.length !== 3 || parts[0] !== "agents") return null;

  const [, slug, fileName] = parts;
  if (!slug || !/^[a-z0-9-]+$/.test(slug) || slug.includes("..") || slug.startsWith(".")) {
    return null;
  }
  if (fileName !== `${slug}.agent` && fileName !== "agent.agent") return null;
  return slug;
}

export function agentDefinitionFileNameForPath(path: string) {
  const slug = agentSlugFromPath(path);
  return slug ? `${slug}.agent` : "agent.agent";
}

function buildAgentConfig(input: {
  title: string;
  body: string;
  engine: AgentEngine;
  model: AgentModelId;
  tools: AgentConfigTool[];
  brain: AgentBrainReference[];
  agents: AgentReference[];
  skills: AgentSkillReference[];
  repositories: AgentGitHubRepositoryConfig[];
  githubAllRepositories: boolean;
  neonDatabases: AgentNeonDatabaseConfig[];
  triggers: AgentTriggerConfig[];
}): AgentConfig {
  const afterSession = extractAfterSessionConfig(input.body);

  return {
    schemaVersion: "agent.v1",
    title: input.title,
    instructions: input.body,
    engine: input.engine,
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
        ...(input.githubAllRepositories ? { allRepositories: true } : {}),
      },
      ...(input.neonDatabases.length > 0
        ? {
            neon: {
              databases: input.neonDatabases,
            },
          }
        : {}),
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

function normalizeEngine(value: string | undefined | null): AgentEngine {
  return value === "codex" ? "codex" : DEFAULT_ENGINE;
}

function normalizeTools(value: unknown) {
  const tools: AgentConfigTool[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(value) ? value : []) {
    const id = typeof item === "string" ? item : readString(isRecord(item) ? item.id : undefined);
    if (!id || seen.has(id)) continue;
    const definition = TOOL_BY_ID.get(id as AgentToolId);
    if (!definition) continue;

    if (id === "amp" || id === "opencode" || id === "codex") {
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
    if (tool.id === "amp" || tool.id === "opencode" || tool.id === "codex") {
      const serialized = {
        id: tool.id,
        type: tool.type,
        provider: tool.provider,
        prCapable: tool.prCapable,
      };
      if (tool.id === "codex") {
        return {
          ...serialized,
          label: tool.label,
          description: tool.description,
        };
      }
      return serialized;
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
    : agentPathForSlug(withoutAgentPrefix.replace(/\/{2,}/g, "/"));
  const slug = agentSlugFromPath(normalized);
  if (!slug || !agentMentionIdForPath(normalized)) return null;
  return agentPathForSlug(slug);
}

function normalizeAgentName(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "Untitled agent";
}

// Whether the integrations frontmatter/config carries the live `@github` all-repositories
// scope. Anything but a literal `true` normalizes to false so old files stay byte-identical.
function normalizeGitHubAllRepositories(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.github)) return false;
  return value.github.allRepositories === true;
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

function normalizeNeonDatabases(value: unknown): AgentNeonDatabaseConfig[] {
  const databasesValue = isRecord(value)
    ? isRecord(value.neon)
      ? value.neon.databases
      : undefined
    : undefined;
  const rows = Array.isArray(databasesValue) ? databasesValue : [];
  const databases: AgentNeonDatabaseConfig[] = [];
  const seen = new Set<string>();

  for (const item of rows) {
    if (!isRecord(item)) continue;
    const projectId = normalizeNeonId(readString(item.projectId));
    const branchId = normalizeNeonId(readString(item.branchId));
    const databaseName = normalizeDatabaseIdentifier(readString(item.databaseName));
    const roleName = normalizeDatabaseIdentifier(readString(item.roleName));
    if (!projectId || !branchId || !databaseName || !roleName) continue;
    const id = normalizeRepositoryId(
      readString(item.id) ?? `${projectId}-${branchId}-${databaseName}-${roleName}`,
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const binding = normalizeNeonDatabaseBinding(item.binding);
    const displayName =
      readString(item.displayName) ?? `${projectId}/${branchId}/${databaseName} (${roleName})`;
    databases.push({
      id,
      projectId,
      branchId,
      databaseName,
      roleName,
      displayName,
      ...(binding ? { binding } : {}),
    });
  }

  return databases;
}

function normalizeNeonDatabaseBinding(value: unknown): AgentNeonDatabaseBinding | null {
  if (!isRecord(value)) return null;
  const provider = readString(value.provider);
  const resourceType = readString(value.resourceType);
  const externalId = readString(value.externalId);
  const displayName = readString(value.displayName);
  const connection = isRecord(value.connection) ? value.connection : null;
  const connectionExternalId = readString(connection?.externalId);
  if (
    provider !== "neon" ||
    resourceType !== "database" ||
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

function normalizeNeonId(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

function normalizeDatabaseIdentifier(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(trimmed) ? trimmed : null;
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
