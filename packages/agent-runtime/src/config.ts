import {
  getAgentModelDefinition,
  getAgentModelRuntimeOptions,
  type ModelProviderOptions,
  type ReasoningExposure,
} from "./models";
import {
  formatWorkspaceToolPolicyContext,
  mcpSearchToolsName,
  mcpUseToolName,
  PROVIDER_PERMISSION_REGISTRY,
  type WorkspaceToolPolicyMap,
} from "./permissions";
import {
  AGENT_SELF_EDIT_SKILL_ID,
  MEMORY_SKILL_ID,
  type ResolvedSkillMetadata,
  resolveEnabledSkillMetadata,
  SKILL_CREATOR_SKILL_ID,
} from "./skills";
import {
  AGENT_TOOL_DEFINITION_BY_ID,
  type AgentToolDefinition,
  BUILTIN_USE_TOOL_NAME,
  type RuntimeToolName,
  resolveRuntimeToolNamesForConfigTools,
} from "./tools";
import type {
  AgentConfig,
  AgentConfigTool,
  AgentGitHubRepositoryConfig,
  AgentMcpToolConfig,
  AgentToolId,
} from "./types";

type PartialPersistedAgentConfig = Omit<Partial<AgentConfig>, "integrations"> & {
  integrations?: {
    github?: {
      repositories?: AgentGitHubRepositoryConfig[];
    };
  };
};

export type ResolvedAgentRuntimeConfig = {
  systemPrompt: string;
  model: {
    provider: "vercel-ai-gateway";
    name: string;
    supportsReasoning: boolean;
    providerOptions?: ModelProviderOptions;
    reasoningExposure: ReasoningExposure;
  };
  tools: RuntimeToolName[];
  mcpServers: AgentMcpToolConfig[];
};

export function resolveAgentRuntimeConfig(input: {
  agent: AgentConfig;
  // Per-session model override (the session's stored modelName). When set to a
  // valid catalog model it wins over the agent's saved default for this run;
  // anything unknown/stale falls back to the agent default. The agent's own
  // configured default (agent.model.name) is never mutated by this.
  modelOverride?: string;
  workspaceName?: string;
  sessionTitle?: string;
  userName?: string;
  userFirstName?: string;
  userLastName?: string;
  userEmail?: string;
  // The agent's "profile": the raw contents of `agent/user.md` (who the user is — identity,
  // preferences, communication style, goals). Injected verbatim (capped) into the system prompt
  // so the agent carries a tiny, curated profile into every session without retrieving it. The
  // caller reads it from the DB at session start; an absent/empty file falls back to an invitation
  // placeholder. See buildProfileSection. Durable facts live in structured memory (the `memory`
  // tool), not here.
  userMemory?: string | undefined;
  // Personal skills discovered from the agent's bundle (agent/skills/<id>/SKILL.md), as metadata
  // only. The runner scans these at session start and passes them in; they merge into the ## Skills
  // index alongside built-in/external skills. Pure-config callers can omit this.
  personalSkills?: ResolvedSkillMetadata[] | undefined;
  toolPolicy?: {
    policy: WorkspaceToolPolicyMap;
    suspendable: boolean;
  };
  // True when this is the user's personal/default agent (agents.isDefault). Hard-gates the
  // inbox tools so only the personal agent can post to a user's personal inbox.
  personalAgent?: boolean;
}): ResolvedAgentRuntimeConfig {
  const instructions = input.agent.instructions.trim() || "Help the user complete the task.";
  const repositories = input.agent.integrations?.github?.repositories ?? [];
  const baseSkills = resolveEnabledSkillMetadata(input.agent);
  // Personal skills never shadow a built-in/external skill: drop any whose id is already taken.
  const baseSkillIds = new Set(baseSkills.map((skill) => skill.id));
  const personalSkills = (input.personalSkills ?? []).filter(
    (skill) => !baseSkillIds.has(skill.id),
  );
  const skills = [...baseSkills, ...personalSkills];
  const mcpServerKeys = [
    ...new Set(
      input.agent.tools
        .filter((tool): tool is AgentMcpToolConfig => tool.type === "mcp")
        .map((tool) => tool.server),
    ),
  ];
  const toolPolicyContext = input.toolPolicy
    ? formatWorkspaceToolPolicyContext({
        providerKeys: enabledGatedProviderKeys(input.agent, repositories),
        policy: input.toolPolicy.policy,
        suspendable: input.toolPolicy.suspendable,
      })
    : null;
  const context = [
    "You are an OpenCompany agent running in an isolated cloud sandbox.",
    "Use tools when you need to inspect or change files, run commands, or verify work.",
    "When you genuinely need user input to proceed correctly, call ask_user_question instead of ending your response with a question. Batch the few decisions you need now, give clear options, and continue after the user answers. Do not use ask_user_question for progress updates or permission to use ordinary tools.",
    "Avoid launching more than eight tool calls in one batch; inspect results before deciding whether more calls are useful.",
    "Keep command output concise and explain material changes to the user.",
    "When a request will take more than a few tool calls or roughly twenty seconds, open your reply with one or two plain-language sentences before any tool call: what you are about to do, a rough time estimate, what you will deliver, and what you will save to memory. Offer a useful optional add-on when it fits. For quick replies, skip this and answer directly.",
    "The sandbox has four file roots. Choose where to put something by how long it should last and who needs it: ./work is a temporary scratch directory for this session only (drafts, intermediate files, deliverables, cloned repos) — nothing here survives the session. ./agent is your private agent folder that persists across sessions, including your profile (agent/user.md) and any other private files worth carrying forward. ./brain is shared company knowledge other agents and people rely on; edit it only via mounted @brain/... refs. ./skills is read-only; open it with read_skill.",
    "agent/memory/ is your structured, evidence-grounded MEMORY (canonical objects + cited evidence) — the single store for every durable fact, retrieved on demand (specific people, companies, projects, decisions, lessons). Manage it ONLY through the `memory` tool (not shell), never by editing files there directly; read the memory skill (skill id `memory`) with read_skill before using it.",
    `agent/skills/ holds your PERSONAL SKILLS: reusable how-to procedures you save for yourself as agent/skills/<id>/SKILL.md folders. They are auto-discovered, listed in ## Skills, and loadable with read_skill from your next session on. When you spot a repeatable workflow worth keeping (or are asked to save one), read the skill-creator skill (read_skill with skillId "${SKILL_CREATOR_SKILL_ID}") and follow it. Use a skill for a repeatable procedure; use memory for facts and your .agent definition for how you behave.`,
    "Where things go (route by lifespan + audience): one-off that won't matter next session → leave it in the conversation, write nothing. How you behave going forward (a standing preference, tone, default tool/model) → your .agent definition via self-edit, not a file. Who your user is (identity, preferences, communication style, goals) → agent/user.md, your profile (see the 'Your profile' section below). Any other durable fact worth remembering (specific people, companies, projects, decisions, lessons, conventions) → structured memory via the `memory` tool. A repeatable procedure worth reusing → a personal skill under agent/skills/. Knowledge the whole team relies on → ./brain. Throwaway scratch for this session → ./work.",
    "File tools require paths prefixed with work/, brain/, or agent/. Bare paths like README.md are invalid; use work/README.md, brain/README.md, or agent/user.md. Use read_skill for skill files.",
    "Use edit_file for targeted changes to existing files. Use write_file only for new files or intentional full-file overwrites.",
    ...opencodePublicRepositoryContext(input.agent, repositories),
    ...githubRepositoryContext(repositories),
    input.agent.brain?.length
      ? `Brain files are mounted under ./brain for this session: ${input.agent.brain
          .map((reference) => formatBrainReferencePath(reference.path))
          .join(
            ", ",
          )}. You can only read or write Brain files under those mounted paths — attempts to access any other Brain path are rejected. To change scope, update this agent's brain refs via self-edit.`
      : null,
    input.agent.agents?.length
      ? `Delegatable workspace agents: ${input.agent.agents
          .map((agent) => `${agent.name} (${agent.path})`)
          .join(
            ", ",
          )}. Use delegate_to_agent for focused subtasks that should be handled by one of these agents. The tool returns a childSessionId; pass that id as sessionId in a later delegate_to_agent call to continue the same delegated session when continuity matters.`
      : null,
    buildToolsIndexSection({ agentTools: input.agent.tools, mcpServerKeys }),
    buildSkillsIndexSection(skills),
    skills.some((skill) => skill.id === AGENT_SELF_EDIT_SKILL_ID)
      ? `You can evolve your own definition. The moment the user asks you to change how you work going forward (a standing preference, tone, workflow, default tool, or model), read skills/agent-self-edit/SKILL.md with read_skill before calling update_agent_file — the runner requires it and will reject an edit you make without reading the skill first. update_agent_file is not preloaded: after reading the skill, discover its schema with find_tools({ query: "update_agent_file" }) and run it with ${BUILTIN_USE_TOOL_NAME}({ tool: "update_agent_file", arguments }).`
      : null,
    toolPolicyContext,
    `Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    input.workspaceName ? `Workspace: ${input.workspaceName}` : null,
    input.sessionTitle ? `Session: ${input.sessionTitle}` : null,
    ...formatUserContext(input),
    buildProfileSection({ userMemory: input.userMemory }),
  ].filter(Boolean);

  const effectiveModelName =
    input.modelOverride && getAgentModelDefinition(input.modelOverride)
      ? input.modelOverride
      : input.agent.model.name;
  const modelRuntime = getAgentModelRuntimeOptions(effectiveModelName);

  return {
    systemPrompt: `${context.join("\n")}\n\nAgent instructions:\n${instructions}`,
    model: {
      provider: "vercel-ai-gateway",
      name: effectiveModelName,
      supportsReasoning: modelRuntime.supportsReasoning,
      ...(modelRuntime.providerOptions ? { providerOptions: modelRuntime.providerOptions } : {}),
      reasoningExposure: modelRuntime.reasoningExposure,
    },
    tools: resolveRuntimeToolNamesForConfigTools({
      tools: input.agent.tools,
      agents: input.agent.agents,
      repositories,
      selfEditEnabled: skills.some((skill) => skill.id === AGENT_SELF_EDIT_SKILL_ID),
      memorySkillEnabled: skills.some((skill) => skill.id === MEMORY_SKILL_ID),
      personalInboxEnabled: input.personalAgent ?? false,
    }),
    mcpServers: input.agent.tools.filter((tool): tool is AgentMcpToolConfig => tool.type === "mcp"),
  };
}

// Hard byte cap on the profile (agent/user.md) when injected into the system prompt. It loads
// into EVERY turn, so an unbounded file would silently bloat context and degrade the prompt
// cache. Kept deliberately small (Hermes-style "tiny memory"); content beyond it is truncated
// with a visible marker so the agent is nudged to trim rather than losing data unknowingly.
// Durable long-tail facts belong in structured memory (the `memory` tool), not here.
export const MAX_PROFILE_BYTES = 3072;

// Truncate on a UTF-8 byte boundary (not a code-unit boundary) so multibyte characters are
// never split, and append a marker the agent can see and act on. Returns the input unchanged
// when it already fits.
function truncateProfile(content: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(content).length <= MAX_PROFILE_BYTES) return content;
  const marker = "\n…[truncated — trim your profile to keep it under ~3KB]";
  const budget = MAX_PROFILE_BYTES - encoder.encode(marker).length;
  // Walk back from the byte budget to the nearest valid character boundary.
  let end = content.length;
  while (end > 0 && encoder.encode(content.slice(0, end)).length > budget) {
    end -= 1;
  }
  return `${content.slice(0, end).trimEnd()}${marker}`;
}

// The "Your profile" block: the agent's always-loaded user.md, injected verbatim (capped) so
// identity/preferences ride in every session without a retrieval step. An empty file shows an
// invitation placeholder so a fresh agent is nudged to start a profile rather than seeing nothing.
// This is NOT a general facts store — durable facts go into structured memory via the `memory` tool.
function buildProfileSection(input: { userMemory: string | undefined }): string {
  const trimmed = input.userMemory?.trim() ?? "";
  const body = trimmed
    ? truncateProfile(trimmed)
    : "(empty — populate this as you learn who your user is)";
  return [
    "## Your profile — agent/user.md, loaded at the start of every session (keep it tight; ~3KB cap)",
    "Who your user is: identity, preferences, communication style, goals. Edit it with file tools as you learn; changes take effect next session. This is NOT a general facts store — durable facts about people, companies, projects, and decisions go into structured memory via the `memory` tool.",
    "",
    body,
  ].join("\n");
}

function formatUserContext(input: {
  userName?: string;
  userFirstName?: string;
  userLastName?: string;
  userEmail?: string;
}) {
  const userName = input.userName?.trim() || input.userEmail?.trim();
  return [
    userName ? `User: ${userName}` : null,
    input.userFirstName?.trim() ? `User first name: ${input.userFirstName.trim()}` : null,
    input.userLastName?.trim() ? `User last name: ${input.userLastName.trim()}` : null,
  ].filter(Boolean);
}

// The `## Tools` index: a compact, cached spine of every capability the agent can reach this
// session, grouped into built-in capabilities and workspace MCP servers. Full tool schemas are NOT
// listed here — the model expands them on demand with find_tools / {server}__search_tools and runs
// one with use_tool / {server}__use_tool. Keeping only one-liners caches cleanly (no system-prompt
// mutation on discovery) and keeps the number of definitions visible at decision time small, which
// is what tool-selection accuracy depends on.
function buildToolsIndexSection(input: {
  agentTools: AgentConfigTool[];
  mcpServerKeys: string[];
}): string | null {
  const builtinCapabilities: AgentToolDefinition[] = [];
  const seen = new Set<AgentToolId>();
  for (const tool of input.agentTools) {
    if (tool.type === "mcp" || typeof tool.id !== "string" || seen.has(tool.id)) continue;
    const definition = AGENT_TOOL_DEFINITION_BY_ID.get(tool.id);
    if (!definition || (definition.type !== "hosted_tool" && definition.type !== "coding_agent")) {
      continue;
    }
    seen.add(tool.id);
    builtinCapabilities.push(definition);
  }

  const lines: string[] = [
    "## Tools",
    "Core file and shell tools (read_file, write_file, edit_file, list_files, git_diff, shell, read_skill) are available directly.",
    "This list is only what's enabled now — more opinionated capabilities are available to add. When a task needs something you can't currently do, call discover_capabilities to see what you could enable; if one fits, confirm with the user (ask_user_question), then enable it durably via self-edit (update_agent_file).",
  ];
  if (builtinCapabilities.length > 0) {
    lines.push(
      `Other tools are not preloaded. To use a capability below, call find_tools({ capability }) to list its tools and input schemas, then ${BUILTIN_USE_TOOL_NAME}({ tool, arguments }) to run one. find_tools returns compact entries (name, description, schema); when a tool is non-trivial or you are unsure how to call it, first call tool_help({ tool }) for its detailed usage instructions, then ${BUILTIN_USE_TOOL_NAME} with arguments matching its schema. Permissions are enforced per underlying tool, so a write or destructive tool may still require approval.`,
      "Built-in capabilities:",
      ...builtinCapabilities.map((capability) => `- ${capability.id} — ${capability.description}`),
    );
  }
  if (input.mcpServerKeys.length > 0) {
    lines.push(
      "MCP integrations (workspace-configured). Each server has its own discovery + run tools; their individual tools are not preloaded:",
      ...input.mcpServerKeys.map((key) => {
        const displayName = PROVIDER_PERMISSION_REGISTRY[key]?.displayName ?? key;
        return `- ${displayName} — call ${mcpSearchToolsName(key)} to list its tools and input schemas, then ${mcpUseToolName(key)} to run one.`;
      }),
    );
  }
  // Always emitted: even an agent with no capability tools or MCP servers should be told it can
  // discover and add capabilities via discover_capabilities (that's exactly when it matters most).
  return lines.join("\n");
}

// The `## Skills` index: one trusted spine per enabled skill, progressively disclosed. Only built-in
// skills ship in code, so only their name/description are trusted and rendered inline. External
// skills (third-party repos) and personal skills (agent- or user-authored in the private bundle)
// both carry untrusted frontmatter, so advertise only the mount path and let the model read SKILL.md
// for the rest — keeping adversarial name/description text out of the system prompt.
function buildSkillsIndexSection(skills: ResolvedSkillMetadata[]): string | null {
  if (skills.length === 0) return null;
  const lines: string[] = [
    "## Skills",
    "When a task matches a skill, read its SKILL.md first with read_skill and follow it. Skill files are mounted read-only under ./skills; supporting files load only when you read them, and scripts run without their source entering context.",
    ...skills.map((skill) => {
      if (skill.origin === "builtin") {
        return `- ${skill.name} — ${skill.description} (skills/${skill.id}/SKILL.md)`;
      }
      const label = skill.origin === "personal" ? "Personal skill" : "External skill";
      return `- ${label} (skills/${skill.id}/SKILL.md) — read its SKILL.md with read_skill to see what it does`;
    }),
  ];
  return lines.join("\n");
}

export function normalizeAgentConfig(config: AgentConfig): AgentConfig {
  const persisted = config as PartialPersistedAgentConfig;

  return {
    ...config,
    tools: Array.isArray(persisted.tools) ? persisted.tools : [],
    brain: Array.isArray(persisted.brain) ? persisted.brain : [],
    agents: Array.isArray(persisted.agents) ? persisted.agents : [],
    skills: Array.isArray(persisted.skills) ? persisted.skills : [],
    integrations: {
      github: {
        repositories: Array.isArray(persisted.integrations?.github?.repositories)
          ? persisted.integrations.github.repositories
          : [],
      },
    },
    triggers: Array.isArray(persisted.triggers) ? persisted.triggers : [],
  };
}

export function agentGitHubRepositories(config: AgentConfig): AgentGitHubRepositoryConfig[] {
  return normalizeAgentConfig(config).integrations.github.repositories;
}

function enabledGatedProviderKeys(
  config: AgentConfig,
  repositories: AgentGitHubRepositoryConfig[],
) {
  const providerKeys = new Set<string>();
  for (const tool of config.tools) {
    if (tool.type === "mcp") {
      providerKeys.add(tool.server);
    }
    if (tool.type === "coding_agent") {
      providerKeys.add("github");
    }
  }
  if (repositories.length > 0) {
    providerKeys.add("github");
  }
  return [...providerKeys].filter((providerKey) => PROVIDER_PERMISSION_REGISTRY[providerKey]);
}

function formatBrainReferencePath(path: string) {
  return path === "/" ? "brain/" : path;
}

function githubRepositoryContext(repositories: AgentGitHubRepositoryConfig[]): string[] {
  if (repositories.length === 0) return [];

  const fullNames = repositories.map((repository) => repository.fullName).join(", ");
  const ghRepoGuidance =
    repositories.length === 1
      ? "gh commands default to the attached repository even before it is cloned; --repo is not needed when targeting this attached repository."
      : "Use --repo owner/repo with gh commands so GitHub knows which attached repository to target.";
  return [
    `Attached GitHub repositories: ${fullNames}.`,
    "You have repository-scoped gh (GitHub CLI) access to these repositories through the gh tool. Authentication is injected automatically; never handle tokens yourself. Use shell for local sandbox commands, not authenticated GitHub operations.",
    ghRepoGuidance,
    "The sandbox starts with work/ as an empty scratch git repository. Clone a repository into work/<repo> on demand only when you need its code, for example: git clone https://github.com/<owner>/<repo>.git work/<repo>.",
    "All session work must happen under work/. Never push to a repository's default branch; use a feature branch and open a pull request.",
  ];
}

function opencodePublicRepositoryContext(
  config: AgentConfig,
  repositories: AgentGitHubRepositoryConfig[],
): string[] {
  if (repositories.length > 0) return [];
  if (!config.tools.some((tool) => tool.id === "opencode")) return [];

  return [
    "opencode can work without an attached GitHub repository when the user provides a public GitHub owner/repo or https://github.com/owner/repo URL. Public repositories are cloned without workspace GitHub credentials, so platform-created pull requests are unavailable for those targets.",
  ];
}
