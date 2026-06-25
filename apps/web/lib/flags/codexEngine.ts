import type { users } from "@opencompany/db/schema";

type AppUser = typeof users.$inferSelect;

/**
 * Per-user feature flag for the Codex runtime.
 *
 * When true, the agent editor shows the engine selector so an agent can run on the Codex runtime
 * instead of the default OpenCompany one. Off for everyone until they opt in from Settings →
 * Feature flags. Backed by the `users.codexEngineEnabled` column (defaults false). Centralized here
 * so every gate reads the same predicate and a future cohort/workspace override is a one-place
 * change.
 */
export function isCodexEngineEnabled(user: Pick<AppUser, "codexEngineEnabled">): boolean {
  return user.codexEngineEnabled;
}
