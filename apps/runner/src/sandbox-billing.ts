import { calculateSandboxUsageCost } from "@opencompany/billing";
import { recordCreditDebit } from "@opencompany/db/credits";
import { sql } from "drizzle-orm";
import type { SandboxInfo } from "e2b";
import { getDb } from "./db";
import { rowsFromExecute } from "./sql-exec";

export type SandboxBillingOwner = {
  namespace: string;
  workspaceId: string;
  userWorkosId: string;
};
export type SandboxBillingDb = Pick<ReturnType<typeof getDb>, "execute" | "transaction">;
export type SandboxBillingSnapshot = Pick<
  SandboxInfo,
  "sandboxId" | "startedAt" | "endAt" | "state" | "cpuCount" | "memoryMB" | "templateId"
>;

type Cursor = SandboxBillingOwner & {
  billableFrom: Date | string;
  providerStartedAt: Date | string | null;
  settledThrough: Date | string | null;
};

export async function registerSandboxBilling(
  input: SandboxBillingOwner & {
    sandboxId: string;
    billableFrom: Date;
    db?: SandboxBillingDb;
  },
) {
  const result = await (input.db ?? getDb()).execute(sql`
    INSERT INTO goat.sandbox_billing_cursors
      (sandbox_id, namespace, workspace_id, user_workos_id, billable_from)
    VALUES (${input.sandboxId}, ${input.namespace}, ${input.workspaceId},
      ${input.userWorkosId}, ${input.billableFrom})
    ON CONFLICT (sandbox_id) DO UPDATE
      SET missing_at = NULL, next_poll_at = LEAST(goat.sandbox_billing_cursors.next_poll_at, now())
      WHERE goat.sandbox_billing_cursors.namespace = excluded.namespace
        AND goat.sandbox_billing_cursors.workspace_id = excluded.workspace_id
        AND goat.sandbox_billing_cursors.user_workos_id = excluded.user_workos_id
    RETURNING sandbox_id
  `);
  if (rowsFromExecute(result).length === 0) {
    throw new Error("Sandbox billing owner does not match its registered owner.");
  }
}

// Provider start times identify running intervals, including resumes. The row lock,
// credit debit, and cursor advance share one transaction so worker replicas and
// retries cannot charge the same interval twice or lose a debit after advancing.
export async function settleSandboxBilling(input: {
  snapshot: SandboxBillingSnapshot;
  observedAt: Date;
  db?: SandboxBillingDb;
}) {
  const { snapshot } = input;
  const startedAt = dateMillis(snapshot.startedAt);
  const endAt = dateMillis(snapshot.endAt);
  const observedAt = dateMillis(input.observedAt);
  if (
    !Number.isInteger(snapshot.cpuCount) ||
    snapshot.cpuCount <= 0 ||
    !Number.isInteger(snapshot.memoryMB) ||
    snapshot.memoryMB <= 0 ||
    endAt < startedAt ||
    !["running", "paused"].includes(snapshot.state)
  ) {
    throw new Error("Invalid E2B billing snapshot.");
  }
  // While a pause is in flight E2B can report paused with the old future timeout.
  // Wait for the completed snapshot rather than billing that timeout as running time.
  if (snapshot.state === "paused" && endAt > observedAt) return 0;
  const through = Math.min(endAt, observedAt);

  return (input.db ?? getDb()).transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT namespace, workspace_id AS "workspaceId", user_workos_id AS "userWorkosId",
        billable_from AS "billableFrom", provider_started_at AS "providerStartedAt",
        settled_through AS "settledThrough"
      FROM goat.sandbox_billing_cursors
      WHERE sandbox_id = ${snapshot.sandboxId}
      FOR UPDATE
    `);
    const cursor = rowsFromExecute<Cursor>(result)[0];
    if (!cursor) return 0;
    const previousStart =
      cursor.providerStartedAt === null ? null : dateMillis(cursor.providerStartedAt);
    if (previousStart !== null && startedAt < previousStart) return 0;
    const billableStart = Math.max(startedAt, dateMillis(cursor.billableFrom));
    const from =
      previousStart === startedAt && cursor.settledThrough !== null
        ? Math.max(billableStart, dateMillis(cursor.settledThrough))
        : billableStart;
    if (through <= from) return 0;

    const resources = {
      template: snapshot.templateId,
      vcpu: snapshot.cpuCount,
      ramMiB: snapshot.memoryMB,
    };
    // Difference cumulative prices to preserve sub-micro rounding across short polls.
    const before = calculateSandboxUsageCost({ ...resources, activeMs: from - billableStart });
    const after = calculateSandboxUsageCost({ ...resources, activeMs: through - billableStart });
    const totalCostUsdMicros = after.totalCostUsdMicros - before.totalCostUsdMicros;
    const costBasis = { ...after.costBasis };
    delete costBasis.costsUsdMicros;
    await recordCreditDebit({
      workspaceId: cursor.workspaceId,
      userWorkosId: cursor.userWorkosId,
      source: "sandbox_usage",
      idempotencyKey: `e2b:${snapshot.sandboxId}:${startedAt}:${from}:${through}`,
      providerCostUsdMicros: after.providerCostUsdMicros - before.providerCostUsdMicros,
      platformFeeUsdMicros: after.platformFeeUsdMicros - before.platformFeeUsdMicros,
      totalCostUsdMicros,
      costBasis: {
        ...costBasis,
        provider: "e2b",
        activeMs: through - from,
        cumulativeActiveMsBefore: from - billableStart,
        cumulativeActiveMsAfter: through - billableStart,
        startedAt: new Date(from).toISOString(),
        endedAt: new Date(through).toISOString(),
      },
      metadata: { provider: "e2b", sandboxId: snapshot.sandboxId, namespace: cursor.namespace },
      db: tx,
    });
    await tx.execute(sql`
      UPDATE goat.sandbox_billing_cursors
      SET provider_started_at = ${new Date(startedAt)}, settled_through = ${new Date(through)}
      WHERE sandbox_id = ${snapshot.sandboxId}
    `);
    return totalCostUsdMicros;
  });
}

function dateMillis(value: Date | string) {
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) throw new Error("Invalid E2B billing timestamp.");
  return result;
}
