# Observability

OpenCompany launch observability is intentionally narrow: production error capture, structured
runtime context, and a short debugging path for failed agent sessions.

Better Stack receives errors through its Sentry-compatible DSN. The repo-owned
`@opencompany/observability` package provides the app-facing API:

- `createLogger` for structured JSON logs
- `captureException` for handled failures
- `sanitizeLogFields` for safe metadata
- `flushObservability` for process shutdown

## Configuration

Remote error capture is disabled when `BETTER_STACK_ERRORS_DSN` is unset or
`OBSERVABILITY_ENABLED=false`.

```sh
OBSERVABILITY_ENABLED=true
OBSERVABILITY_ENV=production
OBSERVABILITY_RELEASE=<git-sha>
OBSERVABILITY_LOG_LEVEL=info
OBSERVABILITY_TIMING=0
BETTER_STACK_ERRORS_DSN=https://...
```

For browser-side error capture, also set:

```sh
NEXT_PUBLIC_OBSERVABILITY_ENABLED=true
NEXT_PUBLIC_OBSERVABILITY_ENV=production
NEXT_PUBLIC_OBSERVABILITY_RELEASE=<git-sha>
NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL=info
NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN=https://...
```

Do not add Better Stack log source tokens or OTLP exporter credentials for this launch slice.

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
- `opencompany.runner_tool_failed`: a sandbox tool failed.
- `opencompany.runner_request_failed`: web/Inngest could not call the runner.
- `opencompany.agent_github_sync_failed`: managed GitHub repo/file sync failed.
- `opencompany.auth_callback_failed`: WorkOS callback provisioning failed.
- `opencompany.web_app_error` or `opencompany.web_global_error`: uncaught Next.js UI error.

## Deferred

The launch PR deliberately does not include Langfuse, distributed tracing, Better Stack OTLP logs,
alert rules, a local `observe` CLI, or a full E2B lifecycle model. Track AI/agent trace work in the
Langfuse issue and sandbox lifecycle work in the E2B lifecycle issue.
