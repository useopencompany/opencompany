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
  AgentNeonDatabaseConfig,
  AgentToolId,
} from "./types";

type PartialPersistedAgentConfig = Omit<Partial<AgentConfig>, "integrations"> & {
  integrations?: {
    github?: {
      repositories?: AgentGitHubRepositoryConfig[];
      allRepositories?: boolean;
    };
    neon?: {
      databases?: AgentNeonDatabaseConfig[];
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

export const FIXED_PERSONAL_AGENT_NAME = "Leo";

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
  // placeholder. See buildProfileSection. This is a cache over structured memory (the `memory`
  // tool), which is the canonical store for all durable facts.
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
  // The personal/default agent runs in the memory/ + personal-brain/ + work/ sandbox layout with no
  // company brain. Branch the file-root guidance, memory/Personal-Brain framing, and workspace line
  // on this; the company/workspace agent keeps the original text exactly.
  const isPersonal = input.personalAgent ?? false;
  const repositories = input.agent.integrations?.github?.repositories ?? [];
  const githubAllRepositories = input.agent.integrations?.github?.allRepositories === true;
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
        providerKeys: enabledGatedProviderKeys(input.agent, repositories, githubAllRepositories),
        policy: input.toolPolicy.policy,
        suspendable: input.toolPolicy.suspendable,
      })
    : null;
  const context = [
    "You are an OpenCompany agent running in an isolated cloud sandbox.",
    "Use tools when you need to inspect or change files, run commands, or verify work.",
    "When you decide a tool lookup, file read, command, or other check is needed, make the tool call before answering; do not say or imply you checked a source unless that evidence is already in the conversation or you actually used the relevant tool.",
    "When you genuinely need user input to proceed correctly, call ask_user_question instead of ending your response with a question. Batch the few decisions you need now, give clear options, and continue after the user answers. Do not use ask_user_question for progress updates or permission to use ordinary tools.",
    "Avoid launching more than eight tool calls in one batch; inspect results before deciding whether more calls are useful.",
    "Keep command output concise and explain material changes to the user.",
    "When a request will take more than a few tool calls or roughly twenty seconds, open your reply with one or two plain-language sentences before any tool call: what you are about to do, a rough time estimate, what you will deliver, and whether any durable file or memory update is clearly intended. Offer a useful optional add-on when it fits. For quick replies, skip this and answer directly.",
    isPersonal
      ? "The sandbox has these file roots. Choose where to put a file by who it is for, not by guessing how long it will matter: ./work is your private scratch space for files only you need to get the job done (cloned repos, temp data, intermediate transforms) — the user cannot see it and nothing here survives the session. personal-brain/ is the user's private, persistent knowledge space — their own notes, research, documents, decisions, and persistent artifacts you intentionally create or update for them when they clearly ask; files there persist across sessions and surface to the user in the app. memory/ is your own persistent structured memory (see below). ./agent is your private agent folder, including your profile (agent/user.md) and your personal skills. ./skills is read-only; open it with read_skill. This session has NO company brain/ root — brain/ does not exist here; explicit persistent user content goes to personal-brain/, never brain/. work/ is ephemeral scratch: it is wiped when the session ends and the user can never see it, so never leave anything intended to persist there."
      : "The sandbox has four file roots. Choose where to put a file by who it is for, not by guessing how long it will matter: ./work is your private scratch space for files only you need to get the job done (cloned repos, temp data, intermediate transforms) — people cannot see it and nothing here survives the session. ./agent is your private agent folder that persists across sessions, including your profile (agent/user.md) and any other private files worth carrying forward. ./brain is shared company knowledge other agents and people rely on — files there persist and surface to people in the app; edit it only via mounted @brain/... refs. ./skills is read-only; open it with read_skill.",
    isPersonal
      ? "memory/ is your structured, evidence-grounded MEMORY (canonical objects + cited evidence) — your distilled understanding of the user, built from their personal brain and your conversations: durable facts, preferences, priorities, patterns (specific people, companies, projects, decisions, lessons). It is distinct from personal-brain/, which holds files (the user's own and persistent artifacts you intentionally save for them); memory/ is your compiled view of what matters. Manage it ONLY through the `memory` tool (not shell), never by editing files there directly; read the memory skill (skill id `memory`) with read_skill before using it."
      : "agent/memory/ is your structured, evidence-grounded MEMORY (canonical objects + cited evidence) — the single store for every durable fact, retrieved on demand (specific people, companies, projects, decisions, lessons). Manage it ONLY through the `memory` tool (not shell), never by editing files there directly; read the memory skill (skill id `memory`) with read_skill before using it.",
    isPersonal
      ? "Before saying you do not know a personal, company, project, document, or past-decision fact, check the likely internal source first: query memory for durable facts and use file tools on personal-brain/ when the answer could live in the user's saved notes, documents, or prior deliverables. Ask the user only after those checks fail or the request is blocked."
      : "Before saying you do not know a company, project, document, or past-decision fact, check the likely internal source first: query memory for durable facts and use file tools on mounted brain/ refs when the answer could live in shared knowledge. Ask the user only after those checks fail or the request is blocked.",
    `agent/skills/ holds your PERSONAL SKILLS: reusable how-to procedures you save for yourself as agent/skills/<id>/SKILL.md folders. They are auto-discovered, listed in ## Skills, and loadable with read_skill from your next session on. When you spot a repeatable workflow worth keeping (or are asked to save one), read the skill-creator skill (read_skill with skillId "${SKILL_CREATOR_SKILL_ID}") and follow it. Use a skill for a repeatable procedure; use memory for facts and your .agent definition for how you behave.`,
    isPersonal
      ? "Where things go (route by audience): create or update personal-brain/ only when the user clearly asks for a saved file/update, names a personal-brain path, or requests a persistent artifact they can open later (doc, report, plan, analysis). For ordinary answers, exploratory work, drafts, or ambiguous intent, respond in chat; if you need scratch files to do the work, use ./work. If you are unsure whether the user wants a persistent file, ask before writing personal-brain/. Files only you need to do the job → ./work. One-off that won't matter next session → leave it in the conversation, write nothing. How you behave going forward (a standing preference, tone, default tool/model) → your .agent definition via self-edit, not a file. Durable facts (specific people, companies, projects, decisions, lessons, conventions) → structured memory via the `memory` tool only when the user explicitly asks you to remember/save them, corrects stale information, or states a clear long-lived fact/preference likely to matter in future sessions; do not infer memory from casual wording or a single task. agent/user.md is not a second store: it's your always-loaded digest of memory (see the 'Your profile' section below) — promote the few things you need in every turn, and it's fine for them to live in both places. A repeatable procedure worth reusing → a personal skill under agent/skills/."
      : "Where things go (route by audience): anything you produce for people to keep or read — a doc, report, plan, analysis — → ./brain under a mounted @brain/... ref, even while you're still iterating on it; it's the only file root they can open (work/ is invisible to them and gone after the session). If no mounted ref fits, deliver the content in your reply and say so — never park a deliverable in work/ or agent/. Files only you need to do the job → ./work. One-off that won't matter next session → leave it in the conversation, write nothing. How you behave going forward (a standing preference, tone, default tool/model) → your .agent definition via self-edit, not a file. Every durable fact worth remembering (specific people, companies, projects, decisions, lessons, conventions) → structured memory via the `memory` tool — memory is the canonical store, always correct to write to. agent/user.md is not a second store: it's your always-loaded digest of memory (see the 'Your profile' section below) — promote the few things you need in every turn, and it's fine for them to live in both places. A repeatable procedure worth reusing → a personal skill under agent/skills/.",
    isPersonal
      ? "File tools require paths prefixed with work/, personal-brain/, or agent/. brain/ is a company-session root and is NOT valid here — if you mean to save persistent user content, write it under personal-brain/ instead. Bare paths like README.md are invalid; use work/README.md, personal-brain/notes.md, or agent/user.md. Use read_skill for skill files."
      : "File tools require paths prefixed with work/, brain/, or agent/. Bare paths like README.md are invalid; use work/README.md, brain/README.md, or agent/user.md. Use read_skill for skill files.",
    "Use edit_file for targeted changes to existing files. Use write_file only for new files or intentional full-file overwrites.",
    ...publicCodingRepositoryContext(input.agent, repositories, githubAllRepositories),
    ...githubRepositoryContext(repositories, githubAllRepositories),
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
    buildToolsIndexSection({
      agentTools: input.agent.tools,
      mcpServerKeys,
      ghEnabled: repositories.length > 0 || githubAllRepositories,
    }),
    buildSkillsIndexSection(skills),
    skills.some((skill) => skill.id === AGENT_SELF_EDIT_SKILL_ID)
      ? `You can evolve your own definition. The moment the user asks you to change how you work going forward (a standing preference, tone, workflow, default tool, or model), read skills/agent-self-edit/SKILL.md with read_skill before calling update_agent_file — the runner requires it and will reject an edit you make without reading the skill first. update_agent_file is not preloaded: after reading the skill, discover its schema with find_tools({ query: "update_agent_file" }) and run it with ${BUILTIN_USE_TOOL_NAME}({ tool: "update_agent_file", arguments }).`
      : null,
    toolPolicyContext,
    `Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    // The personal agent presents no company identity, so omit the workspace line for it.
    !isPersonal && input.workspaceName ? `Workspace: ${input.workspaceName}` : null,
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
      allRepositories: githubAllRepositories,
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
// Structured memory (the `memory` tool) is the canonical store; this file is its hot digest.
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
// A cache, not a store: structured memory (the `memory` tool) is canonical; this file holds the
// promoted subset worth carrying into every turn.
function buildProfileSection(input: { userMemory: string | undefined }): string {
  const trimmed = input.userMemory?.trim() ?? "";
  const body = trimmed
    ? truncateProfile(trimmed)
    : "(empty — populate this as you learn who your user is)";
  return [
    "## Your profile — agent/user.md, reloaded every turn (keep it tight; ~3KB cap)",
    "Who your user is: identity, preferences, communication style, goals. Edit it with file tools as you learn; edits apply from your next turn in this same session. This is a cache, not a store: structured memory (the `memory` tool) is the canonical home of every durable fact, and anything written here should also live there. Promote into this file only what you need in literally every turn, and demote whatever stops earning its ~3KB — it stays safe in memory.",
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
  ghEnabled: boolean;
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
    `Core tools (${[
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "git_diff",
      "shell",
      "read_skill",
      ...(input.ghEnabled ? ["gh"] : []),
    ].join(", ")}) are available directly.`,
    "Other built-in tools may be available on demand when enabled, including memory, recall, fetch_transcript, inbox tools, run_subagent, delegate_to_agent, create_linear_issue, restore_brain_file, and update_agent_file. Use find_tools to list exact available names and schemas, then run one with use_tool.",
    "This list is only what's enabled now — more opinionated capabilities are available to add. When a task needs something you can't currently do, call discover_capabilities to see what you could enable; if one fits, confirm with the user (ask_user_question), then enable it durably via self-edit (update_agent_file).",
  ];
  if (builtinCapabilities.length > 0) {
    lines.push(
      `Other built-in capability tools are not preloaded, and find_tools does not list the core tools above. To use a capability below, call find_tools({ capability }) to list its tools and input schemas, then ${BUILTIN_USE_TOOL_NAME}({ tool, arguments }) to run one. find_tools returns compact entries (name, description, schema); when a tool is non-trivial or you are unsure how to call it, first call tool_help({ tool }) for its detailed usage instructions, then ${BUILTIN_USE_TOOL_NAME} with arguments matching its schema. Permissions are enforced per underlying tool, so a write or destructive tool may still require approval.`,
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
        ...(persisted.integrations?.github?.allRepositories === true
          ? { allRepositories: true }
          : {}),
      },
      neon: {
        databases: Array.isArray(persisted.integrations?.neon?.databases)
          ? persisted.integrations.neon.databases
          : [],
      },
    },
    triggers: Array.isArray(persisted.triggers) ? persisted.triggers : [],
  };
}

export function agentGitHubRepositories(config: AgentConfig): AgentGitHubRepositoryConfig[] {
  return normalizeAgentConfig(config).integrations.github.repositories;
}

// Single predicate for "this agent can reach GitHub": either explicit attached repositories
// or the live `@github` all-repositories scope. Used by the runner for sandbox template
// selection, gh-tool enablement, and capability discovery so they can never disagree.
export function agentHasGitHubAccess(config: AgentConfig): boolean {
  const github = normalizeAgentConfig(config).integrations.github;
  return github.repositories.length > 0 || github.allRepositories === true;
}

function enabledGatedProviderKeys(
  config: AgentConfig,
  repositories: AgentGitHubRepositoryConfig[],
  allRepositories = false,
) {
  const providerKeys = new Set<string>();
  for (const tool of config.tools) {
    if (tool.type === "mcp") {
      providerKeys.add(tool.server);
    }
    if (tool.type === "coding_agent") {
      providerKeys.add("github");
    }
    if (tool.id === "neon") {
      providerKeys.add("neon");
    }
  }
  if (repositories.length > 0 || allRepositories) {
    providerKeys.add("github");
  }
  return [...providerKeys].filter((providerKey) => PROVIDER_PERMISSION_REGISTRY[providerKey]);
}

function formatBrainReferencePath(path: string) {
  return path === "/" ? "brain/" : path;
}

function githubRepositoryContext(
  repositories: AgentGitHubRepositoryConfig[],
  allRepositories = false,
): string[] {
  if (repositories.length === 0 && !allRepositories) return [];

  const lines: string[] = [];
  if (allRepositories) {
    lines.push(
      "GitHub access: you can work with any repository the workspace's GitHub connection can reach — not just a pre-attached list. Always pass the repository argument (owner/repo) explicitly to amp_coder/opencode_coder/codex_coder, and use --repo owner/repo with gh commands.",
    );
  }
  if (repositories.length > 0) {
    const fullNames = repositories.map((repository) => repository.fullName).join(", ");
    const ghRepoGuidance =
      repositories.length === 1 && !allRepositories
        ? "gh commands default to the attached repository even before it is cloned; --repo is not needed when targeting this attached repository."
        : "Use --repo owner/repo with gh commands so GitHub knows which attached repository to target.";
    lines.push(`Attached GitHub repositories: ${fullNames}.`, ghRepoGuidance);
  }
  return [
    ...lines,
    "You have repository-scoped gh (GitHub CLI) access through the gh tool. Authentication is injected automatically; never handle tokens yourself. Use shell for local sandbox commands, not authenticated GitHub operations.",
    "The sandbox starts with work/ as an empty scratch git repository. Clone a repository into work/<repo> on demand only when you need its code, for example: git clone https://github.com/<owner>/<repo>.git work/<repo>.",
    "All session work must happen under work/. Never push to a repository's default branch; use a feature branch and open a pull request.",
  ];
}

function publicCodingRepositoryContext(
  config: AgentConfig,
  repositories: AgentGitHubRepositoryConfig[],
  allRepositories = false,
): string[] {
  if (repositories.length > 0 || allRepositories) return [];
  const publicCodingTools = config.tools
    .filter((tool) => tool.id === "opencode" || tool.id === "codex")
    .map((tool) => tool.label);
  if (publicCodingTools.length === 0) return [];

  return [
    `${publicCodingTools.join(" and ")} can work without an attached GitHub repository when the user provides a public GitHub owner/repo or https://github.com/owner/repo URL. Public repositories are cloned without workspace GitHub credentials, so platform-created pull requests are unavailable for those targets.`,
  ];
}
