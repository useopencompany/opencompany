# Sandbox usage billing

Workspace usage reporting groups `goat.credit_ledger` debits by model, ingestion,
paid capability, and sandbox usage. Only usage sources count as spend; expiring
included credits and balance adjustments remain in billing activity but do not
inflate usage totals. Sandbox entries carry the source `sandbox_usage`, including
Browserbase sessions. Reporting does not create usage or debit workspace balances.

## Current metering gap

The retained Codex and Claude Code runners create, reconnect, and park E2B
sandboxes without recording E2B usage or debiting the product credit ledger.
`calculateSandboxUsageCost` still exists in `packages/billing`, but has no active
runtime caller. The old runner's metering path was removed with the legacy runtime
in PR #1161; it was tied to the legacy ledger and was not wired into the retained
product coding runners. Reinstating that legacy path would not fix product billing.

The existing `chat_sandbox_usage` and `task_sandbox_usage` tables are not evidence
that current coding usage is billed. The task tables are also a separate read
model from the workspace credit ledger. Browserbase has its own settlement path
in `packages/agent/src/browser-profiles`, which uses `recordCreditDebit` and does
not meter E2B compute.

The credit debit primitive already attributes charges to a workspace and actor,
spends included credit before top-ups, and atomically deduplicates debits by
idempotency key. The missing responsibility is durable E2B metering and settlement,
not another balance implementation.

## Required lifecycle metering

E2B [charges for allocated CPU and RAM per second while a sandbox is running](https://e2b.dev/pricing).
Paused time is not running time. A sandbox can span multiple turns, resume from
pause, survive a runner deployment, or be replaced during recovery. Turn wall
time is therefore insufficient to reconstruct its billable lifetime.

The next implementation should:

1. Persist sandbox ownership (workspace, actor, conversation/task), allocation, and
   running intervals independently of the worker's turn lease. Resolve allocation
   from the actual provider sandbox; template names and historical defaults can
   disagree with deployed CPU/RAM.
2. Capture create/resume/pause/kill transitions and reconcile provider lifecycle
   evidence after worker crashes, timeouts, and sandbox replacement. Use a durable
   settlement cursor or outbox so a failed debit remains retryable without rerunning
   the user's work. Persist evidence before it disappears from the provider.
3. Settle nonoverlapping intervals once, recording duration, resources, pricing
   version, and provider cost. Use the existing product credit ledger for the
   charge and expose the same evidence to task cost reporting. Avoid separate
   uncoordinated writes that can leave a usage row without its debit.
4. Define attribution for warm idle time, authentication-only sandboxes, and work
   that continues across a handoff. Never bill paused time or precharge an assumed
   idle timeout that another turn may shorten. Billing must apply independently
   of whether the model uses a connected subscription or API credits.
5. Cover successful, failed, interrupted, retried, and handed-off turns for both
   engines; repeated settlement; changed allocations; multiple actors in one
   workspace; and isolation between workspaces. Alert on unsettled intervals and
   reconcile aggregate recorded provider cost against E2B usage.

Enabling this meter changes customer charges and requires a reviewed billing
design. Do not backfill charges from message timestamps or zero-cost legacy rows:
they do not establish actual running intervals, idle time, or resource allocation.
