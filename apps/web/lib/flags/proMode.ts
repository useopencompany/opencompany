import type { users } from "@opencompany/db/schema";

type AppUser = typeof users.$inferSelect;

/**
 * Per-user "Pro mode" switch for the personal-agent surface.
 *
 * When true, the user gets advanced surfaces that are hidden by default — currently the read-only
 * agent Memory inspector in the /personal sidebar. Backed by the `users.proMode` column (defaults
 * false). Centralized here so every gate reads the same predicate and a future cohort/workspace
 * override is a one-place change.
 */
export function isProMode(user: Pick<AppUser, "proMode">): boolean {
  return user.proMode;
}
