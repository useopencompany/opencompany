# Harness bench — agent evaluation v1

- Status: Proposed (scoped, not yet implemented)
- Tracking: Linear PRO-271 · broader north star in [Product and agent evaluations](./evaluations.md)
- Research basis: wiki `engineering/agent-evaluation-and-regression-testing`; production-trace
  analysis and external-practice research summarized below (2026-09-12)

## Intention

The unit we ship is neither a model nor a harness — it is the pairing. The same model behaves
very differently across scaffolds (Princeton HAL, Terminal-Bench same-model spreads, Cursor's
per-model edit-format findings), and even across serving providers behind one model slug
(opencode zen's premise). Public leaderboards therefore cannot tell us how a model behaves inside
our prompt, our action-discovery contract, and our step limits. Only our own bench can.

The harness bench is a small benchmark of real opencompany workloads that runs the exact
production chat harness so that any change to the pairing produces a number instead of a vibe:

- **(a) Regression** — does a prompt, tool-description, or harness change degrade behavior?
- **(b) Model matrix** — which models pass/fail a task on our harness, and how reliably?
- **(c) Economics** — true cost and wall-clock speed per completed task, per model.
- **(d) Tool optimization** — measure contract/output variants (like the existing v4-vs-v5
  discovery contract comparison) to cut tokens without losing task success.

Evals here are regression floors and measurement instruments, not product oracles. Dogfooding
stays the forward-looking quality signal; the bench catches what silently broke and makes the
pairing measurable.

## What already exists (verified 2026-09-12)

- **Injection seam**: `runProductChatAgent()` (`packages/agent/src/chat-agent.ts`) accepts the
  real system prompt, tool descriptions, and step limits with injectable per-tool runners and
  model resolution, and returns the same `opencompany.chat.debug.v1` trace production persists to
  `chat_messages.debug_trace`. One trace schema for prod and evals means promoting a production
  failure into a regression fixture is copying its trace parts into a scenario.
- **Working precedent**: `packages/agent/scripts/evaluate-action-discovery.ts` — standalone Bun
  eval with synthetic fixtures, Ajv argument validation, multi-model repeats, real dollar cost
  from gateway `providerMetadata.gateway.cost`, resumable JSON output. Verified live against the
  gateway (14 runs, 4 models, $0.24): the v5 discovery contract cut input tokens 18–45% vs the
  legacy v4 contract on identical tasks, and GPT-6 Astra cost ~10x Kimi K2.6 per completed task.
  Gaps: synthetic system prompt (not the production prompt), no duration tracking, no
  baseline-diff workflow, and cases too easy to discriminate models (all passed everything).
- **Production workload data** (prod DB, 45 days, opencompany engine): `use_action` dominates
  (~2.3k calls), then `web_search`, `wiki`, `web_fetch`, brain. Linear issue creation is the top
  write workload and a failure hotspot (~26% of `linear.create_issue` calls errored). Scenarios
  should come from these observed workloads and failures, not imagination.

## Design principles

1. **Run the real harness.** The runner drives `runProductChatAgent()` with the production system
   prompt, tool descriptions, and limits; only tool execution is fixture-backed. The model is
   real, called through the gateway with the provider pinned (otherwise the bench measures the
   route, not the model).
2. **Deterministic grading only (v1).** Outcome and trace-invariant assertions: correct action id,
   Ajv-valid params against the plugin manifest, prohibited calls absent, budgets respected.
   Never exact-wording or exact-trajectory assertions; ordering asserted only where policy
   requires it (e.g. describe-before-use). No LLM judges in v1.
3. **Repeats are table stakes.** Default k=4 trials per scenario x model; report pass rate and
   pass^k (all k succeed — the reliability number). Record cost of failed trials too; failures
   are often the most expensive runs.
4. **Baseline = JSON file + config fingerprint.** Every result carries a hash of (system prompt +
   tool contracts + model catalog entry). Comparisons are paired per-case on identical scenarios.
   No dashboards; the diff prints in the terminal.
5. **Hill-climb one change at a time.** Run on demand around a change; keep the change only if
   the numbers hold. No CI gating until flake rate and cost are understood.

## Scope: commands

All via one entry point, `bun run bench` (workspace script in `packages/agent`, implemented under
`packages/agent/evals/`). Requires `VERCEL_AI_GATEWAY_API_KEY`; every run is metered.

| Command | Purpose (maps to goal) |
| --- | --- |
| `bun run bench` | Run all scenarios, default model set, k=4. Prints per-scenario table + summary; writes JSON to `.context/bench/<timestamp>.json`. |
| `bun run bench --list` | List scenarios with tags and budgets. No model calls. |
| `bun run bench --scenarios <ids>` | Subset by scenario id or tag (e.g. `--scenarios tag:safety`). |
| `bun run bench --models <ids>` | (b) Model matrix: pass^k x $/task x p50 duration per model, paired on identical scenarios. |
| `bun run bench --k <n>` | Trials per scenario x model (default 4; use 1 for a cheap smoke run). |
| `bun run bench --variant <name>` | (d) Named harness variants as a run dimension (e.g. tool-contract `v4`/`v5`, a candidate tool-description set). |
| `bun run bench --save-baseline [path]` | (a) Write results as the named baseline, including the config fingerprint. |
| `bun run bench --compare [path]` | (a) Paired per-case deltas vs a baseline: pass^k, tokens, $, duration; warns when config fingerprints match (nothing changed) or model sets differ. |
| `bun run bench --budget-usd <n>` | Hard cost cap; the run stops cleanly and remains resumable. |
| `bun run bench --concurrency <n>` | Parallel trials (default small; provider-rate-limit aware). |

Non-flags deliberately out of scope for v1: `--judge`, `--ci`, `--record` (live-trace capture),
HTML reports.

## Scope: what a scenario can assert

A scenario is a TypeScript file in `packages/agent/evals/scenarios/` exporting: user message(s),
enabled tools, fixture responses, assertions, budgets, tags.

- **Outcome**: final text matches a predicate (substring/regex/custom function); a claimed write
  actually has a successful tool result behind it.
- **Tool trace**: required actions called with Ajv-valid params; prohibited tools/actions absent;
  schema retrieved before execution; no repeated identical discovery calls; argument invariants
  (e.g. exact issue id, only allowed param keys).
- **Approval flow**: `ask`-mode actions pause before execution and execute exactly once after a
  synthetic approval.
- **Budgets**: max steps, tool calls, input/output tokens, dollars, wall-clock duration.
- **Recorded per trial** (always, without asserting): tokens in/out, real $ cost, duration, step
  count, tool-call count, invalid-argument count, failure classification.

## Scope: initial suite (~8 scenarios)

Port the 6 existing action-discovery cases (saved-insight, complex-query, small-integration,
follow-up, unavailable, approval-resume), then add two derived from production traces:

1. `linear-file-issue` — "file a linear issue for this: <real sanitized bug note>". Asserts the
   discovery flow, exactly one `plugin:linear:linear.save_issue` with valid params (`team`,
   non-empty relevant `title`), no other writes, no unknown-source errors, <=6 steps. Targets the
   ~26% real-world failure rate.
2. `linear-ambiguous-update` — "update that linear issue about the sidebar" with two plausible
   matching issues in fixtures. Asserts no write action fires and the reply asks which issue.

v1 fixtures cover the action tools (`list_actions`/`describe_actions`/`use_action`) only — the
dominant production workload. Wiki/brain/web-tool fixtures, task/subagent scenarios, and the
other engines (`codex`, `claude_code`) are explicitly later.

## Non-goals (v1)

CI gating, LLM judges, simulated multi-turn users, dashboards or hosted eval platforms (the
optional Braintrust wrapper in `packages/observability` remains the upgrade path for trace
review), self-hosted Langfuse, a 30–50 case suite, and DB-backed world-state fixtures.

## Sequencing after v1

1. Evidence-based defaults: validate Auto-router model choices and `AGENT_MODEL_CATALOG` ratings
   with bench numbers.
2. Per-model tuning: capability flags and small per-model prompt deltas on one shared base
   prompt, each justified by a bench delta.
3. Token-efficiency program: concise-by-default action results, output truncation caps,
   cache-stable prompt prefixes — each idea lands as a `--variant` experiment first.
4. Prod-failure flywheel: a helper that scaffolds a scenario from a failed `debug_trace`, so
   production failure -> regression case -> never repeats.

## Key external references

- Anthropic: Demystifying evals for AI agents; Writing effective tools for agents (eval-driven
  tool descriptions, concise-by-default outputs); Adding error bars to evals (paired comparison,
  question-level resampling).
- Sierra tau-bench / tau2-bench (pass^k, final-state grading); Princeton HAL (accuracy-vs-cost
  Pareto, model x scaffold interactions); SWE-Effi (expensive failures).
- Practice: Cline (hill-climbing, in-repo mechanics evals), Amp (evals as regression floors),
  Aider (per-model format table + compliance metric), opencode-bench / opencode zen (real-workload
  tasks, model x provider benchmarking), Manus (KV-cache hit rate), Nous hermes-agent (subsystem
  behavioral probes).
