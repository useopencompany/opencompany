import {
  checkWorkspaceRunAllowance,
  isSpendLimitReason,
  type RunAllowanceReason,
  spendLimitWindowLabel,
  type WorkspaceRunAllowance,
} from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { maybeTriggerAutoRefill } from "@/lib/billing/auto-refill";

export type { RunAllowanceReason };
export { isSpendLimitReason, spendLimitWindowLabel };

type Db = ReturnType<typeof getDb>;

export type RunAllowanceOutcome =
  | { allowed: true; allowance: WorkspaceRunAllowance }
  | { allowed: false; reason: RunAllowanceReason; allowance: WorkspaceRunAllowance };

// The single gate for "is this workspace allowed to run an agent right now?".
// Combines the balance + daily/weekly-limit checks with a reactive auto-refill:
// when the only blocker is an empty balance, we give the saved card a chance to
// top up before turning the user away. Auto-refill never fires for a spend-limit
// block — that is an intentional cap, not a funding gap. Callers map the reason to
// a user-facing message.
export async function ensureWorkspaceRunAllowance(input: {
  workspaceId: string;
  userId?: string | null;
  db?: Db;
}): Promise<RunAllowanceOutcome> {
  const db = input.db ?? getDb();
  let allowance = await checkWorkspaceRunAllowance({ db, workspaceId: input.workspaceId });

  if (!allowance.allowed && allowance.reason === "no_balance") {
    const refill = await maybeTriggerAutoRefill({
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      allowance,
      db,
    });
    if (refill.recharged) {
      allowance = await checkWorkspaceRunAllowance({ db, workspaceId: input.workspaceId });
    }
  }

  if (allowance.allowed) return { allowed: true, allowance };
  // reason is non-null whenever allowed is false.
  return { allowed: false, reason: allowance.reason as RunAllowanceReason, allowance };
}

// User-facing copy for a blocked run. `action` distinguishes starting a new
// session from continuing an existing one (matches the pre-existing wording).
export function runAllowanceErrorMessage(
  reason: RunAllowanceReason,
  action: "start" | "continue",
): string {
  if (reason === "daily_limit_reached") {
    return action === "start"
      ? "Daily spending limit reached. Raise the limit in billing settings or wait until it resets to start a session."
      : "Daily spending limit reached. Raise the limit in billing settings or wait until it resets to continue this session.";
  }
  if (reason === "weekly_limit_reached") {
    return action === "start"
      ? "Weekly spending limit reached. Raise the limit in billing settings to start a session."
      : "Weekly spending limit reached. Raise the limit in billing settings to continue this session.";
  }
  return action === "start"
    ? "Add workspace credits to start a session."
    : "Add workspace credits to continue this session.";
}
