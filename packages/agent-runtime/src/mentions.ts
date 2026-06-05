import { AFTER_SESSION_TAG, extractAfterSessionConfig } from "./after-session";
import { AGENT_MODEL_CATALOG, type ModelRatings } from "./models";
import { MENTION_BOUNDARY_CHARS_RE, type MentionResolver } from "./tiptap-builder";
import { AGENT_TOOL_CATALOG, type AgentToolDefinition } from "./tools";
import type {
  AgentBrainReference,
  AgentCodingToolConfig,
  AgentConfig,
  AgentConfigTool,
  AgentExternalSkillReference,
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
  ratings: ModelRatings;
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
  const slug = normalized ? agentSlugFromPath(normalized) : null;
  if (!slug) return null;
  return `agent/${slug}`;
}

// Trailing punctuation that is trimmed off a mention token (mirrors
// `parseMentionText` in tiptap-builder) so "@exa." resolves as "@exa". Shared by
// every tokenizer below so they agree on where a mention token ends.
const MENTION_TRAILING_PUNCTUATION_RE = /[.,;:!?)}\]]+$/g;

export function extractMentionIds(body: string) {
  const ids: string[] = [];

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "@") continue;
    if (index > 0 && !MENTION_BOUNDARY_CHARS_RE.test(body[index - 1] ?? "")) continue;

    let end = index + 1;
    while (end < body.length && isMentionChar(body[end] ?? "")) end += 1;

    const id = body.slice(index + 1, end).replace(MENTION_TRAILING_PUNCTUATION_RE, "");
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
      ...(mentions.skills.length > 0 ? { skills: mentions.skills } : {}),
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
  if (tool.id === "amp" || tool.id === "opencode") {
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
  const repositoriesById = new Map<string, AgentGitHubRepositoryConfig>();
  const tools = new Set<AgentToolId>();
  const brain = new Map<string, AgentBrainReference>();
  const agentReferences = new Map<string, AgentReference>();
  const enabledSkills = new Map<string, AgentExternalSkillReference>();

  for (const rawId of extractMentionIds(body)) {
    // `@skill/<id>` enables a workspace skill. The mention is the enable signal; the resolved
    // object (with provenance) comes from the injected catalog. An unknown id is dropped so it
    // renders as an unresolved mention in the editor and never reaches the runtime config.
    if (rawId.toLowerCase().startsWith("skill/")) {
      const resolved = skillCatalog.get(rawId.slice("skill/".length).toLowerCase());
      if (resolved) enabledSkills.set(resolved.id, resolved);
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
    skills: Array.from(enabledSkills.values()),
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
export function repositoryMentionIdForConfig(repository: AgentGitHubRepositoryConfig) {
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

    return null;
  };

  return (token, char) => {
    const candidate = resolveCandidate(token, char);
    if (!candidate) return null;
    if (mentionDisplayText(candidate.id, candidate.label) !== token) return null;
    return candidate;
  };
}

// A single-backtick-wrapped mention found at `index` (the opening backtick),
// e.g. "`@opencode`". Returns the trigger, the bare token, and `closeIndex`
// (the closing backtick position) — or null when the span isn't a clean,
// adjacent, single-backtick wrapper. The match is intentionally strict so we
// never disturb real inline code: the inside must be exactly `@token` of
// mention chars, the closing backtick must sit immediately after them, and the
// character after must not continue a word (so "`@exa`tra" is left alone).
function matchBacktickWrappedMention(
  body: string,
  index: number,
): { trigger: "@" | "#"; token: string; closeIndex: number } | null {
  if (body[index] !== "`") return null;
  // Reject double/triple fences and mid-word backticks; the opening backtick
  // must itself sit at a boundary (start, whitespace, or an opening bracket).
  // This deliberately differs from `MENTION_BOUNDARY_CHARS_RE`, which also
  // counts a backtick as a boundary: here a preceding backtick means a nested
  // or double-fence span (e.g. "``@x`"), which we want to reject, not unwrap.
  if (index > 0 && !/[\s([{]/.test(body[index - 1] ?? "")) return null;

  const trigger = body[index + 1];
  if (trigger !== "@" && trigger !== "#") return null;

  let end = index + 2;
  while (end < body.length && isMentionChar(body[end] ?? "")) end += 1;
  if (body[end] !== "`") return null; // closing backtick must be adjacent to the token

  const after = body[end + 1];
  if (after !== undefined && isMentionChar(after)) return null; // would merge into a word

  const token = body.slice(index + 2, end).replace(MENTION_TRAILING_PUNCTUATION_RE, "");
  if (!token) return null;

  return { trigger, token, closeIndex: end };
}

/**
 * Strip the surrounding single backticks from any mention written as inline
 * code (e.g. ``Use `@opencode` `` → `Use @opencode`) when the enclosed token
 * actually resolves via `resolve`. Agents commonly format a mention as code out
 * of habit; backtick-wrapped mentions ARE now recognized by the tokenizer, but
 * leaving the backticks in place would render a pill wrapped in stray
 * backticks. Unwrapping keeps the stored body clean and `tiptapDocToBody`
 * round-tripping. Tokens that don't resolve (real inline code like `` `@param` ``)
 * are left untouched. Idempotent.
 */
export function unwrapBacktickWrappedMentions(body: string, resolve: MentionResolver): string {
  let out = "";
  let index = 0;
  while (index < body.length) {
    const match = body[index] === "`" ? matchBacktickWrappedMention(body, index) : null;
    if (match && resolve(match.token, match.trigger)) {
      // Emit "@token" (between the backticks) and skip both backticks.
      out += body.slice(index + 1, match.closeIndex);
      index = match.closeIndex + 1;
      continue;
    }
    out += body[index];
    index += 1;
  }
  return out;
}

// Mention namespaces that are unambiguously mention-intent (as opposed to prose
// containing an "@", like an email). Used by the linter to warn only on tokens
// the author clearly meant as a mention.
const NAMESPACED_MENTION_PREFIXES = ["brain/", "skill/", "agent/", "agents/"];

/**
 * Inspect a `.agent` body for mention authoring mistakes and return
 * human-readable warnings the model can act on. Two cases, chosen to keep
 * signal high (no false positives on ordinary prose or emails):
 *
 * 1. A mention wrapped in backticks whose token resolves — the save path
 *    auto-unwraps it, but the model is told so it stops doing it.
 * 2. A namespaced token (`@brain/…`, `@skill/…`, `@agent/…`) at a valid mention
 *    boundary that does NOT resolve — it looks like a mention but binds nothing.
 */
export function lintAgentBodyMentions(body: string, resolve: MentionResolver): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const push = (warning: string) => {
    if (seen.has(warning)) return;
    seen.add(warning);
    warnings.push(warning);
  };

  // Case 1: backtick-wrapped resolvable mentions.
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "`") continue;
    const match = matchBacktickWrappedMention(body, index);
    if (match && resolve(match.token, match.trigger)) {
      push(
        `Mention "${match.trigger}${match.token}" is wrapped in backticks. Write it as ${match.trigger}${match.token} (no backticks) — backtick-wrapped mentions are normalized on save and should be authored without backticks.`,
      );
    }
  }

  // Case 2: namespaced tokens that look like a mention but don't resolve. Only
  // `@` is inspected: every entry in `NAMESPACED_MENTION_PREFIXES` is an
  // `@`-namespace (brain/skill/agent), so a `#` token can never be one of them.
  for (let index = 0; index < body.length; index += 1) {
    const trigger = body[index];
    if (trigger !== "@") continue;
    if (index > 0 && !MENTION_BOUNDARY_CHARS_RE.test(body[index - 1] ?? "")) continue;

    let end = index + 1;
    while (end < body.length && isMentionChar(body[end] ?? "")) end += 1;
    const token = body.slice(index + 1, end).replace(MENTION_TRAILING_PUNCTUATION_RE, "");
    if (!token) continue;

    const lower = token.toLowerCase();
    const isNamespaced = NAMESPACED_MENTION_PREFIXES.some((prefix) => lower.startsWith(prefix));
    if (!isNamespaced) continue;
    if (resolve(token, "@")) continue;

    push(
      `"@${token}" looks like a mention but could not be resolved (unknown brain/skill/agent reference); it will not be enabled or highlighted.`,
    );
  }

  return warnings;
}
