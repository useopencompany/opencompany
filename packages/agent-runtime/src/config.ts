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
  type ResolvedSkillMetadata,
  resolveEnabledSkillMetadata,
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
  toolPolicy?: {
    policy: WorkspaceToolPolicyMap;
    suspendable: boolean;
  };
}): ResolvedAgentRuntimeConfig {
  const instructions = input.agent.instructions.trim() || "Help the user complete the task.";
  const repositories = input.agent.integrations?.github?.repositories ?? [];
  const skills = resolveEnabledSkillMetadata(input.agent);
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
    "The sandbox has four file roots. Choose where to put something by how long it should last and who needs it: ./work is a temporary scratch directory for this session only (drafts, intermediate files, deliverables, cloned repos) — nothing here survives the session. ./agent is your private agent folder that persists across sessions: keep freeform durable notes in agent/memory.md, plus any other private files worth carrying forward. ./brain is shared company knowledge other agents and people rely on; edit it only via mounted @brain/... refs. ./skills is read-only; open it with read_skill.",
    "agent/memory/ is structured, evidence-grounded memory (canonical objects + cited evidence). Manage it ONLY through the `memory` CLI, never by editing files there directly; read the memory skill (skill id `memory`) with read_skill before using it.",
    "One-off context that won't matter next session belongs in the conversation, not a file. How you behave going forward lives in your .agent definition via self-edit, not these folders.",
    "File tools require paths prefixed with work/, brain/, or agent/. Bare paths like README.md are invalid; use work/README.md, brain/README.md, or agent/memory.md. Use read_skill for skill files.",
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
    }),
    mcpServers: input.agent.tools.filter((tool): tool is AgentMcpToolConfig => tool.type === "mcp"),
  };
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
  // Only the always-present core line would remain when the agent has no capability tools or MCP
  // servers — nothing to discover, so skip the section entirely.
  return lines.length > 2 ? lines.join("\n") : null;
}

// The `## Skills` index: one trusted spine per enabled skill, progressively disclosed. External
// skills carry untrusted name/description from a third-party repo, so advertise only the mount path
// and let the model read SKILL.md for the rest; built-in skills ship in code, so their name/description
// are trusted.
function buildSkillsIndexSection(skills: ResolvedSkillMetadata[]): string | null {
  if (skills.length === 0) return null;
  const lines: string[] = [
    "## Skills",
    "When a task matches a skill, read its SKILL.md first with read_skill and follow it. Skill files are mounted read-only under ./skills; supporting files load only when you read them, and scripts run without their source entering context.",
    ...skills.map((skill) =>
      skill.source
        ? `- External skill (skills/${skill.id}/SKILL.md) — read its SKILL.md with read_skill to see what it does`
        : `- ${skill.name} — ${skill.description} (skills/${skill.id}/SKILL.md)`,
    ),
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
