# Measured result and production decision

## Decision

**Use this hybrid as Goat's target tool-orchestration architecture, but do not ship this spike as a general multi-tenant production runtime yet.**

The production-worthy design is not “one execute tool replaces every tool.” It is:

1. progressively discover a small capability set;
2. materialize complete typed contracts before action generation;
3. use direct typed calls for single operations, semantic decision boundaries, and every write;
4. use bounded code only for read-only fan-out, joining, filtering, and reduction;
5. enforce capabilities, authorization, retry, and completion policy host-side.

This control-plane architecture is ready to integrate behind a feature flag. The experiment's `node:vm` worker is not an acceptable tenant isolation boundary, so programmatic execution must remain out of broad production until it runs in a real per-tenant isolate or microVM with the controls listed below.

## Why this shape

The design follows the common ground in the official guidance:

- [Anthropic's advanced tool-use guidance](https://www.anthropic.com/engineering/advanced-tool-use) combines deferred tool search, full definitions and examples, and programmatic calling. It recommends code for large or multi-call transformations, but direct calls for simple operations or cases where the model should reason over intermediate results.
- [OpenAI's GPT-5.4 tool-search results](https://openai.com/index/introducing-gpt-5-4/) report that lazy definition loading reduced tokens by 47% at the same accuracy on MCP Atlas. OpenAI's newer [Agents SDK architecture](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) likewise couples progressive disclosure with controlled sandbox execution rather than treating ambient code execution as authority.
- [Cloudflare's sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/) uses a separate VM per sandbox and explicitly leaves authentication, authorization, validation, and rate limiting to the application. That is the minimum production isolation direction for generated code.

The initial execute-only spike violated the most important ordering constraint: generated code had to interpret schemas discovered only after the code was written. This version loads exact input/output contracts first. It also keeps writes out of code, so a syntax repair or program retry can never duplicate a side effect.

## Final architecture

- **Discovery:** one forced `load_tools` call over a 100-tool catalog. Search indexes names, descriptions, and input schemas, then reranks with operation order, rare terms, and read/write effect.
- **Read breadth:** two top read candidates absorb harmless synonyms such as “get” versus “fetch.”
- **Write breadth:** one candidate only, and it must match every explicit write action term after conservative aliases such as `broadcast -> send`.
- **Typed action phase:** selected contracts become normal JSON-schema tools plus TypeScript definitions and realistic examples.
- **Hybrid execution:** direct tools handle writes, single calls, and fresh semantic reasoning. `execute` receives a complete JavaScript function body only for bounded read orchestration.
- **Fail-closed completion:** one host continuation may recover an omitted read. Missing writes are never automatically repaired.
- **Mutation policy:** writes are disabled inside `execute`, direct writes are limited to one attempt per path, and duplicate writes are blocked.
- **Capability policy:** generated code can call only loaded paths, with host-side schema validation, a 12-call budget, timeout, memory ceiling, output ceiling, and structured traces.

## Measurements

Final primary run: 2026-07-17, `anthropic/claude-sonnet-5`, the exact shared 15-task corpus repeated five times, and the shared catalog of 100 mock tools (20 each for Linear, Attio, Slack, GitHub, and Notion).

| Strategy                          |           Passed | Total tokens/task | Complete model round-trips/task | Notes                                                                                 |
| --------------------------------- | ---------------: | ----------------: | ------------------------------: | ------------------------------------------------------------------------------------- |
| Flat schemas                      |      14/15 (93%) |            47,668 |                            3.00 | Earlier shared baseline, one repetition                                               |
| Lazy tiered                       |     15/15 (100%) |             8,861 |                            4.53 | Earlier shared baseline, one repetition                                               |
| Execute-only                      |       8/15 (53%) |             2,183 |                            1.00 | Not comparable: stopped at execute result, omitted final response, and failed 7 tasks |
| **Progressive typed hybrid**      | **75/75 (100%)** |         **8,108** |                        **3.44** | Five repetitions, complete final response                                             |
| Progressive typed hybrid, GPT-5.4 |     15/15 (100%) |             3,966 |                            3.53 | Cross-model probe, one repetition                                                     |

Against the tiered baseline, the primary run used **8.5% fewer tokens** and **24.1% fewer model round-trips** at the same measured reliability. Against flat exposure it used **83.0% fewer tokens**, though flat averaged 0.44 fewer model turns because all definitions were already present.

Primary-run instrumentation:

| Metric                           |            Result |
| -------------------------------- | ----------------: |
| Input / output tokens per task   |       7,610 / 498 |
| Discovery calls per task         |              1.00 |
| Loaded / invoked paths           |         194 / 130 |
| Unused loaded contracts per task |              0.85 |
| Execute attempts                 | 5 across 75 tasks |
| Completion continuations         |                 0 |
| Sandbox/code failures            |                 0 |
| Capability-policy denials        |                 0 |

Only `five-source-digest` used code: five independent reads were invoked in parallel and reduced to compact evidence. It completed in three full model turns in every Claude repetition. This is the strongest evidence for code mode. The other 14 tasks correctly preferred direct typed calls, so the aggregate result mostly validates progressive typed discovery and safe mode selection—not universal code execution.

### Tool-error recovery

The injected task inspected a GitHub PR, attempted a merge that deterministically failed branch protection, and sent the exact rejection to Slack.

| Strategy                     |  Passed | Tokens/task | Model round-trips/task |
| ---------------------------- | ------: | ----------: | ---------------------: |
| Flat                         |     yes |      63,448 |                      4 |
| Lazy tiered                  |     yes |      16,621 |                      6 |
| Execute-only                 |      no |       2,397 |                      1 |
| **Progressive typed hybrid** | **5/5** |  **15,385** |                  **5** |

The direct merge call was attempted once, its exact domain error remained in the trace, and Slack received that evidence. There was no write retry and no code execution.

### Cross-model behavior

`openai/gpt-5.4` passed 15/15. Its five-way program first emitted `async function() { ... }`, producing the exact syntax error `Function statements require a function name`. The single bounded code repair removed the wrapper and succeeded. The program, stack, failure category, invocation trace, and corrected program made this easier to diagnose than a generic failed tool call.

This is also a useful warning: even a successful task can contain a code-generation failure. Production metrics must count attempts and repairs, not only final task success.

## What failed while refining it

Intermediate repeated runs exposed three implementation-quality problems:

1. A two-result default encouraged an unnecessary Slack channel lookup and caused the model to stop before sending.
2. name/summary-only lexical ranking confused `github.create_pull_request` with `github.create_review`.
3. an overly narrow read search sometimes confused collection tools; worse, an early completion policy turned a mistaken `linear.create_issue` retrieval into an unintended mock write.

The final version addresses these by indexing full input metadata, using operation/effect-aware ranking, returning multiple candidates only for reads, and prohibiting automatic write completion. That unintended mock write is the strongest reason not to ship a generic “model searches, then execute does everything” design.

## Security result

Seventeen focused tests pass. They cover typed discovery, search regressions, conservative read/write effect separation, obligation tracking, unloaded paths, disabled and less-obvious writes, duplicate writes, absent Node/network globals, constructor string-code escape, dynamic imports, call quotas, runaway-code timeout, bounded log serialization, and trace behavior.

The spike still uses a constrained child process plus `node:vm`. It limits the worker environment, disables string/Wasm code generation, exposes only frozen `tools` and `console` objects, validates every RPC host-side, and kills the process on timeout. Those are useful layers, **not** a secure multi-tenant boundary.

## Required before production

1. Replace `node:vm` with a fresh V8 isolate or microVM per tenant/execution; deny ambient filesystem and egress by default.
2. Keep credentials host-side and mint short-lived, tenant-scoped capability grants for each allowed tool path.
3. Preserve direct typed writes, add existing Goat approval policy for consequential actions, and require idempotency keys plus durable mutation receipts.
4. Add cancellation, CPU/memory/tool/output quotas, rate-limit propagation, pagination limits, and durable redacted audit traces.
5. Evaluate real-shaped integration responses: empty pages, pagination, auth expiry, rate limits, partial failures, malformed upstream data, and prompt injection embedded in tool output.
6. Run a larger held-out semantic-retrieval corpus so ranking changes cannot be tuned only to these 15 tasks.
7. Roll out read-only execute behind a feature flag first. Keep writes on the existing direct-tool/approval path until production incident and rollback behavior is proven.

## Reproduction artifacts

The harness is in this directory and imports the exact shared tasks and catalog. Raw traces are gitignored locally:

- `.context/progressive-typed-code/final-v2-sonnet-repeats-5.json`
- `.context/progressive-typed-code/final-fault-repeats-5.json`
- `.context/progressive-typed-code/final-gpt54-once.json`

Run the focused tests with:

```bash
bun run --filter @opencompany/goat test -- experiments/progressive-typed-code/progressive-typed-code.test.ts
```
