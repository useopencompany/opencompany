import { AFTER_SESSION_TAG, extractAfterSessionConfig } from "./after-session";
import { AGENT_MODEL_CATALOG, type ModelRatings } from "./models";
import { isKnownAgentSkillId } from "./skills";
import type { MentionResolver } from "./tiptap-builder";
import { AGENT_TOOL_CATALOG, type AgentToolDefinition } from "./tools";
import type {
  AgentBrainReference,
  AgentBuiltinSkillReference,
  AgentCodingToolConfig,
  AgentConfig,
  AgentConfigTool,
  AgentEngine,
  AgentExternalSkillReference,
  AgentGitHubPullRequestTriggerConfig,
  AgentGitHubRepositoryBinding,
  AgentGitHubRepositoryConfig,
  AgentHostedToolConfig,
  AgentModelId,
  AgentNeonDatabaseConfig,
  AgentReference,
  AgentSkillReference,
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
  ratings: ModelRatings;
  contextWindowTokens: number;
};

export type AgentConfigDerivationRepository = {
  fullName: string;
  defaultBranch: string;
  binding?: AgentGitHubRepositoryBinding;
};

export type AgentConfigDerivationNeonDatabase = AgentNeonDatabaseConfig;

export type AgentConfigDerivationAgent = {
  path: string;
  name: string;
};

// The workspace's resolved external skills, matched against `@skill/<id>` body mentions.
export type AgentConfigDerivationSkill = AgentExternalSkillReference;

export const SUPPORTED_AGENT_TOOLS: AgentToolDefinition[] = AGENT_TOOL_CATALOG;

export const SUPPORTED_AGENT_MODELS: AgentModelDefinition[] = AGENT_MODEL_CATALOG.map((model) => ({
  id: model.id,
  type: model.type,
  label: model.label,
  description: model.description,
  category: model.category,
  supportsReasoning: model.supportsReasoning,
  ratings: model.ratings,
  contextWindowTokens: model.contextWindowTokens,
}));

const TOOL_BY_ID = new Map(SUPPORTED_AGENT_TOOLS.map((tool) => [tool.id, tool]));
const TOOL_BY_LABEL = new Map(
  SUPPORTED_AGENT_TOOLS.map((tool) => [tool.label.toLowerCase(), tool]),
);
const MODEL_BY_ID = new Map(SUPPORTED_AGENT_MODELS.map((model) => [model.id, model]));
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const DEFAULT_ENGINE: AgentEngine = "opencompany";

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
  const slug = normalized ? agentSlugFromPath(normalized) : null;
  if (!slug) return null;
  return `agent/${slug}`;
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
  githubAllRepositories: boolean;
  afterSession?: AgentConfig["afterSession"];
} {
  const mentions = collectBodyMentions(body, [], [], []);
  const afterSession = extractAfterSessionConfig(body);
  return {
    tools: mentions.tools,
    brain: mentions.brain,
    agents: mentions.agents,
    githubAllRepositories: mentions.githubAllRepositories,
    ...(afterSession ? { afterSession } : {}),
  };
}

export function collectBodyRepositoryMentions(body: string) {
  return extractMentionIds(body)
    .map((id) => stripGitHubMentionPrefix(id))
    .filter((id) => isValidGitHubFullName(id));
}

// Built-in skills mentioned as `@skill/<id>` in a body, as bare references. Built-in ids
// resolve straight from code (no catalog), so this powers self-edit: an agent adds a built-in
// skill (e.g. first-principles) by mentioning it, removes it by dropping the mention. External
// skills are intentionally excluded — they need workspace resolution and can't be self-added.
export function collectBuiltinSkillMentions(body: string): AgentBuiltinSkillReference[] {
  const seen = new Set<string>();
  const references: AgentBuiltinSkillReference[] = [];
  for (const rawId of extractMentionIds(body)) {
    if (!rawId.toLowerCase().startsWith("skill/")) continue;
    const id = rawId.slice("skill/".length).toLowerCase();
    if (!id || seen.has(id) || !isKnownAgentSkillId(id)) continue;
    seen.add(id);
    references.push({ id });
  }
  return references;
}

/**
 * Canonical derivation for persisted agent saves. The body is what is written
 * to the .agent file, so mention-backed runtime config must be derived from
 * this text rather than from the editor's optional Tiptap presentation cache.
 */
export function deriveAgentConfigFromBody(input: {
  title: string;
  body: string;
  engine?: AgentEngine;
  model?: AgentModelId;
  repositories: AgentConfigDerivationRepository[];
  neonDatabases?: AgentConfigDerivationNeonDatabase[];
  agents?: AgentConfigDerivationAgent[];
  skills?: AgentConfigDerivationSkill[];
  preferredRepositories?: AgentConfigDerivationRepository[];
  triggers?: AgentTriggerConfig[];
}): { body: string; config: AgentConfig } {
  const body = normalizeAgentBody(input.body);
  const mentions = collectBodyMentions(
    body,
    input.repositories,
    input.preferredRepositories ?? [],
    input.agents ?? [],
    input.skills ?? [],
  );
  const afterSession = extractAfterSessionConfig(body);
  const model =
    MODEL_BY_ID.get(input.model ?? DEFAULT_MODEL_ID) ?? MODEL_BY_ID.get(DEFAULT_MODEL_ID)!;
  const tools = bodyToolsToConfig(mentions.tools);
  const neonEnabled = mentions.tools.includes("neon");

  return {
    body,
    config: {
      schemaVersion: "agent.v1",
      title: normalizeTitle(input.title),
      instructions: body,
      engine: normalizeEngine(input.engine),
      model: {
        provider: "vercel-ai-gateway",
        name: model.id,
      },
      tools,
      brain: mentions.brain,
      agents: mentions.agents,
      ...(mentions.skills.length > 0 ? { skills: mentions.skills } : {}),
      ...(afterSession ? { afterSession } : {}),
      integrations: {
        github: {
          repositories: mentions.repositories,
          ...(mentions.githubAllRepositories ? { allRepositories: true } : {}),
        },
        ...(neonEnabled && input.neonDatabases?.length
          ? { neon: { databases: input.neonDatabases } }
          : {}),
      },
      triggers: mentions.activeRepository
        ? syncTriggersToRepository(input.triggers ?? [], mentions.activeRepository)
        : [],
    },
  };
}

function normalizeEngine(value: AgentEngine | undefined): AgentEngine {
  return value === "codex" ? "codex" : DEFAULT_ENGINE;
}

export function toConfigTool(
  tool: AgentToolDefinition,
  overrides: Partial<AgentCodingToolConfig> = {},
): AgentConfigTool {
  if (tool.id === "amp" || tool.id === "opencode" || tool.id === "codex") {
    return {
      id: tool.id,
      type: "coding_agent",
      provider: tool.id,
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
  skills: AgentConfigDerivationSkill[] = [],
) {
  const repositoryCatalog = repositoryCatalogForDerivation(repositories, preferredRepositories);
  const agentCatalog = agentCatalogForDerivation(agents);
  const skillCatalog = new Map(skills.map((skill) => [skill.id.toLowerCase(), skill]));
  let activeRepository: AgentGitHubRepositoryConfig | null = null;
  let githubAllRepositories = false;
  const repositoriesById = new Map<string, AgentGitHubRepositoryConfig>();
  const tools = new Set<AgentToolId>();
  const brain = new Map<string, AgentBrainReference>();
  const agentReferences = new Map<string, AgentReference>();
  const enabledSkills = new Map<string, AgentSkillReference>();

  for (const rawId of extractMentionIds(body)) {
    // Plain `@github` grants live integration-wide access (every repository the workspace's
    // GitHub connection can reach, resolved at session time). It deliberately does NOT set
    // `activeRepository`, so trigger syncing still follows explicit repository mentions only.
    if (rawId.toLowerCase() === "github") {
      githubAllRepositories = true;
      continue;
    }

    // `@skill/<id>` enables a skill. A known built-in id (e.g. first-principles) resolves to a
    // bare reference straight from code — no catalog needed. Otherwise the id must match the
    // injected external catalog (which carries provenance); an unknown id is dropped so it
    // renders as an unresolved mention in the editor and never reaches the runtime config.
    if (rawId.toLowerCase().startsWith("skill/")) {
      const skillId = rawId.slice("skill/".length).toLowerCase();
      if (isKnownAgentSkillId(skillId)) {
        enabledSkills.set(skillId, { id: skillId });
      } else {
        const resolved = skillCatalog.get(skillId);
        if (resolved) enabledSkills.set(resolved.id, resolved);
      }
      continue;
    }

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

    // `@github/owner/repo` is an alias for `@owner/repo` — strip the prefix before lookup.
    const repoToken = stripGitHubMentionPrefix(rawId);

    const repositoryById = repositoryCatalog.byId.get(repositoryIdForFullName(repoToken));
    if (repositoryById) {
      repositoriesById.set(repositoryById.id, repositoryById);
      activeRepository = repositoryById;
      continue;
    }

    const repositoryByFullName = repositoryCatalog.byFullName.get(repoToken.toLowerCase());
    if (repositoryByFullName) {
      repositoriesById.set(repositoryByFullName.id, repositoryByFullName);
      activeRepository = repositoryByFullName;
    }
  }

  return {
    tools: Array.from(tools),
    brain: Array.from(brain.values()),
    agents: Array.from(agentReferences.values()),
    skills: Array.from(enabledSkills.values()),
    repositories: Array.from(repositoriesById.values()),
    activeRepository,
    githubAllRepositories,
  };
}

// `@github/owner/repo` aliases `@owner/repo`; strip the `github/` prefix only when what
// follows still looks like an owner/repo pair, so a repository literally named
// `github/<repo>` keeps resolving as itself.
function stripGitHubMentionPrefix(id: string) {
  if (!id.toLowerCase().startsWith("github/")) return id;
  const remainder = id.slice("github/".length);
  return isValidGitHubFullName(remainder) ? remainder : id;
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
  const trimmed = value.trim().replace(/^@/, "").toLowerCase();
  if (trimmed.startsWith("agents/")) {
    const path = normalizeAgentPath(trimmed);
    const mentionId = path ? agentMentionIdForPath(path) : null;
    if (mentionId) return mentionId;
  }
  return trimmed.replace(/^agents\//, "agent/").replace(/\/agent\.agent$/i, "");
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
  if (!slug) return null;

  return agentPathForSlug(slug);
}

function agentPathForSlug(slug: string) {
  return `agents/${slug}/${slug}.agent`;
}

function agentSlugFromPath(path: string) {
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

// Mirrors the web editor's `repositoryMentionId` so a config-derived repository
// pill carries the same id the editor would have stored.
function repositoryMentionIdForConfig(repository: AgentGitHubRepositoryConfig) {
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

// Mirrors the web editor's `mentionIdDisplayText`: the text a mention pill
// renders for a given id (empty when the id has no recognized prefix, in which
// case the label is used instead).
function mentionIdDisplayText(id: string) {
  const trimmed = id.trim();
  if (trimmed.startsWith("tool:")) return trimmed.slice("tool:".length);
  if (trimmed.startsWith("model:")) return trimmed.slice("model:".length);
  if (trimmed.startsWith("brain/")) return trimmed;
  if (trimmed.startsWith("agent/")) return trimmed;
  if (trimmed.startsWith("skill/")) return trimmed;
  if (trimmed === "integration:github") return "github";
  if (trimmed === "after-session") return "after-session";
  return "";
}

function mentionDisplayText(id: string, label: string) {
  const idDisplay = mentionIdDisplayText(id);
  return idDisplay.length > 0 ? idDisplay : label.trim();
}

/**
 * Build a {@link MentionResolver} from an agent's persisted config. Used by the
 * runner's self-edit path to construct an authoritative Tiptap `content` doc
 * whose mention pills carry the same `{id,label}` the web catalog would produce.
 *
 * It only emits a pill when the rendered display equals the original body token
 * (a per-mention round-trip guard); otherwise the token stays plain text. This
 * keeps `tiptapDocToBody(content) === body` so the detail page renders the
 * stored doc instead of falling back to a lossy rebuild.
 */
export function buildConfigMentionResolver(config: AgentConfig): MentionResolver {
  const repositoryByFullName = new Map<string, AgentGitHubRepositoryConfig>();
  for (const repository of config.integrations?.github?.repositories ?? []) {
    repositoryByFullName.set(repository.fullName.toLowerCase(), repository);
  }

  const agentMentionIdByKey = new Map<string, string>();
  for (const agent of config.agents ?? []) {
    const mentionId = agentMentionIdForPath(agent.path);
    if (!mentionId) continue;
    agentMentionIdByKey.set(normalizeAgentMentionId(mentionId), mentionId);
    const name = agent.name.trim().toLowerCase();
    if (name) agentMentionIdByKey.set(name, mentionId);
  }

  const skillIds = new Set((config.skills ?? []).map((skill) => skill.id.toLowerCase()));

  const resolveCandidate = (
    token: string,
    char: "@" | "#",
  ): { id: string; label: string } | null => {
    if (!token) return null;

    if (char === "#") {
      const hook = AFTER_SESSION_TAG.slice(1);
      return token === hook ? { id: hook, label: hook } : null;
    }

    const toolId = toolIdFromMention(token);
    if (toolId) return { id: `tool:${toolId}`, label: toolId };

    if (brainReferenceFromMention(token)) return { id: token, label: token };

    if (token.toLowerCase().startsWith("skill/")) {
      return skillIds.has(token.slice("skill/".length).toLowerCase())
        ? { id: token, label: token }
        : null;
    }

    if (token === "github") return { id: "integration:github", label: "github" };

    const agentMentionId =
      agentMentionIdByKey.get(normalizeAgentMentionId(token)) ??
      agentMentionIdByKey.get(token.trim().toLowerCase());
    if (agentMentionId) return { id: agentMentionId, label: agentMentionId };

    const repository = repositoryByFullName.get(token.toLowerCase());
    if (repository) {
      return { id: repositoryMentionIdForConfig(repository), label: repository.fullName };
    }

    // `@github/owner/repo` alias: resolve to the same repository pill, keeping the typed
    // token as the label so the round-trip guard (display === token) holds.
    const aliasToken = stripGitHubMentionPrefix(token);
    if (aliasToken !== token) {
      const aliasRepository = repositoryByFullName.get(aliasToken.toLowerCase());
      if (aliasRepository) {
        return { id: repositoryMentionIdForConfig(aliasRepository), label: token };
      }
    }

    return null;
  };

  return (token, char) => {
    const candidate = resolveCandidate(token, char);
    if (!candidate) return null;
    if (mentionDisplayText(candidate.id, candidate.label) !== token) return null;
    return candidate;
  };
}
