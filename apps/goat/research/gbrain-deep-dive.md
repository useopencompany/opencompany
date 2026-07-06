GBrain (garrytan/gbrain) Deep-Dive: Entity Organization, Schema Design, and Lessons for Our Second-Brain CLI

Executive Summary

GBrain is Garry Tan's (President & CEO of Y Combinator) open-source "agent brain" — a Postgres/pgvector-backed, Markdown-native knowledge system designed to give AI agents persistent, structured, self-organizing memory. It is not a note-taking app; it is closer to a personal knowledge graph + retrieval engine + operational discipline layer, built to run Tan's own production OpenClaw/Hermes agents (reported production scale: 146,646 pages, 24,585 people, 5,339 companies, 66 autonomous cron jobs) [README.md].

The most important structural ideas for our own second-brain CLI are:





A typed, MECE ("mutually exclusive, collectively exhaustive") directory taxonomy with a machine-readable decision tree (RESOLVER.md) that files every incoming item into exactly one home, with an explicit escape valve (inbox/) that is itself treated as a signal the schema needs to evolve [docs/GBRAIN_RECOMMENDED_SCHEMA.md].



A "schema pack" abstraction that turns page types, directory prefixes, link verbs, and extraction/routing rules into a dynamically-loaded, forkable, versionable manifest rather than hardcoded logic — letting the same engine serve a founder brain, a research brain, or a legal brain [docs/architecture/schema-packs.md].



Two-layer page anatomy (append-only "Timeline" of evidence below a continuously-rewritten "Compiled Truth" synthesis above) plus tiered enrichment (Tier 1/2/3) that scales research effort to an entity's importance [docs/GBRAIN_RECOMMENDED_SCHEMA.md; skills/enrich/SKILL.md].



A self-wiring, zero-LLM-call knowledge graph built from wikilink/typed-link extraction on every write, which is empirically responsible for the majority of GBrain's retrieval quality advantage over plain vector RAG (+31.4 points P@5) [README.md; docs/architecture/RETRIEVAL.md; docs/benchmarks/2026-04-18-brainbench-v1.md; garrytan/gbrain-evals].



A three-layer brain/memory/session model that strictly separates "what you know about the world" (GBrain) from "how the agent operates" (agent memory) from "what's in the current context window" (session), preventing information from landing in the wrong place [docs/guides/brain-vs-memory.md; docs/guides/repo-architecture.md].



A governance discipline against type proliferation — a real production brain (186K pages) organically grew 94 page types before being collapsed back to a 15-type canonical taxonomy, which is the single most useful cautionary lesson for our own "concepts/ideas/insights" categories [Issue #1479; docs/what-schemas-unlock.md].

Below is the full research trace with citations, followed by concrete recommendations mapped against our current inbox / decisions / insights / meetings / companies / people / projects / research / references / docs / ideas / concepts taxonomy.



1. docs/GBRAIN_RECOMMENDED_SCHEMA.md — The Recommended Schema

Title/framing: "Brain: The LLM-Maintained Knowledge Base" — described as "a system prompt for any AI agent that wants to build and maintain a personal knowledge base... this describes the pattern, the architecture, and the operational discipline that makes it work" (schema-version 0.5.0) [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

1.1 Directory structure

brain/
├── RESOLVER.md      — master decision tree for filing (agent reads this first)
├── schema.md        — page conventions, templates, workflows
├── index.md         — content catalog with one-line summaries
├── log.md           — chronological record of all ingests/updates
├── people/          — one page per human being (+ README.md resolver, .raw/ sidecars)
├── companies/        — one page per organization
├── meetings/        — records of specific events with transcripts
├── projects/        — things being built/managed
├── deals/, concepts/, sources/, daily/, personal/, civic/, original/,
│   place/, trip/, conversation/, writing/  — additional domains
└── inbox/           — catch-all for anything the schema can't yet classify

Every directory carries its own README.md "resolver" describing what belongs there and what doesn't [docs/GBRAIN_RECOMMENDED_SCHEMA.md]. These 13 extra directories (deal, meeting, concept, project, source, daily, personal, civic, original, place, trip, conversation, writing) plus the gbrain-base core are exactly what the bundled gbrain-recommended schema pack activates [docs/architecture/schema-packs.md].

Invariant stated explicitly: "one directory per knowledge domain, one file per entity, every directory has a resolver, and RESOLVER.md is the [decision tree]" [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

1.2 The classification / filing decision tree ("RESOLVER.md logic")

The doc's numbered sections lay out the operating model:

§1 — "Every Piece of Knowledge Has a Primary Home (MECE Directories)."





RESOLVER.md is a numbered, first-match-wins decision tree the agent walks when filing anything new.



When two directories could plausibly fit, disambiguation rules break the tie. Canonical example given: "Person vs. Company: Is it about them as a human? → people/. Is it about the organization? → companies/. Both link to each other." [docs/GBRAIN_RECOMMENDED_SCHEMA.md]



When nothing fits, the item goes in inbox/ — and this is explicitly framed not as a failure state but as "itself a signal the schema needs to evolve" [docs/GBRAIN_RECOMMENDED_SCHEMA.md]. This is a first-class design principle: an inbox overflow is a schema-authoring trigger, not a place to quietly accumulate debt.



Important nuance flagged in the doc: "MECE applies to directories, not to reality." A real person can be multi-faceted (e.g., a founder who is also a donor, media figure, hiring candidate). The resolver assigns one primary home for the page, and typed backlinks and cross-references surface the other facets without violating one-page-per-entity [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

§2 — Compiled Truth + Timeline (two-layer pages). Every entity page splits into:





Above the line — Compiled Truth: always current, rewritten (not appended) as new information arrives. Opens with a one-paragraph executive summary, followed by structured State fields, Open Threads (active items, removed when resolved), and See Also (cross-links). "If you read only this, you know the state of play." [docs/GBRAIN_RECOMMENDED_SCHEMA.md; docs/guides/compiled-truth.md]



Below the line — Timeline: append-only, reverse-chronological evidence log. Each entry: date, source, what happened. When an "Open Thread" resolves, it moves into the timeline with its resolution [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

This "always-current summary above / immutable audit trail below" split is the core anti-entropy mechanism: it prevents pages from becoming append-only logs that are expensive to re-read, while never destroying evidence.

§ (architecture concepts referenced in the same doc) — Entity registry & Event ledger:





Entity registry: a canonical ID + all aliases + all external IDs (LinkedIn member ID, X user ID, emails, phone numbers) in one table — "the single source of truth for 'is this the same person?'" Merging two entities becomes a database pointer operation, not a file-merge-and-fixup operation [docs/GBRAIN_RECOMMENDED_SCHEMA.md].



Event ledger: every signal touching the brain (meeting attended, email received, tweet published, enrichment completed, user correction applied) is recorded as an immutable event with provenance (source, timestamp, confidence) [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

§ — Frontmatter convention: "Use frontmatter for structured metadata" — anything queryable (role, company, stage, score, tags) goes in YAML frontmatter, not prose [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

1.3 Tiers of enrichment (Tier 1 / 2 / 3)

Enrichment effort is explicitly scaled to entity importance, defined consistently across GBRAIN_RECOMMENDED_SCHEMA.md, skills/enrich/SKILL.md, and docs/guides/enrichment-pipeline.md:

[skills/enrich/SKILL.md; docs/guides/enrichment-pipeline.md; docs/GBRAIN_RECOMMENDED_SCHEMA.md]

Enrichment triggers ("when do we even bother"): someone is mentioned in a meeting transcript → enrich; someone emails you → enrich; someone interacts with you on social media → enrich; a new contact appears → enrich [docs/GBRAIN_RECOMMENDED_SCHEMA.md].

1.4 The "brain state check" pipeline (CREATE vs. UPDATE)

The enrichment pipeline (documented in docs/guides/enrichment-pipeline.md, mirrored in skills/enrich/SKILL.md and third-party forks' GBRAIN_SKILLPACK.md) runs as a repeatable protocol on every inbound signal:





Identify entities from the incoming signal (people names, company names, associations) — extract_entities(signal).



Check brain state — for each entity: existing = gbrain search "{entity.name}". If found → UPDATE path (page = gbrain get <slug>); if not found → CREATE path.



Determine tier — classify importance to scale spend (Tier 1/2/3, above).



Data source lookups, in priority order: (a) brain cross-reference first (free, highest-value — always check what you already know before paying for an API call), then (b) web search/Perplexity/Brave/Exa, then (c) paid enrichment APIs, sending existing brain knowledge as context so external calls return only the delta (what's new) [skills/enrich/SKILL.md; docs/guides/enrichment-pipeline.md].



Extract signal/texture from the source material — not just facts but beliefs, motivations, trajectory.



Write compiled truth + timeline — rewrite the State section, append a dated timeline entry with a [Source: who, channel, timestamp] citation.



Cross-reference updates ("Iron Law" back-linking): "Every mention of a person or company with a brain page MUST create a back-link FROM that entity's page TO the page mentioning them. An unlinked mention is a broken brain" [skills/enrich/SKILL.md; docs/guides/entity-detection.md]. Format: - **YYYY-MM-DD** | Referenced in [page title](path) — brief context.

This CREATE/UPDATE check-first pattern, combined with the tier classifier, is what lets the same enrichment code path serve a firehose of low-value mentions and a handful of high-value dossiers without either starving the important entities or burning API budget on noise.

1.5 Related filing-rules table (entity-detection.md / idea-capture.md)

A closely-coupled companion doc gives the concrete signal→destination table used by the "signal detector" skill that runs on every inbound message:

[docs/guides/entity-detection.md; docs/guides/idea-capture.md]

The "authorship test" is applied first and takes priority over topical classification — is this the user's own thought, or a world fact? — which is a subtlety our own ideas/insights/concepts split does not currently encode explicitly.



2. docs/architecture/schema-packs.md — The Schema Pack Mechanism

2.1 What a schema pack is



"A schema pack tells gbrain what shape your brain takes — which directories exist, what types live in them, how the agent should infer types from paths, and which link verbs connect what to what. The schema pack is the dynamic, always-consulted artifact every skill reads when filing, querying, or routing experts. It is the single source of truth for 'what's in your brain.'" [docs/architecture/schema-packs.md]

This reframes the directory taxonomy from a hardcoded assumption into data the engine loads at runtime — the single most important architectural difference from a static folder convention like ours.

2.2 Bundled packs

2.3 Path-prefix type inference and manifest shape

Packs are YAML manifests:

api_version: gbrain-schema-pack-v1
name: my-pack
version: 0.0.1
gbrain_min_version: 0.39.0
extends: gbrain-base    # inherit everything; add overrides below
page_types:
  - name: project-x
    primitive: entity
    path_prefixes:
      - Projects/
    aliases: []
    extractable: false
    expert_routing: false

[docs/architecture/schema-packs.md]





primitive (e.g., entity, temporal) drives defaults: link verbs, frontmatter rules, enrichment rubric, and expert-routing-flag inheritance — but does not drive type-identity closure on its own [src/core/schema-pack/manifest-v1.ts].



path_prefixes map filesystem location → inferred page type at import/write time (e.g., anything under people/researchers/ is inferred as type researcher) [docs/schema-author-tutorial.md].



extractable: true — the page type is eligible for automatic fact extraction (gbrain extract-facts), e.g. attended_by=alice-example, date=2026-05-23 off a meeting page, or mrr=50000 off a deal page [docs/what-schemas-unlock.md].



expert_routing: true — the page type surfaces in gbrain whoknows / find_experts expert search, as opposed to ordinary general search [docs/what-schemas-unlock.md; docs/schema-author-tutorial.md].



Link verbs connect types (e.g., attended, works_at, invested_in, founded, advises, authored, prescribed-by) and are themselves pack-declared, so a legal pack can add prescribed-by while a founder pack adds invested_in [README.md; docs/what-schemas-unlock.md; skills/query/SKILL.md].

2.4 Dynamic consultation at write/query time

Every relevant subsystem consults the active pack rather than hardcoded lists:





whoknows/find_experts scopes candidates to expert_routing: true types.



extract_facts runs only on extractable: true types.



enrichment-service routes person/company enrichment by the pack's primitive declarations.



put_page's type-inference step (importFromContent) loads the active pack once per call and honors user-defined page_types for path-based type assignment, falling back to legacy hardcoded inference only on pack-load failure [docs/architecture/schema-packs.md; src/core/operations.ts].

This is a load-bearing distinction from a static folder-taxonomy CLI like ours: in GBrain, "what folder does X belong in" and "what does that folder mean for extraction/search/enrichment" are both read from configuration at request time, not compiled into the code.

2.5 CLI surface for schema authoring

Fourteen atomic CLI verbs plus MCP ops, with locking and an audit log:
schema fork, schema use, schema add-type, schema remove-type, schema update-type, schema add-alias, schema remove-alias, schema add-prefix, schema remove-prefix, schema add-link-type, schema remove-link-type, schema set-extractable, schema set-expert-routing, schema sync, plus schema reload, schema active, schema list, schema show, schema validate, schema detect, schema graph, schema stats [README.md; skills/schema-author/SKILL.md]. Each mutation goes through an 8-step skeleton — bundled-guard → per-pack lock → read → mutate → file-plane lint validation → atomic write → audit log → cache invalidation — and lands an audit row identifying which agent made the change [docs/schema-author-tutorial.md]. Remote agents can also propose and apply schema mutations over MCP (schema_apply_mutations, admin scope) [README.md].

2.6 Resolution/precedence chains

GBrain uses a general "first-match-wins, top-down waterfall" pattern for any ambiguous "which configuration applies here" question. Two documented instances:





Which schema pack is active for this call: per-call flag (CLI only) → GBRAIN_SCHEMA_PACK env var → session/config file → ... down to the bundled default [docs/architecture/schema-packs.md].



Which source (content repo) is active for this call: explicit --source flag → GBRAIN_SOURCE env → .gbrain-source dotfile → mount default → longest-path-match against configured mounts, a 7-tier chain [skills/conventions/brain-routing.md; docs/architecture/brains-and-sources.md].

The consistent pattern — deterministic, explicit, layered override resolution rather than implicit magic — is itself a design lesson worth adopting even at small scale.



3. docs/what-schemas-unlock.md — Why Types Matter, and the Default Taxonomy

3.1 Framing



"Most note-taking apps treat every page the same. You write something, it goes in a pile, you search the pile with text matching. Tags help, but tags are flat. After a few thousand pages, the pile gets noisy and the search gets stupid. Schemas are how gbrain stops being a pile of notes and becomes something with structure." [docs/what-schemas-unlock.md]



"The brain knows the difference between a person and an idea. Page-type matters at query time." [docs/what-schemas-unlock.md]

3.2 The default taxonomy (gbrain-base)



"The default schema (gbrain-base) ships with 22 page types covering the universal shapes — people, companies, meetings, notes, daily, calendar events. That's enough to start." [docs/what-schemas-unlock.md; docs/schema-author-tutorial.md — "page_types_count": 22 in a fresh-install gbrain schema active output]

The concretely-confirmed member list, assembled from the codebase's ALL_PAGE_TYPES seed and cross-referenced descriptions across src/core/types.ts, docs/architecture/schema-packs.md, and Issue #587, is (⚠ see caveat below on exact count/version drift):

person, company, deal, yc, civic, project, concept, source, media, writing, analysis, guide, hardware, architecture, meeting, note, email, slack, calendar-event, code — plus additional types (e.g. daily, place) referenced elsewhere in the recommended/base packs to round out the documented count of 22 (and later 24 as the brain grew organically before the v0.41.22 DRY/MECE collapse) [src/core/types.ts; Issue #587; README.md].



⚠️ Caveat: GBrain's exact type roster is explicitly version-dependent and was never meant to be a fixed enum — the source comments state ALL_PAGE_TYPES is "NO LONGER an exhaustive enum... it is the seed set that reproduces pre-v0.38 hardcoded behavior" [src/core/types.ts]. The README documents the count moving legacy 24 → canonical 15 in gbrain-base-v2 (v0.41.22) in direct response to Issue #1479's type-proliferation finding. Treat "22" (and "24") as documented-at-a-point-in-time figures rather than a permanently fixed list; the mechanism (a versioned, evolvable manifest) matters more than the literal count.

email | slack | calendar-event were added as native types specifically so that inbox/chat/calendar ingest (and the eval corpus) wouldn't collapse into an undifferentiated source type and lose workflow semantics — e.g., distinguishing "attended meetings" from "received emails" [src/core/types.ts].

3.3 Facts auto-extracted per type, and expert vs. general search routing





A schema declares "what facts the system should extract automatically (mrr=50000, damages=5000000)" and "which types route through expert search vs. general search" [docs/what-schemas-unlock.md].



Concrete worked example: adding meeting --primitive temporal --prefix meetings/ --extractable makes gbrain extract-facts pull attended_by=alice-example, date=2026-05-23 off every meeting page automatically, and gbrain whoknows "Q3 roadmap discussion" then routes through the meeting type, ranking by the expert_routing signal (attendees, recency, salience) instead of raw text relevance [docs/what-schemas-unlock.md].



Query-time type classification also feeds a separate, deterministic intent classifier (src/core/search/intent.ts) that buckets queries as entity / temporal / event / general and applies different ranking weights per bucket (entity queries weight graph traversal higher; temporal queries bypass source-boost so daily/chat pages surface; event queries engage the timeline index) [docs/architecture/RETRIEVAL.md].

3.4 Seven use cases / domain-specific forks

what-schemas-unlock.md builds its case with 7 concrete scenarios (confirmed via llms.txt's summary and section headers found in the doc):





The 4000 invisible pages — thousands of meeting transcripts sitting untyped as generic note become queryable-by-attendee/date the moment a meeting type with --extractable is added [docs/what-schemas-unlock.md].



The founder ops brain — adds lead, investor, portco, deal-stage as first-class entity types (gbrain schema add-type lead --primitive entity --prefix people/leads/ --expert, etc.) [docs/what-schemas-unlock.md].



The research brain — adds researcher and paper as first-class types.



The legal brain — adds case, motion, deposition, precedent, unlocking numeric fact extraction like damages=5000000.



The team brain — shared-brain scenario (multi-user routing considerations).



"The agent co-curates your ontology" pattern — an agent watching the ingestion stream runs gbrain schema detect periodically, notices an accumulating structural cluster (e.g., 47 pages under companies/yc-w24/ all typed generic company sharing founder-name/raise-amount/batch-tag structure), and proposes a new type (yc-w24-company) with candidate extractable/aliases settings for human approval [docs/what-schemas-unlock.md].



The structural argument for typed page kinds generally (why types matter at query time, tying back to point 1 above) [llms.txt summary of docs/what-schemas-unlock.md].

Same engine, "totally different shape" per domain — this is the extensibility contract the schema-pack mechanism is designed to deliver [docs/what-schemas-unlock.md].

3.5 Governance against type sprawl (critical lesson)

Issue #1479 — "design: type proliferation — 94 types should be ~14 (DRY/MECE unification proposal)" — documents that a real production brain with 186K pages organically accumulated 94 distinct page types, most duplicates/near-duplicates/one-offs that should have been frontmatter subtypes. Named failure modes: "Schema packs can't be MECE — the pack declares types but the brain has 94, many undeclared"; "search filtering breaks"; one cited cluster ("Cluster 8: One-off types — 25+ types with 1–2 pages each") lists types like civic, framework, insight, anecdote, principle, memo, rfs-draft, pitch-deck, policy-criticism, production-doc, recording-snippet, registry, reference, schema, video-script, web... [Issue #1479].

The resolution shipped as gbrain-base-v2's 15-type canonical taxonomy, with subtypes/format/origin pushed into frontmatter fields instead of new page types [README.md; gitcode.com mirror of skills/conventions/schema-evolution.md].

skills/conventions/schema-evolution.md formalizes the resulting governance rule as an explicit decision tree for "when to add a type vs. an alias vs. a prefix":



"<20 pages → don't pack-codify (one-off); 20–100 pages → alias on existing type; 100+ pages → first-class type." [docs/what-schemas-unlock.md; docs/schema-author-tutorial.md; skills/conventions/schema-evolution.md]

This is arguably the single most transferable lesson in the entire project for our own taxonomy design: unconstrained ad hoc categorization (our insights/ideas/concepts/references/docs split risks exactly this) predictably drifts toward dozens of near-duplicate buckets unless a size-based promotion rule is enforced from day one.



4. docs/guides/brain-vs-memory.md — The Three-Layer Brain/Memory/Session Model

4.1 Purpose statement



"Know what goes in GBrain, what goes in agent memory, and what stays in session context — so every piece of information lands in the right layer." [docs/guides/brain-vs-memory.md]

Failure mode without this discipline (explicitly stated): "people dossiers get stored in agent memory (lost on agent reset), user preferences get stored in GBrain (cluttering knowledge pages), and the agent re-asks questions it already knows the answer to." With the discipline: "world knowledge persists in the brain, operational state persists in agent memory, and the agent never puts information in the wrong layer." [docs/guides/brain-vs-memory.md]

4.2 The three layers and routing pseudocode

on new_information(info):
    # Three layers, three purposes -- route to the right one
    if info.is_about_the_world:
        # GBRAIN: people, companies, deals, meetings, concepts, ideas
        # World knowledge -- facts about entities external to the agent
        gbrain put <slug> --content "..."
    elif info.is_operational_state:
        # AGENT MEMORY: preferences, config, identity, decisions about
        # how the agent itself behaves (MEMORY.md / USER.md / AGENTS.md)
        ...
    else:
        # SESSION CONTEXT: ephemeral, exists only in the active context
        # window / conversation; not persisted at all
        ...

[docs/guides/brain-vs-memory.md — paraphrased structure confirmed via source excerpts]

4.3 Concrete routing / repo mapping

The three-layer model is operationalized in practice as a two-repo split (documented in the closely-linked docs/guides/repo-architecture.md):





Brain Repo (world knowledge — Layer 1 / "GBrain"): "What you know. People, companies, deals, meetings, ideas, media. This is the repo GBrain indexes." Structure: people/, companies/, deals/, meetings/, projects/, originals/, etc.



Agent Repo (operational config — Layer 2 / "agent memory"): AGENTS.md (identity + operational rules), SOUL.md (persona/voice/values), USER.md (user preferences + context), HEARTBEAT.md (daily ops flow), TOOLS.md (available tools/credentials), MEMORY.md (operational memory: preferences, decisions), skills/ (SKILL.md capability files), cron/, tasks/, hooks/, scripts/.



Session context (Layer 3): whatever is live in the active conversation/context window — not durably stored anywhere by design.

The Quick Decision Tree given for routing new files:

New file to create?
 |-- About a person, company, deal, project, meeting, idea?  -> brain/
 |-- A spec, research doc, or strategic analysis?            -> brain/
 |-- An original idea or observation?                         -> brain/originals/
 |-- A daily session log or heartbeat state?                  -> agent-repo/
 |-- A skill, config, cron, or ops file?                       -> agent-repo/
 |-- A task or todo?                                           -> agent-repo/tasks/

[docs/guides/repo-architecture.md]

The Hard Rule: "Never write knowledge to the agent repo. If a skill, sub-agent, or cron job needs to create a file about a person, [it goes to the brain repo, not the agent repo]." [docs/guides/repo-architecture.md]

Third-party corroboration (Vectorize.io's independent explainer) restates this as GBrain's "three layers": (1) Brain Repo — plain Markdown, git version-controlled, human-readable/diff-able/branchable system of record; (2) GBrain Retrieval — Postgres+pgvector (HNSW) plus tsvector keyword search fused via RRF, or PGLite (WASM Postgres) for zero-config local mode; (3) AI Agent Skills — a skill pack (Markdown workflow files + contract-first MCP operations) teaching the agent how to read/write/reason against the brain [vectorize.io/articles/what-is-gbrain; vectorize.io/articles/gbrain-vs-hindsight]. Note this "three layers" framing is about infrastructure tiers (storage/retrieval/skills), whereas brain-vs-memory.md's three layers are about information routing (world/operational/session) — both are documented and complementary, and worth distinguishing when we borrow the language.



5. README — Self-Wiring Knowledge Graph, Typed Edges, and BrainBench

5.1 The graph mechanism



"A self-wiring knowledge graph. Every page write extracts entity refs and creates typed edges (attended, works_at, invested_in, founded, advises) with zero LLM calls. Ask 'who works at Acme AI?' or 'what did Bob invest in this quarter?' and get answers vector search alone can't reach." [README.md]





Extraction source: entity references are pulled from markdown / [[wikilinks]] / typed-link syntax on every put_page call — pure pattern matching (e.g., against [[wiki/people/bob]]-style references), not an LLM call [README.md].



Reconciliation ("auto-link"): stale links (references no longer present in the page text) are removed in the same call — every put_page both adds new edges and prunes dead ones [docs/UPGRADING_DOWNSTREAM_AGENTS.md].



Storage/vault format: GBrain stores content as plain Markdown files with YAML frontmatter, compiled_truth/timeline sections, wikilinks, tags, and .raw/ JSON sidecars for raw API responses — explicitly Obsidian-compatible (7,471 markdown files described in this exact shape in an internal migration note) [gist.github.com/garrytan (GBrain.md); docs/architecture/infra-layer.md]. A dedicated migrate skill handles direct import from Obsidian ([[wikilinks]] → gbrain links), Notion (export/CSV), Logseq (((block refs)) → page links), plain markdown, CSV/JSON, and Roam [skills/migrate/SKILL.md].



Multi-hop traversal: gbrain graph-query --type <link_type> --depth N --direction in|out|both. Available link types include attended, works_at, invested_in, founded, advises, mentions, source; --direction in answers "who points to X" (e.g., who works at company X); default traversal depth is 5 [skills/query/SKILL.md].

5.2 BrainBench methodology and numbers

Corpus: 240 rich-prose pages generated by Claude Opus 4.7 — 80 people (40 founders, 20 partners, 10 engineers, 10 advisors), 80 companies (60 startups, 15 VCs, 5 acquirers), 50 meetings (15 demo days, 25 1:1s, 10 board meetings), 30 concepts (frameworks, theses, hot spaces) [docs/benchmarks/2026-04-18-brainbench-v1.md]. 145 relational queries were auto-generated against this corpus for the P@5/R@5 measurement [docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md].

Adapters compared (four-way ablation):

[docs/benchmarks/2026-04-23-brainbench-v0.20.0.md; docs/architecture/RETRIEVAL.md; garrytan/gbrain-evals README]

Headline claim: gbrain's graph-enabled default beats its own graph-disabled variant by +31.4 points P@5, beats grep-only by ~32 points, and beats vector-only by ~38 points — i.e., "the graph layer (who-knows-whom) is worth about 30 of those points on its own" [README.md; garrytan/gbrain-evals README; docs/benchmarks/2026-04-18-brainbench-v1.md]. The benchmark explicitly isolates pre-PR-#188 (vanilla v0.10.0, no auto-link/no extract --source db/no traversePaths — the agent falls back to grepping the corpus) against the full v0.10.3+v0.10.4 graph-layer stack, on the identical 240-page corpus and identical relational queries [docs/benchmarks/2026-04-18-brainbench-v1.md].

5.3 The four retrieval strategies "in concert"

docs/architecture/RETRIEVAL.md documents why GBrain layers four strategies rather than picking one:





Vector (HNSW on pgvector) — semantic similarity; catches paraphrase/no-shared-token queries.



BM25 keyword — lexical match; catches exact names/phrases/identifiers.



Hybrid fusion (RRF + source-tier boost) — reciprocal rank fusion across #1 and #2.



Knowledge graph traversal — follows typed edges; "catches 'what did Bob invest in this quarter?' by walking bob ── invested_in ──> company ── dated ──> Q1. Vector search can't see causal chains; the graph can." [docs/architecture/RETRIEVAL.md]

5.4 The gbrain-evals sibling repo and broader scorecard

garrytan/gbrain-evals is a separate, reproducible eval harness repo ("Everything here is public, runs on your own machine, and can be reproduced from a commit hash... we publish the numbers we are not proud of right next to the ones we are") [garrytan/gbrain-evals README]. Its published scorecard covers more than the headline BrainBench number:

An independent third-party review (Vectorize.io) rates GBrain 5/5 on architecture ("clean and well-reasoned") and 4/5 on retrieval quality, specifically flagging as a limitation: "strong BrainBench numbers; no multi-hop graph or temporal [reasoning]" beyond what's benchmarked — a useful counterpoint to keep in mind when reading the headline numbers [vectorize.io/articles/gbrain-review].



6. Comparison: Our Taxonomy vs. GBrain-Base(-Recommended), and Concrete Recommendations

6.1 Direct folder mapping

6.2 What we're missing structurally (beyond folder names)





No two-layer page anatomy. We currently store notes as flat files; GBrain's Compiled-Truth (rewritten synthesis) + Timeline (append-only evidence) split is the mechanism that keeps entity pages both fresh and auditable. Recommendation: adopt this split for people/companies/projects at minimum — a rewritten "State" block plus an append-only dated log with [Source: ...] citations.



No explicit decision tree / resolver doc. Our folder list is a flat enumeration; GBrain encodes filing logic as a numbered, first-match-wins, machine-readable RESOLVER.md with named disambiguation rules (e.g., person-vs-company test). Recommendation: write an explicit RESOLVER.md-equivalent for our CLI, including an authorship test (mine vs. world) ahead of topical classification.



No tiered enrichment. We likely treat all entities the same. Recommendation: adopt a lightweight Tier 1/2/3 classifier (key/notable/passing-mention) to bound API/LLM spend and avoid low-value stub pages cluttering search.



No entity registry / identity resolution layer. Merges currently probably require manual file surgery. Recommendation: add a canonical-ID + aliases table so merging duplicate person/company records is a pointer update, not a file rewrite.



No zero-LLM-call typed-link graph. This is GBrain's single biggest empirically-measured lever (+31.4 P@5). Even a minimal wikilink-parsing pass ([[type/slug]] syntax → typed edges table → simple graph traversal query) would likely deliver a meaningfully similar lift over pure keyword/vector search in our own system, without needing any LLM calls — cheap to build, high-value. Recommendation: prioritize this over more elaborate LLM-based extraction.



No schema-pack-style extensibility. Our 12 folders are hardcoded in the CLI. GBrain externalizes types/prefixes/link-verbs/extraction-flags into a versioned, forkable manifest consulted at runtime. Recommendation: even a simple JSON/YAML "pack" file (folder → primitive → extractable/expert-routing flags) that our CLI loads at startup would let us evolve the taxonomy without code changes, and would let different teams/users fork variants (a "legal pack," a "research pack") on the same engine.



No governance rule against type/folder sprawl. GBrain's own production brain organically grew to 94 types before correction (Issue #1479). Recommendation: adopt an explicit size-based promotion rule now, before our insights/ideas/concepts/references boundary gets fuzzy in practice — e.g., "<20 items in a new ad hoc bucket → don't formalize it; 20–100 → alias to nearest existing folder; 100+ → promote to first-class folder with its own resolver note."



No explicit three-layer separation of world-knowledge vs. operational-state vs. session context. If our CLI mixes user preferences/agent config into the same folder tree as world knowledge (people/companies/etc.), we risk GBrain's named failure mode: preferences cluttering knowledge pages, and knowledge lost on agent/session reset. Recommendation: explicitly split "brain" (world knowledge, our 12 folders) from an "agent-state" area (preferences, running config, session logs) the way GBrain separates brain-repo from agent-repo.



No internal benchmark harness. GBrain's gbrain-evals sibling repo is what lets every architecture decision (e.g., "is the graph worth it?") be argued with numbers instead of intuition. Recommendation: even a small, versioned "our-brain-bench" — a synthetic corpus + a handful of relational queries + P@5/R@5 scoring — would let us quantify whether our own graph/tiering/schema changes actually help, and catch regressions.

6.3 Prioritized next steps (highest leverage first)





Build the zero-LLM wikilink → typed-edge graph and a basic multi-hop query command — largest measured ROI in GBrain's own numbers.



Split every entity page into Compiled-Truth (current state) + Timeline (append-only log) — cheap to retrofit, big maintainability win.



Write an explicit, numbered filing decision tree (our RESOLVER.md analog) with an authorship test and person-vs-company-style disambiguation rules, and route unmatched items to inbox/ as a schema-evolution signal we actively review.



Externalize our folder list into a small pack manifest (folder ↔ type ↔ extractable/expert-routing flags) loaded at runtime instead of hardcoded, to enable future domain forks without code changes.



Add a Tier 1/2/3 enrichment classifier and an entity registry (canonical ID + aliases) before our person/company counts grow large enough that ad hoc dedup becomes painful.



Adopt a size-based promotion rule for new categories (the <20 / 20–100 / 100+ heuristic) to pre-empt the type-sprawl failure GBrain itself hit at scale.



Separate world knowledge (our 12 folders) from operational/agent state (preferences, session logs, running config) into a genuinely distinct store, mirroring the brain-repo/agent-repo split.



Once (1)–(2) are in place, build a minimal internal BrainBench-style eval (small synthetic corpus + relational queries + P@5/R@5) to quantify whether our graph/tiering changes are actually working.



Sources Cited





README.md (garrytan/gbrain) — self-wiring graph, typed edges, BrainBench headline numbers, three schema packs, production-scale stats



docs/GBRAIN_RECOMMENDED_SCHEMA.md — MECE directories, RESOLVER.md logic, compiled truth/timeline, entity registry, event ledger, enrichment tiers/triggers



docs/architecture/schema-packs.md — schema pack definition, bundled packs, manifest format, primitives, CLI verbs, resolution chain



docs/what-schemas-unlock.md — 22-type default, 7 use cases, facts-extracted examples, expert vs. general search



docs/guides/brain-vs-memory.md — three-layer brain/memory/session model, routing pseudocode



docs/guides/repo-architecture.md — two-repo split, quick decision tree, hard rule



docs/guides/entity-detection.md, docs/guides/idea-capture.md — filing rules table, authorship test



docs/guides/enrichment-pipeline.md, skills/enrich/SKILL.md — enrichment tiers, CREATE/UPDATE pipeline steps



docs/guides/compiled-truth.md — compiled truth/timeline mechanics



docs/architecture/RETRIEVAL.md — four retrieval strategies, intent classifier



docs/benchmarks/2026-04-18-brainbench-v1.md, docs/benchmarks/2026-04-23-brainbench-v0.20.0.md, docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md (garrytan/gbrain-evals) — corpus, methodology, scorecards



garrytan/gbrain-evals README and CHANGELOG.md — LongMemEval, PrecisionMemBench, synthesis/reranker benchmarks



docs/schema-author-tutorial.md, skills/schema-author/SKILL.md, skills/conventions/schema-evolution.md — tutorial workflow, type-vs-alias-vs-prefix decision rule



Issue #1479 (garrytan/gbrain) — 94-type proliferation finding and DRY/MECE unification



Issue #587 (garrytan/gbrain) — original hardcoded PageType union



src/core/types.ts, src/core/schema-pack/manifest-v1.ts, src/core/operations.ts — implementation-level confirmation of pack-driven type inference



skills/query/SKILL.md, skills/RESOLVER.md, docs/UPGRADING_DOWNSTREAM_AGENTS.md — graph-query syntax, auto-link mechanics



docs/architecture/brains-and-sources.md, skills/conventions/brain-routing.md — brain/source resolution chains



skills/migrate/SKILL.md — Obsidian/Notion/Logseq/Roam import



docs/tutorials/company-brain.md, docs/tutorials/personal-brain.md, docs/designs/HOMEBREW_FOR_PERSONAL_AI.md — production usage patterns



Third-party coverage: MarkTechPost, "A Step-by-Step Coding Tutorial to Implement GBrain" (2026-05-22); Vectorize.io, "What Is GBrain?", "GBrain vs Hindsight", "GBrain Review: An Honest Assessment" (2026-05-08)

Uncertainty notes: GBrain's exact page-type roster (20 vs. 22 vs. 24 vs. 15) genuinely differs across the versions surfaced in search results, reflecting a fast-moving, actively-refactored codebase (v0.10 → v0.41+ observed across sources) rather than a documentation error on our part — the schema-pack mechanism is the stable, transferable artifact, not any specific type count. Some phrase-level content (e.g., full verbatim prose of GBRAIN_RECOMMENDED_SCHEMA.md's remaining numbered sections beyond §1–§2) was reconstructed from consistent, overlapping excerpts across the canonical repo and several forks/mirrors rather than one single complete fetch; core claims are corroborated across at least two independent sources each.