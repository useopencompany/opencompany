import type { users } from "@opencompany/db/schema";

type AppUser = typeof users.$inferSelect;

/**
 * Per-user product-surface switch for the personal-agent-first pivot.
 *
 * When true, the user's primary surface is the personal agent (root → /personal, personal
 * onboarding). When false, they get the legacy company/workspace surface (root → /company).
 * Backed by the `users.personalFirst` column (defaults true in this phase). Centralized here so
 * the routing/onboarding/UI branches all read the same predicate and a future per-workspace or
 * cohort override is a one-place change.
 */
export function isPersonalFirst(user: Pick<AppUser, "personalFirst">): boolean {
  return user.personalFirst;
}
