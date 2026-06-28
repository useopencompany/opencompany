import { isHotContextEnabled as isSharedHotContextEnabled } from "@opencompany/db/user-flags";

/**
 * Per-user opt-in for the runner hot-context layer.
 *
 * When true, eligible personal-memory agent sessions receive a small, session-stable memory digest
 * in the system prompt. Backed by the `users.hotContext` column (defaults false). Delegates to the
 * shared DB-package predicate so web and runner gates read the same logic, and a future
 * cohort/workspace override is a one-place change.
 */
export function isHotContextEnabled(
  user: Parameters<typeof isSharedHotContextEnabled>[0],
): boolean {
  return isSharedHotContextEnabled(user);
}
