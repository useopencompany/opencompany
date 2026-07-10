# Observability

OpenCompany observability is intentionally narrow: production error capture, structured server
logs, runtime context, Braintrust runner traces for opted-in agent debugging, and a short debugging
path for failed agent sessions.

Better Stack receives errors through its Sentry-compatible DSN and production server logs through
platform log drains. The repo-owned `@opencompany/observability` package provides the app-facing
API:

- `createLogger` for structured JSON logs
- `captureException` for handled failures
- `sanitizeLogFields` for safe metadata
- `flushObservability` for process shutdown

## Operating Model

- Server logs explain backend behavior.
- Browser errors explain client crashes.
- PostHog explains product behavior.
- Client logs are opt-in only after a specific debugging need.

Do not add broad browser log forwarding, `@logtail/browser`, global `console.*` capture, PostHog
console log recording, or session replay for this slice. Browser console, network, and replay data
can expose prompts, agent output, file contents, URLs, tokens, and user-authored text.

## Configuration

Remote error capture is disabled when no Better Stack DSN is set or
`OBSERVABILITY_ENABLED=false`.

```sh
OBSERVABILITY_ENABLED=true
OBSERVABILITY_ENV=production
OBSERVABILITY_LOG_LEVEL=info
OBSERVABILITY_TIMING=0
BETTER_STACK_ERRORS_DSN=https://...
```

Braintrust runner tracing is disabled unless it is explicitly enabled and keyed:

```sh
BRAINTRUST_ENABLED=false
BRAINTRUST_API_KEY=...
BRAINTRUST_PROJECT_ID=...
BRAINTRUST_PROJECT_NAME="OpenCompany Runner"
```

When enabled, Braintrust captures runner-only agent traces: agent turn spans, model stream spans,
tool and MCP calls, delegation, sandbox hydration, Brain sync, exposed reasoning summaries, and run
outcomes. This intentionally captures prompt/model/tool content for debugging. Keep it disabled in
environments where full AI content must not leave the platform.

The model call is traced by Braintrust's default `wrapAISDK` integration (via `getBraintrustAISDK`,
which wraps the `ai` namespace and no-ops to the unwrapped SDK when Braintrust is disabled). `wrapAISDK`
opens the `streamText` and per-step `doStream` LLM spans automatically, capturing the chat transcript,
per-step tool calls and results, token usage, and the model slug — Braintrust derives estimated cost
from the model plus those token metrics. The spans nest under the per-turn root span opened by
`traceBraintrust`. Runtime and MCP tool execution is captured by `wrapAISDK` as the tool-call /
tool-result pair on that trace; we no longer open manual `tool.*` spans. Tool failures are still
reported to Better Stack via `captureException`.

We lean on the defaults that the AI SDK and Braintrust expose rather than hand-rolled instrumentation.
The Better Stack timing trace remains a separate concern: `model_stream_total` and
`model_first_stream_part` are timed via `timeAsync`, and the surrounding non-LLM steps (session/message
loads, lease, sandbox hydration, brain sync, delegation) still open Braintrust step spans via
`observeRunStep` so a turn reads coherently.

Accepted tradeoff: `wrapAISDK` closes its streaming LLM span when the result stream drains, with no
cancel handler. The runner consumes `result.fullStream` itself and cancels it (`iterator.return()`) on
mid-stream abort or suspend (`ask_user_question`, tool-approval suspend, stream error), so on those
paths the LLM span can remain "in progress" with no usage logged. This is a known limitation of every
default AI-SDK integration and is accepted in exchange for using the defaults; the turn still completes
or suspends correctly, billing is unaffected (usage is recorded to the DB independently), and the root
span plus timing trace stay intact. Each run flushes Braintrust (`flushBraintrust()` in a `finally`
around the root trace) so end-of-run spans are delivered promptly.

Hosted releases get commit attribution automatically: Vercel/Render expose server commit metadata,
and the production workflow injects the released SHA into the web build for browser captures. Use
`OBSERVABILITY_RELEASE` only for manual or non-Git deploys where platform metadata is unavailable.

For the web app, setting only the public DSN is enough when server and browser errors should use
the same Better Stack application:

```sh
NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN=https://...
```

`BETTER_STACK_ERRORS_DSN` remains available as a server-side override when the runner or web server
should report to a different Better Stack application.

Production logs are forwarded by the hosting platforms, not by app-side source tokens:

- Vercel web logs: Better Stack source `opencompany-web-production`.
- Render runner logs: Better Stack source `opencompany-runner-production`.
- Render preview runner logs: shared Better Stack Render source `opencompany-runner-preview`
  (`source_id=2511725`; one source for all PR previews; query by `preview_pr_number` and
  `session_id`).

Keep source tokens in Better Stack/Vercel/Render/Infisical configuration only. Do not commit source
tokens, Logtail browser tokens, or OTLP exporter credentials.

## Status Page

The public product status page is hosted in Better Stack at `https://status.opencompany.cloud`.
Keep it focused on customer-visible product availability:

- `Application`: Better Stack keyword monitor for `https://my.opencompany.cloud/api/healthz`,
  requiring `"service":"opencompany-web"`.
- `Agent runtime`: Better Stack keyword monitor for the production `RUNNER_PUBLIC_URL` `/healthz`,
  requiring `"service":"opencompany-runner"`.

Both monitors should use `GET`, SSL verification, redirects, the `eu`, `us`, `as`, and `au`
regions, a 180 second check frequency, a 30 second timeout, and 180 second confirmation and
recovery periods. The status page should use the custom domain `status.opencompany.cloud`, expose
90 days of history, allow subscriptions, and automatically create reports for monitor incidents.

Do not expose the existing `opencompany.cloud` website monitor on the v1 product status page. Keep
third-party dependencies such as Vercel, Render, Neon, WorkOS, Inngest, and model providers off the
page unless they become manually tracked components with a clear incident communication policy.

The DNS record for the custom domain is a CNAME from `status.opencompany.cloud` to
`statuspage.betteruptime.com`. If the domain is managed through Cloudflare, keep this record in
DNS-only mode.

Server startup emits one reporter diagnostic per runtime:

- `opencompany.observability_reporter_registered`: server-side Better Stack/Sentry reporter was
  registered.
- `opencompany.observability_reporter_skipped`: reporter registration was skipped. Check `reason`,
  `next_runtime`, `has_server_dsn`, and `has_public_dsn`.

If handled server exceptions only show `observability_reporter=local`, verify
`OBSERVABILITY_ENABLED`, `BETTER_STACK_ERRORS_DSN`, `NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN`,
`OBSERVABILITY_ENV`, and `OBSERVABILITY_LOG_LEVEL` in the deployed web runtime. The diagnostic logs
only record whether DSNs are present, never their values.

## Safe Log Content

Allowed log fields:

- internal IDs such as `workspace_id`, `user_id`, `agent_id`, `session_id`, and `message_id`
- coarse status enums, durations, counts, route names, release, environment, and service name
- provider/model names and sandbox ids

Do not log prompts, model output, command output, command bodies, agent file text, repo file
contents, tokens, secrets, emails, browser URLs with query strings, or other free-form user text.

Braintrust traces are the exception to the prompt/output rule when `BRAINTRUST_ENABLED=true`. We use
the default `wrapAISDK` integration with no custom field-level masking, so prompts, model output, tool
inputs, and tool results are captured verbatim. Input/output capture is governed only by the AI SDK /
`wrapAISDK` defaults (`recordInputs`/`recordOutputs`). Treat Braintrust access as production data
access, and keep Braintrust disabled in environments where full AI content must not leave the platform.

## Goat Run Outcomes

Goat signups, chat turns, task runs, and Brain agent ingest jobs emit a first-layer health signal
through `@opencompany/goat-observability` when `GOAT_OBSERVABILITY_ENABLED=true` and
`GOAT_OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Use SigNoz for the aggregate view:

- `goat.signups_total` grouped by `goat.signup_source`
- `goat.runs_total` grouped by `goat.surface`, `goat.outcome`, and `goat.failure_category`
- `goat.run_duration_ms` grouped by `goat.surface`
- `goat.chat.turns_total` and `goat.chat.turn_duration_ms`
- `goat.task_runs_total` and `goat.task_run_duration_ms`
- `goat.brain_ingest_runs_total` and `goat.brain_ingest_run_duration_ms` for Brain agent ingest jobs

Safe metric dimensions are intentionally low-cardinality: signup source, surface, outcome, failure
category, model, status, stage, task-started boolean, Brain ingest kind/source provider/source type,
and web-search provider/operation. Do not put run IDs, user IDs, source refs, prompts, tool args, or
result text on metrics.

Use traces or structured logs for investigation IDs:

| Surface | Terminal event | Primary DB lookup IDs |
|---|---|---|
| Goat signup | `goat.signup.completed` | none |
| Goat chat | `opencompany.goat_chat_turn_finished` | `chat_session_id`, `chat_message_id`, optional `task_id` |
| Goat task | `opencompany.goat_task_run_finished` | `task_id`, `display_id` |
| Brain agent ingest | `opencompany.goat_brain_ingest_run_finished` | `job_id`, `source_item_id`, `brain_ref` |

Suggested SigNoz dashboard panels:

- New Goat signups per day: count spans named `goat.signup.completed` with a 1 day interval
- Total Goat runs: `sum(goat.runs_total)` grouped by `goat.surface`
- Success rate: successful runs divided by total runs, grouped by `goat.surface`
- Failure rate: failed runs divided by total runs, grouped by `goat.surface`
- Failures by category: `sum(goat.runs_total{goat.outcome="failure"})` grouped by
  `goat.surface` and `goat.failure_category`
- p95 duration: `p95(goat.run_duration_ms)` grouped by `goat.surface`
- Brain agent ingest failures by source: `goat.brain_ingest_runs_total` grouped by
  `goat.source_provider` and `goat.source_type`

Suggested first alerts:

- Goat failure rate above 10% for 15 minutes, grouped by `goat.surface`.
- Brain agent ingest has zero successful runs for 30 minutes while failures are present.
- Any `goat.failure_category="auth"` spike, grouped by surface.
- p95 `goat.run_duration_ms` doubles against the previous hour for chat or tasks.

For DB follow-up:

```sql
-- Goat chat
select id, title, model, engine, closed_at, updated_at
from goat.chat_sessions
where id = '<chat_session_id>';

select id, role, task_id, created_at, updated_at
from goat.chat_messages
where id = '<chat_message_id>';

-- Goat task
select id, display_id, status, stage, error, model, updated_at
from goat.tasks
where id = '<task_id>' or display_id = '<display_id>';

-- Brain ingest
select id, source_item_id, status, attempts, last_error, completed_at, updated_at
from goat.brain_ingest_jobs
where id = '<job_id>';
```

## Failed Agent Run Checklist

When a user reports that an agent failed:

1. Collect the visible `session_id` from the URL or database.
2. Search Better Stack errors for `session_id`.
3. If no error is found, search runner logs for `session_id`.
4. Inspect the durable event stream:

```sql
select id, type, payload, created_at
from agent_session_events
where session_id = '<session_id>'
order by id asc;
```

5. Check the latest session state:

```sql
select id, status, last_error, e2b_sandbox_id, model_provider, model_name, updated_at
from agent_sessions
where id = '<session_id>';
```

Prefer these correlation fields in all handled captures:

- `workspace_id`
- `user_id`
- `agent_id`
- `session_id`
- `message_id`
- `sandbox_id`
- `model_provider`
- `model_name`

### Preview Sessions

For hosted PR previews, run the read-only debugger before the preview stack is torn down:

```sh
PREVIEW_DATABASE_URL="$PREVIEW_NEON_URL" \
  bun run preview:debug-session -- --pr <number> --session <session_id>
```

The script opens a `READ ONLY` transaction, runs only `SELECT` queries, rolls back, and prints:

- session status, last error, model, sandbox, and run-lease state
- runner job state and last errors
- message role/status/timing summaries with content lengths only
- selected runtime event summaries without raw event payloads
- approval/question states and usage totals
- Better Stack searches for the shared preview source

Use `BETTER_STACK_PREVIEW_SOURCE_NAME` only if the shared source is named differently. Do not pass or
paste raw database URLs in issue comments or logs; keep preview DB access in the operator shell.

## What To Look For

- `opencompany.runner_start_failed`: runner failed while provisioning a session.
- `opencompany.runner_message_failed`: model call, sandbox call, or runtime loop failed.
- `opencompany.runner_sandbox_failed`: E2B create/connect/prepare failed.
- `opencompany.runner_tool_failed`: a runtime tool failed. Hosted tools include searchable fields
  such as `hosted_provider`, `hosted_operation`, `tool_error_stage`, and `tool_error_code`.
  For example, unsupported Exa company/people filters are tagged as
  `tool_error_code=exa_unsupported_category_filter_combination`.
- `opencompany.runner_request_failed`: web/Inngest could not call the runner.
- `opencompany.runner_request_succeeded`: web/Inngest successfully handed work to the runner.
- `opencompany.runner_request_fallback`: direct web-to-runner dispatch failed or was unavailable,
  and web fell back to Inngest.
- `opencompany.runner_session_start_accepted`: runner accepted a session start request.
- `opencompany.runner_message_run_accepted`: runner accepted a message run request.
- `opencompany.runner_session_ready`: runner provisioned the session sandbox.
- `opencompany.runner_session_running`: runner started executing a user message.
- `opencompany.runner_session_completed`: runner completed a user message.
- `opencompany.runner_session_aborted`: runner stopped a message after an abort.
- `opencompany.runner_session_failed`: runner failed a message run.
- `opencompany.durable_stream_publish_failed`: runner could not append a runtime event to the
  session Durable Stream.
- `opencompany.durable_stream_proxy_read`: web proxy read from a session Durable Stream; check
  `status` and `retried_after_create`.
- `opencompany.durable_stream_proxy_create_failed`: web proxy could not create a missing stream
  before retrying a read.
- `opencompany.agent_sync_job_queued`: the app enqueued or coalesced a `workspace_sync_jobs` outbox
  row after an agent edit. Check `agent_id`, `workspace_id`, `path`, `desired_version`, and
  `next_run_at`.
- `opencompany.workspace_sync_dispatch_succeeded`: the app sent `workspace.sync_requested` to
  Inngest after a workspace write. Check `inngest_event_ids`.
- `opencompany.workspace_sync_dispatch_failed`: the app could not send the Inngest event after the
  DB write. Check `error_name` and `error_message`.
- `opencompany.workspace_projection_capped`: due jobs exceeded the per-commit cap; the remainder
  stays pending for the next drain iteration. Check `due` and `committing`.
- `opencompany.workspace_github_sync_failed`: the projector's single-commit push to the managed
  GitHub repo failed. Check `workspace_id`, `jobs`, and `error_message`.
- `opencompany.sync_outbox_recovery_dispatched`: the once-a-minute sweeper re-dispatched
  `workspace.sync_requested` for a workspace with due outbox jobs.
- `opencompany.sync_outbox_recovery_dispatch_failed`: the sweeper failed to re-dispatch. Check
  `error_name` and `error_message`.
- `opencompany.auth_callback_failed`: WorkOS callback provisioning failed.
- `opencompany.next_request_error`: Next.js caught a server render, route handler, or server
  action failure. Check `next_route_path`, `next_route_type`, `next_render_source`, and
  `request_path`.
- `opencompany.billing_checkout_failed`: settings credit top-up failed before redirecting to
  Stripe Checkout. Check `checkout_stage`, `checkout_record_id`, `workspace_id`, and `user_id`.
- `opencompany.web_app_error` or `opencompany.web_global_error`: uncaught Next.js UI error.
  Browser captures include `browser_pathname`, online state, and the current authenticated
  `workspace_id`/`user_id` when available. Do not include full browser URLs or query strings.

## Deferred

This slice deliberately does not include distributed web/Inngest-to-runner tracing, Better Stack
OTLP logs, browser log capture, session replay, alert rules, a local `observe` CLI, Braintrust eval
scaffolding, or a full E2B lifecycle model. Track sandbox lifecycle work in the E2B lifecycle issue.

If deeper client debugging becomes necessary, prefer highly masked, error-triggered or
support-triggered replay over broad browser logs.
