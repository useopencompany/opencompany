import type { users } from "./schema";

type AppUser = typeof users.$inferSelect;

/**
 * Per-user opt-in for the runner hot-context layer.
 *
 * When true, personal-memory agent sessions receive a small, session-stable memory digest in the
 * system prompt. Backed by the `users.hotContext` column (defaults false). Centralized in the shared
 * DB package so web and runner gates read the same predicate and a future cohort/workspace override
 * is a one-place change.
 */
export function isHotContextEnabled(user: Pick<AppUser, "hotContext">): boolean {
  return user.hotContext;
}
