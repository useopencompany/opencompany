# Observability

OpenCompany observability is intentionally narrow: production error capture, structured server
logs, runtime context, and a short debugging path for failed agent sessions.

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

## Safe Log Content

Allowed log fields:

- internal IDs such as `workspace_id`, `user_id`, `agent_id`, `session_id`, and `message_id`
- coarse status enums, durations, counts, route names, release, environment, and service name
- provider/model names and sandbox ids

Do not log prompts, model output, command output, command bodies, agent file text, repo file
contents, tokens, secrets, emails, browser URLs with query strings, or other free-form user text.

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

This slice deliberately does not include Langfuse, distributed tracing, Better Stack OTLP logs,
browser log capture, session replay, alert rules, a local `observe` CLI, or a full E2B lifecycle
model. Track AI/agent trace work in the Langfuse issue and sandbox lifecycle work in the E2B
lifecycle issue.

If deeper client debugging becomes necessary, prefer highly masked, error-triggered or
support-triggered replay over broad browser logs.
