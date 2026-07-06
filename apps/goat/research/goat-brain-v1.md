# Goat Brain v1 Best-Practice Scope

Status: research proposal for discussion.

This document defines the ideal Goat Brain v1 target we should discuss before implementation. It is
not a description of the current code. The goal is to agree on the product and technical contract
for a durable, trustworthy, agent-readable brain that Goat can use across chat, tasks, research, and
connected-account workflows.

Reference inputs:

- `apps/goat/research/gbrain-deep-dive.md`
- `apps/web/lib/personal/brain.ts`
- `apps/web/lib/personal/memory.ts`
- `packages/memory/README.md`
- `packages/memory/src/schema.ts`
- `packages/memory/src/document.ts`
- `packages/memory/src/validate.ts`
- `packages/memory/src/store.ts`
- `apps/runner/src/memory-tool.ts`

## North Star

Goat Brain should be the user's durable private knowledge layer for everything Goat learns, creates,
imports, and needs to reason over later. It should feel like a small personal operating system:
structured enough for reliable agent use, readable enough for humans, and auditable enough that a
user can trust where a claim came from.

The core promise:

> Goat remembers important knowledge as cited, structured Markdown; retrieves it with hybrid search
> plus graph traversal; and keeps agent-maintained memory separate from user-owned knowledge.

## Design Principles

1. **Markdown is the source of truth.** Brain records are plain Markdown with frontmatter, stable ids,
   wikilinks, and a predictable body shape. Database rows and indexes are projections.
2. **Evidence before truth.** Important claims need provenance. The system can hold draft knowledge,
   but established compiled truth must cite evidence.
3. **Compiled truth plus timeline.** Each durable entity has a current synthesis above an append-only
   evidence trail. Users and agents should not have to reread the whole history to know the current
   state.
4. **Typed but not overtyped.** The schema should be small, MECE at the directory level, and governed
   against type sprawl. Subtypes usually belong in frontmatter, not in new directories.
5. **Graph first where cheap.** Wikilinks and typed relationships should create edges without LLM
   calls. Relational questions should not depend only on vector search.
6. **Layer separation is a hard contract.** User knowledge, agent operational memory, and session
   context are different things and must not collapse into one store.
7. **Every write has a reason.** Brain mutations should be attributable to a user action, task,
   import, integration event, correction, or explicit agent proposal.
8. **Retrieval should be inspectable.** The model should receive snippets with ids, paths, relation
   context, and citation hints so answers can say why a record was relevant.

## Information Layers

Goat should use three explicit information layers.

### 1. Brain: user-owned knowledge

This is the durable knowledge base. It stores people, companies, projects, decisions, research,
references, meetings, conversations, docs, and original user ideas. It is user-private by default
and should be editable through Goat's Brain UI.

The Brain answers: "What does the user know about the world, their work, and their own artifacts?"

### 2. Memory: agent-maintained operational understanding

This is the agent's distilled memory about how to serve the user: preferences, recurring behavior,
communication style, durable instructions, past corrections, and workflow habits. It should be
tool-managed, cited, and visible read-only unless we intentionally add an editing surface.

The Memory answers: "How should Goat behave for this user?"

Memory should reuse the personal agent model's strongest contracts:

- canonical objects versus immutable evidence
- `draft`, `active`, `deprecated`, and `merged` lifecycle
- `## Compiled truth` plus `## Timeline`
- evidence citations of the form `[^ev:<evidence-id>]`
- CLI/tool-only writes from the runner
- root pinning so the model cannot use tool arguments to escape the memory tree

### 3. Session context: ephemeral conversation state

This is the current chat or task context window. It should not be persisted unless a write path
classifies it into Brain or Memory. Most conversation details should die here.

The session answers: "What is currently being discussed?"

## Brain Record Model

Every Brain record should have a stable logical path and a stable id. The path is for humans and
schema routing. The id is for merges, aliases, citations, and graph edges.

Recommended body shape:

```markdown
---
id: alice-example
type: person
status: active
created_at: 2026-07-06T12:00:00Z
updated_at: 2026-07-06T12:00:00Z
aliases:
  - Alice E.
source_ids: []
related:
  - type: works_at
    target: acme-ai
---

# Alice Example

## Compiled truth

Current, rewritten synthesis. Claims that matter cite evidence.

<!-- TIMELINE:BELOW - append only past this marker -->

## Timeline

### 2026-07-06T12:00:00Z

- Source: gmail/thread/abc123
- Summary: First meaningful evidence entry.
```

Important distinctions:

- **Canonical records** are the current view of one thing: person, company, project, decision,
  concept, topic, customer, vendor, place, or similar.
- **Evidence records** are immutable source artifacts: meeting, conversation, email, document,
  research run, import, correction, or integration event.
- **Reports** are authored deliverables. They can cite evidence and link to canonical records, but
  should not silently become canonical truth.

## Proposed v1 Directory Taxonomy

The v1 taxonomy should start smaller than a typical human would want. We should add new first-class
types only after repeated use proves they deserve schema behavior.

Recommended v1 folders:

- `inbox/` - unresolved or unclassified material. Inbox volume is a schema signal, not a dumping
  ground.
- `people/` - humans.
- `companies/` - companies, organizations, funds, institutions.
- `projects/` - ongoing initiatives owned or tracked by the user.
- `decisions/` - durable choices, tradeoffs, reversals, and rationale.
- `meetings/` - meeting evidence and meeting summaries.
- `conversations/` - chat, email, DM, and call evidence when not better filed as a meeting.
- `research/` - research runs, reports, technical investigations, market scans.
- `docs/` - imported or authored source documents.
- `concepts/` - reusable ideas, frameworks, terms, and mental models.
- `references/` - external sources that are useful primarily as sources.
- `daily/` - daily notes, periodic summaries, and dated rollups if we decide Goat needs them.

Potential later folders, not v1 defaults:

- `places/`
- `customers/`
- `vendors/`
- `products/`
- `tasks/`
- `finance/`

These should begin as frontmatter fields or subtypes unless they cross an agreed promotion
threshold.

## Resolver Contract

Goat Brain needs a machine-readable resolver, even if the first version is Markdown. The resolver is
the filing decision tree the agent reads before creating or moving records.

Suggested first-match rules:

1. If the item is a user preference, behavior correction, recurring instruction, or agent operating
   rule, it belongs in Memory, not Brain.
2. If the item is only relevant to the active conversation and has no durable future value, keep it
   in session.
3. If the item is evidence from a source system, create an evidence record and link it to any
   canonical subjects.
4. If the item is primarily about a human, file under `people/`.
5. If the item is primarily about an organization, file under `companies/`.
6. If the item is primarily about an ongoing user initiative, file under `projects/`.
7. If the item records a meaningful choice or rationale, file under `decisions/`.
8. If the item is a produced investigation or answer, file under `research/`.
9. If the item is a reusable abstraction, term, or framework, file under `concepts/`.
10. If no rule fits, file under `inbox/` and mark why classification failed.

Disambiguation rules:

- A person working at a company gets one person page and one company page, linked by `works_at`.
- A meeting involving a person does not move the person page into `meetings/`; it creates meeting
  evidence linked to the person.
- A research report about a company remains a report, then updates the company compiled truth only
  through a cited synthesis step.
- A user-authored idea belongs in Brain even if it is rough; an agent behavior preference belongs in
  Memory.

## Schema Pack

The taxonomy should eventually be described by a versioned schema pack, not hardcoded. The pack is
the contract between the UI, CLI, runner tools, retrieval, validation, and migrations.

Minimum useful fields:

```yaml
api_version: goat-brain-schema-pack-v1
name: goat-default
version: 0.1.0
types:
  - name: person
    primitive: entity
    path_prefixes: ["people/"]
    extractable: true
    expert_routing: true
  - name: research
    primitive: artifact
    path_prefixes: ["research/"]
    extractable: true
    expert_routing: false
relations:
  - name: mentions
  - name: works_at
  - name: founded
  - name: attended
  - name: about
  - name: cites
```

The v1 implementation can start with a static default pack, but the design should assume the pack is
loaded and consulted at write, validation, extraction, and retrieval time.

## Type Governance

We should explicitly prevent the "94 types" failure mode described in the GBrain research.

Proposed rule:

- Fewer than 20 records: do not create a first-class type. Use an existing type plus frontmatter.
- 20 to 100 records: consider an alias, subtype field, or dedicated resolver rule.
- More than 100 records with distinct retrieval/write behavior: consider a first-class type.

New first-class types should require:

- a directory or path prefix
- a resolver rule
- frontmatter fields
- relation vocabulary
- retrieval behavior
- migration plan from existing records
- examples of records that do and do not belong

## Identity, Aliases, And Merges

Goat Brain needs identity resolution from day one, even if the first version is simple.

Each canonical record should have:

- stable id
- title
- aliases
- external identifiers when known
- source references
- merge status
- redirect target when merged

Merging should be a pointer operation first and a synthesis operation second:

1. Mark the duplicate as `merged`.
2. Point it at the surviving id.
3. Preserve the duplicate title as an alias on the survivor.
4. Repoint evidence subjects and graph edges.
5. Ask an agent or user to re-synthesize compiled truth with valid citations.

The system should avoid large destructive file rewrites for ordinary deduplication.

## Evidence And Citation Contract

Evidence should be first-class. It is how Goat avoids turning model output into unsupported truth.

Evidence records should include:

- source kind: gmail, calendar, linear, github, browser, upload, chat, task, manual, import
- source ref: URL, external id, thread id, path, or opaque integration identifier
- captured timestamp
- actor or author when known
- subject ids
- raw excerpt or normalized summary
- optional raw sidecar for large or structured payloads

Compiled truth should cite evidence for factual claims that affect future behavior. Draft records can
hold uncited notes, but an `active` record should pass citation validation.

Corrections are evidence. A user saying "that's wrong, Alice no longer works there" should create a
correction evidence record and trigger a compiled-truth rewrite.

## Graph And Links

The first graph should be deterministic and cheap:

- Parse wikilinks and typed relations from Markdown/frontmatter.
- Create typed directional edges on every write.
- Remove stale edges when a record is rewritten and links disappear.
- Store enough provenance to explain where an edge came from.
- Support inbound, outbound, and multi-hop traversal.

Suggested relation vocabulary:

- `mentions`
- `about`
- `cites`
- `works_at`
- `founded`
- `invested_in`
- `advises`
- `attended`
- `owns`
- `depends_on`
- `decided_by`
- `supersedes`
- `related`

The relation vocabulary should be open enough for early use but validated as slug-shaped strings. If
particular relations become important to product behavior, they should move into the schema pack.

## Retrieval Scope

Goat Brain retrieval should combine multiple signals:

1. **Lexical search** for exact names, ids, identifiers, and phrases.
2. **Semantic/vector search** for paraphrase and conceptual similarity.
3. **Graph traversal** for relational questions.
4. **Recency and status weighting** so stale, merged, or deprecated records do not dominate.
5. **Type-aware routing** so "who knows X" and "what did we decide about X" use different ranking
   weights.

Retrieval output to the model should include:

- id
- path
- title
- type
- status
- matching snippet
- compiled-truth excerpt
- relation context
- citation/evidence hints
- `get` command or UI link for full context

Default retrieval should hide invalid records and merged redirect stubs, with explicit recovery
modes for debugging.

## Write Paths

Goat should support four write paths, each with clear authority.

### User-authored writes

The user creates, edits, moves, or deletes Brain Markdown directly in the UI. These writes should be
validated before save and indexed after save.

### Agent-proposed writes

An agent proposes a diff or new record. The user can accept, reject, or edit. This is the default
for high-impact canonical truth changes.

### Agent-automatic evidence writes

Trusted background tasks can append evidence records automatically when the user asked Goat to do
work that clearly produces durable evidence, such as a research run or imported meeting summary.

### Integration ingest writes

Connected systems can create evidence records through explicit import/sync flows. The ingestion
system should not silently rewrite canonical truth without a synthesis step.

## Synthesis Workflow

The ideal update flow:

1. Ingest or create evidence.
2. Identify canonical subjects.
3. Find existing records by id, alias, external id, and search.
4. Create draft canonical records only when no match exists.
5. Append evidence and graph links.
6. Propose or run compiled-truth rewrite.
7. Validate citations, links, frontmatter, and timeline shape.
8. Index records and edges.
9. Emit an audit event.

This keeps "what happened" separate from "what we now believe."

## Tooling Surface

Goat Brain should have a small tool/CLI surface that agents can use safely.

Core commands:

- `brain query`
- `brain get`
- `brain create`
- `brain rewrite`
- `brain append-evidence`
- `brain link`
- `brain merge`
- `brain move`
- `brain delete`
- `brain doctor`
- `brain schema show`
- `brain schema validate`

Important safety properties:

- Tool roots are pinned by the runner.
- Agent-controlled arguments cannot escape the Brain or Memory tree.
- Writes are atomic.
- Validation happens before persistence where possible.
- Tool output redacts secrets.
- Usage/cost for model-backed retrieval is metered separately from answer generation.

## Storage And Indexing

The product-facing source of truth should remain readable files or file-shaped records. Indexes are
derived.

Logical stores:

- Brain files: user-owned knowledge.
- Memory files: agent-owned operational understanding.
- Evidence sidecars: raw integration payloads too large or structured for Markdown.
- Entity registry: ids, aliases, external ids, merge state.
- Edge table: deterministic graph projection.
- Search indexes: lexical, vector, and metadata filters.
- Audit log: every meaningful write, import, merge, correction, and schema mutation.

The database can store these directly, but the contract should remain exportable to a Markdown tree.
The export should be good enough that a user could inspect, diff, and back up their Brain.

## UI Scope

The v1 UI should make trust and correction easy.

Needed surfaces:

- file tree or type-grouped browser
- Markdown editor for user-owned Brain records
- read-only Memory viewer
- record detail view with compiled truth and timeline
- evidence/citation display
- search view with type filters
- graph-linked "related" panel
- inbox triage queue
- proposed changes/diff review
- merge/alias management
- doctor/health warnings

The UI should not expose implementation complexity, but it should expose provenance. Users should be
able to answer: "Why does Goat believe this?"

## Background Jobs

Likely background jobs:

- index changed records
- extract deterministic links and edges
- run schema/doctor checks
- suggest inbox classifications
- detect duplicate entities
- synthesize compiled truth after evidence ingest
- generate daily or project rollups when enabled
- compact raw integration payloads into evidence summaries

Jobs should be idempotent and safe to rerun. Any job that changes canonical truth should either be
user-approved or leave an auditable proposal.

## Evaluation

We should build a small Goat Brain eval before relying on intuition.

Minimum v1 eval:

- synthetic corpus with people, companies, meetings, decisions, research reports, and corrections
- relational questions that require graph traversal
- exact-name questions that test alias handling
- contradiction/correction questions that test compiled truth versus stale evidence
- filing tests that exercise the resolver
- retrieval metrics such as precision@5 and recall@5

The eval should compare:

- lexical only
- vector only
- lexical plus vector
- lexical plus vector plus graph
- type-aware retrieval versus flat retrieval

## V1 Acceptance Criteria

Goat Brain v1 should be considered real when:

- Records have validated frontmatter, stable ids, and two-layer bodies.
- Brain, Memory, and session context are separate in product and tooling.
- Evidence records can be created and cited by compiled truth.
- Canonical records can be merged without losing aliases or evidence links.
- The resolver can classify new material into a primary home or inbox.
- Wikilinks or explicit relations create deterministic graph edges.
- Retrieval can return cited snippets with graph context.
- A user can inspect and correct why Goat believes something.
- A doctor command can find broken records, broken citations, bad links, duplicate ids, and invalid
  frontmatter.
- There is at least one eval showing the graph layer improves relational retrieval.

## Explicit Non-Goals For V1

- Fully autonomous schema evolution.
- Large domain-specific schema packs.
- Perfect entity resolution.
- Silent canonical truth rewriting from every integration event.
- Treating Goat Brain as a general document management system.
- Building a public/team-shared knowledge graph before private single-user semantics are solid.
- Optimizing for the current implementation's constraints at the expense of the ideal contract.

## Discussion Questions

These are the decisions we should make before implementation planning.

1. Should Goat Brain's first source of truth be Markdown files, database rows with Markdown content,
   or a hybrid that always exports to Markdown?
2. Should Brain and Memory share one underlying package with different schemas, or remain separate
   packages with shared primitives?
3. Which v1 folder list is the smallest useful taxonomy?
4. Should canonical compiled truth rewrites require user approval by default?
5. What evidence sources should be allowed to write automatically in v1?
6. Is `daily/` a first-class folder, or should daily summaries wait?
7. Do we want schema packs in v1, or just design the contracts so they can arrive cleanly in v2?
8. How strict should citation validation be for active Brain records?
9. How visible should Memory be in the Goat UI?
10. What is the first retrieval eval we want to trust?
