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

The model call is instrumented as an `llm` span manually (not via Braintrust's `wrapAISDK`). We open
the span with `traceBraintrustStep`/`observeRunStep`, which always calls `span.end()` in a `finally`,
then log the chat transcript (`input` as messages, `output` as the assistant message), token usage
(prompt, completion, total, plus cached and reasoning tokens), time-to-first-token, and the model slug
in `metadata.model`. Braintrust derives estimated cost from `metadata.model` plus those token metrics.

We deliberately avoid `wrapAISDK` for streaming here: it closes the `llm` span (and logs usage) only
when its patched result stream drains to completion, with no error/cancel handler on that path. Since
the runner consumes `result.fullStream` itself and can abort or hit tool/stream errors mid-stream,
`wrapAISDK` would leave spans stuck "in progress" with no usage. Manual instrumentation closes the span
deterministically on success, error, and abort.

Two further reliability details for the long-lived runner: the model span's output/usage are logged on
the explicit span object (not `currentSpan()`), so they can't be dropped to a no-op span if the AI SDK
stream runs outside the span's async-context; and each run flushes Braintrust (`flushBraintrust()` in a
`finally` around the root trace) so end-of-run spans are delivered promptly rather than lingering
because the background async flush hadn't completed.

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

Braintrust traces are the exception to the prompt/output rule when `BRAINTRUST_ENABLED=true`.
Braintrust masking still redacts secret-like keys and common inline credential patterns, but agents
can surface sensitive data in free text. Treat Braintrust access as production data access. Masking
only redacts secret-like *string* values: numeric/boolean values (e.g. the `tokens`, `prompt_tokens`,
`completion_tokens`, and `time_to_first_token` metrics, which match the "token" key rule) are left
intact, because Braintrust requires `metrics.*` to be numeric and rejects the whole row otherwise.

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
- `opencompany.runner_sse_connected`: browser connected to runner SSE; check `replayed_events`.
- `opencompany.runner_sse_closed`: browser disconnected from runner SSE.
- `opencompany.runner_sse_rejected`: runner rejected an SSE connection.
- `opencompany.agent_sync_job_queued`: the app wrote or updated an `agent_sync_jobs` row after an
  agent edit. Check `agent_id`, `workspace_id`, `path`, `desired_version`, and `next_run_at`.
- `opencompany.agent_sync_dispatch_succeeded`: the app sent `agent.sync_requested` to Inngest.
  Check `inngest_event_ids`.
- `opencompany.agent_sync_dispatch_failed`: the app could not send the Inngest event after the DB
  write. Check `error_name`, `error_message`, and `dispatch_status_marked_failed`.
- `opencompany.agent_github_sync_started`: the Inngest worker started materializing an agent file.
- `opencompany.agent_github_sync_succeeded`: GitHub materialization completed. Check `status`,
  `commit_sha`, `blob_sha`, and `duration_ms`.
- `opencompany.agent_github_sync_failed`: managed GitHub repo/file sync failed.
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
