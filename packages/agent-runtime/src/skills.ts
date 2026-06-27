import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { normalizeSkillCommand, validateSkillFiles } from "./skill-resolver";
import { AGENT_TOOL_CATALOG, type AgentToolDefinition } from "./tools";
import {
  type AgentConfig,
  type AgentExternalSkillReference,
  type AgentSkillFile,
  type AgentSkillReference,
  type AgentSkillSource,
  type AgentWorkspaceSkillSource,
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
  // Built-in skills with `addable` are offered in the agent editor's @-mention menu and
  // can be self-added via self-edit, so an agent or user can turn them on per-agent. Only
  // meaningful for `defaultEnabled: false` skills; `defaultEnabled: true` ones are always on,
  // and internal skills (e.g. onboarding) leave this unset so they stay out of the picker.
  addable?: boolean;
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
- \`@skill/<id>\` — turn on an addable built-in skill (see "Skills you can add" below).

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

## Skills you can add

Some built-in skills are **available but off by default** — turn one on by mentioning it as
\`@skill/<id>\` in your body, turn it off by dropping the mention. The skill then loads on
demand whenever a matching task comes up. (This only works for built-in skills; skills added
from a GitHub/skills.sh URL are managed by a human in the editor and are preserved as-is.)

- \`@skill/first-principles\` — a 15-prompt framework for breaking a hard problem down to
  fundamentals and rebuilding the answer from scratch. Add it when you regularly face stuck or
  high-stakes decisions and want a sharper way to reason through them.
- \`@skill/humanizer\` — strip the telltale signs of AI-generated writing and give prose a real
  human voice. Add it when you regularly write text people will read — emails, posts,
  summaries, docs.
- \`@skill/y-combinator-knowledge\` — YC-style startup sparring: office-hours framing, user
  obsession, MVP and growth pressure, fundraising discipline, and links to canonical YC/PG
  teachings. Add it for founder, product, growth, fundraising, or company strategy agents.
- \`@skill/move-to-opencompany\` — import an external knowledge base (a GitHub repo or folders)
  into the Brain safely, with a preview and a receipt (imported N, lost 0). Add it when the user
  is migrating notes, docs, or a wiki into OpenCompany.
- \`@skill/cto-pr-review\` — review pull requests and diffs as a blocking senior technical
  reviewer. Add it for agents responsible for code review, merge readiness, architecture, or
  release risk.
- \`@skill/implementer\` — implement software changes with a strong SWE loop: read context,
  define the real contract, test first when practical, make a narrow change, verify, and review
  the diff. Add it for agents that regularly write code.

Add a skill only when it genuinely fits how you work — an unused skill is just noise in your
definition.

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
   options short — the user can always type their own free-text answer, so you don't need to
   cover every case. Do **not** ask these as plain chat questions, and do **not** pause for a
   trivial, already-specified edit.
3. Draft the **complete new body** — not a diff — and keep it light (see "Keep the body
   light"). Keep what should stay, add or rewrite what should change, and keep any
   \`@mentions\` for tools and Brain mounts you still want active.
4. Call \`update_agent_file\` with:
   - \`body\`: the full new Markdown body (required).
   - \`title\`: an optional new display name for yourself (e.g. a name the user picked). Omit it
     to keep your current name. Only set it when the user actually wants you renamed.
   - \`model\`: an optional model id to switch to. Omit it to keep your current model.
   - \`triggers\`: an optional complete list of your recurring schedules (see "Schedules"
     above). Omit it to keep your current schedules.
   - \`summary\`: a one-line description of what you changed and why.
5. If the tool returns \`ok: false\`, read the \`errors\`, fix the body, and call it again.
   Common failures: empty body, an unknown model id, or malformed content.

## Important constraints

- **Keep it valid.** A broken edit is rejected, never silently applied.
- **Renaming yourself** is allowed via the optional \`title\` argument, but only when the user
  asks for it (e.g. they pick a name during onboarding). Don't rename yourself unprompted.
- **Repositories and delegated agents are preserved** automatically; you cannot add
  unauthorized repositories through this tool. To use \`@amp\` or \`gh\`, a repository must
  already be attached to you by a human. **GitHub pull-request triggers are also preserved**
  and can only be changed by a human — but you *can* manage your own **schedule** triggers
  here (see "Schedules" above).
- **Changes take effect on your next turn in this same session** — the runtime reloads your
  configuration every turn, so the new tools, instructions, skills, model, and schedules are live
  the moment you next act (your next reply, or the user's next message). No new session needed.
  Only the reply you're finishing right now keeps the configuration it started with.

## A good loop

Think about the agent's purpose and which tools fit → ask the user a short, structured
round of personalization questions (\`ask_user_question\`) unless the change is trivial →
draft a light, scannable body with the right \`@mentions\` → \`update_agent_file\` → keep the
conversation flowing. The change is already live for the rest of this session, so just continue
naturally; mention the new version or what changed only if it's useful to the user.
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
   first. Use one structured tool call with short options; the user can always type their own
   free-text answer if none fit. Do not ask these as plain chat questions.
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
- Note that changes to your definition take effect from your next turn in this same session.
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
with credentials you never handle). (This structured tree is the canonical store for every durable
fact. Your profile \`agent/user.md\` is not a second store — it's a small, always-loaded digest of
this tree, edited directly; anything promoted there should also live here.)

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
(Need to write the citation pattern literally, e.g. to document it? Escape it as \`\\[^ev:id]\` and it
is treated as prose, not a citation.)

Every file has a unique \`id\` that is also its file name. Ids are lowercase slugs
(e.g. \`acme\`, \`jane-doe\`, \`acme-call-2026-06-06\`).

## Commands

- **create** — a new canonical object. Query by name first: if this person/company already exists
  under another spelling, update that record (\`rewrite\`/\`alias\`) instead of making a second one.
  \`create\` refuses a near-duplicate of an existing object of the same type and names it; pass
  \`--allow-similar\` only when it genuinely is a different thing that happens to share a name.
  \`memory create --type company --id acme --alias "Acme Inc"\`
- **append-evidence** — record immutable evidence and link it to canonical subjects.
  \`memory append-evidence --kind meeting --id acme-call-2026-06-06 --subject acme --subject jane-doe --source-ref "gcal://event/abc" --summary "Confirmed enterprise eval; SSO is the blocker."\`
  Provenance (\`--kind\` + \`--source-ref\`) and at least one existing \`--subject\` are required.
- **rewrite** — update an object's compiled truth. Must cite linked evidence.
  \`memory rewrite acme --truth "Acme is evaluating our enterprise tier; SSO is the gating requirement [^ev:acme-call-2026-06-06]."\`
  Every \`[^ev:...]\` must point at evidence that lists this object as a subject, or it is rejected.
- **alias** — add or remove alternate names on a canonical object (retrieval matches on them).
  \`memory alias acme --add "Acme Corp" --remove "ACME"\` (both flags repeatable). An alias another
  object already owns is rejected, so aliases stay globally unique.
- **link** — add or remove **directional, typed** \`related\` edges between canonical objects.
  \`memory link acme --to jane --as employs\` — \`--as\` is a freeform lowercase relation type
  (e.g. \`employs\`, \`works_at\`, \`depends_on\`, \`part_of\`; defaults to \`related\`). \`--to\` and
  \`--remove\` are repeatable; there's one edge per target, so re-linking updates its type. Edits
  only the named object's links; query can then expand along them (see \`--hops\` below).
- **get** — read a structured record with compiled truth and recent timeline entries. \`memory get acme\` (add \`--section truth|timeline|frontmatter|all\` to narrow output or read the raw file).
- **query** — hybrid retrieval over everything. \`memory query "acme enterprise blockers"\`
  Filter with \`--type\`, \`--status\`, \`--folder\`, \`--since\`, \`--limit\`. Add \`--hops N\` to also pull
  in objects reachable via \`related\` edges (e.g. \`--hops 1\` surfaces directly-linked neighbours).
  \`--since\` takes a relative window (\`30m\`, \`24h\`, \`7d\`, \`2w\`) or an ISO-8601 timestamp, matched
  against \`updated_at\`. Run query with no text for a recency listing — \`memory query --since 24h\`
  lists everything updated in the last day, newest first.
  Results include capped compiled truth and a \`memory get <id>\` hint for the full record/timeline.
- **merge** — fold a duplicate canonical object into another, then re-synthesize. Aliases, related
  links and timeline move to the survivor; the source becomes a redirect stub.
  \`memory merge --from acme-corp --into acme\` (then \`memory rewrite acme ...\`). Use \`--dry-run\` first.
- **delete** — permanently remove a file (a leftover merge stub, a duplicate, or a bad object).
  \`memory delete acme-corp\` (use \`--dry-run\` to preview). Related links and evidence subjects are
  scrubbed automatically; if the target is still cited or is a merge target, it needs \`--force\` and
  you must repair those references afterward (run \`memory doctor\`).
- **doctor** — health check (broken links, missing provenance, stale truth, duplicates, and
  \`near_duplicate\` look-alike objects that should probably be merged).
  \`memory doctor\` — a read-only report; fix what it flags with the commands above.

## How to use it well

- When you learn something durable about a person, company, project, customer, or decision,
  **capture it as evidence first**, then **rewrite** the relevant object's compiled truth citing it.
- Before answering questions about people, companies, or past decisions, **query** memory; use
  **get** when the query result indicates a likely record and details or timeline matter.
- For "what's new" / "catch me up" questions about memory itself, list recent updates with
  \`memory query --since 24h\` (or \`7d\`) and no search text. For what was *said* recently, the
  recall tool over past transcripts is the better source.
- When two objects are connected (a person at a company, a decision on a project), **link** them
  so future queries can hop between them with \`--hops\`. A well-linked graph retrieves better.
- Keep compiled truth tight and current; let the timeline hold the history.
- Run **doctor** occasionally and after merges to catch broken links and stale summaries.
- Prefer **merge** over **delete** when two objects are the same thing — it preserves the evidence
  and timeline. Reach for **delete** only to clear leftover stubs or genuinely bad objects.
- Don't record one-off, throwaway context here — that belongs in the conversation.
`;
}

const MEMORY_SKILL_MD = buildMemorySkillMd();

export const SKILL_CREATOR_SKILL_ID = "skill-creator";

function buildSkillCreatorSkillMd(): string {
  return `---
name: skill-creator
description: Create or improve your own personal skills — reusable, on-demand playbooks for procedures you repeat. Use when you notice a repeatable workflow worth saving, or when the user asks you to "make/save a skill", "remember how to do X", or "create a skill for X".
---

# Creating a personal skill

A **personal skill** is a small playbook you write for your future self: a reusable procedure you
can load on demand instead of relearning it each time. This skill explains when to make one and how
to write a good one. Personal skills are private to you and persist across sessions.

## When to create one

Make a skill when you find yourself repeating — or expect to repeat — a multi-step procedure, and
notes would help you do it well next time. Don't create one for a one-off task or something you can
already do without notes.

Pick the right surface — don't put everything in a skill:

- **A repeatable procedure / how-to → a skill** (this surface).
- **A fact** about a person, company, project, or decision → **memory** (the \`memory\` tool).
- **How you behave by default** (tone, standing preferences, default tools/model) → your **\`.agent\`
  definition** via self-edit.
- **Shared team knowledge** others rely on → the **Brain** (\`brain/\`).
- **One-off context** for this task only → just keep it in the **conversation**.

## Where it lives and how it loads

- A skill is a folder in your private bundle: \`agent/skills/<id>/SKILL.md\`, plus optional supporting
  files. Create and edit it with \`write_file\` and \`edit_file\` — there is no special tool.
- \`<id>\` is a short lowercase slug (letters, digits, hyphens), e.g. \`weekly-digest\`. It can't
  collide with a built-in skill id.
- Skills are **auto-discovered** — you never list them anywhere. They appear in your \`## Skills\`
  index and load with \`read_skill\` **from your next turn in this same session onward** (only the
  reply you're writing now was already configured). So a skill you write now is active the next
  time you act this session — no new session needed. Within the current reply you can still
  re-read your draft with \`read_file agent/skills/<id>/SKILL.md\`.

## Write the SKILL.md

Start with YAML frontmatter, then a Markdown body:

\`\`\`
---
name: Weekly digest
description: How to write and post the Monday digest the way the user likes it. Use when preparing the weekly digest or when asked to post the Monday update.
provenance: agent
---

# Weekly digest

1. Pull last week's shipped PRs and highlights.
2. Draft in the user's preferred format (see references/format.md).
3. Post and confirm.
\`\`\`

- **\`name\`** (required): a short human title.
- **\`description\`** (required): the most important line — it's all your future self sees in the
  index when deciding whether to open the skill. Say both **what** it does and **when** to use it,
  in a sentence or two. Be specific and a little eager so you actually trigger it.
- **\`provenance\`** (optional): \`agent\` when you created the skill yourself, \`user\` when the user
  asked for it.

## Keep it lean (progressive disclosure)

- The SKILL.md body is the instructions you'll follow — write tight, imperative steps, and explain
  *why* where it matters. Keep it focused on one class of task.
- If it grows long or carries bulky reference material, split that into supporting files in the same
  folder and point to them from the body:
  - \`references/\` — detailed docs you read only when needed.
  - \`templates/\` — boilerplate to copy.
  - \`scripts/\` — helper scripts to run.
- Only the SKILL.md body loads when you open a skill; supporting files load when you read them. Don't
  dump everything into SKILL.md.

## Constraints

- A skill is **instructions only** — it can't grant tools or capabilities. To change your tools or
  model, use self-edit, not a skill.
- Improve a skill over time: when you learn a better way, \`edit_file\` its SKILL.md rather than making
  a second near-duplicate skill.
- A malformed skill (missing \`name\`/\`description\`, no \`SKILL.md\`, or an invalid id) is silently
  skipped at next-session discovery — so double-check the frontmatter after you write it.
`;
}

const SKILL_CREATOR_SKILL_MD = buildSkillCreatorSkillMd();

export const ONBOARDING_SKILL_ID = "onboarding";

function buildOnboardingSkillMd(): string {
  return `---
name: onboarding
description: First-session onboarding for a brand-new user. Only for the very first session, when the user has just introduced themselves. Ignore in normal sessions.
---

# First-session onboarding

This is the user's **very first session**. Their message has two parts:

1. **The task they want done today** — what they actually typed and want from you.
2. **First-session background** — their name, role, and website, collected on the onboarding
   screen and attached to this message (they did *not* type it in chat, so don't quote it back as
   if they did). It may also include a **chosen setup** (a role/mode they picked, e.g. "Chief of
   Staff", with a short description of what that mode means) and the **integrations they enabled**.

Your job: get yourself set up — learn who they are, tune how you work — and
*then* do the task they asked for. Keep the setup brief and conversational, not a wizard.

If a **chosen setup** is present, treat its description as the role they want you to play: lean into
it when you tune your soul (below), and reflect it back in your greeting. If **integrations** are
listed, they're already enabled on you — don't ask the user to turn them on; just acknowledge them
briefly (and note any that still need connecting in workspace settings if a task needs them).

## 1. Read who they are (silently)

From the background and task, pull out their **name**, **role**, the **company or project** behind
their website and what it does. If a **website** is given, fetch it with \`web_fetch\` **before** you
reply and use what you learn to be specific — quietly, don't narrate "let me check your site".

## 2. Save the foundation to memory

Write what you learned so it persists:

- Put their identity into your hot-memory file \`agent/user.md\` with \`write_file\` — name, role,
  company/project and what it does, and how they seem to want to work. Keep it tight; this rides in
  every future session.
- For durable, retrievable facts about their company and themselves as distinct things, also capture
  them with the \`memory\` tool (e.g. a \`company\` object and a \`person\` object) following its skill.

## 3. Greet them, then tune your soul

Now send **one** short message that:

- **Reflects what you learned** — greet them by name and show you understand their role and what
  they're building (ideally a detail only the website or context could have given you). One or two
  sentences; warm, not effusive.
- **Asks how you should work for them** — tone, defaults, what they care about most — so you can
  tune your soul to fit. Keep it light: one or two concrete prompts, not an interview.

Then **stop and wait** for their answer. Don't start the task yet.

## 4. Tune the soul

Once they reply:

- **Keep your identity fixed** — your name is Leo. Do not ask the user to rename you, and do not
  call \`update_agent_file\` to change your title.
- **Tune your soul** — update \`agent/soul.md\` with \`write_file\` to reflect who they are and how
  they want you to work (the "Who I serve" and "How I work" sections especially). Keep it tight.

Do this quickly and don't over-explain the mechanics — a brief "Got it, I'll work that way" is plenty.

## 5. Now do the task

Turn to the task they asked for in their first message and actually make progress on it — research,
draft, or take the first concrete step. If you genuinely need a detail to proceed, ask, but bias to
action. From here on, behave as their normal personal agent.

The feeling to create: an agent that wanted to know them and let them shape it before diving in —
not a setup wizard.
`;
}

const ONBOARDING_SKILL_MD = buildOnboardingSkillMd();

export const FIRST_PRINCIPLES_SKILL_ID = "first-principles";

function buildFirstPrinciplesSkillMd(): string {
  return `---
name: first-principles
description: Break a hard problem down to fundamental truths and rebuild the solution from scratch. Use for high-stakes or stuck decisions where the conventional approach isn't working, the assumptions feel shaky, or you need an answer better than "how it's usually done."
---

# First-principles thinking

Most reasoning is **reasoning by analogy** — copying what already exists with small tweaks.
First-principles thinking instead strips a problem down to the few things you *know* are true,
then rebuilds an answer from only those, ignoring how it's normally done. It's slower, so spend
it where it pays off, not on routine choices.

## When to use this

- A decision is hard, high-stakes, or you're stuck, and the obvious approach isn't working.
- You suspect the "best practice" everyone copies doesn't actually fit this situation.
- You're told something is impossible or fixed, and you're not sure the constraint is real.
- You want an answer that's genuinely better than the default, not just a safe variation of it.

Don't reach for it on reversible, low-stakes, or well-understood choices — there, analogy is
faster and fine. Use judgement: the goal is a better decision, not a longer one.

## How to run it

Work the 15 prompts below **in order**, in five passes. Write your answers down (a scratch file
in \`work/\` is ideal) — externalizing the reasoning is most of the value. You don't need a
paragraph per prompt; a tight, honest answer beats a long one. Skip a prompt only when it
genuinely doesn't apply, and say why. End at pass 5 with a decision and the single truth it
rests on.

### Pass 1 — Strip to fundamentals

1. **State the real goal as an outcome, not a solution.** What are we *actually* trying to
   achieve? Phrase it as the end result we want, with no method baked in. ("Move people across
   the city in 10 minutes," not "build a faster train.")
2. **List the bedrock facts.** What do we know to be true here that can't be reduced further —
   physical limits, hard numbers, contractual or legal givens, things we've directly verified?
   Keep only what you could defend if challenged.
3. **Separate convention from truth.** Go through everything you "know" about this problem and
   sort each item into *proven truth* vs *inherited convention* ("this is how it's done").
   Convention is not evidence — set it aside for now.

### Pass 2 — Challenge the assumptions

4. **Test each constraint for necessity.** For every constraint and assumption, ask: is this
   *actually* required by the fundamentals, or just how it's currently done? What's the evidence
   it must be true? Demand a reason, not a precedent.
5. **Sort real vs imagined constraints.** Split the constraints into ones rooted in the bedrock
   facts (real) and ones that are habit, fear, or convenience (imagined). Be honest — most
   "hard" constraints are softer than they look.
6. **Five whys to a root cause.** Pick the core difficulty and ask "why" about five times in a
   row, each answer feeding the next question, until you hit something fundamental that you
   can't reduce further. That root is what you actually have to solve.

### Pass 3 — Reason up from the ground

7. **Rebuild from only the fundamentals.** Ignoring the current approach entirely, if you
   assembled a solution using *only* the bedrock facts from pass 1 and the real constraints from
   pass 2, what would it look like? Design it from scratch, not as an edit of the status quo.
8. **Interrogate what you're copying.** Whatever convention or best practice you'd otherwise
   reach for — what is it actually optimizing for, and was that the same goal as yours (prompt
   1)? If the goals differ, the practice may be solving someone else's problem.
9. **Find the simplest mechanism.** What is the simplest possible mechanism that satisfies the
   fundamentals? Prefer the answer with the fewest moving parts that still works — added
   complexity has to earn its place against this baseline.

### Pass 4 — Stress-test and reconstruct

10. **Find where it breaks.** Where does the from-scratch solution fail? Walk the edge cases and
    the second- and third-order effects — what does it set in motion once it's running?
11. **Pre-mortem.** Assume it's a year later and this failed badly. What would have had to be
    true for that to happen? Which of those failure conditions are plausible, and what would
    you change now to defuse them?
12. **Flex the resources.** How would the fundamental solution change with 10× the resources, or
    with one-tenth? The extremes expose which parts are essential and which are just sized to
    today's budget — and often reveal a better middle.

### Pass 5 — Decide and translate to action

13. **Name the real tradeoff.** Put the conventional approach and the from-scratch one
    side by side and state the tradeoff between them *in fundamentals* — not "safer vs riskier"
    but what each actually buys and costs against the goal.
14. **Design the cheapest test.** What is the smallest, fastest, cheapest experiment that would
    validate (or kill) the core assumption everything rests on? Find a way to learn the truth
    before committing fully.
15. **Commit and stay falsifiable.** State the decision, name the single fundamental truth it
    rests on, and write down exactly what evidence would change your mind. If you can't name
    what would change your mind, you haven't finished reasoning.

## The point

The output isn't fifteen filled-in answers — it's a decision you can defend from the ground up,
a clear view of which constraints were never real, and one cheap test before you bet on it. If
the conventional answer survives all five passes, that's a real result too: now you *know* why
it's right instead of just assuming it.
`;
}

const FIRST_PRINCIPLES_SKILL_MD = buildFirstPrinciplesSkillMd();

export const HUMANIZER_SKILL_ID = "humanizer";

function buildHumanizerSkillMd(): string {
  return `---
name: humanizer
description: Make writing sound human. Strip the telltale patterns of AI-generated text and give the prose a real voice. Use whenever you write or edit something a person will actually read — an email, a post, a summary, a doc, a message.
---

# Humanizer: write like a person

Anything you write for a human gets judged twice: once on what it says, once on whether it
sounds like a person said it. AI-generated text has recognizable tells — readers spot them in
seconds and discount everything that follows. This skill is how you strip those tells and put
a real voice in their place. It draws on Wikipedia's "Signs of AI writing" guide, built from
thousands of observed instances of AI text.

Apply it to drafts you produce (emails, posts, summaries, docs) and to text you're asked to
edit. Preserve the meaning and the intended tone; rewrite the delivery.

## Patterns to strip

### Significance inflation

Puffing up importance with claims about legacy and broader trends: *stands as a testament,
pivotal moment, underscores its importance, reflects broader trends, marking a shift, evolving
landscape, indelible mark*. Cut the inflation; state what the thing is and what it does.

> Before: "The launch marks a pivotal moment in the company's journey, reflecting broader
> industry trends."
> After: "The product launched in March. It's the company's first paid tier."

### Promotional gloss

LLMs drift into ad copy: *vibrant, rich, boasts, nestled, groundbreaking, renowned, stunning,
seamless, commitment to excellence*. Neutral, specific facts beat every one of these words.

### Fake-depth "-ing" add-ons

Tacked-on participle phrases that pretend to analyze: *...highlighting the importance of,
...ensuring alignment, ...showcasing its versatility, ...fostering collaboration*. Either say
something concrete or end the sentence.

### AI vocabulary

Words that spike in post-2023 text, especially together: *delve, crucial, pivotal, intricate,
tapestry, landscape (abstract), testament, underscore, showcase, foster, enduring, vibrant,
interplay, Additionally*. None are wrong alone; a cluster of them is a fingerprint. Prefer the
plain word: use, important, complex, also.

### Copula avoidance

"Serves as", "stands as", "functions as", "boasts", "features" where "is" and "has" belong.
"The gallery is LAAA's exhibition space", not "serves as LAAA's exhibition space".

### Formula tics

- **Negative parallelism:** "It's not just X, it's Y." Say Y.
- **Rule of three everywhere:** "innovation, inspiration, and insights." Two is fine. One is fine.
- **False ranges:** "from the Big Bang to dark matter." Name the actual contents.
- **Synonym cycling:** the protagonist / the main character / the central figure / the hero —
  pick one name and repeat it; repetition is human.
- **Vague authority:** "experts argue", "industry reports suggest", "observers have noted" —
  name the source or drop the claim.

### Visual tells

- Em dashes sprinkled everywhere — like this — for punch. Use commas, periods, or parentheses.
- Bolded inline headers in every bullet ("**Speed:** ...", "**Quality:** ...") — write sentences.
- Emojis decorating headings or bullets.
- Title Case Headings — use sentence case.
- Curly quotes from a chat window; use straight quotes.

### Chat residue

"Great question!", "I hope this helps", "Let me know if...", "As of my last update", "While
specific details are limited" — correspondence artifacts and disclaimers don't belong in
finished text. Neither does excessive hedging ("could potentially possibly suggest") or the
generic upbeat close ("The future looks bright. Exciting times lie ahead."). End on a fact or
a next step.

## Put a voice in it

Stripping the tells gets you to neutral. Neutral is still obviously machine-made — sterile
prose with identical sentence lengths, no opinions, no first person, no friction. Go further:

- **Have a take.** "I'd skip this one" reads human; a balanced list of pros and cons reads
  generated.
- **Vary the rhythm.** Short sentence. Then a longer one that takes its time getting where
  it's going. The pattern-free pattern is the human one.
- **Admit uncertainty and mixed feelings.** "Impressive and a little unsettling" beats
  "impressive."
- **Use "I" when it's honest.** "I keep coming back to the pricing" signals a person thinking.
- **Be specific about feelings and facts alike.** Not "this is concerning" but what exactly
  worries you; not "significantly faster" but the number.
- **Let a little mess in.** An aside, a tangent, a sentence fragment. Perfect structure feels
  algorithmic.

Match the voice to the audience: a Slack reply, an investor email, and a blog post should not
sound like the same narrator. When you're writing as the user, match how *they* write — read a
few of their messages or posts first if you can.

## Process

1. Draft (or read) the text.
2. Sweep it against every pattern group above; rewrite what you catch.
3. Run the final audit on your own output: ask yourself "what makes this still read as
   AI-generated?" — name the remaining tells honestly, then fix them.
4. Read it aloud in your head. If a sentence would sound stilted spoken to a colleague,
   rewrite it.

Deliver the final text only — the audit is your internal pass, not part of the output, unless
the user asked to see the reasoning.
`;
}

const HUMANIZER_SKILL_MD = buildHumanizerSkillMd();

export const Y_COMBINATOR_KNOWLEDGE_SKILL_ID = "y-combinator-knowledge";

function buildYCombinatorKnowledgeSkillMd(): string {
  return `---
name: y-combinator-knowledge
description: Be a high-leverage YC-style startup sparring partner. Use for founder office hours, startup strategy, idea validation, MVP scope, user conversations, growth, fundraising, hiring, and hard prioritization.
---

# Y Combinator knowledge

Use this skill when the user wants YC-level startup judgment: a sharp sparring partner who
pushes toward users, speed, focus, evidence, and uncomfortable truth. Do not imitate YC partners
or claim affiliation. Apply the public YC/Paul Graham canon as an operating model, then adapt it
to the user's actual company, stage, constraints, and evidence.

## Operating posture

- Be concrete. Convert vague strategy into a weekly goal, a user segment, a learning question,
  and the next action.
- Prefer customer evidence over opinions. Ask what users did, paid for, retained, complained
  about, or pulled out of the team.
- Push for narrowness before scale. Find the smallest market, workflow, or customer set where
  the product can become urgent.
- Default to action. The next step should usually be a user conversation, a launch, a manual
  concierge test, a sale, or a smaller build.
- Be candid without theater. Name the riskiest assumption, the fake work, and the metric that
  would prove progress.
- Keep the company alive. Watch runway, burn, founder energy, and whether the plan can create
  a believable path to default alive.

## Office-hours loop

Run startup conversations like office hours, not a strategy essay:

1. Stage the company in one sentence: customer, problem, product, traction, team, runway.
2. Identify the live bottleneck: idea, users, activation, retention, revenue, distribution,
   hiring, fundraising, or focus.
3. Ask for the sharpest numbers: weekly active users, retained users, revenue, growth rate,
   conversion, sales cycle, burn, runway, and the last five customer conversations.
4. Separate signal from story. What changed because users pulled, paid, returned, referred, or
   complained? What is just founder narrative?
5. Pick one priority for the week. Write the concrete experiment, owner, deadline, success
   threshold, and what decision it will unlock.
6. End with the founder's homework. One to three actions, all measurable, all doable before the
   next check-in.

## YC lenses

### Idea and market

- Good startup ideas usually start from real problems, preferably problems the founders know
  personally and can build for.
- Look for intensity before breadth. A few people who urgently need the thing beat many people
  who say it sounds interesting.
- If the idea feels too broad, ask: who is the first narrow customer, what painful job do they
  hire this for, and why now?
- If the user has no idea yet, push them toward observation: workflows, annoyances, expensive
  hacks, and changes in the world that create newly possible products.

### MVP and product

- The MVP is the smallest product that can create real user learning, not a small version of the
  eventual company.
- Ship earlier than feels comfortable, but not before there is a clear testable promise.
- Do things manually when automation would hide whether users actually care.
- Product quality means solving the urgent user problem and creating an unusually good early
  experience, not polishing every surface.

### Users and growth

- Talking to users is a job, not a slogan. Ask about what they already do, what broke, what they
  tried, what they paid for, and what would make them switch.
- Recruit early users by hand. Do not wait for distribution to happen.
- Measure growth weekly. Early numbers are small; compounding and retention matter more than
  vanity scale.
- A launch is a learning event. Launch repeatedly, learn from who reacts, then narrow or expand.

### Fundraising

- Fundraising is not company progress. Use it when it helps the company move faster, not as the
  main validation loop.
- A good fundraise story is simple: big problem, specific customer pull, strong team, credible
  insight, and evidence that the company can grow.
- Keep investor writing plain and founder-written. No marketing fog, no inflated category
  language, no hiding the actual business.
- Ask whether the company can make meaningful progress without this round. That pressure often
  improves both the business and the pitch.

### Hiring and operations

- Hire when a function is breaking and the company has learned what excellent work in that
  function looks like.
- Before hiring, ask whether the founders can do the work manually, simplify the process, or use
  tools to remove it.
- Avoid organizational theater: meetings, dashboards, planning cycles, and titles that do not
  change user or revenue outcomes.

### Founder psychology

- Early startups are fragile. Treat morale, focus, and speed as company assets.
- Challenge avoidant behavior: endless rebuilding, broad positioning, premature hiring,
  over-research, investor chasing, and polished decks before customer proof.
- Maintain intensity without magical thinking. The answer is usually a smaller sharper plan
  executed every week.

## Diagnostic prompts

Use these questions to force clarity:

- What did users do last week that they did not do before?
- Who exactly wants this most, and what are they doing without it?
- What is the one metric that would make this week obviously better?
- What part of the product could be manual for the next ten customers?
- If you had to get one paying customer in seven days, what would you do?
- What are you doing that feels productive but is not changing user behavior?
- What would make you change your mind about this idea?
- Are you default alive? If not, what has to become true before runway runs out?

## Canonical YC links

Start here when the answer would benefit from primary material. Prefer official YC and Paul
Graham sources over summaries.

- YC Startup Library: https://www.ycombinator.com/library
- Startup School: https://www.startupschool.org/
- Office Hours collection: https://www.ycombinator.com/library/carousel/Office%20Hours
- Startup School collection: https://www.ycombinator.com/library/carousel/Startup%20School
- Essays by Paul Graham at YC: https://www.ycombinator.com/library/carousel/Essays%20by%20Paul%20Graham
- Paul Graham essays index: https://www.paulgraham.com/articles.html
- YC essential startup advice: https://www.ycombinator.com/library/4D-yc-s-essential-startup-advice
- Order of operations for starting a startup: https://www.ycombinator.com/library/61-order-of-operations-for-starting-a-startup
- How to get startup ideas: https://www.ycombinator.com/library/8g-how-to-get-startup-ideas
- How to talk to users: https://www.ycombinator.com/library/Iq-how-to-talk-to-users
- How to plan an MVP: https://www.ycombinator.com/library/6f-how-to-plan-an-mvp
- How to build an MVP: https://www.ycombinator.com/library/Io-how-to-build-an-mvp
- How to get your first customers: https://www.ycombinator.com/library/Ip-how-to-get-your-first-customers
- The real product-market fit: https://www.ycombinator.com/library/5z-the-real-product-market-fit
- Growth for startups: https://www.ycombinator.com/library/6k-growth-for-startups
- YC guide to business models: https://www.ycombinator.com/library/Gh-yc-guide-to-business-models
- Getting press for your startup: https://www.ycombinator.com/library/4c-getting-press-for-your-startup
- Modern Startup Funding: https://www.startupschool.org/
- Paul Graham, Do Things that Don't Scale: https://www.paulgraham.com/ds.html
- Paul Graham, How to Get Startup Ideas: https://www.paulgraham.com/startupideas.html
- Paul Graham, Default Alive or Default Dead?: https://www.paulgraham.com/aord.html

## Output formats

For office hours, prefer:

- Snapshot: stage, users, traction, runway, current priority.
- Diagnosis: the bottleneck and the riskiest assumption.
- Prescription: one weekly priority, one experiment, and success criteria.
- Homework: concrete next actions and what evidence to bring back.

For fundraising or pitch review, prefer:

- Plain one-sentence company description.
- What is compelling.
- What is unclear or weak.
- The evidence investors will ask for.
- Rewritten pitch bullets in direct founder language.

For product/growth work, prefer:

- User segment.
- Pain and current workaround.
- Manual test.
- MVP scope.
- Metric.
- Seven-day plan.
`;
}

const Y_COMBINATOR_KNOWLEDGE_SKILL_MD = buildYCombinatorKnowledgeSkillMd();

export const MOVE_TO_OPENCOMPANY_SKILL_ID = "move-to-opencompany";

function buildMoveToOpenCompanySkillMd(): string {
  return `---
name: move-to-opencompany
description: Import an external knowledge base — a GitHub repo or a set of folders/files — into the Brain, safely. Stage, preview, confirm, commit, and report a receipt. Use when the user wants to migrate notes, docs, a wiki, or an existing second brain into OpenCompany.
---

# Import a knowledge base into OpenCompany

You bring an outside knowledge base (a GitHub repo, an exported wiki, a pile of markdown) into the
user's Brain — without ever silently losing or clobbering their content. Two rules hold the whole
skill together:

1. Stage in work/, commit to the Brain. work/ is your private, ephemeral scratch space — clone,
   inspect, and transform there. Nothing in work/ survives the session and the user never sees it,
   so an import that only landed in work/ is LOST. The Brain is where imports persist:
   personal-brain/ (your default — the user's private knowledge) or brain/ for a shared company
   workspace.
2. Never overwrite blind. Default to SKIP on a path collision. Every overwrite is recoverable (the
   prior version is captured automatically when you save), but the user still decides — surface
   collisions in the preview and only overwrite when they say so.

## The procedure

### 1. Locate and STAGE the source (in work/)
- GitHub repo: clone it into work/import-src with the gh tool (gh repo clone <owner/name>
  work/import-src). For a public repo not attached to this agent, fall back to the shell:
  git clone --depth 1 <https-url> work/import-src.
- Files the user pasted, attached, or pointed at a path: copy them under work/import-src/ with the
  shell.
- Survey with list_files work/import-src and read a few representative files. Layouts vary — do not
  assume structure.

### 2. PLAN the mapping (no writes yet)
- Decide each source file's destination Brain path. Map the source folders onto a clean wiki shape
  (personal-brain/<area>/... or brain/wiki/<area>/...); rename messy paths to something a human
  would keep.
- Convert non-markdown text to .md where sensible; leave already-markdown as-is.
- Exclude noise: .git/, build output, binaries, lockfiles — anything that is not knowledge.
- Respect the size limits. A single file over 2 MB, or a personal brain growing past ~32 MB total,
  is too large to load back into a session and would be dropped. Mark oversized files to SKIP or
  split, and say so — never let one vanish silently.
- Detect collisions: for each destination, read_file it. Classify NEW (nothing there), IDENTICAL
  (same content — skip, no-op), or DIFFERENT (a real collision that needs a decision).

### 3. PREVIEW + CONFIRM (ask_user_question)
Show a compact preview before touching the Brain: how many files will be imported, the destination
tree, which are skipped and why (noise / too big / identical), and every DIFFERENT collision. Then
ask_user_question once: proceed as previewed, and for collisions choose skip-existing (default),
overwrite (recoverable), or import-as a <name>.imported.md copy. Do not write until they answer.

### 4. COMMIT (write_file into the Brain)
- Write each planned file with write_file to its Brain destination (personal-brain/... or
  brain/...). These persist and surface to the user; work/ does not.
- Be idempotent: skip IDENTICAL files and honor the user's collision choice. Running the skill
  twice on the same source converges to the same Brain — never duplicate.
- If the import is large, commit in coherent batches by area rather than truncating mid-import.

### 5. RECEIPT (always)
End with an honest, structured tally:
- Imported: N — list the destination paths (or per-folder counts if there are many).
- Skipped: M — each with a reason (identical / too large / excluded noise / user chose skip).
- Overwritten: K — note these are recoverable (a prior version was saved automatically).
- Lost: 0 — this is the contract. If anything could not be imported AND could not be safely
  skipped, say so loudly and leave the source in work/ so nothing is dropped silently.

## Guardrails
- Never import directly into work/ as a destination — it is staging only.
- memory/ is off-limits to file tools; never route imports there.
- This skill grants no new tools — it is the safe procedure around gh, shell, list_files,
  read_file, write_file, and ask_user_question that you already have.
`;
}
const MOVE_TO_OPENCOMPANY_SKILL_MD = buildMoveToOpenCompanySkillMd();

export const CTO_PR_REVIEW_SKILL_ID = "cto-pr-review";

function buildCtoPrReviewSkillMd(): string {
  return `---
name: cto-pr-review
description: Review pull requests and diffs as a blocking CTO-level technical reviewer. Use when evaluating code for merge readiness, correctness, architecture, security, migrations, tests, and product risk.
---

# CTO PR review

Review code as the person accountable for what ships. Your job is to decide whether the change
is safe to merge, not to make the author feel good. Be fair, concrete, and technically rigorous.

## When to use this

- The user asks for a PR review, diff review, code review, merge check, or release-readiness pass.
- You are reviewing work from another agent before continuing.
- A change touches shared behavior, security boundaries, billing, auth, data persistence,
  migrations, env/config, external APIs, or user-facing flows.

Do not use this for broad brainstorming or implementation. If asked to fix the issues you find,
finish the review first, then switch to the appropriate implementation workflow.

## Review procedure

1. Establish the review target: base/head commits, branch diff, PR, patch, or files changed.
2. Read the stated requirements and identify the real contract being changed.
3. Inspect the changed code and the surrounding code it depends on. Do not judge from the diff
   alone when behavior depends on nearby helpers, schemas, routes, or tests.
4. Check the high-risk surfaces:
   - correctness and edge cases
   - security, authorization, secret handling, and untrusted input
   - data loss, migrations, env vars, and backwards compatibility
   - product behavior, UX states, and API contracts
   - test coverage and whether tests prove the changed behavior
   - maintainability, ownership boundaries, and consistency with local patterns
5. Verify when practical with tests, typecheck, build, or a focused command. If you cannot verify,
   name the gap.
6. Produce findings first, ordered by severity. Do not lead with praise or a summary.

## Severity

- **Critical** - Must fix before merge. Security issue, data loss, broken core flow, invalid
  migration, auth bypass, or behavior that can corrupt user/company state.
- **Important** - Should fix before merge. Incorrect edge case, missing validation, contract
  mismatch, incomplete test coverage for risky behavior, or maintainability issue likely to cause
  real defects.
- **Minor** - Optional cleanup. Small readability, naming, or local consistency issues that do not
  affect correctness.

Style-only feedback belongs in Minor unless it hides a real correctness or maintenance problem.

## Output format

Start with findings. Use this shape:

\`\`\`
Findings
- Critical: path/to/file.ts:123 - Description of the bug, why it matters, and the concrete fix.
- Important: path/to/file.ts:45 - Description...

Open questions
- Anything that blocks a confident review.

Verification
- Commands or checks run, or "Not run" with the reason.

Merge assessment
- Blocked, risky, or ready.
\`\`\`

If there are no findings, say so plainly and still report verification and residual risk. Do not
invent issues. Do not rubber-stamp unverified behavior as safe.
`;
}

const CTO_PR_REVIEW_SKILL_MD = buildCtoPrReviewSkillMd();

export const IMPLEMENTER_SKILL_ID = "implementer";

function buildImplementerSkillMd(): string {
  return `---
name: implementer
description: Implement software changes like a strong SWE: read context first, use TDD when practical, keep the diff narrow, match local patterns, verify behavior, and review your own work before finishing.
---

# Implementer

Implement the requested software change with senior-engineer discipline. The goal is a correct,
reviewable diff that fits the codebase and is proven by the lightest meaningful verification.

## Work loop

1. Read the relevant code, tests, docs, and local conventions before editing.
2. State the real contract being changed: inputs, outputs, persisted data, UI behavior, or runtime
   side effects.
3. Choose the narrowest implementation that satisfies that contract. Prefer existing helpers,
   patterns, components, and test styles.
4. For behavior changes, use TDD when practical:
   - Write or update one focused test first.
   - Run it and verify it fails for the expected reason.
   - Implement the minimal code needed to pass.
   - Run it again and verify it passes.
   - Refactor only while keeping the test green.
5. For changes where TDD is not practical, name why and use the smallest verification that proves
   the behavior.
6. Update docs, env examples, migrations, or generated artifacts only when the changed contract
   requires it.
7. Review your own diff before finishing.

## Engineering rules

- Keep scope tight. Do not bundle unrelated cleanup or broad refactors.
- Treat external input as hostile and validate at boundaries.
- Do not silently swallow errors. Surface them, handle them, or make invalid state impossible.
- Do not add new dependencies, feature flags, retries, or abstractions unless the current task
  clearly needs them.
- Preserve user changes in the worktree. Work with existing edits; do not revert unrelated files.
- For UI work, include loading, empty, error, and slow states when the flow needs them.

## Self-review checklist

Before declaring the work done, check:

- Does the diff match the requested behavior and no more?
- Are tests meaningful, and did at least one relevant failing test fail before implementation when
  TDD was practical?
- Did the right verification commands run cleanly?
- Could this break auth, billing, persistence, migrations, env/config, external APIs, or user
  data?
- Are docs and examples still honest?
- Is the final answer explicit about what changed, what was verified, and what remains unverified?

## Final report

Keep the close-out short:

- What changed.
- Verification run.
- Anything not verified and why.

Do not claim a check passed unless you ran it. Do not leave the user with a vague "should work."
`;
}

const IMPLEMENTER_SKILL_MD = buildImplementerSkillMd();

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
  {
    id: SKILL_CREATOR_SKILL_ID,
    name: "Create a personal skill",
    description:
      "Create or improve your own personal skills — save a reusable procedure as agent/skills/<id>/SKILL.md to load on demand later. Use when you spot a repeatable workflow worth keeping, or are asked to make or remember a skill.",
    defaultEnabled: true,
    files: [{ path: "SKILL.md", content: SKILL_CREATOR_SKILL_MD }],
  },
  {
    id: ONBOARDING_SKILL_ID,
    name: "First-session onboarding",
    description:
      "First-session onboarding for a brand-new user — turn their self-introduction into a personal, useful first interaction and seed memory. Only for the very first session; ignore in normal sessions.",
    // Opt-in: enabled on the personal agent's config and invoked by the onboarding session's
    // seeded pointer. Dormant (never read) in normal sessions.
    defaultEnabled: false,
    files: [{ path: "SKILL.md", content: ONBOARDING_SKILL_MD }],
  },
  {
    id: FIRST_PRINCIPLES_SKILL_ID,
    name: "First-principles thinking",
    description:
      "Break a hard problem down to fundamental truths and rebuild the solution from scratch — a 15-prompt framework for stuck or high-stakes decisions where the conventional approach isn't working.",
    // Offered, not default-on: surfaced in the @-mention menu and self-addable, so any agent
    // (company or personal) can turn it on per-agent without it loading in every session.
    defaultEnabled: false,
    addable: true,
    files: [{ path: "SKILL.md", content: FIRST_PRINCIPLES_SKILL_MD }],
  },
  {
    id: HUMANIZER_SKILL_ID,
    name: "Humanizer",
    description:
      "Make writing sound human — strip the telltale patterns of AI-generated text (significance inflation, promotional gloss, -ing add-ons, rule-of-three, em-dash overuse) and give prose a real voice. Use whenever writing or editing text a person will read.",
    // Offered, not default-on — same model as first-principles. The personal agent scaffold
    // enables it by default via an @skill/humanizer body mention.
    defaultEnabled: false,
    addable: true,
    files: [{ path: "SKILL.md", content: HUMANIZER_SKILL_MD }],
  },
  {
    id: Y_COMBINATOR_KNOWLEDGE_SKILL_ID,
    name: "Y Combinator knowledge",
    description:
      "Be a high-leverage YC-style startup sparring partner — use public YC/PG startup teachings for founder office hours, strategy, MVP scope, users, growth, fundraising, hiring, and prioritization.",
    // Offered, not default-on: most useful for founder, product, growth, fundraising, and
    // company-strategy agents, but too domain-specific to load in every session.
    defaultEnabled: false,
    addable: true,
    files: [{ path: "SKILL.md", content: Y_COMBINATOR_KNOWLEDGE_SKILL_MD }],
  },
  {
    id: MOVE_TO_OPENCOMPANY_SKILL_ID,
    name: "Import a knowledge base",
    description:
      "Import an external knowledge base (a GitHub repo or folders/files) into the Brain safely — stage in work/, preview, confirm, commit to personal-brain/, and report a receipt (imported N, skipped M, lost 0). Use when migrating notes, docs, or a wiki into OpenCompany.",
    // Offered, not default-on: only relevant during a one-time migration, so it would be noise in
    // every session. The durability layer (PRO-244 version backup) makes its overwrites safe.
    defaultEnabled: false,
    addable: true,
    files: [{ path: "SKILL.md", content: MOVE_TO_OPENCOMPANY_SKILL_MD }],
  },
  {
    id: CTO_PR_REVIEW_SKILL_ID,
    name: "CTO PR review",
    description:
      "Review pull requests and diffs as a blocking CTO-level technical reviewer — findings first by severity across correctness, architecture, security, migrations, tests, and product risk.",
    defaultEnabled: false,
    addable: true,
    files: [{ path: "SKILL.md", content: CTO_PR_REVIEW_SKILL_MD }],
  },
  {
    id: IMPLEMENTER_SKILL_ID,
    name: "Implementer",
    description:
      "Implement software changes like a strong SWE — read context first, test behavior when practical, keep the diff narrow, match local patterns, verify, and review your own work.",
    defaultEnabled: false,
    addable: true,
    files: [{ path: "SKILL.md", content: IMPLEMENTER_SKILL_MD }],
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

// Metadata for an enabled skill, without file contents. Built-in files live in code; external
// files live in the snapshot DB; personal files live in the agent's bundle (agent_files). All are
// loaded by the runner. `provenance` only applies to personal skills (who authored them) and feeds
// future curation; it is absent for built-in/external skills.
export type ResolvedSkillMetadata = {
  id: string;
  name: string;
  description: string;
  command?: string;
  origin: "builtin" | "external" | "personal" | "workspace";
  source?: AgentSkillSource;
  provenance?: "agent" | "user";
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
      const origin = reference.source.type === "workspace" ? "workspace" : "external";
      out.push({
        id: reference.id,
        name: reference.name,
        description: reference.description,
        origin,
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

// Built-in skills the agent editor offers in its @-mention menu and that agents can self-add:
// the `addable` catalog members (always `defaultEnabled: false`). Metadata only — no file
// contents — so callers (incl. the web client) never pull the inline SKILL.md strings.
export function listAddableBuiltinSkills(): ResolvedSkillMetadata[] {
  return AGENT_SKILL_CATALOG.filter((skill) => skill.addable).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    origin: "builtin" as const,
  }));
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

export function workspaceSkillSourcePath(id: string): AgentWorkspaceSkillSource["path"] {
  return `skills/${id}`;
}

export function serializeSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
  const frontmatter = stringifyYaml(
    {
      name,
      description,
    },
    { lineWidth: 0 },
  ).trimEnd();

  return ["---", frontmatter, "---", "", body].join("\n");
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
  if (type === "workspace") {
    const path = typeof sourceRecord.path === "string" ? sourceRecord.path.trim() : "";
    if (path !== workspaceSkillSourcePath(id)) return null;
    return {
      id,
      name,
      description,
      source: { type, path },
    };
  }

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

// Personal skills are procedural playbooks the agent writes for itself. They live as ordinary
// files in the agent's private bundle under `<bundleDir>/skills/<id>/SKILL.md` (+ supporting
// files) and are auto-discovered each session — never listed in `skills:` frontmatter, which is
// reserved for built-in and external skills. The cap keeps the always-injected ## Skills index
// lean even if the agent accumulates many over time; skills beyond it are simply not surfaced.
export const MAX_PERSONAL_SKILLS = 16;

// One discovered personal skill: its catalog metadata plus the folder's files (relative to the
// skill directory, e.g. "SKILL.md", "references/x.md") ready to materialize into the read-only mount.
export type PersonalSkill = {
  metadata: ResolvedSkillMetadata;
  files: AgentSkillFile[];
};

export type PersonalSkillScanResult = {
  skills: PersonalSkill[];
  // Human-readable reasons a candidate folder was skipped (malformed frontmatter, bad id, collision,
  // validation failure, cap). The runner logs these; the files themselves still persist as bundle files.
  warnings: string[];
};

// SKILL.md frontmatter for a personal skill. Like the external-skill parser it requires `name` and
// `description`, and additionally reads the optional `provenance` marker (agent- vs user-authored).
function parsePersonalSkillFrontmatter(
  content: string,
): { name: string; description: string; command?: string; provenance?: "agent" | "user" } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return null;
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(normalized.slice(4, end));
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const record = frontmatter as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name || !description) return null;
  const rawProvenance = typeof record.provenance === "string" ? record.provenance.trim() : "";
  const provenance =
    rawProvenance === "agent" || rawProvenance === "user" ? rawProvenance : undefined;
  const command = normalizeSkillCommand(record.command);
  return {
    name,
    description,
    ...(command ? { command } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

// Discover the agent's personal skills from its bundle files. Pure: no DB, no files, no network —
// the runner passes in the already-loaded bundle rows. `bundleFiles` are repo-relative paths
// (e.g. "agents/leo/skills/foo/SKILL.md"); `bundleDir` is the agent's bundle directory
// ("agents/leo"); `reservedIds` are ids already taken by built-in/external skills so a personal
// skill can never shadow one. Each candidate folder is validated (valid mount id, no collision,
// well-formed SKILL.md frontmatter, passes validateSkillFiles); failures are skipped with a warning
// rather than throwing, so one bad skill never blocks the rest or the session.
export function scanPersonalSkills(input: {
  bundleFiles: Array<{ path: string; content: string }>;
  bundleDir: string;
  reservedIds?: Iterable<string>;
}): PersonalSkillScanResult {
  const skillsPrefix = `${input.bundleDir}/skills/`;
  const reserved = new Set(input.reservedIds ?? []);
  const warnings: string[] = [];

  // Group bundle files by skill id (the first path segment under skills/).
  const filesById = new Map<string, AgentSkillFile[]>();
  for (const file of input.bundleFiles) {
    if (!file.path.startsWith(skillsPrefix)) continue;
    const rest = file.path.slice(skillsPrefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue; // a file directly under skills/ with no skill folder — ignore
    const id = rest.slice(0, slash);
    const relative = rest.slice(slash + 1);
    if (!relative) continue;
    const list = filesById.get(id);
    if (list) list.push({ path: relative, content: file.content });
    else filesById.set(id, [{ path: relative, content: file.content }]);
  }

  const skills: PersonalSkill[] = [];
  for (const id of [...filesById.keys()].sort()) {
    if (skills.length >= MAX_PERSONAL_SKILLS) {
      warnings.push(
        `Personal skill "${id}" omitted: exceeds the ${MAX_PERSONAL_SKILLS}-skill cap.`,
      );
      continue;
    }
    if (!isValidSkillMountId(id)) {
      warnings.push(`Personal skill "${id}" skipped: not a valid skill id.`);
      continue;
    }
    if (isKnownAgentSkillId(id) || reserved.has(id)) {
      warnings.push(
        `Personal skill "${id}" skipped: id collides with a built-in or external skill.`,
      );
      continue;
    }
    const files = filesById.get(id)!;
    const validationError = validateSkillFiles(files);
    if (validationError) {
      warnings.push(`Personal skill "${id}" skipped: ${validationError}`);
      continue;
    }
    const skillMd = files.find((file) => file.path === "SKILL.md")!; // guaranteed by validateSkillFiles
    const parsed = parsePersonalSkillFrontmatter(skillMd.content);
    if (!parsed) {
      warnings.push(
        `Personal skill "${id}" skipped: SKILL.md needs valid frontmatter with name and description.`,
      );
      continue;
    }
    skills.push({
      metadata: {
        id,
        name: parsed.name,
        description: parsed.description,
        ...(parsed.command ? { command: parsed.command } : {}),
        origin: "personal",
        ...(parsed.provenance ? { provenance: parsed.provenance } : {}),
      },
      files,
    });
  }

  return { skills, warnings };
}
