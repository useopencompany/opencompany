import type { users } from "@opencompany/db/schema";

type AppUser = typeof users.$inferSelect;

/**
 * Per-user opt-in to the legacy company/workspace surface for personal-first users.
 *
 * When true, the /personal sidebar shows the Personal/Company space switcher again so existing
 * users can reach /company. Backed by the `users.companySurfaceEnabled` column (defaults false);
 * flipped from personal Settings. Centralized here so every gate reads the same predicate and a
 * future cohort/workspace override is a one-place change.
 */
export function isCompanySurfaceEnabled(user: Pick<AppUser, "companySurfaceEnabled">): boolean {
  return user.companySurfaceEnabled;
}
