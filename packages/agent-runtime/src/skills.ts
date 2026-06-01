import { AGENT_TOOL_CATALOG, type AgentToolDefinition } from "./tools";
import type { AgentConfig, AgentSkillReference } from "./types";

export type AgentSkillFile = {
  // Path relative to the skill folder, e.g. "SKILL.md" or "references/format.md".
  path: string;
  content: string;
};

export type AgentSkillDefinition = {
  id: string;
  name: string;
  description: string;
  // Built-in skills with `defaultEnabled` are available in every session without
  // being listed in the agent's `skills:` frontmatter. The config field lets agents
  // (and, later, the editor) add more skills over time.
  defaultEnabled: boolean;
  files: AgentSkillFile[];
};

// A human-readable prerequisite hint per tool, so the agent knows when adding a mention
// will actually function. Derived from the catalog's declared requirements rather than
// hardcoded, so it stays correct as tools are added.
function toolPrerequisiteHint(tool: AgentToolDefinition): string {
  if (tool.requiredWorkspaceResource?.provider === "github") {
    return " Requires at least one GitHub repository attached to this agent; mentioning it without an attached repo records the tool but it will not run.";
  }
  if (tool.credentialSource === "workspace") {
    return " Beta: requires the workspace to have this integration configured in MCP settings before it will run.";
  }
  return "";
}

// Generated from AGENT_TOOL_CATALOG so the skill always lists exactly the tools that exist,
// with their descriptions and prerequisites.
function availableToolMentionLines(): string {
  return AGENT_TOOL_CATALOG.map(
    (tool) => `- \`@${tool.id}\` — ${tool.description}${toolPrerequisiteHint(tool)}`,
  ).join("\n");
}

function buildSelfEditSkillMd(): string {
  return `---
name: agent-self-edit
description: Evolve your own .agent definition — adjust your instructions, model, and tools — reliably and safely.
---

# Self-editing your agent definition

You are an OpenCompany agent. Your entire definition lives in a single \`.agent\` file:
YAML frontmatter (title, model, tools, brain, repositories) plus a Markdown body that
becomes your instructions. This skill lets you **evolve that definition** — sharpen your
own prompting, explicitly switch your model, or change which tools and integrations you
use — so you get better at your job over time.

You do **not** edit the \`.agent\` file directly. You propose a new body (and optionally a
new model) with the \`update_agent_file\` tool. The runner validates the change, applies it
atomically, versions it, and syncs it to the workspace GitHub repo. If the change is
invalid, the tool returns errors and nothing is saved — fix them and call it again.

## When to use this

- The user asks you to "personalize yourself", "improve your instructions", "remember how
  you should behave", "give yourself web search / a tool", or change how you work going forward.
- You notice a durable, repeatable instruction that belongs in your definition rather than
  in one conversation (a standing preference, a tone, a workflow, a default tool).

Do **not** use this for one-off task context — that belongs in the conversation, or in the
Brain (\`brain/\`) if it is long-lived knowledge rather than behavior.

## How the .agent body works

The body is plain Markdown that you receive verbatim as your system instructions. \`@mention\`
tokens inside it declaratively bind tool and Brain configuration. Mention something to add
it; delete the mention to remove it. The model is separate per-agent config and only
changes here when you pass the explicit \`model\` argument to \`update_agent_file\`.

- \`@brain/path\` or \`@brain/folder/\` — mount Brain context.

## Tools and integrations you can add or remove

Mention a tool's token in the body to enable it; remove the mention to disable it. The
currently available tools are:

${availableToolMentionLines()}

To **add** a tool, include its \`@mention\` in the new body and, ideally, a sentence telling
yourself when to use it (for example: "Research the live web with @exa before answering
factual questions."). To **remove** one, leave its mention out of the new body. Adding a
tool whose prerequisites are not met is allowed and won't fail validation, but the tool
stays inert until the prerequisite is satisfied.

## How to make a change

> The runner requires that you have read this skill (via \`read_skill\`) before it will accept
> \`update_agent_file\`. If you call the tool without having read this skill in the current
> session, it returns \`ok: false\` and saves nothing — read this skill, then retry.

1. Read your current definition. It is not in \`work/\` or \`brain/\`; use the description the
   runner gave you in the system prompt, and ask the user what they want changed if it is
   not obvious.
2. Draft the **complete new body** — not a diff. Keep what should stay, add or rewrite what
   should change, and keep any \`@mentions\` for tools and Brain mounts you still want active.
3. Call \`update_agent_file\` with:
   - \`body\`: the full new Markdown body (required).
   - \`model\`: an optional model id to switch to. Omit it to keep your current model.
   - \`summary\`: a one-line description of what you changed and why.
4. If the tool returns \`ok: false\`, read the \`errors\`, fix the body, and call it again.
   Common failures: empty body, an unknown model id, or malformed content.

## Important constraints

- **Keep it valid.** A broken edit is rejected, never silently applied.
- **Don't change your title/name** here — that is out of scope for self-editing in this
  version; focus on instructions, model, tools, and brain mounts.
- **Repositories, triggers, and delegated agents are preserved** automatically; you cannot
  add unauthorized repositories through this tool. To use \`@amp\` or \`gh\`, a repository must
  already be attached to you by a human.
- **Changes take effect on your next session**, not the current one — the running session was
  configured when it started. Tell the user this so they know to start a fresh session (or
  send a new message, if your runtime reloads config per turn) to see the new behavior.

## A good loop

Briefly confirm the intent with the user → draft the full new body → \`update_agent_file\` →
report the new version and what changed → remind them it applies to the next session.
`;
}

const AGENT_SELF_EDIT_SKILL_MD = buildSelfEditSkillMd();

export const AGENT_SELF_EDIT_SKILL_ID = "agent-self-edit";

export const AGENT_SKILL_CATALOG: AgentSkillDefinition[] = [
  {
    id: AGENT_SELF_EDIT_SKILL_ID,
    name: "Self-edit agent definition",
    description:
      "Evolve your own .agent definition — adjust instructions, model, and tools — validated and synced safely via update_agent_file.",
    defaultEnabled: true,
    files: [{ path: "SKILL.md", content: AGENT_SELF_EDIT_SKILL_MD }],
  },
];

export const AGENT_SKILL_DEFINITION_BY_ID = new Map(
  AGENT_SKILL_CATALOG.map((skill) => [skill.id, skill]),
);

export function isKnownAgentSkillId(id: string): boolean {
  return AGENT_SKILL_DEFINITION_BY_ID.has(id);
}

// The skills available to a session: every built-in `defaultEnabled` skill, plus any
// additional known skills listed in the agent's `skills:` config. Deduplicated by id.
export function resolveEnabledSkills(config: Pick<AgentConfig, "skills">): AgentSkillDefinition[] {
  const ids = new Set<string>();
  for (const skill of AGENT_SKILL_CATALOG) {
    if (skill.defaultEnabled) ids.add(skill.id);
  }
  for (const reference of config.skills ?? []) {
    if (isKnownAgentSkillId(reference.id)) ids.add(reference.id);
  }
  return AGENT_SKILL_CATALOG.filter((skill) => ids.has(skill.id));
}

// Normalize an arbitrary frontmatter value into known skill references, dropping unknown
// ids. Mirrors the lenient normalization used for tools.
export function normalizeAgentSkills(value: unknown): AgentSkillReference[] {
  const references: AgentSkillReference[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const id =
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id.trim()
          : null;
    if (!id || seen.has(id) || !isKnownAgentSkillId(id)) continue;
    seen.add(id);
    references.push({ id });
  }
  return references;
}
