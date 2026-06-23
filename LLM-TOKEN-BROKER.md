# LLM Token Broker — Plan & Progress

> Status tracker for the V2 key architecture: sandboxed CLIs never see raw provider
> keys; the runner brokers every model call and meters it server-side as the billable
> record. Started 2026-06-11 off the PR #424 (codex) "no API key" problem.

## The problem

Agent sessions execute in agent-controlled E2B cloud sandboxes. Anything in the
sandbox process env is readable by the agent and by prompt-injected repo content.
Before this work:

1. `VERCEL_AI_GATEWAY_API_KEY` **and** `E2B_API_KEY` were injected globally into every
   sandbox at creation (`session-lifecycle.ts` → `ensureSandbox`), and per-command for
   the opencode tool and the memory CLI subprocess.
2. The codex tool (PR #424) would have added a third raw key (`OPENAI_CODEX_API_KEY` →
   `CODEX_API_KEY` in the sandbox).
3. Billing for hosted-tool runs was parsed from the CLI's own JSONL output —
   self-reported by a process inside the sandbox, i.e. honest-actor accounting. A
   leaked key allows spend that never appears in our books.

## The concept

A runner-hosted **reverse proxy ("LLM broker")** plus **per-delegation tokens**:

```
E2B sandbox (CLI: opencode / codex / memory)
   │   Bearer ocbt_<random>            ← short-lived, per tool call, worthless after revoke
   ▼
Runner  /broker/:provider/v1/*         ← Fastify plugin, public URL (Render)
   │   validate token (DB, multi-instance), provider + tool endpoint scope → 401/402/403
   │   attach real key server-side; upstream pinned per provider
   │   stream response → client (byte-identical) while usage scanner settles before close
   │   recordSpend per request (llm_broker_requests + token counters)
   ▼
Upstream: gateway → ai-gateway.vercel.sh/v1   (VERCEL_AI_GATEWAY_API_KEY)
          openai  → api.openai.com/v1         (OPENAI_CODEX_API_KEY)
```

**Billing model.** Broker metering is the source of truth: each token settles into
exactly one `agent_session_tool_usage` row (`operation: "brokered"`,
`costSource: "broker_metered"`) debited through the existing ledger idempotency. The
CLI's self-reported JSONL usage stays for activity display but bills 0 — no double
counting, no trust in sandbox output. Settlement deliberately bypasses the run-lease
guard (upstream spend must bill even after a lease reclaim); the atomic `settled_at`
CAS is the single-winner defense. Unpriceable requests record zero cost with
`usageParsed=false` — billing never guesses.

**Token lifecycle.** Mint at hosted-tool start (TTL = tool timeout + slack, default
budget = $5/delegation) → revoke + settle in the tool's `finally` → backstops at
`archiveSession`/`abortSession` → leftover sweeper piggybacked on the 60s stale-run
sweep (runner-death coverage).

**Compatibility posture.** Tokens are scoped to provider + tool endpoint family, not to
one exact model string. That means a `codex_coder` token can call OpenAI Responses API
routes but not Gateway chat/embeddings; a future Codex model rename should not require a
broker release. If Codex starts using a new endpoint, we want an explicit 403 + smoke-test
failure rather than silently opening arbitrary OpenAI routes.

**Activation.** Broker is on iff `RUNNER_LLM_BROKER_PUBLIC_URL ?? RENDER_EXTERNAL_URL`
is set AND `RUNNER_LLM_BROKER_ENABLED !== false`. Local dev has no E2B-reachable URL →
legacy direct key injection, byte-for-byte unchanged. The env flag is a no-deploy kill
switch. (Deliberately NOT the web-side `RUNNER_PUBLIC_URL`, which is localhost in the
local `.env` the runner also loads.)

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Billable source of truth | Broker metering; JSONL display-only at cost 0 |
| Amp | **Out of scope** — own backend (ampcode.com) + reliable `provider_reported` per-thread cost; keeps direct `AMP_API_KEY` injection |
| Local dev | Fallback to direct key injection when no public URL |
| Global sandbox keys | Removed on the brokered path (kept on legacy fallback for one release) |
| Token format | Opaque `ocbt_` + 48 hex, SHA-256 hash at rest, DB-validated (multi-instance) |
| Token scope | Provider + tool endpoint family; no exact model binding in v1 |
| Per-request pricing | Gateway-reported cost → `MODEL_PRICING` → `AUX_GATEWAY_MODEL_PRICING` → zero (never estimate) |
| Budgets | Hard-coded `$5` default per broker token/delegation; explicit lower overrides allowed |
| Codex broker env var | `OPENCOMPANY_LLM_BROKER_TOKEN` via Codex provider `env_key`, not `CODEX_API_KEY` |
| Infra placement | Keep broker in the runner for v1; split only if broker traffic/ownership becomes independently scaling |

## Infra placement

The runner is the right home for v1.

- It already owns the session execution lease, sandbox lifecycle, tool timeouts, abort/archive
  paths, and the DB writes that settle model/tool/sandbox usage. Putting the broker here keeps
  the token lifecycle and the billable row in one data plane.
- It is long-lived on Render, which is what streaming model calls and E2B command streams need.
  The Next.js API layer is the wrong fit: serverless request duration, streaming behavior,
  deployment coupling, and public web auth concerns would all become harder.
- A dedicated broker service is a good future extraction only if broker traffic needs independent
  scaling, multi-region routing, or provider governance separate from session execution. Today it
  would add another deployable, DB client, secret surface, and cross-service settlement protocol
  before the product has proven Codex volume.

So the boundary is: **web starts sessions, runner executes and brokers session-owned model
traffic, Postgres remains the accounting source of truth.**

## Progress

### ✅ Phase 1 — Broker infrastructure (PR [#439](https://github.com/useopencompany/opencompany-experimental/pull/439))

- [x] Migration `0055`: `llm_broker_tokens` (auth, lifecycle, denormalized totals) +
      `llm_broker_requests` (per-upstream-request audit rows)
- [x] `apps/runner/src/llm-broker.ts` — routes, auth matrix, upstream pinning,
      `include_usage` injection, SSE passthrough with finalizer metering (byte-identical under test)
- [x] `llm-broker-tokens.ts` — mint/validate/spend/revoke/settle store + `settled_at` CAS,
      `withBrokerDelegation` wrapper, default `$5` token budget
- [x] Tool-scoped endpoint authorization (`codex_coder` → Responses, `opencode_coder` → chat,
      `memory` → chat/embeddings) without exact model binding
- [x] `llm-broker-usage.ts` — usage parsers (chat SSE, Responses API `response.completed`,
      embeddings, gateway cost field) + pricing
- [x] Billing: `HostedToolCostSource` += `broker_metered`; `AUX_GATEWAY_MODEL_PRICING`
      shared by memory tool + broker
- [x] opencode wired (config → `/broker/gateway/v1`, `OPENCOMPANY_LLM_BROKER_TOKEN` env)
- [x] memory CLI wired (`MEMORY_GATEWAY_BASE_URL` + token; CLI bundle regenerated)
- [x] Global sandbox env injection of `E2B_API_KEY` + `VERCEL_AI_GATEWAY_API_KEY`
      removed when broker active
- [x] Lifecycle: tool `finally`, archive/abort settlement, leftover sweeper
- [x] Env/docs: `.env.example`, `docs/env-vars.md`, `docs/runner.md`,
      `docs/secret-management.md`, `docs/stack/ai-and-agent-runtime.md`, `render.yaml`
- [x] Tests: 38 new broker tests + extended opencode/memory/billing suites; full
      lint/typecheck/build/test/format green

### ⬜ Phase 2 — Codex through the broker (PR B, on top of #424 + #439)

- [x] Port `louismorgner/codex-tool-plan` (PR #424) onto the broker infra
- [x] Write `${CODEX_HOME}/config.toml` custom provider:
      `model_provider = "opencompany"`, `base_url = <publicUrl>/broker/openai/v1`,
      `env_key = "OPENCOMPANY_LLM_BROKER_TOKEN"`, `wire_api = "responses"` — schema verified
      against pinned `@openai/codex@0.132.0` with `--strict-config`
- [x] `OPENCOMPANY_LLM_BROKER_TOKEN` env carries the broker token; relax the key-required guard to
      "broker active OR raw key present"
- [x] `codexHostedToolUsage` → display-only (cost 0, `broker_metered`) when brokered
- [ ] Infisical `prod` `/runner`: add `OPENAI_CODEX_API_KEY` as a **budget-capped
      OpenAI project key** (blast-radius cap; reconciliation/alerts can follow after v1)

### ⬜ Phase 3 — Preview verification (after #439 deploys to a preview)

Run an opencode delegation + a memory query on a PR preview (preview runner gets
`RENDER_EXTERNAL_URL` automatically → broker auto-active), then assert:

- [ ] `llm_broker_requests` rows exist with `usage_parsed = true`
- [ ] Exactly **one** `workspace_credit_ledger` debit per delegation, with
      `metadata.brokerTokenId`
- [ ] The JSONL display row records cost 0 (`broker_metered`)
- [ ] Inside the sandbox: `env | grep -c 'VERCEL\|E2B'` → 0
- [ ] During Codex invocation, `OPENCOMPANY_LLM_BROKER_TOKEN` is present and `CODEX_API_KEY`
      / `OPENAI_CODEX_API_KEY` are absent
- [ ] Session cost UI shows the brokered cost exactly once
- [ ] Watch opencode TTFT / long-SSE behavior through Render's proxy (latency hop)

### ⬜ Phase 4 — Cleanup (PR C, after prod soak)

- [ ] Drop the legacy *global* sandbox key injection unconditionally (the per-tool
      direct-injection fallback stays as the documented local-dev path)
- [ ] Optional: label `operation: "brokered"` nicely in the web tool-usage breakdown
- [ ] Optional: project-spend reconciliation alert: OpenAI project spend vs
      `llm_broker_requests` totals, unparsed usage count, and record-spend failures

## Open risks / watch items

- **Codex live smoke** still required against the pinned CLI version. The config schema was
  verified with `@openai/codex@0.132.0 --strict-config`
  (`model_providers`, `base_url`, `env_key`, `wire_api = "responses"`), but only a live
  brokered `codex exec` proves streaming + usage shape end-to-end.
- **Render proxy + long SSE**: model streams emit continuously so idle timeouts should
  not trigger; verify on preview with a long opencode run.
- **Gateway `stream_options.include_usage`** for non-OpenAI routed models (e.g.
  Anthropic via the OpenAI-compat endpoint): broker injects it; confirm the gateway
  honors it across providers. Fallback is the zero-cost + `usageParsed=false` path.
- **`agent_session_tool_usage.cost_usd_micros` is `integer`** (~$2,147 cap per row) —
  fine per delegation; revisit if budgets grow.
- **Rollback**: `RUNNER_LLM_BROKER_ENABLED=false` in Infisical reverts everything to
  direct injection + legacy billing without a deploy.

## Out of scope (explicitly)

- **Amp** — brokering it would be key-concealment only; depends on an unverified CLI
  server-URL override and its billing is already reliable per-thread.
- **Main agent loop** — already calls the gateway from the runner process
  (`model-turn.ts`); key never entered the sandbox.
- **GitHub installation tokens in the sandbox** — separate trust problem, not an LLM
  key; unchanged here.
