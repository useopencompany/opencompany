# QM Scope-Centric Agent Architecture Research

Status: external architecture research

Date: 2026-08-05

Source snapshot: [`yc-software/qm` at `866764ed6ea34acc2d444d2e38e98cb7f7a9070f`](https://github.com/yc-software/qm/tree/866764ed6ea34acc2d444d2e38e98cb7f7a9070f)

## Research Question

Does QM model its product around durable, user-defined agents, or around tasks
without a person/agent entity?

The answer is neither exactly. QM is **scope-centric**:

- Human principals are durable entities.
- Personal, channel, group, team, and organization scopes are durable resource
  boundaries.
- Conversations resolve to one of those scopes.
- Sessions and runs represent work inside a scope.
- Tasks mostly project temporary subagent activity from the selected harness.
- There is no persistent, user-managed `Agent` domain entity comparable to an
  OpenCompany `.agent` file.

QM's product language sometimes says "personal agent" or "channel agent," but
the implementation is one shared company core operating with different scoped
memory, files, instructions, credentials, permissions, and sandbox state. Its
own shared prompt says that one core serves the organization while each
conversation is isolated. Sources: [product overview](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/README.md#L7-L31),
[shared-core prompt](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/resolution/protocols/shared-core.md#L1-L8).

## Executive Model

```text
Human principal
  -> conversation
  -> resolved scope
  -> session
  -> run through a selected harness/model
  -> optional temporary subagent tasks
```

The core concepts are:

| Concept | Durable | Meaning |
| --- | --- | --- |
| Principal | Yes | A human identity, classified as internal or guest, with optional team memberships. |
| Scope | Yes | The ownership and isolation boundary: `personal`, `channel`, `group`, `team`, or `org`. |
| Conversation | Request context | A DM, Slack channel, group conversation, or project context with an audience. |
| Session | Yes | Conversation history inside a scope. A channel may have many thread sessions sharing one channel scope. |
| Run | Yes | One execution attempt within a session, using a chosen model and harness. |
| Task | Yes, as activity history | A small status record for bounded work, usually reflecting a harness-native subagent. |
| Agent definition | No | There is no durable `Agent` record, agent id, agent configuration CRUD surface, or agent roster in the inspected revision. |

The source type model defines principals, scope kinds, conversations, and
sessions directly. Sessions carry both a `scopeId` and a `threadRef`, which is
the key distinction between shared resource context and individual conversation
history. Source: [core types](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/types.ts#L3-L83).

The negative `Agent` finding came from inspecting the source tree, stores,
routes, schema creation, and harness adapters at the pinned revision. It should
be re-checked if QM later adds managed agents.

## Scope Resolution

QM derives the resource scope from the conversation:

- A DM becomes `personal:<actor id>`.
- A group conversation becomes `group:<conversation ref>`.
- A channel becomes `channel:<channel ref>`.

It then builds a layered workspace with the organization mounted read-only and
the current conversation scope mounted read-write. In a personal DM, the
actor's team scopes are also mounted read-only. Source: [resolution service](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/resolution/resolution-service.ts#L15-L45).

This means the apparent "agent" changes because its resolved environment
changes, not because the system selected a different durable agent object. The
selected harness can also change without changing this model: Pi, OpenCode,
Codex, and Claude Code all drive the same core and scoped resources. Source:
[architecture overview](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/README.md#L44-L78).

## Isolated Memory

### Storage model

Memory is conceptually a Markdown notebook named `memory/MEMORY.md`. The
production Postgres implementation stores complete notebook revisions in a
`memory_revisions` table keyed by `scope_id` and sequence number. It preserves
operation, author, timestamp, and body, and uses a per-scope advisory lock when
appending or replacing a revision. Sources: [memory service contract and
notebook behavior](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/memory-service.ts#L6-L45),
[Postgres memory schema and locking](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/postgres-memory-service.ts#L4-L94).

Captured facts are normalized into dated Markdown bullets, deduplicated by
normalized text, and capped at 300 facts. The simple query path requires every
search term to occur in a bullet; this is not an embedding or vector retrieval
system. Source: [capture and query behavior](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/memory-service.ts#L47-L100).

### Capture model

By default, a one-shot model reviews the user input and assistant reply after a
turn and extracts durable facts. The extraction prompt includes preferences,
identifiers, responsibilities, and ongoing work, while excluding secrets,
credentials, one-off trivia, and second-hand claims about people who did not
speak. A separate agent-only strategy can disable automatic capture and make
the running core curate memory explicitly. Source: [per-turn extraction](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/strategies/per-turn.ts#L10-L58),
[capture flow](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/strategies/per-turn.ts#L125-L158).

QM periodically asks a model to consolidate the notebook by updating,
deduplicating, or deleting stale facts while retaining explicit user-requested
memories and provenance. The Postgres revision history supports inspecting and
restoring earlier notebook versions. Sources: [consolidation rules](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/strategies/consolidation.ts#L18-L53),
[history and restore](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/postgres-memory-service.ts#L128-L164).

### Read and write boundaries

The default policy is to write only to the current writable scope and recall
from all visible workspace layers. In practice:

- A personal DM writes personal memory and can recall personal, team, and
  organization memory.
- A channel writes channel memory and can recall channel and organization
  memory.
- A channel does not automatically recall a participant's personal notebook.

Source: [memory policy](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/policy.ts#L3-L34),
[orchestrator recall construction](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/core/orchestrator.ts#L750-L771).

There is one deliberate cross-scope behavior: after a human speaks in a channel
or group, extracted durable facts can also be copied into that speaker's
personal memory with a `(said in ...)` provenance suffix. The shared
conversation still does not gain access to the person's existing personal
memory. Source: [channel/group copy-to-personal behavior](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/memory/memory-service.ts#L154-L184).

### Security interpretation

The isolation is primarily an application-enforced namespace and authorization
boundary:

- Memory rows are selected by exact `scope_id`.
- The orchestrator computes an explicit read list and optional write scope.
- Memory tool operations use those claims rather than accepting an arbitrary
  scope from the model.

The inspected `memory_revisions` schema does not add Postgres row-level security
or per-scope encryption, and its body is stored as `TEXT`. Memory isolation is
therefore not the same kind of boundary as encrypted credential storage. It
depends on the core, capability checks, and membership resolution being correct.

## Credentials and Keychain

In QM, "credentials" covers several forms of authority:

- Personal API tokens exposed as environment variables.
- Bundles of environment-variable fields.
- Credential files such as AWS, GitHub CLI, gcloud, netrc, or SSH state.
- OAuth access and refresh tokens for connected apps.
- Durable login state in a scope's sandbox.
- Organization-owned service credentials used through a broker or, when
  configured, direct environment injection.

The product intent is that the core acts as the person it is serving, using
their permissions and credentials, with audited operations. Source: [security
overview](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/README.md#L80-L95).

### Storage and ownership

A keychain credential records an `ownerId`, service, kind, encrypted secret,
fingerprint, origin, and optional expiry. OAuth connector records also retain
encrypted refresh-token material and account metadata. Grants are separate
records that bind one credential to an `audienceScopeId`, with a purpose,
`once` or `standing` mode, status, timestamps, and optional expiry. Source:
[credential and grant model](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/credentials/keychain.ts#L42-L115).

Secrets are encrypted at rest using AES-256-GCM with a random IV and an
HKDF-derived key. Source: [secret encryption](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/connectors/connector-client-store.ts#L55-L95).

### Personal use and shared grants

On a normal personal-scope turn, the orchestrator can materialize the actor's
own environment credentials and connected-app tokens. In other scopes, those
personal credentials are not inherited automatically. A shared scope receives
only its standing grants, plus separately authorized organization credentials.
Source: [turn-time credential selection](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/core/orchestrator.ts#L940-L985).

The keychain enforces that:

- Only the owner can grant a personal credential.
- Every grant names the target conversation scope and records a purpose.
- A one-time grant is atomically marked used.
- A grant cannot be materialized from another scope.
- Loading a credential directly by id works only in its owner's personal
  conversation; every other context requires a grant.

Sources: [grant creation and one-time use](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/credentials/keychain.ts#L820-L864),
[scope-bound materialization](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/credentials/keychain.ts#L1180-L1219).

Channel participants can request a teammate's credential. The owner receives an
ask and must approve or decline it on their own live turn; consent is not
accepted from relayed statements or autonomous triggers. Alternatively, a
channel agent can request a task from the person's "personal agent." Approval
causes QM to run a normal DM-scoped turn as that person with their personal
setup, then return the result to the channel. This is scoped execution and
consent, not communication between two durable agent entities. Sources:
[keychain ask route](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/api/routes/keychain.ts#L244-L340),
[personal-agent Slack flow](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/slack/README.md#L135-L144).

### Organization credential broker

Organization service credentials can be configured for brokered delivery. The
running sandbox receives an hour-lived signed capability listing the credential
slugs available to that scope, not the raw secrets. The broker verifies the
entitlement, requires HTTPS, pins the destination host, restricts HTTP methods
and path prefixes, strips arbitrary caller headers, and injects the secret
server-side. Sources: [broker capability issuance](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/core/orchestrator.ts#L1085-L1140),
[broker enforcement](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/api/credential-broker.ts#L128-L171),
[one-hour capability lifetime](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/auth/capability-token.ts#L1-L7).

Broker delivery is the strongest design because the model and sandbox do not
need the raw organization secret. It is not universal: an organization
credential can also be configured for direct environment delivery, and
personal credentials are decrypted and materialized as environment variables
or temporary files when used. Sources: [direct environment delivery](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/core/orchestrator.ts#L990-L1012),
[temporary file materialization](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/credentials/keychain.ts#L1279-L1312).

### Sandbox login state

Each writable scope also gets a durable sandbox computer. Known authentication
paths such as `.aws`, `.config/gh`, `.config/gcloud`, `.ssh`, `.netrc`, and
`.git-credentials` are treated specially so login state survives for that
scope. Scratch sandboxes are explicitly credential-free and wiped when
released. Sources: [resident credential paths](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/credentials/resident-paths.ts#L1-L73),
[credential-free scratch boxes](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/sandbox/sprites-sandbox.ts#L408-L424).

## What Channels Are

In the current product, a channel is primarily a Slack room such as
`#engineering` or `#launch`. It is not an agent definition.

The channel id becomes a shared `channel:<Slack channel id>` resource scope.
Each Slack thread receives its own `threadRef` and session, but all threads in
the same Slack channel resolve to the same channel scope. Therefore they share
channel memory, files, skills, sandbox state, policies, crons, and authorized
credentials while keeping separate transcript histories.

```text
#launch -> channel:C123 (shared resources)
  |- thread A -> session ch:C123:<root A>
  |- thread B -> session ch:C123:<root B>
  `- thread C -> session ch:C123:<root C>
```

Slack DMs instead resolve to a personal scope and use one continuous session
per DM channel. Multi-person DMs resolve to group scopes. Web projects also use
group scopes, so `group` is broader than only Slack group DMs. Sources:
[Slack thread and scope construction](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/slack/turn-handler.ts#L226-L243),
[Slack-to-core session mapping](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/slack/README.md#L208-L219),
[web project group scopes](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/projects/project-store.ts#L9-L58).

Membership matters because the conversation audience feeds policy, egress, and
resource authorization. Private channels use verified membership, and
externally shared or guest-containing conversations are deliberately restricted
rather than silently inheriting internal access. Source: [Slack audience
restrictions](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/slack/README.md#L135-L146).

## Tasks and Subagents

QM does persist task records, but their model is deliberately small: id,
session id, origin run id, title, status, and timestamps. A task has no agent
id, assignee, persona, memory owner, credential owner, or independent lifecycle.
Source: [task model](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/tasks/task-store.ts#L1-L52).

The harness adapters turn provider-native subagent events into these task rows:

- Codex `spawnAgent` collaboration calls become tasks tied to the parent
  session and run.
- OpenCode `task` tool events become tasks.
- Claude exposes fixed child roles named `research`, `code`, and `consult` for
  bounded delegation.

Sources: [Codex task projection](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/harness/codex-harness.ts#L363-L420),
[OpenCode task projection](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/harness/opencode-harness.ts#L501-L551),
[Claude child roles](https://github.com/yc-software/qm/blob/866764ed6ea34acc2d444d2e38e98cb7f7a9070f/src/harness/claude-harness.ts#L326-L349).

These are ephemeral runtime workers represented as inspectable activity, not
user-managed coworkers. Tasks are therefore downstream of scope, session, run,
and harness execution; they are not QM's primary organizing entity.

## Comparison With OpenCompany

OpenCompany currently makes the agent definition explicit and durable. Its
`.agent` file owns the agent's name, instructions, engine, model, tools, Brain
mounts, skills, integrations, and references to other agents. See the local
[`.agent` format](../agent-file.md).

The contrast is:

| OpenCompany today | QM |
| --- | --- |
| Durable, versionable agent definition | One shared core with scope-specific context |
| Agent identity is explicit | Human and conversation identity are explicit |
| Agent-to-agent references and child sessions | Harness-native temporary subagents and DM-scoped personal execution |
| Agent-selected Brain mounts and tools | Scope-owned memory, files, sandbox, skills, policy, and credentials |
| Session belongs to a selected agent | Session belongs to a resolved scope and thread |

The most reusable lesson is that **agent definition and execution context are
separate axes**. OpenCompany does not need to remove its durable agent entity to
adopt the useful parts of QM's approach.

A possible hybrid model would preserve:

```text
AgentDefinition
  x ContextScope (personal, channel, project, team, organization)
  -> ConversationSession
  -> Run
  -> Tasks / delegated child sessions
```

That would allow one explicit OpenCompany agent to work in multiple contexts
without confusing the agent's identity with ownership of memory, files, or
credentials. It would also allow a shared channel context to choose or switch
agents without losing the channel's durable resources.

## Useful Design Lessons for OpenCompany

1. **Make context ownership explicit.** Memory, files, sandbox state, and
   credentials do not necessarily belong to an agent. They may belong to a
   person, channel, project, team, or workspace.
2. **Separate session history from shared context.** QM's channel threads have
   separate transcripts while sharing one channel resource scope. This is a
   clean model for long-lived collaborative rooms.
3. **Use capability intersections for shared work.** A channel run should have
   the rights of the current context and verified audience, not whichever
   participant happens to invoke it.
4. **Treat personal credentials as grants, not ambient channel state.** Explicit
   once/standing grants and owner-only consent are stronger than copying a
   user's personal environment into a shared agent.
5. **Broker organization secrets where practical.** Host-, method-, and
   path-bound proxy calls keep raw shared secrets out of the model sandbox.
6. **Keep task records operational.** QM avoids turning every temporary worker
   into a permanent agent. OpenCompany can keep durable agent definitions while
   still treating one-off subagent executions as tasks or child sessions.
7. **Preserve provenance on cross-context memory.** QM's copy-to-personal rule
   is useful, but any cross-scope capture needs a visible source and a way to
   correct or delete it.

## Questions to Revisit Before Borrowing the Model

- Should OpenCompany memory attach to an agent, a person, a context, or some
  explicit combination?
- If several agents work in one channel, which memories and files are shared,
  and which remain agent-specific?
- Does a delegated agent run with the caller's context, its own context, or the
  intersection of both?
- Should a channel retain its sandbox and credentials when its selected agent
  changes?
- Which boundaries need application authorization, database row-level
  security, encryption, or all three?
- Should facts learned in a shared context be copied into personal memory
  automatically, suggested for approval, or never copied?
- Can organization credentials always use a broker, or do some tools require
  controlled direct materialization?

## Bottom Line

QM is best described as **one company brain, many isolated context scopes, and
temporary task workers**.

It has first-class people, conversations, sessions, scopes, and tasks, but no
first-class persistent software-agent entity. Its strongest ideas for
OpenCompany are the separation of session history from shared context, scoped
resource ownership, explicit credential grants, and brokered organization
secrets. Those ideas are compatible with retaining OpenCompany's explicit,
versioned `.agent` definitions.
