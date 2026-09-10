# Action discovery

opencompany chat, Codex, and Claude Code share a progressive action catalog in host tool
contract v5. The model sees these operations:

| Operation | Result |
| --- | --- |
| `list_actions({})` | All currently available sources, as before. |
| `list_actions({source})` | Every available action in catalog order, with its exact ID, source, permission mode, and a whitespace-normalized description preview of at most 160 characters. Longer previews end in `…`. No parameter schemas. |
| `describe_actions({actions: [id, ...]})` | Complete current descriptors for one to five exact IDs, including full descriptions and parameter schemas, plus explicit `not_found` IDs. Repeated IDs are deduplicated after validating the batch size. |
| `use_action({action, params})` | The existing execution path, with availability checks, approval, deduplication, provider retry limits, and the 16-admission turn budget. |

Listing and description read the existing policy-filtered catalog. They do not execute providers,
refresh remote MCP discovery snapshots, require approval, or consume the execution budget.
Successful description records each found action's source as discovered. Unknown or unavailable
IDs do not admit a source. Description does not grant execution permission.

A known ID can go directly to description. Models should reuse complete definitions already
visible in the conversation, including historical full-schema listings. Source admission remains
separate from schema visibility: if a host requests source discovery again, a compact listing is
sufficient. No per-action database admission requirement or historical transcript rewrite is added.

The persisted session contract controls rolling deployment behavior. Retained Codex contracts
v2–v4 and chat contracts v3–v4 receive their original full-schema listings. The MCP adapter exposes
`describe_actions` only for v5; legacy gateway description requests are rejected. Previous
approval continuations and legacy Brain capture remain supported.

## Action budget

The shared limit is 16 admitted invocations per turn for both chat and background tasks.
Discovery is free. Unknown action IDs and missing source discovery are rejected before admission;
a known, admitted invocation consumes a slot even when parameter validation or provider execution
fails. A duplicate invocation does not consume another slot or dispatch the provider again.
Approval requests and denied approvals are handled before the host admission claim.

Execution responses include `budget: { limit, used, remaining }` after admission, including
provider errors and duplicate invocations. A `call_budget` response reports zero remaining.
Snapshots describe admission order; concurrently executing calls can finish in a different order.
An inner host gateway's budget takes precedence over the model-facing wrapper's local count,
because the host keeps the same turn's accounting across approval continuations.

The native opencompany runner makes `use_action` inactive on subsequent model steps once a
response reports zero remaining or `call_budget`. Other tools remain available to finish work
from the evidence already gathered. The existing final model step still requires a text answer.
Codex and Claude Code receive the same gateway budget and stop instructions, but their external
loops do not use this native runner's tool selection. The host cap continues to reject excess
invocations, including calls already emitted in the same parallel batch.

The action budget bounds admitted integration/capability invocations, not total inference spend,
discovery calls, or work through unrelated tools. Model-step limits and provider retry controls
remain separate. Approval/retry reconstruction resets local wrapper state; the persisted host is
the authoritative boundary. An older host without budget metadata can still report `call_budget`,
which the native runner recognizes.

## Verification and evaluation

Focused service, chat, gateway, history, and real MCP client/server tests cover the contract and
existing execution controls. `discovery-payload.test.ts` records the same PostHog catalog for both
representations. The fixture was captured on September 9, 2026 through source discovery; it
contains action definitions only. The PostHog JSON is gzip-compressed on disk to avoid storing
repeated schema structures as a large text file. Decompression restores the complete snapshot.
The Linear fixture contains two real action definitions used by the synthetic evaluation.

| PostHog descriptor arrays, excluding response envelopes | JSON characters |
| --- | ---: |
| Full listing, 15 descriptors | 498,714 |
| Compact listing, including source IDs | 4,205 |
| Complete insights-list, insight-get, and insight-query definitions | 9,944 |
| Compact listing plus those three definitions | 14,149 |

This is 99.16% less listing text and 97.16% less text for listing plus those three definitions.
These character counts are not tokenizer measurements, historical billing replays, or a forecast
of total billing savings. An explicitly requested large schema remains complete: the largest
fixture descriptor is 111,510 characters. Search, pagination, schema compression in tool results,
native provider tool injection, and prompt-cache diagnosis are outside this contract.

Run the focused model evaluation from the repository root:

```sh
infisical run --env=dev --path=/runner -- bun packages/agent/scripts/evaluate-action-discovery.ts
```

It uses Kimi K3 and the configured default Claude Code/Codex model IDs through AI Gateway, with
their configured reasoning options. All integration responses are mocked; it does not read or
write customer data. The approval case changes the fixture's save action to `ask` and uses actual
AI SDK approval request/response continuation, with a synthetic approval. Other cases exercise
saved insight results, a large trends query, a small integration, visible definitions on a
follow-up, and an unavailable action. Both contracts run twice, alternating order on the second
repeat. Real model inference is metered; the harness stops scheduling further model work after
its cost limit is reached.

`ACTION_DISCOVERY_EVAL_MODELS`, `ACTION_DISCOVERY_EVAL_CASES`, and
`ACTION_DISCOVERY_EVAL_REPEATS` can narrow the run. Calls run serially by default;
`ACTION_DISCOVERY_EVAL_CONCURRENCY` can change evaluation concurrency.
`ACTION_DISCOVERY_EVAL_OUTPUT` controls the JSON report path (default
`.context/action-discovery-eval.json`). Set `ACTION_DISCOVERY_EVAL_RESUME=1` to keep existing
results and schedule only missing cases after an interruption; the fixture hash must match.
Use a new report path when changing the contract or evaluation prompts. Reports include argument validity,
schema visibility, completion, discovery calls, input/output tokens, provider-reported cost, and
synthetic traces. The harness tests model behavior with the shared service and provider tool
protocol; adapter integration tests separately cover the Codex/Claude MCP transport. This small
suite does not establish universal model reliability or identical caching across providers.

### September 9, 2026 results

The final comparison contains 72 runs: six cases, two repeats, both contracts, and three models.
All 36 v4 and 36 v5 runs completed with valid executed arguments and complete schemas visible
before execution. There were no duplicate discovery requests, and every follow-up reused the
visible definition without discovery. All approval cases paused before the write and executed
the approved change once. Complex-query traces selected daily total pageviews and the requested
event-property breakdown; approval traces changed only the requested title.

| Model | v4 input tokens | v5 input tokens | Reduction | v4 cost | v5 cost | v4 / v5 discovery calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Kimi K3 (`moonshotai/kimi-k3`) | 1,251,046 | 202,090 | 83.85% | $1.793912 | $0.369331 | 10 / 20 |
| Claude Code default (`anthropic/claude-sonnet-5`) | 1,953,752 | 312,831 | 83.99% | $0.349186 | $0.085608 | 10 / 18 |
| Codex default (`openai/gpt-6-astra`) | 1,394,868 | 186,822 | 86.61% | $1.545779 | $0.835042 | 10 / 18 |

Tokens and costs above sum all model steps across each model's twelve runs per contract.
Costs are gateway-reported inference charges for these runs, with automatic caching enabled;
they are not a controlled cache comparison or predicted customer savings. Listing and description
are both counted as discovery calls. The saved-insight case fell from 2,702,251 to 108,930 input
tokens across models and repeats (95.97%); the complex-query case fell from 1,721,873 to 442,647
(74.29%). The approval case increased from 51,019 to 69,857 tokens (36.92%), illustrating that an
extra description step can cost more for a small catalog. Large individual schemas remain intact.

Failures were investigated before selecting this final comparison. An early string-pattern
constraint produced malformed Kimi tool arguments; the final contract uses a simple string schema,
an explicit array example, and boundary validation. Early Claude traces also exposed a missing
required parameter and execution before description; the final shared instructions explicitly
require the complete selected schema. A scoring bug initially rejected a harmless issue read
before an approved write; scoring now checks that the approved write itself occurs exactly once.

With the final instructions, Claude and Codex passed all 48 runs. Kimi initially had six incomplete
runs out of 24 under concurrent evaluation (one v4, five v5), followed by two v5 stops in a further
24-run concurrent check. Those responses stopped with reasoning content and no answer or tool
call; executed arguments remained valid. An eight-run diagnostic passed, then a serial rerun of
all 24 Kimi cases passed with unchanged instructions. The table uses that serial Kimi rerun and
the 48 Claude/Codex runs. The serial report was resumed after a sandbox interruption, preserving
completed cases. These results do not establish why the intermittent stops occurred, nor prove
that serial scheduling fixes them; no production retry or concurrency change was introduced.
