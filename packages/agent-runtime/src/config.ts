import {
  getAgentModelRuntimeOptions,
  type ModelProviderOptions,
  type ReasoningExposure,
} from "./models";
import {
  formatWorkspaceToolPolicyContext,
  PROVIDER_PERMISSION_REGISTRY,
  type WorkspaceToolPolicyMap,
} from "./permissions";
import { AGENT_SELF_EDIT_SKILL_ID, resolveEnabledSkills } from "./skills";
import { type RuntimeToolName, resolveRuntimeToolNamesForConfigTools } from "./tools";
import type { AgentConfig, AgentGitHubRepositoryConfig, AgentMcpToolConfig } from "./types";

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
  workspaceName?: string;
  sessionTitle?: string;
  userName?: string;
  toolPolicy?: {
    policy: WorkspaceToolPolicyMap;
    suspendable: boolean;
  };
}): ResolvedAgentRuntimeConfig {
  const instructions = input.agent.instructions.trim() || "Help the user complete the task.";
  const repositories = input.agent.integrations?.github?.repositories ?? [];
  const skills = resolveEnabledSkills(input.agent);
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
    "Avoid launching more than eight tool calls in one batch; inspect results before deciding whether more calls are useful.",
    "Keep command output concise and explain material changes to the user.",
    "When a request will take more than a few tool calls or roughly twenty seconds, open your reply with one or two plain-language sentences before any tool call: what you are about to do, a rough time estimate, what you will deliver, and what you will save to memory. Offer a useful optional add-on when it fits. For quick replies, skip this and answer directly.",
    "The sandbox has four file roots. Choose where to put something by how long it should last and who needs it: ./work is a temporary scratch directory for this session only (drafts, intermediate files, deliverables, cloned repos) — nothing here survives the session. ./agent is your private agent folder that persists across sessions: keep durable learnings in agent/memory.md, plus any other private notes or files worth carrying forward. ./brain is shared company knowledge other agents and people rely on; edit it only via mounted @brain/... refs. ./skills is read-only; open it with read_skill.",
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
          )}. Only edit files inside mounted brain paths when updating long-lived context.`
      : null,
    input.agent.agents?.length
      ? `Delegatable workspace agents: ${input.agent.agents
          .map((agent) => `${agent.name} (${agent.path})`)
          .join(
            ", ",
          )}. Use delegate_to_agent for focused subtasks that should be handled by one of these agents. The tool returns a childSessionId; pass that id as sessionId in a later delegate_to_agent call to continue the same delegated session when continuity matters.`
      : null,
    skills.length
      ? `Skills available this session — when a task matches one, read its SKILL.md first and follow it: ${skills
          .map((skill) => `${skill.name} — ${skill.description} (skills/${skill.id}/SKILL.md)`)
          .join(
            "; ",
          )}. Skill files are mounted read-only under ./skills; read them with read_skill.`
      : null,
    skills.some((skill) => skill.id === AGENT_SELF_EDIT_SKILL_ID)
      ? "You can evolve your own definition. The moment the user asks you to change how you work going forward (a standing preference, tone, workflow, default tool, or model), read skills/agent-self-edit/SKILL.md with read_skill before calling update_agent_file — the runner requires it and will reject an edit you make without reading the skill first."
      : null,
    toolPolicyContext,
    `Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    input.workspaceName ? `Workspace: ${input.workspaceName}` : null,
    input.sessionTitle ? `Session: ${input.sessionTitle}` : null,
    input.userName ? `User: ${input.userName}` : null,
  ].filter(Boolean);

  const modelRuntime = getAgentModelRuntimeOptions(input.agent.model.name);

  return {
    systemPrompt: `${context.join("\n")}\n\nAgent instructions:\n${instructions}`,
    model: {
      provider: "vercel-ai-gateway",
      name: input.agent.model.name,
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
    "You have repository-scoped git and gh (GitHub CLI) access to these repositories from the shell and gh tools. Authentication is injected automatically; never handle tokens yourself.",
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
