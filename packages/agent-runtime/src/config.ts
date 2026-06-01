import { getAgentModelRuntimeOptions, type ModelProviderOptions } from "./models";
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
    exposeReasoningSummary: boolean;
  };
  tools: RuntimeToolName[];
  mcpServers: AgentMcpToolConfig[];
};

export function resolveAgentRuntimeConfig(input: {
  agent: AgentConfig;
  workspaceName?: string;
  sessionTitle?: string;
  userName?: string;
}): ResolvedAgentRuntimeConfig {
  const instructions = input.agent.instructions.trim() || "Help the user complete the task.";
  const repositories = input.agent.integrations?.github?.repositories ?? [];
  const skills = resolveEnabledSkills(input.agent);
  const context = [
    "You are an OpenCompany agent running in an isolated cloud sandbox.",
    "Use tools when you need to inspect or change files, run commands, or verify work.",
    "Avoid launching more than eight tool calls in one batch; inspect results before deciding whether more calls are useful.",
    "Keep command output concise and explain material changes to the user.",
    "When a request will take more than a few tool calls or roughly twenty seconds, open your reply with one or two plain-language sentences before any tool call: what you are about to do, a rough time estimate, what you will deliver, and what you will save to the Brain. Offer a useful optional add-on when it fits. For quick replies, skip this and answer directly.",
    "The sandbox workspace root has two writable file roots: ./work for session-local files and scratch work, and ./brain for mounted Brain context. Read-only skill files may also be mounted under ./skills, but can only be read with read_skill.",
    "Read, write, and edit file tools require paths prefixed with work/ or brain/. Bare paths like README.md are invalid; use work/README.md or brain/README.md. Use read_skill for skill files.",
    "Use edit_file for targeted changes to existing files. Use write_file only for new files or intentional full-file overwrites.",
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
      exposeReasoningSummary: modelRuntime.exposeReasoningSummary,
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
