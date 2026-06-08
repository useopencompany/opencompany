import { AGENT_TOOL_CATALOG, type AgentToolDefinition } from "./tools";
import {
  type AgentConfig,
  type AgentExternalSkillReference,
  type AgentSkillFile,
  type AgentSkillReference,
  type AgentSkillSource,
  isExternalSkillReference,
} from "./types";

export type { AgentSkillFile };

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

// Tool mentions for a given catalog type, named dynamically so the guidance always reflects
// exactly the tools that exist (no hard-coded ids that can drift from the catalog).
function toolMentionsOfType(type: AgentToolDefinition["type"], join: "and" | "comma"): string {
  const mentions = AGENT_TOOL_CATALOG.filter((tool) => tool.type === type).map(
    (tool) => `\`@${tool.id}\``,
  );
  if (join === "and") return mentions.join(" and ");
  if (mentions.length <= 1) return mentions.join("");
  return `${mentions.slice(0, -1).join(", ")}, or ${mentions[mentions.length - 1]}`;
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
Durable context lives elsewhere too: keep your operating doc in \`agent/soul.md\` and other
private notes in your agent folder (\`agent/\`), and shared long-lived knowledge in the Brain
(\`brain/\`). Use self-edit only when the change is to how you behave going forward.

## How the .agent body works

The body is plain Markdown that you receive verbatim as your system instructions. \`@mention\`
tokens inside it declaratively bind tool and Brain configuration. Mention something to add
it; delete the mention to remove it. The model is separate per-agent config and only
changes here when you pass the explicit \`model\` argument to \`update_agent_file\`.

- \`@brain/path\` or \`@brain/folder/\` — mount Brain context.
- \`@toolname\` — enable a tool (see the list below).

## Keep the body light

The body is a quick-reference for your future self, **not an essay**. Write it as tight
bullets and one-line sentences, not paragraphs. Cover only:

- **What to do when** — the jobs you handle and how you approach each.
- **How to behave** — tone, defaults, standing preferences.
- **Which tool for which job** — keep the \`@mentions\` you want active, each with a short
  "use it for X" note.
- **A little context** — who you serve and what good looks like. Keep durable facts in the
  Brain, not here.

Cut filler and restating-the-obvious. A scannable definition beats a long one — the user
reads and edits this. A good body is closer to this shape:

\`\`\`
You are Ada, an engineering agent for the team.

## What you do
- Implement features, fixes, and refactors. Delegate the actual coding to @opencode.
- Research libraries and prior art with @exa before proposing an approach.

## How you work
- Confirm scope before large changes; keep PRs small and reviewable.
- Default to TypeScript; match existing code style.

## Context
- See @brain/wiki/engineering/ for stack, conventions, and architecture.
\`\`\`

## Tools and integrations you can add or remove

Mention a tool's token in the body to enable it; remove the mention to disable it. The
currently available tools are:

${availableToolMentionLines()}

To **add** a tool, include its \`@mention\` in the new body and, ideally, a sentence telling
yourself when to use it (for example: "Research the live web with @exa before answering
factual questions."). To **remove** one, leave its mention out of the new body. Adding a
tool whose prerequisites are not met is allowed and won't fail validation, but the tool
stays inert until the prerequisite is satisfied.

## Pick tools for the job

Match tools to what this agent is *for* — don't leave an agent without a way to do its core
job. Think about the agent's purpose first, then mention the tools that serve it:

- **Engineering / coding agent → it must have a coding tool.** Default to \`@opencode\`: it
  works on attached *and* public GitHub repositories, so it's useful even before a human
  attaches a repo. Add \`@amp\` as well when a repository is attached (Amp requires one). If
  you're setting up an engineering agent and unsure, mention \`@opencode\` — never ship a
  coding agent with no coding tool. (Available coding tools: ${toolMentionsOfType("coding_agent", "and")}.)
- **Research agent →** \`@exa\` for web search, content extraction, and cited answers.
- **Social / audience agent →** the relevant \`@x\`, \`@youtube\`, \`@tiktok\`, or \`@instagram\`
  tools.
- **Ops / project agent →** workspace integrations (${toolMentionsOfType("mcp", "comma")}) when
  configured.

When in doubt about which tools fit, that is exactly what the personalization questions
below are for — ask the user rather than guessing or under-equipping yourself.

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

1. **Read your current definition and think first.** It is not in \`work/\` or \`brain/\`; use
   the description the runner gave you in the system prompt. Reason about the agent's
   purpose, what the user actually asked for, and which of the tools above genuinely serve
   that purpose — don't jump straight to writing.
2. **Ask before you guess.** Unless the change is trivial and fully specified (e.g. "add web
   search" → just add \`@exa\`), pause **once** with \`ask_user_question\` to personalize.
   Batch 2–4 short, structured questions covering how the agent should behave, which
   tools/integrations it should use, tone and defaults, and any recurring schedule. Keep
   options short; set \`allowOther: true\` where a sensible answer may fall outside them. Do
   **not** ask these as plain chat questions, and do **not** pause for a trivial,
   already-specified edit.
3. Draft the **complete new body** — not a diff — and keep it light (see "Keep the body
   light"). Keep what should stay, add or rewrite what should change, and keep any
   \`@mentions\` for tools and Brain mounts you still want active.
4. Call \`update_agent_file\` with:
   - \`body\`: the full new Markdown body (required).
   - \`model\`: an optional model id to switch to. Omit it to keep your current model.
   - \`triggers\`: an optional complete list of your recurring schedules (see "Schedules"
     above). Omit it to keep your current schedules.
   - \`summary\`: a one-line description of what you changed and why.
5. If the tool returns \`ok: false\`, read the \`errors\`, fix the body, and call it again.
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

Think about the agent's purpose and which tools fit → ask the user a short, structured
round of personalization questions (\`ask_user_question\`) unless the change is trivial →
draft a light, scannable body with the right \`@mentions\` → \`update_agent_file\` → report the
new version and what changed → remind them it applies to the next session.
`;
}

const AGENT_SELF_EDIT_SKILL_MD = buildSelfEditSkillMd();

export const AGENT_SELF_EDIT_SKILL_ID = "agent-self-edit";

export const OPENCOMPANY_SETUP_SKILL_ID = "opencompany-setup";

function buildOpenCompanySetupSkillMd(): string {
  return `---
name: opencompany-setup
description: Set up an OpenCompany workspace for the user — establish the Brain (a company wiki) and tune your own definition so the user has great scaffolding from day one.
---

# Setting up OpenCompany

You are an OpenCompany agent. This skill teaches you how the workspace fits together and how
to set it up well for a new user — especially right after they sign up. You set up two
surfaces: the **Brain** (shared knowledge) and **yourself** (your definition and your private
\`agent/soul.md\`). Aim for a focused, high-signal starting point that the user can grow — not
a pile of empty files.

## How the pieces relate

- **The Brain** is your workspace's shared, long-lived knowledge — plain Markdown files that
  every agent in the workspace can read and that persist across sessions. Treat it as a
  **company wiki** under \`brain/wiki/\`. Use it for durable facts about the company, product,
  customers, and processes — not one-off task context.
- **Your \`.agent\` definition** is your behavior: instructions, model, tools, and which Brain
  paths you mount. You change it with the \`agent-self-edit\` skill.
- **\`agent/soul.md\`** is your private operating doc — who you serve and how you work. Read it
  before any work and keep it current.

You **mount** Brain context by \`@mention\`-ing it in your definition: \`@brain/wiki/\` mounts the
wiki. Files you write under a mounted path persist and show up in the user's **Brain** view.

## The Brain is a wiki

Organize the Brain as a wiki under \`brain/wiki/\`. Here is the canonical shape — a strong
default, **not a fixed template**:

\`\`\`
brain/wiki/
  company/       # what we do, mission, structure, key facts
  product/       # what we build, how it works, roadmap
  team/          # who's who, roles, ways of working
  growth/        # marketing, sales, acquisition
  strategy/      # bets, positioning, priorities
  competitors/   # who we're up against, how we differ
  operations/    # processes, tools, vendors
  projects/      # active initiatives
  meetings/      # notes and decisions
\`\`\`

**Adapt it to the business.** An agency adds \`clients/\`; a software company adds
\`engineering/\`; a creator adds \`content/\`. Drop folders that don't apply. Give each folder a
one-line \`README.md\` naming what belongs there so it can evolve.

**Keep it low-noise:**

- Prefer a few high-signal files over many empty stubs.
- Write only what you actually know — don't invent facts.
- READMEs are a sentence, not a wall of boilerplate.
- Let the structure grow over time; don't front-load everything.
- Each file stays under 256 KB.

## First-run setup protocol

When the workspace is fresh, or the user asks to "set up OpenCompany" / "get me set up",
follow this loop. The user should feel guided and in control — not interrogated.

1. **Read this skill** (you are doing that now).
2. **Ground yourself.** If a company URL came in the signup, do a **quick @exa research pass**
   — one or two targeted searches to learn what the company does. Don't over-research.
3. **Ask 1–2 sharp questions with \`ask_user_question\`**, building on the signup details and
   what you found: what the company really does, who it serves, and what they want help with
   first. Use one structured tool call with short options and \`allowOther: true\` when the
   user's answer may not fit your options. Do not ask these as plain chat questions.
4. **Scaffold a tailored \`brain/wiki/\`**: the folders that fit this business, each with a
   one-line README, plus two or three genuinely useful seeded files (e.g.
   \`brain/wiki/company/overview.md\`, \`brain/wiki/strategy/priorities.md\`). Capture what you
   learned; leave the rest to grow.
5. **Personalize \`agent/soul.md\`** to this user — fill in who you serve (their role and what
   they care about) and what good looks like for their focus areas. Keep it short.
6. **Tune your definition.** Read \`skills/agent-self-edit/SKILL.md\` with \`read_skill\`, then
   call \`update_agent_file\` to give yourself crisp instructions for this user and mount the
   wiki with \`@brain/wiki/\`.
7. **Solve "what now?"** (see below) so the user has a clear next step.

## Closing — solve "what now?"

Don't just stop after setup. In plain language:

- Tell the user what you set up, and point them to the **Brain** tab (to see and expand the
  wiki) and the **Agent** tab (to see and customize you and your \`soul.md\`). Invite them to
  tweak anything — it's all theirs to edit.
- Note that changes to your definition take effect on your next session.
- If a concrete first task is obvious from what you learned, **offer to start on it right now**
  rather than leaving them on a blank page.

## Guardrails

- Prefer asking over assuming; a short, sharp set of questions beats a long form.
- During interactive setup, prefer \`ask_user_question\` for required decisions so the run pauses
  cleanly and resumes with structured answers. If the tool says questions are unavailable, proceed
  with best judgment and explain your assumption.
- Don't over-scaffold. A handful of genuinely useful files is the goal.
- The Brain is shared knowledge; your definition and \`soul.md\` are behavior. Keep durable
  facts in the Brain and durable behavior in your definition — don't mix them up.
- This skill grants no new powers beyond the file and self-edit tools you already have.
`;
}

const OPENCOMPANY_SETUP_SKILL_MD = buildOpenCompanySetupSkillMd();

export const MEMORY_SKILL_ID = "memory";

// Relative path (under skills/<id>/) where the runner drops the bundled CLI. The skill's files
// in this catalog are SKILL.md only — the ~150 KB JS bundle is delivered by the runner so it
// never bloats agent-runtime (and the web bundle that imports it).
//
// `.mjs` (not `.js`) is load-bearing: the bundle is ESM (`import …`, `import.meta.url`), and it
// lands in a read-only skills mount with no package.json, so `node memory.js` would treat it as
// CommonJS and fail on the first `import`. The `.mjs` extension forces ESM.
export const MEMORY_CLI_FILE = "memory.mjs";

function buildMemorySkillMd(): string {
  return `---
name: memory
description: Maintain durable, evidence-grounded memory across sessions with the \`memory\` CLI — canonical objects (people, companies, projects, decisions…) compiled from cited evidence, plus hybrid retrieval.
---

# Structured memory

You have a persistent, structured memory under \`agent/memory/\` that survives across sessions.
Manage it **only** through the \`memory\` tool — do not hand-edit files under \`agent/memory/\` with
\`edit_file\`/\`write_file\`, and do not run the CLI yourself with \`shell\`; the \`memory\` tool enforces
the structure, provenance, and links that keep memory trustworthy (and runs model-backed retrieval
with credentials you never handle). (\`agent/memory.md\` remains your freeform scratchpad; the
structured tree is separate.)

Call the \`memory\` tool, passing the subcommand and flags in its \`args\` string:

\`\`\`
memory({ args: '<command> [options]' })
\`\`\`

Add \`--json\` to any command for machine-readable output.

## The model: compiled truth + evidence

Memory has two kinds of files, each a two-layer document — a **compiled truth** (your current
synthesized belief) on top, and an **append-only timeline** of dated entries below:

- **Canonical objects** — one file per real thing: \`person\`, \`company\`, \`project\`, \`customer\`,
  \`decision\`, \`concept\`, \`theme\`. This is what you believe is true *now*.
- **Evidence** — immutable source records (\`meeting\`, \`conversation\`, \`doc\`, \`research\`,
  \`correction\`) with provenance, linked to the canonical objects they are about.

The rule that keeps memory honest: **compiled truth must cite evidence.** You capture evidence
first, then rewrite an object's compiled truth with \`[^ev:<evidence-id>]\` citations pointing at it.

Every file has a unique \`id\` that is also its file name. Ids are lowercase slugs
(e.g. \`acme\`, \`jane-doe\`, \`acme-call-2026-06-06\`).

## Commands

- **create** — a new canonical object.
  \`memory create --type company --id acme --alias "Acme Inc" --truth "Logistics SaaS we sell to."\`
- **append-evidence** — record immutable evidence and link it to canonical subjects.
  \`memory append-evidence --kind meeting --id acme-call-2026-06-06 --subject acme --subject jane-doe --source-ref "gcal://event/abc" --summary "Confirmed enterprise eval; SSO is the blocker."\`
  Provenance (\`--kind\` + \`--source-ref\`) and at least one existing \`--subject\` are required.
- **rewrite** — update an object's compiled truth. Must cite linked evidence.
  \`memory rewrite acme --truth "Acme is evaluating our enterprise tier; SSO is the gating requirement [^ev:acme-call-2026-06-06]."\`
  Every \`[^ev:...]\` must point at evidence that lists this object as a subject, or it is rejected.
- **get** — read a file. \`memory get acme\` (add \`--section truth|timeline|frontmatter\`).
- **query** — hybrid retrieval over everything. \`memory query "acme enterprise blockers"\`
  Filter with \`--type\`, \`--status\`, \`--folder\`, \`--since\`, \`--limit\`.
- **merge** — fold a duplicate canonical object into another, then re-synthesize.
  \`memory merge --from acme-corp --into acme\` (then \`memory rewrite acme ...\`). Use \`--dry-run\` first.
- **doctor** — health check (broken links, missing provenance, stale truth, duplicates).
  \`memory doctor\` (add \`--fix-freshness\` to mark stale objects).

## How to use it well

- When you learn something durable about a person, company, project, customer, or decision,
  **capture it as evidence first**, then **rewrite** the relevant object's compiled truth citing it.
- Before answering questions about people, companies, or past decisions, **query** memory.
- Keep compiled truth tight and current; let the timeline hold the history.
- Run **doctor** occasionally and after merges to catch broken links and stale summaries.
- Don't record one-off, throwaway context here — that belongs in the conversation.
`;
}

const MEMORY_SKILL_MD = buildMemorySkillMd();

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
  {
    id: MEMORY_SKILL_ID,
    name: "Structured memory",
    description:
      "Maintain durable, evidence-grounded memory across sessions with the memory CLI — canonical objects compiled from cited evidence, plus hybrid retrieval.",
    defaultEnabled: true,
    files: [{ path: "SKILL.md", content: MEMORY_SKILL_MD }],
  },
];

export const AGENT_SKILL_DEFINITION_BY_ID = new Map(
  AGENT_SKILL_CATALOG.map((skill) => [skill.id, skill]),
);

export function isKnownAgentSkillId(id: string): boolean {
  return AGENT_SKILL_DEFINITION_BY_ID.has(id);
}

// Mount-slug constraint, mirrored exactly from the runner's resolveSandboxSkillPath so an
// external skill that normalizes here is guaranteed to mount and be readable via read_skill.
const SKILL_MOUNT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSkillMountId(id: string): boolean {
  return SKILL_MOUNT_ID_RE.test(id) && !id.includes("--");
}

// Metadata for an enabled skill (built-in or external), without file contents. Built-in
// files live in code; external files live in the snapshot DB and are loaded by the runner.
export type ResolvedSkillMetadata = {
  id: string;
  name: string;
  description: string;
  origin: "builtin" | "external";
  source?: AgentSkillSource;
};

// The skills available to a session, as metadata only: every built-in `defaultEnabled`
// skill, plus any known built-in or well-formed external skill listed in the agent's
// `skills:` config. Deduplicated by id (built-in id wins). Pure — no DB, no files.
export function resolveEnabledSkillMetadata(
  config: Pick<AgentConfig, "skills">,
): ResolvedSkillMetadata[] {
  const out: ResolvedSkillMetadata[] = [];
  const seen = new Set<string>();
  for (const skill of AGENT_SKILL_CATALOG) {
    if (!skill.defaultEnabled) continue;
    out.push({ id: skill.id, name: skill.name, description: skill.description, origin: "builtin" });
    seen.add(skill.id);
  }
  for (const reference of config.skills ?? []) {
    if (seen.has(reference.id)) continue;
    if (isExternalSkillReference(reference)) {
      out.push({
        id: reference.id,
        name: reference.name,
        description: reference.description,
        origin: "external",
        source: reference.source,
      });
      seen.add(reference.id);
    } else if (isKnownAgentSkillId(reference.id)) {
      const definition = AGENT_SKILL_DEFINITION_BY_ID.get(reference.id)!;
      out.push({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        origin: "builtin",
      });
      seen.add(reference.id);
    }
  }
  return out;
}

// The built-in skills whose files (shipped in code) should be materialized for a session.
// External skills are excluded here — the runner loads their files from the snapshot DB.
export function resolveEnabledBuiltinSkillFiles(
  config: Pick<AgentConfig, "skills">,
): AgentSkillDefinition[] {
  const ids = new Set<string>();
  for (const skill of AGENT_SKILL_CATALOG) {
    if (skill.defaultEnabled) ids.add(skill.id);
  }
  for (const reference of config.skills ?? []) {
    if (!isExternalSkillReference(reference) && isKnownAgentSkillId(reference.id)) {
      ids.add(reference.id);
    }
  }
  return AGENT_SKILL_CATALOG.filter((skill) => ids.has(skill.id));
}

// The only hosts an external skill source url may point at. Mirrors the resolver's SSRF
// allowlist so a hand-edited `.agent` can't smuggle an arbitrary `https://…` through.
const ALLOWED_SKILL_SOURCE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "skills.sh",
  "www.skills.sh",
]);

function isAllowedSkillSourceUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_SKILL_SOURCE_HOSTS.has(parsed.hostname.toLowerCase());
}

// Validate the *shape* of an external skill reference (no DB, no network). Returns a
// normalized reference or null. A malformed external object is dropped entirely so it can
// never half-mount. Integrity-vs-content checks happen at resolve/materialize time.
export function normalizeExternalSkillReference(
  value: unknown,
): AgentExternalSkillReference | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const source = record.source;
  if (!id || !name || !description || !source || typeof source !== "object") return null;
  if (!isValidSkillMountId(id) || isKnownAgentSkillId(id)) return null;

  const sourceRecord = source as Record<string, unknown>;
  const type = sourceRecord.type;
  if (type !== "github" && type !== "skills.sh") return null;
  const url = typeof sourceRecord.url === "string" ? sourceRecord.url.trim() : "";
  if (!isAllowedSkillSourceUrl(url)) return null;
  const ref = typeof sourceRecord.ref === "string" ? sourceRecord.ref.trim() : "";
  if (!ref) return null;
  const path = typeof sourceRecord.path === "string" ? sourceRecord.path.trim() : "";
  if (path.split("/").includes("..")) return null;

  return {
    id,
    name,
    description,
    source: { type, url, ref, path },
  };
}

// Normalize an arbitrary frontmatter value into skill references. Keeps known built-in ids
// (bare strings or `{id}` objects) and well-formed external objects; drops everything else.
// Deduplicated by id, with built-in ids winning over an external of the same id.
export function normalizeAgentSkills(value: unknown): AgentSkillReference[] {
  const references: AgentSkillReference[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const external = normalizeExternalSkillReference(item);
    if (external) {
      if (seen.has(external.id)) continue;
      seen.add(external.id);
      references.push(external);
      continue;
    }
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

// Canonical content hash for a skill folder. Order-independent (files are sorted by path),
// content- and path-sensitive. Used by the resolver (to dedup/cache) and the runner (to
// revalidate a snapshot before mounting). Uses Web Crypto so it stays isomorphic.
export async function computeSkillFolderIntegrity(files: AgentSkillFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: string[] = [];
  for (const file of sorted) {
    parts.push(file.path, "\0", file.content, "\0");
  }
  const data = new TextEncoder().encode(parts.join(""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
