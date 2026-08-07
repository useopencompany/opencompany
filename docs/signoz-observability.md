# SigNoz opencompany Observability

This runbook covers the SigNoz dashboard and MCP workflow for investigating chat turns, task
runs, and Brain agent ingest jobs.

## Dashboard

Use the production SigNoz Cloud tenant:

```text
https://stable-snapper.eu2.signoz.cloud
```

Created dashboard:

| Asset | Name | ID |
|---|---|---|
| Dashboard | `OpenCompany opencompany Run Outcomes` | `019f4b71-e314-7a19-9921-434c8dfff619` |
| Trace view | `OpenCompany opencompany Failed Runs` | `019f4b72-28d9-7ba6-8a6c-3bd914033ea1` |
| Trace view | `OpenCompany opencompany All Run Spans` | `019f4b72-295f-7dbc-acb7-ee94d1ea6d03` |

Dashboard URL:

```text
https://stable-snapper.eu2.signoz.cloud/dashboard/019f4b71-e314-7a19-9921-434c8dfff619
```

Current panels:

- `Run Counts by Outcome` (`bar`, trace-backed).
- `Failed or Aborted Runs by Failure Category` (`bar`, trace-backed).
- `Chat Turn Count` (`value`, trace-backed).
- `Task Dispatch Count` (`value`, trace-backed).
- `Brain Ingest Span Count by Source Provider and Type` (`table`, trace-backed).

The dashboard intentionally uses trace-backed aggregates for the first layer of run observability.
Those panels return current data and preserve drill-down paths to trace IDs and opencompany lookup IDs.
Metric-native panels can be added once the newer run counters have emitted enough fresh production
traffic to be useful in SigNoz.

No SigNoz alerts have been created yet.

## Current Tenant State

As of July 10, 2026, the tenant has these opencompany services:

- `opencompany-goat`
- `opencompany-runner-goat`

Observed opencompany metrics:

- `goat.chat.tasks_started_total`
- `goat.chat.turns_total`
- `goat.chat.turn_duration_ms.bucket`
- `goat.chat.turn_duration_ms.count`
- `goat.chat.turn_duration_ms.max`
- `goat.chat.turn_duration_ms.min`
- `goat.chat.turn_duration_ms.sum`
- `goat.task_dispatches_total`
- `goat.task_dispatch_duration_ms.bucket`
- `goat.task_dispatch_duration_ms.count`
- `goat.task_dispatch_duration_ms.max`
- `goat.task_dispatch_duration_ms.min`
- `goat.task_dispatch_duration_ms.sum`

Expected after fresh traffic on the merged instrumentation:

- `goat.runs_total`
- `goat.run_duration_ms.*`
- `goat.task_runs_total`
- `goat.task_run_duration_ms.*`
- `goat.brain_ingest_runs_total`
- `goat.brain_ingest_run_duration_ms.*`

Trace data already includes the core run spans:

- `goat.chat.turn`
- `goat.task.run`
- `goat.brain_ingest.run`

SigNoz log search returned no log rows in the tenant during setup. Treat traces as the current
source of truth for run investigation in SigNoz, and use metrics for low-cardinality trends once
fresh counter data is present. Structured logs still exist in application code and platform log
drains, but they are not currently visible in this SigNoz tenant.

## Signals

### Spans

| Span | Service | Use |
|---|---|---|
| `goat.chat.turn` | `opencompany-goat` | One foreground Goat chat turn. |
| `goat.task.dispatch` | `opencompany-goat` | Web app dispatch of a background task to the runner. |
| `goat.task.claim` | `opencompany-runner-goat` | Runner claim of a queued task. |
| `goat.task.run` | `opencompany-runner-goat` | Full terminal task run. |
| `goat.task.plan` | `opencompany-runner-goat` | Task planning stage. |
| `goat.task.model_stream` | `opencompany-runner-goat` | Model streaming stage for a task. |
| `goat.task.tool_call` | `opencompany-runner-goat` | Tool execution inside a task. |
| `goat.task.complete` | `opencompany-runner-goat` | Task completion write. |
| `goat.task.fail` | `opencompany-runner-goat` | Task failure write. |
| `goat.brain_ingest.run` | `opencompany-runner-goat` | Full terminal Brain agent ingest job. |
| `goat.brain_ingest.complete` | `opencompany-runner-goat` | Brain ingest completion or skip write. |
| `goat.brain_ingest.fail` | `opencompany-runner-goat` | Brain ingest failure write. |

Important span attributes:

- `goat.outcome`: `success`, `failure`, `skipped`, or `aborted`.
- `goat.failure_category`: `model_provider`, `tool`, `auth`, `integration`, `budget`,
  `lease_lost`, `timeout`, `validation`, `runner_unconfigured`, `network`, `bug`, or `unknown`.
- `goat.model`
- `goat.status`
- `goat.stage`
- `goat.attempt`
- `goat.task_started`
- `goat.ingest_kind`
- `goat.source_provider`
- `goat.source_type`
- Investigation IDs:
  - `goat.chat_session_id`
  - `goat.chat_message_id`
  - `goat.task_id`
  - `goat.display_id`
  - `goat.brain_ingest_job_id`
  - `goat.brain_source_item_id`
  - `goat.brain_ref`

### Metrics

| Metric | Type | Use |
|---|---|---|
| `goat.runs_total` | Counter | Unified run count by `goat.surface`, `goat.outcome`, and failure category. |
| `goat.run_duration_ms` | Histogram | Unified run duration by surface and outcome. |
| `goat.chat.turns_total` | Counter | Chat turn count by outcome/model/task-started. |
| `goat.chat.turn_duration_ms` | Histogram | Chat turn duration. |
| `goat.chat.tasks_started_total` | Counter | Chat turns that start background tasks. |
| `goat.chat.web_searches_total` | Counter | Chat web-search calls. |
| `goat.chat.web_search_cost_usd_micros` | Counter | Chat web-search cost in micro-USD. |
| `goat.codex_chat.queue_wait_ms` | Histogram | Cloud Codex time from enqueue to first runner claim, by model. |
| `goat.task_dispatches_total` | Counter | Web app task dispatch attempts. |
| `goat.task_dispatch_duration_ms` | Histogram | Task dispatch duration. |
| `goat.task_runs_total` | Counter | Runner task terminal outcomes. |
| `goat.task_run_duration_ms` | Histogram | Runner task duration. |
| `goat.task_stage_duration_ms` | Histogram | Runner task stage duration. |
| `goat.brain_ingest_runs_total` | Counter | Brain agent ingest terminal outcomes. |
| `goat.brain_ingest_run_duration_ms` | Histogram | Brain agent ingest duration. |
| `goat.brain_ingest_spend_usd_micros` | Counter | Brain ingest provider spend by model, Brain query, or web search. |
| `goat.brain_ingest_budget_exhaustions_total` | Counter | Brain ingest attempts stopped by the spend gate. |
| `goat.tool_calls_total` | Counter | Task tool-call count by outcome. |
| `goat.tool_call_duration_ms` | Histogram | Task tool-call duration. |
| `goat.model_usage_tokens` | Counter | Model token usage by token direction. |

Metric labels are intentionally low-cardinality. They do not include run IDs, user IDs, prompts,
tool args, outputs, source refs, or debug traces. Use traces for investigation IDs.

### Structured Events

Primary terminal events:

| Event | Surface | Lookup IDs |
|---|---|---|
| `opencompany.goat_chat_turn_finished` | Goat chat | `chat_session_id`, `chat_message_id`, optional `task_id` |
| `opencompany.goat_task_run_finished` | Goat task | `task_id`, `display_id` |
| `opencompany.goat_brain_ingest_run_finished` | Brain agent ingest | `job_id`, `source_item_id`, `brain_ref` |

Runner and integration events:

- `opencompany.goat_task_run_accepted`
- `opencompany.goat_task_worker_disabled`
- `opencompany.goat_task_lease_lost`
- `opencompany.goat_task_heartbeat_failed`
- `opencompany.goat_task_failed`
- `opencompany.goat_task_worker_failed`
- `opencompany.goat_task_schedule_sweep_failed`
- `opencompany.goat_task_failure_notification_failed`
- `opencompany.goat_brain_ingest_heartbeat_failed`
- `opencompany.goat_brain_ingest_job_failed`
- `opencompany.goat_brain_ingest_worker_failed`
- `opencompany.goat_brain_agent_ingest_finished`
- `opencompany.goat_brain_asset_extraction_failed`
- `opencompany.goat_codex_chat_heartbeat_failed`
- `opencompany.goat_codex_chat_turn_failed`
- `opencompany.goat_codex_chat_worker_failed`
- `opencompany.goat_codex_chat_auth_persist_failed`
- `opencompany.goat_gmail_history_reset`
- `opencompany.goat_gmail_poll_disabled`
- `opencompany.goat_gmail_poll_failed`
- `opencompany.goat_gmail_messages_buffered`
- `opencompany.goat_gmail_poll_worker_failed`
- `opencompany.goat_gmail_snapshot_failed`
- `opencompany.goat_gmail_flush_failed`
- `opencompany.goat_gmail_window_flushed`
- `opencompany.goat_gmail_flush_worker_failed`
- `opencompany.goat_gmail_instructions_lookup_failed`
- `opencompany.goat_slack_conversation_label_failed`
- `opencompany.goat_slack_user_name_failed`
- `opencompany.goat_slack_previous_context_failed`
- `opencompany.goat_slack_thread_context_failed`
- `opencompany.goat_slack_flush_failed`
- `opencompany.goat_slack_window_flushed`
- `opencompany.goat_slack_flush_worker_failed`
- `opencompany.goat_slack_credential_load_failed`
- `opencompany.goat_linear_snapshot_failed`
- `opencompany.goat_linear_flush_failed`
- `opencompany.goat_linear_window_flushed`
- `opencompany.goat_linear_flush_worker_failed`
- `opencompany.goat_linear_credential_load_failed`

## MCP Workflow

Configure and authenticate the MCP server first:

```sh
bun run mcp:configure
codex mcp login signoz
```

Useful SigNoz MCP tools:

- `signoz_list_dashboards`
- `signoz_get_dashboard`
- `signoz_list_metrics`
- `signoz_query_metrics`
- `signoz_search_traces`
- `signoz_aggregate_traces`
- `signoz_get_trace_details`
- `signoz_get_field_keys`
- `signoz_get_field_values`
- `signoz_search_logs`
- `signoz_aggregate_logs`
- `signoz_create_dashboard`
- `signoz_update_dashboard`
- `signoz_create_view`
- `signoz_update_view`

Example prompts for Codex or Claude Code after `/mcp` shows `signoz` connected:

```text
Use SigNoz MCP. Open dashboard "OpenCompany opencompany Run Outcomes" and summarize opencompany failures in the
last 24 hours by span name, goat.outcome, and goat.failure_category.
```

```text
Use SigNoz MCP. Search traces from the last 6 hours where service.name is opencompany-goat or
opencompany-runner-goat, span name is one of goat.chat.turn, goat.task.run, goat.brain_ingest.run,
and goat.outcome is failure or aborted. Return trace IDs plus goat.task_id, goat.display_id,
goat.chat_session_id, goat.chat_message_id, goat.brain_ingest_job_id, goat.source_provider,
goat.source_type, and goat.failure_category when present.
```

```text
Use SigNoz MCP. Get trace details for <trace_id>. Identify the first failing opencompany span, summarize
the failure category, and list the DB lookup IDs. Do not print prompts, tool args, model output, or
secrets.
```

```text
Use SigNoz MCP. List all metrics whose name starts with goat. Report which expected run metrics are
missing and whether traces exist for goat.chat.turn, goat.task.run, and goat.brain_ingest.run.
```

## Investigation Steps

1. Open the `OpenCompany opencompany Run Outcomes` dashboard and select the incident window.
2. Check run outcome volume first. Look for spikes in `failure`, `aborted`, or `skipped`.
3. Open the `OpenCompany opencompany Failed Runs` trace view.
4. Filter by the failing surface:
   - Chat: `name = goat.chat.turn`
   - Task: `name = goat.task.run`
   - Brain ingest: `name = goat.brain_ingest.run`
5. Group or filter by `goat.failure_category`.
6. Open one representative trace and copy the relevant lookup IDs.
7. Query Postgres with the IDs:

```sql
-- chat
select id, title, model, engine, closed_at, updated_at
from goat.chat_sessions
where id = '<chat_session_id>';

select id, role, task_id, created_at, updated_at
from goat.chat_messages
where id = '<chat_message_id>';

-- task
select id, display_id, status, stage, error, model, updated_at
from goat.tasks
where id = '<task_id>' or display_id = '<display_id>';

-- Brain ingest
select id, source_item_id, status, attempts, last_error, result->'budget' as budget,
       completed_at, updated_at
from goat.brain_ingest_jobs
where id = '<job_id>';
```

8. If SigNoz traces show a terminal failure but the DB row looks healthy, inspect the full trace for
   lease loss or a failed terminal write span.
9. If traces are missing but production behavior failed, check Better Stack logs. As of setup,
   structured opencompany logs are not visible in the SigNoz tenant.

## Dashboard Maintenance

If a panel unexpectedly shows no data, first confirm the selected dashboard time range includes opencompany
traffic. The opencompany outcome value for failures is `failure`, not `failed`; use `aborted` separately
for abandoned runs.

After production has emitted fresh traffic from the merged run-outcome instrumentation, update the
dashboard to add metric-native panels for:

- `goat.runs_total`
- `goat.run_duration_ms`
- `goat.task_runs_total`
- `goat.task_run_duration_ms`
- `goat.brain_ingest_runs_total`
- `goat.brain_ingest_run_duration_ms`
- `goat.brain_ingest_spend_usd_micros`
- `goat.brain_ingest_budget_exhaustions_total`

Keep ID-bearing investigation panels trace-based. Do not add run IDs, source refs, prompts, tool
args, model output, or result text as metric labels.
