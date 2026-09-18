# Approve for me

Settings → Preferences → Permissions contains one personal switch, off by default. It applies to the acting user's plugin actions in chats and tasks, including workflow runs. It does not change the connection's On/Ask/Off permissions, enable anything for teammates, or release requests already waiting for a person.

## Decisions

For a new Ask request, the server checks an explicit list of eligible operations, then asks `typesafe-ai/jev` via Vercel AI Gateway to evaluate user intent and risk. Both scores must reach 0.75. This threshold was calibrated on the evaluation below; it is not a probability guarantee. The server reads intent from the authenticated turn, treats descriptions/arguments as untrusted, and binds approval to the exact arguments and connection revision.

Eligible operations include selected Linear, Gmail, Slack, Drive, and Calendar reads, Gmail drafts, and an existing Linear issue's labels-only update. All other operations still ask, including sending, publishing, payment, deletion, access changes, production deployment, and unknown tools. Coding-engine permissions and paid-capability confirmations keep their existing behavior.

Review has a four-second deadline, no retries, and a 24,000-character context ceiling. Missing context, invalid output, timeout, or provider failure means ask. There is no alternate model that can widen approval. A concurrent duplicate review also falls back to manual approval so a visible request cannot be released by a competing review. Opt-out is checked at review commit and again on execution. A user's denial wins over an in-flight review. Normal durable invocation deduplication still protects writes.

The activity row says “Automatically approved.” Its detail explains that the action was routine and within the request. Failed or uncertain reviews use the existing approval card.

## PostHog

`action_approval_reviewed` records one completed review of a new Ask request while the preference is enabled. The winning persisted review emits the event; retries do not emit it again. Properties: `workspace_id`, `run_id`, `request_id`, `action_id`, `surface`, `outcome`, `reason`, `model`, `policy_version`, `duration_ms`. No prompts, arguments, provider output, recipients, or scores are sent to PostHog.

In Trends, choose **Total count of action_approval_reviewed**, break down by **outcome**, and display as a pie chart or percentage bar. Filter `surface` for chat/task or `reason` to investigate fallback. The two outcomes are:

- `auto_approved`: automatic approval granted.
- `requires_approval`: automatic approval declined; the action waits for a person. This is not a user denial.

The denominator is completed reviews with the preference enabled, including operations rejected by the fixed eligibility policy. It excludes On actions, Off actions, preference-disabled requests, and reviews canceled before a decision commits. Server analytics are best effort, so the durable approval record remains authoritative if telemetry delivery fails.

`run_approval_resolved` separately records a new human decision with `approval_id`, `run_id`, `workspace_id`, and `resolution`. Break down by `resolution` to see actual approved/denied/canceled decisions. This event covers run approvals generally, including non-plugin approvals, so do not divide its total by the automatic-review total.

For an exact percentage using distinct review identities, use this HogQL query:

```sql
SELECT
  properties.outcome AS outcome,
  uniqExact(tuple(distinct_id, properties.run_id, properties.request_id)) AS requests,
  round(100.0 * requests / sum(requests) OVER (), 1) AS percentage
FROM events
WHERE event = 'action_approval_reviewed'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY outcome
```

## Evaluation

Run the synthetic evaluation with the existing Gateway credential injected into the process:

```sh
bun packages/agent/evals/approval-review.ts
```

An optional `--production-sample <private-json-path>` accepts a read-only export of turn prompts and assistant tool traces; `--output <path>` saves only anonymous case labels, decisions, scores, and timings. Do not commit or publish raw session exports. The evaluator calls Jev only and never executes sampled actions or changes real permissions.

On 2026-09-18, the final run evaluated 30 labeled synthetic cases (including a 10-case holdout added after initial calibration) plus 16 historical plugin calls from three sessions, found in a bounded sample of 40 recent turns belonging to the requesting user. Account ownership was identified through the exact originating request. Results:

| Set | Cases | Automatic approvals | Must-ask cases incorrectly approved | Routine cases deferred |
| --- | ---: | ---: | ---: | ---: |
| Synthetic, including holdout | 30 | 10 | 0 | 1 |
| Historical | 16 | 1 | 0 | 12 |
| Total | 46 | 11 | 0 | 13 |

No provider failures occurred in the final run. The 35 model calls took a median of 281 ms, a p95 of 368 ms, and a maximum of 416 ms (excluding persistence/analytics). The initial 0.98 threshold deferred every case. The holdout classified all ten cases as expected at the final threshold. Historical coverage was low: many reads referenced opaque IDs whose scope could not be established from the current request alone. Their routine labels reflect the session's intended task; deferring them is safer than guessing that an ID is authorized. Replay uses the recorded prompt/arguments and operation names, not complete historical discovery definitions or prior provider results. It simulates Ask review even where the original permission may have been On. This is a small development evaluation, not a representative production approval rate or proof against prompt injection.

## Release and rollback

The migration adds a non-null boolean defaulting to false. Deploy it before code that selects the new column. The existing `VERCEL_AI_GATEWAY_API_KEY` is reused; no new secret is required. The AI SDK versions across agent, runner, and web are aligned because their message types cross package boundaries.

Rolling back application code leaves the unused preference column and review metadata harmlessly in place. Do not drop the column during an application rollback. To stop reviewing an account immediately, turn off its preference; requests not yet dispatched return to manual approval. This cannot undo actions already executed.
