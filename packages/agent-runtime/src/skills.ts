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

Do **not** use this for one-off task context — that belongs in the conversation, not a file.
Durable context lives elsewhere too: keep private durable notes in your agent folder
(\`agent/\`) and shared long-lived knowledge in the Brain (\`brain/\`). Use self-edit only when
the change is to how you behave going forward.

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

## Schedules (recurring triggers)

You can give yourself recurring schedules — for example a daily standup or a weekly review.
A schedule fires on its own and starts a **fresh session** whose first user message is the
\`prompt\` you set, so write the prompt as a self-contained instruction to your future self.

Pass a \`triggers\` array to \`update_agent_file\`. It is the **complete list** of your
schedules and replaces all of them at once:

- **Omit \`triggers\`** to leave your current schedules unchanged.
- Pass an array to set them; pass \`[]\` to remove all schedules.
- Each entry needs a \`cron\` and a \`prompt\`, plus optional \`timezone\` (IANA, default
  \`UTC\`), \`enabled\` (default \`false\`), and \`id\` (auto-assigned if omitted).

Only these cron shapes are supported — anything else is rejected:

- \`*/N * * * *\` — every N minutes (N = 1–59)
- \`0 */N * * *\` — every N hours (N ∈ {1, 2, 3, 4, 6, 8, 12})
- \`M H * * *\` — daily at H:M
- \`M H * * 1-5\` — weekdays at H:M
- \`M H * * D\` — weekly on day D (0 = Sunday … 6 = Saturday) at H:M

Example — a weekday 9am check-in in New York time:

\`\`\`
triggers: [
  { cron: "0 9 * * 1-5", prompt: "Review yesterday's PRs and post a summary.", timezone: "America/New_York", enabled: true }
]
\`\`\`

Set \`enabled: true\` only when you actually want it to run. A schedule with an unsupported
cron or an empty prompt is rejected and nothing is saved — fix it and call again.

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
   - \`triggers\`: an optional complete list of your recurring schedules (see "Schedules"
     above). Omit it to keep your current schedules.
   - \`summary\`: a one-line description of what you changed and why.
4. If the tool returns \`ok: false\`, read the \`errors\`, fix the body, and call it again.
   Common failures: empty body, an unknown model id, or malformed content.

## Important constraints

- **Keep it valid.** A broken edit is rejected, never silently applied.
- **Don't change your title/name** here — that is out of scope for self-editing in this
  version; focus on instructions, model, tools, and brain mounts.
- **Repositories and delegated agents are preserved** automatically; you cannot add
  unauthorized repositories through this tool. To use \`@amp\` or \`gh\`, a repository must
  already be attached to you by a human. **GitHub pull-request triggers are also preserved**
  and can only be changed by a human — but you *can* manage your own **schedule** triggers
  here (see "Schedules" above).
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

export const OPENCOMPANY_SETUP_SKILL_ID = "opencompany-setup";

function buildOpenCompanySetupSkillMd(): string {
  return `---
name: opencompany-setup
description: Set up an OpenCompany workspace for the user — establish the Brain (shared company knowledge) and tune your own definition so the user has great scaffolding from day one.
---

# Setting up OpenCompany

You are an OpenCompany agent. This skill teaches you how the workspace fits together and
how to set it up well for a new user — especially right after they sign up. The surface you
set up here is the **Brain**. You shape your own behavior with the separate
\`agent-self-edit\` skill, which this skill hands off to.

## How the pieces relate

- **The Brain** is your workspace's shared, long-lived knowledge: plain Markdown/text files
  under \`brain/\` (for example \`brain/company/overview.md\`). It is **shared by every agent
  in the workspace** and persists across sessions. Use it for durable facts about the company,
  its goals, customers, voice, and processes — not for one-off task context.
- **Your \`.agent\` definition** is *you*: your instructions (the Markdown body), your model,
  your tools, and which Brain paths you mount. It controls **behavior**, the Brain holds
  **knowledge**. You change your definition with the \`agent-self-edit\` skill.
- An agent **mounts** Brain context by \`@mention\`-ing it in its body: \`@brain/folder/\`
  mounts a folder, \`@brain/folder/file.md\` mounts one file. Mounted files appear under
  \`./brain\` in your session and are the ones you can read and edit.

## How to edit the Brain

You edit the Brain by writing files in the \`brain/\` directory of your session with the
normal file tools (paths must be prefixed with \`brain/\`, e.g. \`brain/company/overview.md\`).
Changes you make are saved back to the workspace automatically when the turn finishes, and
become visible to the user in the **Brain** view.

Two rules to keep in mind:

- **A file persists only if it sits under a Brain path you have mounted.** During first-run
  setup your definition mounts the whole Brain (\`@brain/\`), so any file you create under
  \`brain/\` is saved. If you later narrow your mounts to specific folders, only files under
  those folders are writable in future sessions.
- **Keep files small and structured.** Each file must stay under 256 KB. Prefer a few
  high-signal files in sensible folders (e.g. \`brain/company/\`, \`brain/customers/\`) over
  many empty stubs.

## First-run setup protocol

When this is a fresh workspace, or the user asks you to "set up OpenCompany" / "get me set
up", follow this loop. The user should feel guided and in control — not interrogated.

1. **Read this skill** (you are doing that now) so you know the moves.
2. **Ask 2–3 high-signal clarifying questions**, building on whatever signup details came in
   the first message (their role, company URL, team size, and the areas they want help with).
   Good questions: what the company actually does, who its customers are, and what they want
   you to help with first. Ask them together, conversationally, and wait for the answer.
3. **Write a small, tasteful starter Brain** capturing what you learned — for example
   \`brain/company/overview.md\` (what the company does, who it serves) and
   \`brain/company/goals.md\` (current priorities), plus one or two files tied to the user's
   focus areas. Write only what you actually know; don't invent facts. If the user gave a
   company URL and you have web research available, you may use it to enrich the overview —
   otherwise keep it to what they told you.
4. **Tune your own definition** so you are useful going forward: read
   \`skills/agent-self-edit/SKILL.md\` with \`read_skill\`, then call \`update_agent_file\`
   to give yourself clear instructions for this user and to mount the Brain folders you just
   created (e.g. \`@brain/company/\`). Mounting the specific folders you created keeps future
   sessions focused; you can keep \`@brain/\` if a broad mount is more useful.
5. **Summarize what you set up** in plain language: list the Brain files you created, what you
   changed about yourself, and remind the user that everything lives in the **Brain** view and
   is fully editable. Note that changes to your definition take effect on your next session.

## Guardrails

- Prefer asking over assuming; a short, sharp set of questions beats a long form.
- Don't over-scaffold. A handful of genuinely useful files is the goal.
- The Brain is shared knowledge; your definition is behavior. Put durable facts in the Brain
  and durable behavior in your definition — don't mix them up.
- This skill covers Brain setup and points you at \`agent-self-edit\` for your own definition.
  It does not grant any new powers beyond the file and self-edit tools you already have.
`;
}

const OPENCOMPANY_SETUP_SKILL_MD = buildOpenCompanySetupSkillMd();

export const AGENT_SKILL_CATALOG: AgentSkillDefinition[] = [
  {
    id: AGENT_SELF_EDIT_SKILL_ID,
    name: "Self-edit agent definition",
    description:
      "Evolve your own .agent definition — adjust instructions, model, and tools — validated and synced safely via update_agent_file.",
    defaultEnabled: true,
    files: [{ path: "SKILL.md", content: AGENT_SELF_EDIT_SKILL_MD }],
  },
  {
    id: OPENCOMPANY_SETUP_SKILL_ID,
    name: "Set up OpenCompany",
    description:
      "Set up the workspace for a new user — establish the Brain (shared company knowledge) and tune your own definition for great day-one scaffolding.",
    defaultEnabled: true,
    files: [{ path: "SKILL.md", content: OPENCOMPANY_SETUP_SKILL_MD }],
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
