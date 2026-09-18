# Approve for me

Settings → Preferences → Permissions contains one personal switch, off by default. It applies to the acting user's plugin actions in chats and tasks, including workflow runs. It does not change the connection's On/Ask/Off permissions, enable anything for teammates, or release requests already waiting for a person.

## Decisions

For a new Ask request, `typesafe-ai/jev` via Vercel AI Gateway evaluates whether the action helps complete the task and whether its effects are low risk. Policy `task-risk-v2` requires a task-relevance score of 0.55 and a low-risk score of 0.75. Relevance deliberately permits reasonable intermediate steps and opaque IDs found during the task. Explicit restrictions, conflicting IDs, extra recipients, unrelated work, and requests to wait for approval still require manual review. These thresholds are development calibration, not probability guarantees.

There is no list of approved tool names. Ordinary reads, searches, document/issue creation and edits, attachments, organization, drafts, and requested routine communications can be approved across plugins. The reviewer uses the authenticated current request plus up to four earlier requests from the same actor and session, oldest first. Provider descriptions and arguments remain untrusted data and cannot change the review instructions. The full selected requests are preserved; oversized context falls back to asking instead of silently dropping restrictions.

Fixed guards keep destructive or metered actions, recognized payment/deletion/deployment/publishing/access/credential operations, access-changing write parameters, moves of existing Linear issues between teams, and read requests exceeding 1,000 results manual. Read-only operation names can still be reviewed (for example, listing payments does not move money). Jev also checks for high risk that cannot be determined from names alone: destructive SQL, production changes, mass communications, sensitive personal records, credentials, and sensitive exports. Asking for a high-risk action does not make it low risk. Unknown providers are not automatically disqualified, but effects that cannot be understood still ask. Coding-engine permissions and paid-capability confirmations retain their existing behavior.

Review has a four-second deadline, no retries, and a 48,000-character context ceiling. Missing intent, invalid output, timeout, or provider failure means ask. There is no alternate model that can widen approval. A concurrent duplicate review also falls back to manual approval so a visible request cannot be released by a competing review. Automatic approval is bound to the current request, exact arguments, current connection, tool definition, and review policy. The current request and active-run status are checked again when the decision commits. Opt-out is checked at review commit and again on execution. Old-policy approvals return to manual approval, as do changed connections or definitions. A user's denial wins over an in-flight review. Normal durable invocation deduplication still protects writes.

The activity row says “Automatically approved.” Its detail explains that the action was routine and within the request. Failed or uncertain reviews use the existing approval card.

## PostHog

`action_approval_reviewed` records one completed review of a new Ask request while the preference is enabled. The winning persisted review emits the event; retries do not emit it again. Properties: `workspace_id`, `run_id`, `request_id`, `action_id`, `surface`, `outcome`, `reason`, `model`, `policy_version`, `duration_ms`. No prompts, arguments, provider output, recipients, or scores are sent to PostHog.

In Trends, choose **Total count of action_approval_reviewed**, break down by **outcome**, and display as a pie chart or percentage bar. Filter `surface` for chat/task or `reason` to investigate fallback. The two outcomes are:

- `auto_approved`: automatic approval granted.
- `requires_approval`: automatic approval declined; the action waits for a person. This is not a user denial.

The denominator is completed reviews with the preference enabled, including operations rejected by the fixed high-risk guards. It excludes On actions, Off actions, preference-disabled requests, and reviews canceled before a decision commits. Server analytics are best effort, so the durable approval record remains authoritative if telemetry delivery fails.

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

On 2026-09-18, the final `task-risk-v2` run evaluated 50 labeled synthetic cases plus 16 historical plugin calls from the requesting user's three sessions. The historical tasks cover issue attachments, a daily Drive document, and mail research; they were found in a bounded read-only sample of 40 recent turns, with account ownership identified through the exact originating request. No sampled actions were executed.

| Set | Cases | Automatic approvals | Must-ask cases incorrectly approved | Routine cases deferred |
| --- | ---: | ---: | ---: | ---: |
| Synthetic | 50 | 24 | 0 | 0 |
| Historical | 16 | 16 | 0 | 0 |
| Total | 66 | 40 | 0 | 0 |

All 26 must-ask cases remained manual. The ten new holdout cases, authored after calibration and before the final run, classified as expected. They cover new-provider reads, opaque IDs, ordinary scheduling and documents, task continuation, payment, destructive SQL, previous explicit restrictions, conflicting recipients, and injected export instructions. The 58 model calls took a median of 266 ms, p95 of 522 ms, and maximum of 1,488 ms, excluding persistence and analytics. Eight requests were rejected before calling Jev; no provider failures occurred in the final run.

The first development attempt exposed an oversized mailbox search and an access-changing issue move, which now have fixed guards. An intermediate run also had one provider failure that correctly fell back to manual approval. Two older synthetic labels (routine sending and an unfamiliar read provider) and the three historical task-deliverable writes were deliberately changed to match the user's expanded approval policy. Labels were set before the final run; the old holdout is now regression coverage, not a new holdout.

The original `routine-v1` evaluation approved only 1 of these 16 historical actions. The new policy approved 16/16 by inferring ordinary intermediate steps, using prior task context, and allowing low-risk writes instead of requiring an exact tool allowlist. Replay uses recorded requests/arguments and operation names, not complete historical discovery definitions or all provider results, and simulates Ask review even where original permissions may have been On. These are development examples, not a representative production approval rate or proof against prompt injection. PostHog's `policy_version` allows real-world coverage to be compared after rollout.

## Release and rollback

The v2 policy requires no new migration or credential. The account preference still defaults off; On/Ask/Off permissions and already pending requests are unchanged.

The migration adds a non-null boolean defaulting to false. Deploy it before code that selects the new column. The existing `VERCEL_AI_GATEWAY_API_KEY` is reused; no new secret is required. The AI SDK versions across agent, runner, and web are aligned because their message types cross package boundaries.

Rolling back application code leaves the unused preference column and review metadata harmlessly in place. Do not drop the column during an application rollback. To stop reviewing an account immediately, turn off its preference; requests not yet dispatched return to manual approval. This cannot undo actions already executed.
