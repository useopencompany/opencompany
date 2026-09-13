# Harness bench

Run the real `runProductChatAgent()` prompt, action tools, governance and eight-step limit
against real gateway models. All integration execution is synthetic; no Linear or PostHog
account is contacted. The six discovery cases reuse the existing captured action schemas;
the two Linear regressions cover issue creation and an ambiguous update that must not write.

From the repository root (also available in `packages/agent`):

```sh
bun run bench --list
bun run bench --scenarios linear-file-issue --models moonshotai/kimi-k2.6 --k 4
bun run bench --scenarios tag:safety --k 1
bun run bench --scenarios small-integration --k 1 --save-baseline
bun run bench --scenarios small-integration --k 1 --compare
bun run bench --variant v4,v5 --models moonshotai/kimi-k2.6 --k 1
bun run bench --budget-usd 1 --concurrency 2
bun run bench --resume .context/bench/<timestamp>.json --budget-usd 5
```

`VERCEL_AI_GATEWAY_API_KEY` must be in the process environment or the repository's `.env.local`.
`--list` and `--help` need no key and make no model calls. Every actual trial is metered.
No extra production environment variables, database, dev server or hosted eval service is needed.

Defaults: all nine scenarios, k=4, v5, concurrency=1, $5 run budget. The small model set follows
the production router's answer models (Kimi K2.6 and Kimi K3) plus Sonnet 5. `--models` accepts
comma-separated exact `AGENT_MODEL_CATALOG` IDs. `--scenarios` accepts comma-separated IDs and
`tag:<tag>` selectors. `--variant` accepts v4, v5, or both. Other catalog models are opt-in.

Providers are pinned with `providerOptions.gateway.only`, using the model's native provider
(and DeepInfra for Meta and DeepSeek V4 Flash); an unavailable pinned route fails instead of
silently falling back. Qwen 3.8 Max uses Alibaba. For example:

```sh
bun run bench --scenarios linear-file-issue,linear-ambiguous-update --models deepseek/deepseek-v4-flash,alibaba/qwen3.8-max --k 4
```

See `providerFor()` when adding a model whose gateway provider differs from its ID prefix.
The catalog's reasoning options and gateway auto caching are preserved. Benchmark output is
capped at 4,096 tokens per model step, with no SDK retries; these controls are fingerprinted.
See [Gateway provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options).

## Reading results

The terminal prints each trial's status, tokens, real gateway dollars, wall-clock time, steps,
tool calls, invalid arguments and failure reasons. JSON in `.context/bench/` additionally keeps
fixture tool inputs/results, approval evidence and the production `opencompany.chat.debug.v1`
trace, including completed steps of failed/interrupted trials. SDK exception bodies, headers
and messages are never saved. Eval generations disable external telemetry export.

- **Pass rate:** successful completed trials / completed trials. Pending/interrupted trials are
  reported separately; they never make an incomplete k-group pass.
- **pass^k:** 1 when all k observed trials pass, 0 when a complete k-group includes a failure,
  unknown while the group is incomplete. The model summary averages this across scenario groups.
  This is an observed all-trials success measure, not an estimate with confidence bounds.
- **Tokens:** per-trial totals across every model step; case summaries show mean tokens/attempt.
- **Cost:** `providerMetadata.gateway.cost`, including failures and previous interrupted attempts.
  Missing cost stays unknown and stops further spending. $/success includes failed-attempt costs.
- **Duration:** wall-clock time including tool execution and synthetic approval continuation;
  summaries report p50. Cache hits and provider load affect both costs and timings.

The new Linear scenarios cost roughly $0.01 per Kimi K2.6 trial and $0.02–$0.04 per Kimi K3 or
Sonnet trial in the initial September 2026 validation; the cross-tool `posthog-linear-triage`
case ranged $0.002 (DeepSeek V4 Flash) to $0.12 (Kimi K3) per trial. A full default run is 108 trials; plan for
roughly $2–$5, with larger PostHog schemas or failures potentially costing more. Start with one
model and `--k 1`. These are observed planning estimates, not fixed provider prices.

## Baselines and resuming

`--save-baseline [path]` defaults to `.context/bench/baseline.json`. Incomplete runs never
replace a baseline. `--compare [path]` pairs identical scenarios/models and repeat indices,
prints changes in pass^k, tokens, dollars and duration, and shows configuration fingerprints.
It warns about unchanged fingerprints and differing models or k. A single baseline variant
can be compared with a different candidate variant; changed scenario fixtures/assertions are
not silently paired.

Fingerprints capture the **actual production-generated system prompt and tool schemas**, the
fixture catalog, the model catalog entry, pinned provider/options and harness/output limits.
The fixture date is fixed to avoid daily prompt drift. Scenario fingerprints also cover the
prompt, budgets, assertions, fixture functions and seeded history. Changing production prompting
moves the fingerprint without editing the benchmark. Tests exercise this directly.

`--resume <report>` inherits the original scenario/model/variant/k configuration and rejects
fingerprint or fixture drift before any model call. Completed trials are retained. Interrupted
trials restart as new attempts; their previous costs and evidence remain in the report. The
budget on resume is **cumulative**, including previous attempts. Reports are checkpointed after
each completed model step with serialized atomic file replacements. SIGINT/SIGTERM preserve
partial progress. Do not run two processes against the same report path.

The dollar cap stops admission of new model calls as soon as observed cost reaches the cap;
active calls drain and their reported costs are retained. **It cannot guarantee an exact billed
ceiling:** the gateway reports cost after generation, and already-running requests can cross the
cap (up to the concurrency setting). Interrupts/provider failures can also leave unreported
charges. Use concurrency=1 for the smallest overrun and an account-level spending limit when a
strict billing ceiling is required. A lost gateway cost is never treated as zero.

Exit codes: 0 = all passed/list/help, 1 = completed with failures, 2 = stopped/incomplete,
3 = invalid configuration/report. Unit tests run with `bun --cwd packages/agent test evals`;
there is intentionally no live-model CI gate.

## Adding a scenario

Add a `Scenario` under `scenarios/` and register it in `scenarios/index.ts`. Supply a sanitized
user prompt, tags, budgets, allowed actions, deterministic fixture results and outcome predicates.
The common grader checks action argument schemas with Ajv, prohibited tools/actions, schema
visibility before execution, repeated discovery, ask-mode approval ordering and quantitative
budgets. Schemas returned by parallel calls in the same model response are not yet visible.
For approval cases the adapter appends an SDK approval response and uses production's
`prepareProductChatStep({ finalizeAfterApproval: true })` for the final answer. The follow-up case
seeds a prior tool-result message so it checks reuse of an already-visible full schema.

Do not assert exact wording or a single valid tool trajectory. The v1 fixture surface is only
`list_actions`, `describe_actions` and `use_action`; other engines, judges, hosted dashboards,
recording production traces, and wiki/brain/browser fixtures remain out of scope.
