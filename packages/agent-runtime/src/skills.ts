import type { AgentSkillId } from "./types";

const OPENCOMPANY_SKILL_SOURCE = `---
name: opencompany
description: Use when creating or changing OpenCompany agent files, Brain files, or workspace configuration proposals.
---

# OpenCompany Workspace Configuration

Use this skill when the user asks you to create, improve, or repair OpenCompany agents or Brain files.

Read only the files you need:

- skills/opencompany/agent-files.md for .agent authoring, frontmatter, mentions, and validation.
- skills/opencompany/brain.md for Brain file changes.

## Workflow

1. Inspect current agents and Brain with the opencompany workspace tools.
2. Draft the smallest useful change.
3. Validate any proposed .agent source with opencompany_validate_agent or validate-agent.mjs.
4. Create a proposal with opencompany_propose_config_change.
5. Tell the user what changed and that they must approve it in the OpenCompany UI before it applies.

Do not write workspace agent config directly through shell or file tools. Workspace config changes must be proposals.
Self-edits are allowed only as proposals and still require user approval.`;

const OPENCOMPANY_AGENT_FILES_SOURCE = `# Agent Files

An OpenCompany agent is a single plain-text .agent file with YAML frontmatter and a Markdown body.

The body is the user-facing source of truth. Put readable instructions in the body and use mentions to bind runtime configuration:

- @opencompany enables this skill.
- @exa enables web research.
- @amp enables delegated coding work when a repository is also mentioned.
- @fast or @deep select common models.
- @brain/path.md or @brain/folder/ mounts Brain context.
- @owner/repo binds an authorized GitHub repository.
- #after-session enables a short idle-time memory/update hook.

Write focused bodies. State the agent's job, what inputs it expects, what output should look like, and any constraints. Avoid generic "be helpful" filler.

Example:

\`\`\`yaml
---
title: "Support triage"
model: openai/gpt-5.4-mini
tools: []
brain:
  - support/
skills:
  - opencompany
---

Triage support threads using @brain/support/. Classify urgency, identify the customer-visible next step, and draft a concise reply.

When asked to improve this agent, use @opencompany and propose a validated .agent update.
\`\`\`

Before proposing an agent change, call opencompany_validate_agent with the full source. Treat warnings as things to explain or fix.`;

const OPENCOMPANY_BRAIN_SOURCE = `# Brain Files

Brain files are long-lived workspace context. Use Brain for durable facts, examples, preferences, playbooks, and decisions that future agents should reuse.

Keep Brain changes narrow:

- Prefer updating one existing file over creating many new files.
- Preserve useful existing content.
- Use clear headings and short paragraphs.
- Do not store secrets, credentials, or private tokens.

When proposing Brain edits, include the complete file content for each changed file. The user must approve the proposal before it becomes workspace state.`;

const OPENCOMPANY_VALIDATE_AGENT_SOURCE = `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const source = readFileSync(process.argv[2] ?? 0, "utf8");
const errors = [];

if (!source.trim()) errors.push("Agent source is empty.");
if (!source.startsWith("---\\n")) errors.push("Agent source should start with YAML frontmatter.");
if (!/^---\\n[\\s\\S]*?\\n---\\n/.test(source)) {
  errors.push("Agent source must contain a closing frontmatter fence.");
}
if (!/^title:\\s*.+$/m.test(source)) errors.push("Frontmatter should include title.");
if (!/^model:\\s*.+$/m.test(source)) errors.push("Frontmatter should include model.");
if (!/^skills:\\n(?:\\s+-\\s+opencompany\\s*$|\\s*\\[.*\\]\\s*$)/m.test(source)) {
  errors.push("Use skills: [opencompany] or a skills list when this agent should self-configure.");
}

if (errors.length > 0) {
  console.error(errors.join("\\n"));
  process.exit(1);
}

console.log("Agent source looks structurally valid.");
`;

export type AgentSkillDefinition = {
  id: AgentSkillId;
  name: string;
  description: string;
  sandboxPath: string;
  files: Array<{ path: string; content: string }>;
};

export const DEFAULT_AGENT_SKILLS: AgentSkillId[] = ["opencompany"];

export const AGENT_SKILL_CATALOG: AgentSkillDefinition[] = [
  {
    id: "opencompany",
    name: "opencompany",
    description:
      "Use when creating or changing OpenCompany agent files, Brain files, or workspace configuration proposals.",
    sandboxPath: "skills/opencompany/SKILL.md",
    files: [
      { path: "skills/opencompany/SKILL.md", content: OPENCOMPANY_SKILL_SOURCE },
      { path: "skills/opencompany/agent-files.md", content: OPENCOMPANY_AGENT_FILES_SOURCE },
      { path: "skills/opencompany/brain.md", content: OPENCOMPANY_BRAIN_SOURCE },
      { path: "skills/opencompany/validate-agent.mjs", content: OPENCOMPANY_VALIDATE_AGENT_SOURCE },
    ],
  },
];

export const AGENT_SKILL_DEFINITION_BY_ID = new Map(
  AGENT_SKILL_CATALOG.map((skill) => [skill.id, skill]),
);

export function resolveAgentSkillIds(
  value: unknown,
  options: { defaultWhenMissing?: boolean } = {},
) {
  if (!Array.isArray(value)) {
    return options.defaultWhenMissing ? DEFAULT_AGENT_SKILLS : [];
  }

  const seen = new Set<AgentSkillId>();
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!AGENT_SKILL_DEFINITION_BY_ID.has(id as AgentSkillId)) continue;
    seen.add(id as AgentSkillId);
  }

  return Array.from(seen);
}

export function resolveAgentSkillDefinitions(value: unknown) {
  return resolveAgentSkillIds(value, { defaultWhenMissing: true }).flatMap((id) => {
    const skill = AGENT_SKILL_DEFINITION_BY_ID.get(id);
    return skill ? [skill] : [];
  });
}
