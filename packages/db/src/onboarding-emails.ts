import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { type OnboardingEmailStep, onboardingEmails } from "./schema";

export type { OnboardingEmailStatus, OnboardingEmailStep } from "./schema";

type DbLike = any;

const DAY_MS = 24 * 60 * 60 * 1000;

// The founder onboarding drip: welcome on signup, a check-in a day later, and a
// feedback-call ask four days after that (five days from signup). Offsets are
// applied at enrollment time; the cron sweep only ever compares `scheduled_at`.
export const GOAT_ONBOARDING_EMAIL_SEQUENCE: Array<{
  step: OnboardingEmailStep;
  delayMs: number;
}> = [
  { step: "welcome", delayMs: 0 },
  { step: "checkin", delayMs: 1 * DAY_MS },
  { step: "feedback_call", delayMs: 5 * DAY_MS },
];

// A send is retried up to this many times (attempts is incremented on each
// claim). The claim skips rows that have already burned through their attempts;
// the sweep marks them `failed` once here.
export const MAX_GOAT_ONBOARDING_EMAIL_ATTEMPTS = 6;

// The web client is neon-http (no interactive transactions), so the claim is a
// single-statement CTE — the same atomic-claim shape as the credit ledger. A
// row is claimed by flipping `pending` -> `sending` and bumping `attempts`;
// SKIP LOCKED lets concurrent sweeps (the hourly cron plus the inline send at
// signup) run without double-sending. A `sending` row whose owner crashed
// mid-send is reclaimed once its soft lease (10 minutes on `updated_at`) lapses.
function rowsFromExecute<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: T[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export type ClaimedOnboardingEmail = {
  id: string;
  workosUserId: string;
  step: OnboardingEmailStep;
  attempts: number;
  email: string;
  firstName: string | null;
};

// Inserts the three sequence rows for a newly-owned workspace. Idempotent: the
// unique (workos_user_id, step) index makes a repeat call (e.g. a re-run of the
// auth path) a no-op rather than a duplicate enrollment.
export async function enrollOnboardingEmails(
  input: { workosUserId: string; now?: Date },
  options: { db?: DbLike } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const now = input.now ?? new Date();
  await db
    .insert(onboardingEmails)
    .values(
      GOAT_ONBOARDING_EMAIL_SEQUENCE.map((entry) => ({
        workosUserId: input.workosUserId,
        step: entry.step,
        scheduledAt: new Date(now.getTime() + entry.delayMs),
      })),
    )
    .onConflictDoNothing({
      target: [onboardingEmails.workosUserId, onboardingEmails.step],
    });
}

// Atomically claims up to `limit` due sends, joining the owner's current email
// and name so the caller never sends to a stale address. Returns the claimed
// rows already flipped to `sending`. Pass `workosUserId` to scope the claim to a
// single owner (the inline welcome at signup) so it never picks up another
// user's backlog; omit it for the global cron sweep.
export async function claimDueOnboardingEmails(
  input: { limit: number; workosUserId?: string },
  options: { db?: DbLike } = {},
): Promise<ClaimedOnboardingEmail[]> {
  const db = options.db ?? getDb();
  const userFilter = input.workosUserId ? sql`AND workos_user_id = ${input.workosUserId}` : sql``;
  const result = await db.execute(sql`
    WITH due AS (
      SELECT id
      FROM goat.onboarding_emails
      WHERE attempts < ${MAX_GOAT_ONBOARDING_EMAIL_ATTEMPTS}
        ${userFilter}
        AND (
          (status = 'pending' AND scheduled_at <= now())
          OR (status = 'sending' AND updated_at < now() - interval '10 minutes')
        )
      ORDER BY scheduled_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    UPDATE goat.onboarding_emails AS e
    SET status = 'sending', attempts = e.attempts + 1, updated_at = now()
    FROM due, goat.users AS u
    WHERE e.id = due.id AND u.workos_user_id = e.workos_user_id
    RETURNING
      e.id AS "id",
      e.workos_user_id AS "workosUserId",
      e.step AS "step",
      e.attempts AS "attempts",
      u.email AS "email",
      u.first_name AS "firstName"
  `);
  return rowsFromExecute<ClaimedOnboardingEmail>(result).map((row) => ({
    ...row,
    attempts: Number(row.attempts),
  }));
}

export async function markOnboardingEmailSent(
  id: string,
  options: { db?: DbLike } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  const now = new Date();
  await db
    .update(onboardingEmails)
    .set({ status: "sent", sentAt: now, lastError: null, updatedAt: now })
    .where(eq(onboardingEmails.id, id));
}

// Retryable failure: return the row to `pending` with a backed-off schedule so
// the next sweep picks it up.
export async function rescheduleOnboardingEmail(
  input: { id: string; nextRunAt: Date; error: string },
  options: { db?: DbLike } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(onboardingEmails)
    .set({
      status: "pending",
      scheduledAt: input.nextRunAt,
      lastError: input.error.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(onboardingEmails.id, input.id));
}

// Terminal failure: attempts exhausted, stop trying.
export async function failOnboardingEmail(
  input: { id: string; error: string },
  options: { db?: DbLike } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(onboardingEmails)
    .set({ status: "failed", lastError: input.error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(onboardingEmails.id, input.id));
}

// Unsubscribe: stop the remaining sequence for whoever owns this email address.
// Returns how many pending/sending rows were skipped.
export async function skipPendingOnboardingEmailsForEmail(
  email: string,
  options: { db?: DbLike } = {},
): Promise<number> {
  const db = options.db ?? getDb();
  const result = await db.execute(sql`
    UPDATE goat.onboarding_emails AS e
    SET status = 'skipped', updated_at = now()
    FROM goat.users AS u
    WHERE u.workos_user_id = e.workos_user_id
      AND lower(u.email) = lower(${email})
      AND e.status IN ('pending', 'sending')
    RETURNING e.id
  `);
  return rowsFromExecute(result).length;
}
