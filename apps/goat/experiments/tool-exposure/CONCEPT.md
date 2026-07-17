# Adaptive Lossless Tool Exposure for Goat

Status: concept proposal for discussion
Basis: [tiered tool-exposure spike](./RESULTS-2026-07-17.md)

## Executive proposal

The recommended design is an **engine-routed, task-conditioned tool DAG with a generic dispatcher
and lossless escape hatches**.

The important change from the first spike is that Level 1 must not be a fixed list of popular tools.
The engine should deterministically select Level-1 tool cards from the user's current request. A
static popularity list can be a tie-breaker, but it must never crowd out an exact requested operation.

The normal path is:

1. The engine loads a versioned registry of every available integration and tool.
2. Before the model turn, deterministic lexical rules and optional pinned embeddings identify all
   relevant integrations.
3. Within each relevant integration, the engine selects two to six **request-specific** tool cards.
4. The model receives the Level-0 integration catalog, selected Level-1 cards, and three stable
   engine tools: `expand_integration`, `inspect_tool`, and `call_tool`.
5. When the model calls `call_tool`, the engine resolves the full Level-2 schema outside model
   context, validates the arguments, enforces policy, and executes it.
6. If selection or argument construction fails, stable pointers let the model retrieve a complete
   integration directory or a full tool definition without another routing inference.

This preserves the spike's 87–92% context reduction while directly addressing its failure mode:
`list_issues` and `list_pull_requests` would be selected from the verbs and objects in the request,
instead of being hidden behind static `search_*` cards.

This is the best design indicated by the spike; it is not yet empirically proven optimal. The next
evaluation must compare it against both flat exposure and the fixed-curation prototype.

## Goals

- Keep all connected integrations discoverable without flat schema exposure.
- Make the common path require no model-driven tool search or extra routing LLM call.
- Preserve native multi-step agent behavior: the model still decides what to call and in what order.
- Make routing and exposure reproducible from the user request and registry version.
- Preserve a lossless path to every tool, schema, example, and convention.
- Keep activation separate from authorization, approval, validation, and execution policy.
- Provide enough instrumentation to explain every exposed, omitted, expanded, and called node.

## Non-goals

- Engine-managed task partitioning or sub-agent orchestration.
- Inferring a complete execution plan before the model runs.
- Real integration authentication or approval redesign.
- Tool-result compaction; this proposal manages tool definitions, not large tool outputs.
- Permanently learning routing rules from production traffic without an offline review process.

## Why this design

The spike produced four useful findings:

1. **Integration routing worked.** Regex matching found 22 of 23 required integration occurrences,
   and the one deliberate miss recovered through a Level-0 pointer.
2. **Static tool curation failed.** The model substituted visible `search_*` tools for omitted
   `list_*` tools even when the request explicitly said “list.”
3. **The generic dispatcher worked.** Common tools were called with valid arguments from short
   Level-1 signatures; full schemas did not need to be injected on every step.
4. **Expansion is expensive but useful.** Non-curated tasks recovered, but directory discovery
   often added a model step and materially increased latency.

The right optimization target is therefore not “pick the best four tools for an integration.” It is
“maximize required-tool coverage for this request under a small deterministic context budget.”

## System shape

```text
                         immutable/versioned registry
                       ┌──────────────────────────────┐
                       │ Integration nodes (Level 0)  │
                       │ Tool cards (Level 1)          │
                       │ Full definitions (Level 2)    │
                       └──────────────┬───────────────┘
                                      │
User message ──> deterministic activation engine
                 │ integration matches + reasons
                 │ clause-aware tool candidates + scores
                 │ stable token budget and tie-breaking
                 ▼
             turn exposure snapshot
                 │
                 ▼
┌──────────────────────────────── model loop ────────────────────────────────┐
│ Static policy + Level-0 catalog                                           │
│ Conversation history                                                      │
│ Latest user request + request-specific Level-1 cards                      │
│ Always-callable engine tools:                                             │
│   expand_integration(pointer, intent?)                                    │
│   inspect_tool(pointer)                                                   │
│   call_tool(pointer, arguments)                                           │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ tool call
                                ▼
                      validation/policy/dispatcher
                                │
                                ▼
                       integration implementation
```

The model never receives the full registry. The engine never executes a tool merely because it was
activated. Exposure only affects what the model can efficiently reason about.

## The versioned tool DAG

### Level 0: integration cards

Level 0 contains one compact card for every integration that is connected and usable in the current
workspace. It should not include every provider Goat could theoretically support.

Example:

```text
Linear — engineering issues, projects, cycles, teams and comments [integration://linear]
Slack — conversations, channels, messages, threads, reactions and files [integration://slack]
```

Each card contains:

- Stable integration ID and display name.
- A curated one-sentence capability summary.
- Explicit aliases and entity patterns used by the activation engine.
- A stable pointer to the complete Level-1 directory.
- Registry version and schema hash in engine metadata, not the visible line.

Target size is roughly 15–25 tokens per connected integration. Level 0 is stable across user turns
until connections or registry versions change, making it a good prompt-cache prefix.

### Level 1: request-specific tool cards

Level 1 is generated deterministically for the current user request. It is not a static curated set.

Example for “List open Linear issues for ENG and send a summary to #release”:

```text
Linear candidates:
- list_issues(teamKey?, status?, limit?) — list issues with structured filters
  [tool://linear/list_issues]

Slack candidates:
- send_message(channel, text) — send a message to a channel or DM
  [tool://slack/send_message]
- list_channels(query?, includeArchived?) — resolve a channel name when needed
  [tool://slack/list_channels]
```

Each card contains only:

- Stable tool pointer and exact tool name.
- Required arguments and compact optional-argument names.
- One action-oriented sentence.
- Side-effect class when relevant: read, write, destructive, or external communication.
- Compact output kind when it helps chaining, such as `returns Issue[]` or `returns channelId`.

It does not contain the full JSON schema, examples, long MCP descriptions, or integration
conventions. Target size is roughly 25–50 tokens per card.

### Level 2: immutable full definitions

Level 2 contains the complete definition:

- Full JSON input schema.
- Full output schema when available.
- Examples and integration conventions.
- Raw provider tool identity and schema version.
- Risk, authorization, approval, rate-limit, and execution metadata.
- Historical schema hash so a trace can resolve the exact definition used at the time.

The active pointer can remain short, for example `tool://linear/create_issue`. The execution trace
also records the resolved immutable version, such as its registry version and schema hash.

Level 2 normally stays outside the model context. It enters model context only through an explicit
`inspect_tool` result or a validation error containing the relevant schema fragment.

## Registry model

The registry needs semantic routing metadata in addition to MCP's raw `listTools` response.

```ts
type IntegrationDescriptor = {
  id: string;
  name: string;
  summary: string;
  aliases: string[];
  entityPatterns: string[];
  embedding?: number[];
  manifestPointer: string;
  registryVersion: string;
};

type ToolDescriptor = {
  pointer: string;
  integrationId: string;
  name: string;
  shortDescription: string;
  shortSignature: string;
  operationAliases: string[];
  objectAliases: string[];
  inputKinds: string[];
  outputKinds: string[];
  sideEffect: "read" | "write" | "destructive" | "external_communication";
  popularityPrior: number;
  embedding?: number[];
  fullDefinitionPointer: string;
  schemaHash: string;
};
```

Raw MCP descriptions must not be trusted as routing metadata or system instructions. Integration
adapters should provide reviewed summary/alias overlays. Provider text can be stored in Level 2 and
presented as untrusted data when explicitly inspected.

## Deterministic activation

Activation runs once before each new user turn. It uses the latest user request as the authority;
tool-result prose and retrieved external content must not silently activate integrations.

### 1. Normalize and split the request

The engine normalizes Unicode, casing, integration mentions, identifiers, channel syntax, and common
operation aliases. It performs shallow deterministic clause splitting on punctuation and coordinating
phrases so multi-integration requests retain coverage per clause.

For example:

```text
list open Linear issues for ENG
search Attio for Acme
search Slack for launch risk
list GitHub pull requests
search Notion for Q3 launch
```

This is not task planning. It only prevents one high-scoring clause from consuming the entire tool
candidate budget.

### 2. Activate integrations

An integration activates when any of these conditions hold:

1. Exact integration name, alias, handle, or provider-specific identifier match.
2. Reviewed keyword/entity rule match.
3. Pinned embedding similarity exceeds a calibrated threshold and margin.
4. The model explicitly expands its Level-0 pointer.

The initial embedding proposal is:

- Use exact and rule matches immediately.
- Add every integration with cosine similarity at or above a calibrated threshold, initially 0.78.
- Require a 0.05 margin over unrelated integrations for embedding-only matches.
- Do not force a top-one winner; activate every integration above threshold so multi-source requests
  remain multi-source.
- Use stable integration IDs as the final tie-breaker.

Thresholds are configuration, versioned with benchmark results. A query embedding is a non-generative
inference, not an LLM routing turn, but its model/version and latency must still be logged. The first
production iteration should run embeddings in shadow until they improve recall enough to justify
their latency and cost.

False positives are relatively cheap because they add only a few Level-1 cards. The integration
threshold should therefore favor recall, while the tool candidate budget controls context growth.

### 3. Select tools inside each active integration

Every tool is scored independently for every relevant clause using:

- Exact operation aliases: `list`, `create`, `update`, `compare`, `react`, `send`.
- Exact object aliases: `issue`, `pull request`, `company`, `thread`, `page`.
- Identifier and argument-shape evidence: `ENG-42`, `#release`, PR numbers, record IDs.
- Lexical/BM25 similarity over the short description and signature.
- Pinned embedding similarity over a reviewed tool card.
- A small popularity prior used only as a tie-breaker.

Selection rules:

1. Include every exact operation-and-object match.
2. Include the highest semantic match for each clause when it clears the tool threshold.
3. Include obvious prerequisite resolvers when their typed output satisfies a required argument, for
   example `list_channels` alongside `send_message` when only a channel name is available.
4. Fill remaining slots by hybrid score.
5. Select two to six cards per active integration, subject to a turn-wide default cap of 24 cards.
6. Give every matched clause and integration at least one slot before allocating extras.
7. Never let the popularity prior displace an exact operation-and-object match.
8. Use stable pointers as deterministic tie-breakers.

The 24-card cap is a starting point, not a claim of optimality. With 40 tokens per card it budgets
roughly 1,000 tokens for Level 1. If coverage would exceed the cap, the exposure trace must record
which candidates were pruned and why.

### 4. Build an exposure snapshot

The result is an immutable `TurnExposureSnapshot`:

```ts
type TurnExposureSnapshot = {
  registryVersion: string;
  requestHash: string;
  integrations: Array<{
    id: string;
    reasons: ActivationReason[];
    score: number;
  }>;
  toolCards: Array<{
    pointer: string;
    matchedClauses: number[];
    reasons: ActivationReason[];
    score: number;
  }>;
  prunedCandidates: Array<{ pointer: string; reason: string }>;
  timings: { lexicalMs: number; embeddingMs: number; totalMs: number };
};
```

The snapshot is logged and reused for every step in that user turn. It is not recomputed from model
prose between steps.

## What enters the model loop

### Stable, cacheable context

The stable prefix contains:

1. Goat's normal system policy and behavioral instructions.
2. The Level-0 catalog for connected integrations.
3. Instructions explaining pointers and the recovery protocol.
4. The three generic engine-tool schemas.

The only always-callable tools are:

```ts
expand_integration({
  pointer: string,
  intent?: string
})

inspect_tool({
  pointer: string
})

call_tool({
  pointer: string,
  arguments: Record<string, unknown>
})
```

Keeping these schemas stable avoids re-sending hundreds of native tool schemas and maximizes provider
prompt-cache reuse.

### Turn-specific context

Immediately adjacent to the latest user request, the engine adds a non-persisted context block with:

- The selected Level-1 cards, grouped by integration and request clause.
- A one-line explanation that the list is a candidate view, not an exhaustive capability list.
- Pointers for full integration directories and tool inspection.
- No routing scores, thresholds, or internal chain-of-thought-like data; those remain in traces.

Conceptually:

```text
<available_tools registry="reg_abc123">
Candidate tools selected for this request; other tools remain available through integration pointers.

Linear [integration://linear]
- list_issues(teamKey?, status?, limit?) — list issues using filters
  [tool://linear/list_issues]

Slack [integration://slack]
- send_message(channel, text) — send a message to a channel or DM
  [tool://slack/send_message]
</available_tools>

<user_request>
List open Linear issues for ENG and send a summary to #release.
</user_request>
```

This block is runtime context only. Goat should continue persisting the user's original message, not
the generated catalog. On the next user turn the engine recomputes Level 1 from the new request.

### Context during later model steps

Exposure state is monotonic within a user turn:

- Initial Level-1 cards remain visible.
- `expand_integration` and `inspect_tool` results remain in the tool-call history for that turn.
- Successful tool calls do not inject full schemas into later steps.
- Tool results include the called pointer so the model can associate results with the tool.
- The next user turn starts from a newly computed snapshot rather than accumulating prior schemas.

Typed tool outputs can enable already-selected downstream candidates, but untrusted result text must
not automatically expand new integrations. A future dependency-activation mechanism should require
both a typed registry edge and evidence from the original user request.

## Engine tools and recovery

### `call_tool`: the normal execution path

The model uses the Level-1 signature to call a tool:

```json
{
  "pointer": "tool://linear/list_issues",
  "arguments": { "teamKey": "ENG", "status": "open", "limit": 20 }
}
```

The dispatcher then:

1. Resolves the pointer against the turn's immutable registry snapshot.
2. Loads the complete Level-2 schema outside model context.
3. Validates and normalizes arguments.
4. Checks the current user's connection, permissions, approval policy, and rate limits.
5. Executes the existing integration implementation.
6. Returns a compact result containing the pointer and provider output.
7. Records the schema hash and validation/execution trace.

Activation never bypasses authorization or approval. An unexposed but valid pointer is still subject
to the same dispatcher checks.

If validation fails, the result should be actionable and bounded:

```json
{
  "ok": false,
  "code": "INVALID_TOOL_ARGUMENTS",
  "pointer": "tool://linear/create_issue",
  "errors": ["teamKey is required", "priority must be an integer from 0 to 4"],
  "relevantSchema": { "...": "only fields needed to repair this call" },
  "inspectPointer": "tool://linear/create_issue"
}
```

The full schema is available through `inspect_tool`, but common validation repairs should not require
another complete definition.

### `expand_integration`: recovery from routing or candidate misses

The Level-0 pointer lets the model request a complete Level-1 directory. For a normal 15–30-tool MCP
server, returning every short card is acceptable because expansion is exceptional. Larger manifests
can be deterministically paginated with stable cursors while keeping every tool reachable.

The optional `intent` narrows ordering, not visibility: the response must still expose a pointer or
cursor to the complete directory. It must not become another lossy search surface.

Expansion reasons are logged as `model_request`, distinct from automatic activation.

### `inspect_tool`: recovery from schema ambiguity

This returns the immutable Level-2 definition as data. It is intended for nested schemas, unions,
provider-specific conventions, or a failed call the model cannot repair from the validation fragment.

The expected common path is zero `inspect_tool` calls. A high inspection rate means Level-1 signatures
are too weak or the generic dispatcher is hurting argument construction.

### Direct use of remembered pointers

If the model knows a stable pointer from earlier context, it may call or inspect it even when it was
not in the current candidate set. The dispatcher resolves it against the current registry snapshot;
removed, unauthorized, or version-incompatible tools return structured errors. This makes pointers
genuinely lossless rather than merely decorative.

## Turn lifecycle

```text
New user message
  ├─ Load registry snapshot for current workspace/user
  ├─ Deterministically compute exposure snapshot
  ├─ Call model with Level 0 + selected Level 1 + three engine tools
  │
  ├─ Model returns final text ───────────────────────────────────────> finish
  │
  └─ Model calls engine tool
       ├─ expand_integration ─> append full Level-1 directory ─┐
       ├─ inspect_tool ───────> append Level-2 definition ─────┤
       └─ call_tool ──────────> validate/policy/execute ───────┤
                                                               │
                                      next model step <─────────┘

Next user message
  └─ Discard turn exposure state and recompute from the new request
```

No separate LLM decides whether tools should be discovered. The only model decisions are normal agent
decisions: call a visible candidate, follow a pointer, inspect a schema, or answer.

## Multi-integration requests

Multi-integration coverage must be a first-class invariant, not an incidental outcome of global top-K
retrieval.

For each request clause, the engine records:

- Which integrations matched.
- Which operation/object concepts matched.
- Which Level-1 tool cards cover it.
- Whether the clause lost candidates to the global token budget.

An exposure snapshot is invalid if a high-confidence clause has no candidate and no integration
pointer. In that case the engine should include the best candidate plus a low-confidence marker in
the trace, not silently drop the clause.

This coverage allocator is what prevents a five-source request from spending all candidate slots on
the two most semantically similar integrations.

## Determinism and replay

Given the following inputs, activation output must be reproducible:

- Normalized user request.
- Registry version.
- Routing configuration version.
- Alias/rule set version.
- Embedding model/version and stored vectors, if enabled.

Every trace records those inputs plus stable tie-break decisions. Pure lexical routing should replay
bit-for-bit. Embedding routing is operationally deterministic only when the embedding model and
vectors are pinned; changing either creates a new routing configuration version.

## Security boundaries

- Tool descriptions, schemas, and MCP results are external input. Sanitize names and delimit all
  provider-controlled text as data.
- Only reviewed Level-0 and Level-1 overlays enter privileged system/developer context.
- Activation grants visibility, never permission.
- Dispatcher authorization uses the live user/workspace identity, not model-supplied fields.
- Tool pointers are identifiers, not executable code. Unknown or malformed pointers fail closed.
- External tool-result text cannot activate more integrations automatically.
- Destructive and externally visible operations continue through Goat's approval policy regardless
  of how their tool card was activated.
- Registry snapshots must not expose tools from disconnected or cross-tenant integrations.

## Instrumentation

Record one exposure trace per user turn and one step record per model call.

### Exposure trace

- Registry and routing configuration versions.
- Available integration/tool counts.
- Level-0 and Level-1 estimated token counts.
- Integration matches, scores, matched text, and activation reason.
- Tool matches per clause, scores, and reason.
- Candidate budget, allocations, and pruned candidates.
- Lexical and embedding latency.

### Model-step trace

- Provider input, cached-input, and output tokens.
- Visible integration and tool-card pointers.
- Explicit Level-1 and Level-2 expansions.
- Called pointer and resolved schema hash.
- Argument validation failures and retries.
- Tool execution latency and result status.
- Total step and turn latency.

### Outcome metrics

- Integration activation recall.
- Level-1 required-tool candidate recall.
- End-to-end required-tool recall and precision.
- Exact task success using actual final state where possible.
- Trigger false-negative and pointer-recovery rates.
- Directory expansion and schema inspection rates.
- Invalid-argument retry rate.
- Tokens and latency by task integration count and schema complexity.

The most important new metric is **Level-1 candidate recall before the model runs**. It directly
detects the fixed-curation failure that the first spike only discovered at execution time.

## Caching and latency

- Cache registry snapshots by workspace connection set and schema hash.
- Precompute integration and tool-card embeddings when a registry changes.
- Cache Level-0 serialized text with the registry snapshot.
- Keep the base system prompt, Level-0 catalog, and three meta-tool schemas stable for provider prompt
  caching.
- Place request-specific Level 1 late in the prompt, adjacent to the latest user message.
- Run lexical routing synchronously; target less than 1 ms p95 locally.
- Evaluate query-embedding latency separately. It should remain below 50 ms p95 and must measurably
  improve candidate recall before becoming part of the critical path.

The first spike showed that regex latency was irrelevant; extra model steps dominated. Production
optimization should therefore prioritize avoiding unnecessary expansion steps over shaving
microseconds from lexical matching.

## Proposed Goat integration

The implementation should be shared by foreground Goat chat and the Goat task runner rather than
duplicated in each loop.

Suggested boundaries:

```text
packages/tool-exposure/
  registry.ts             versioned integration/tool descriptors
  activation.ts           pure deterministic routing and budgeting
  exposure.ts             Level-0/Level-1 serialization
  dispatcher-contract.ts  pointer and validation contracts
  trace.ts                instrumentation schema

apps/goat/
  adapters for user-connected native/MCP integrations
  foreground chat exposure and engine-tool runtime

apps/runner/
  task-loop exposure runtime
  existing integration execution adapters and policy enforcement
```

The shared package should be pure and testable without credentials or network access. App and runner
adapters own user-specific registry assembly and real execution.

For the AI SDK loop:

- Build the registry and exposure snapshot before `generateText`/`streamText`.
- Expose only the three engine tools in the AI SDK `tools` object.
- Add Level 1 as an engine-owned, non-persisted context block on the latest user turn.
- Keep expansion results in normal tool-call history for subsequent steps.
- Use the dispatcher to call existing Goat/MCP implementations.
- Do not mutate the persisted user message with exposure data.

## Rollout plan

### Phase 1: registry and offline routing

- Ingest real MCP `listTools` catalogs for connected Goat integrations.
- Create reviewed Level-0 summaries and routing overlays.
- Replay representative Goat task prompts through the activation engine.
- Measure integration and candidate recall without changing model exposure.

### Phase 2: shadow mode

- Keep current production tools unchanged.
- Compute and log exposure snapshots alongside real turns.
- Compare selected candidates to tools actually called.
- Tune aliases, clause coverage, thresholds, and card budgets.

### Phase 3: controlled agent evaluation

- Compare flat, fixed-curation, adaptive generic-dispatch, and an optional dynamic-native-tool variant.
- Run at least five repetitions across Goat's supported models.
- Use real schemas and score actual final state and arguments, not only tool names.
- Include single-, multi-, ambiguous-, false-negative-, nested-schema-, and destructive-tool cases.

### Phase 4: opt-in production trial

- Start with background tasks or an internal feature flag.
- Preserve immediate rollback to the current exposure mode.
- Review every expansion, validation retry, and missed-tool report.
- Move to foreground main chat only after non-inferiority gates hold.

## Go/no-go gates

Recommended initial gates against the current production baseline:

- Required-tool recall no more than 1 percentage point worse, with confidence intervals.
- Level-1 candidate recall at least 99% on labeled tasks.
- At least 80% lower uncached input tokens on turns with five or more integrations.
- Common-path latency no more than 5% worse at p50 and p95.
- Explicit directory expansion on fewer than 10% of turns.
- Schema inspection on fewer than 5% of turns.
- At least 90% recovery from deliberately constructed integration-trigger misses.
- No cross-tenant, disconnected-tool, or approval-bypass failures.

If candidate recall misses its gate, increase per-clause coverage or card budget before adding more
model-driven recovery. The common path should remain deterministic.

## Alternatives considered

### Flat exposure

It preserved required-tool recall through 800 mock schemas, but first-step input reached 177k tokens.
It is a useful oracle and fallback, not a scalable default.

### Fixed curated Level 1

Rejected by the spike. It anchors the model to nearby visible operations and systematically hides
request-specific tools.

### Model-driven `find_tools` before every task

Rejected as the normal path because it spends another model decision and step on routing, increases
latency, and is harder to replay. It remains useful only as an explicit lossless recovery action.

### Dynamically expose selected native tool schemas

This may improve provider-native tool selection and complex argument generation, but it moves full
Level-2 schemas into context and changes the tool set between requests. It should be an evaluation
variant, particularly for tools with deeply nested schemas. The generic dispatcher remains the
recommended default until data shows a material quality gap.

### Embeddings only

Rejected. Exact provider names, identifiers, operation verbs, and channel/issue syntax are strong
deterministic signals. Embeddings should complement reviewed rules and lexical retrieval, not replace
them.

## Open questions for discussion

1. Should the first production version be lexical-only, or should pinned embeddings enter after a
   shadow period?
2. Is 24 Level-1 cards the right global budget, or should the budget be token-based and model-specific?
3. Should complex-schema tools be proactively promoted to native full-schema tools after selection?
4. How should reviewed routing overlays be owned and versioned as MCP servers change?
5. Should explicit pointer expansions survive into the next user turn when the follow-up is clearly
   about the same operation?
6. At what connected-integration count does Level 0 itself need domain grouping or pagination?
7. Which production surface is the safer first trial: background Goat tasks or foreground main chat?

## Recommended next spike

Implement only the activation engine and exposure serializer first. Reuse the existing mock registry,
but replace static `curatedToolNames` with clause-aware deterministic candidate selection. Rerun the
same 15 tasks and add paraphrases for `list`, `search`, `fetch`, `create`, `update`, `compare`, and
cross-integration handoffs.

The decisive test is simple: the adaptive design must retain the fixed prototype's token savings
while matching flat exposure's 100% required-tool recall on the existing suite. If it cannot, Goat
should not adopt generic-dispatch tiering as its main chat tool surface.
