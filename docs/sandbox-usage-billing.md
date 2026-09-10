# Sandbox usage billing

The runner charges E2B compute to the workload's workspace credit balance and
records the owning user. Charges appear as **Sandbox usage** in Usage and Billing.
They are independent of model billing, including connected Codex/Claude subscriptions,
and do not require a chat session or message reference in the ledger.

## Metering

Codex and Claude coding workloads register their sandbox, workspace, user, and
runner namespace in `goat.sandbox_billing_cursors` before starting work. A workload
without a billing workspace cannot acquire a coding sandbox. Authentication-only
sandboxes are not workload registrations and remain platform costs.

A runner worker polls registered sandboxes every minute, in bounded batches scoped
to its namespace. E2B's sandbox information supplies the current running interval,
allocated CPU/RAM, and the last pause time. The worker charges running time,
including warm idle time, at the existing [E2B compute rates](https://e2b.dev/pricing).
Paused time is excluded. Resource allocation comes from E2B rather than the template
name, so custom memory allocations are priced correctly.

The cursor and `recordCreditDebit` run in one transaction under a cursor row lock.
Repeated polls, competing workers, and restarted workers cannot charge the same
interval twice. A failed transaction preserves both the prior cursor and balance.
Prices are calculated cumulatively within each running interval to retain fractional
micro-dollar rounding across short polls. Charges consume included credits first,
then top-ups, using the existing workspace billing rules.

Reconnecting a registered sandbox also attempts to settle its previous interval
before resume; deleting a sandbox attempts to settle before E2B removes it. Sandbox
replacement creates a separate cursor. Registration preserves the original owner
and first billable timestamp, preventing reconnects from resetting billing or
silently moving charges to another workspace/user.

## Scope and limits

Billing begins when a workload first registers its sandbox after deployment. An
existing sandbox registers on its next coding acquisition; earlier runtime is not
backbilled. No historical charges are reconstructed from chat timestamps.

This is a polling meter, not an E2B invoice reconciliation system. E2B's information
endpoint exposes the current or most recently paused interval, not a full history.
If a sandbox is deleted externally, or several pause/resume cycles replace its
history between observations, some runtime can remain unbilled. The same limitation
applies if the pre-transition billing attempt fails during a database/provider
outage. Unknown time is not charged from an assumed timeout. A provider 404 retires
the cursor from polling; a subsequent successful acquisition reactivates it.

Worker errors emit `opencompany.sandbox_billing_failed` and remain eligible for a
later poll. Full provider event history would be the next step if exact invoice
reconciliation becomes necessary.

## Deployment and rollback

Apply migration `0265_sandbox_billing_cursors.sql` before deploying the runner.
The billing worker runs under the existing `RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED`
gate and uses the existing E2B credentials; no additional environment variables or
provider webhooks are required. Registration and billing start with the new runner.

The migration is additive and does not debit or backfill existing workspaces.
Rolling back the runner stops new E2B debits. Keep the cursor table and ledger rows
so a later rollout preserves settlement history. Removing billing code does not
reverse charges already recorded in the ledger.

Usage reporting groups ledger usage sources into model, ingestion, paid capability,
and sandbox categories. Credit expirations and balance adjustments remain in billing
activity but are excluded from usage spend totals. Browserbase retains its separate
settlement path and shares the `sandbox_usage` ledger source.
