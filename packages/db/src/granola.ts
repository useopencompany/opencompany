import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import { brainSources, granolaSyncState } from "./product-schema";
import type { WorkflowEventContext } from "./workflow-event-routes";

type DbLike = any;

export const GRANOLA_PROVIDER = "granola" as const;
export const GRANOLA_CREDENTIAL_KIND = "api_key" as const;

export type GranolaBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
};

export type GranolaSyncStateRow = {
  integrationId: string;
  userWorkosId: string;
  updatedAfterCursor: Date | null;
  pageCursor: string | null;
  pendingUpdatedAfterCursor: Date | null;
};

export async function listEnabledGranolaBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GranolaBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: brainSources.integrationId,
      brainRef: brainSources.brainId,
    })
    .from(brainSources)
    .where(
      and(
        eq(brainSources.provider, GRANOLA_PROVIDER),
        eq(brainSources.enabled, true),
        inArray(brainSources.integrationId, [...integrationIds]),
      ),
    );
  return rows;
}

export async function ensureGranolaSyncState(
  input: { integrationId: string; userWorkosId: string },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(granolaSyncState)
    .values({ integrationId: input.integrationId, userWorkosId: input.userWorkosId })
    .onConflictDoNothing();
}

// Claims one integration's poll slot: stamps last_polled_at only when the row
// hasn't been polled within the cooldown, so concurrent runner replicas skip
// each other. Returns the cursor on success, null when another replica holds
// the slot.
export async function claimGranolaSyncState(
  input: { integrationId: string; cooldownMs: number },
  db: DbLike = getDb(),
): Promise<GranolaSyncStateRow | null> {
  const cooldownSeconds = Math.max(1, Math.floor(input.cooldownMs / 1000));
  const rows = await db
    .update(granolaSyncState)
    .set({ lastPolledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(granolaSyncState.integrationId, input.integrationId),
        or(
          isNull(granolaSyncState.lastPolledAt),
          lt(granolaSyncState.lastPolledAt, sql`now() - make_interval(secs => ${cooldownSeconds})`),
        ),
      ),
    )
    .returning({
      integrationId: granolaSyncState.integrationId,
      userWorkosId: granolaSyncState.userWorkosId,
      updatedAfterCursor: granolaSyncState.updatedAfterCursor,
      pageCursor: granolaSyncState.pageCursor,
      pendingUpdatedAfterCursor: granolaSyncState.pendingUpdatedAfterCursor,
    });
  return rows[0] ?? null;
}

export async function updateGranolaSyncPage(
  input: {
    integrationId: string;
    expectedUpdatedAfterCursor: Date;
    expectedPageCursor: string | null;
    pageCursor: string;
    pendingUpdatedAfterCursor: Date | null;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(granolaSyncState)
    .set({
      pageCursor: input.pageCursor,
      pendingUpdatedAfterCursor: input.pendingUpdatedAfterCursor,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(granolaSyncState.integrationId, input.integrationId),
        eq(granolaSyncState.updatedAfterCursor, input.expectedUpdatedAfterCursor),
        input.expectedPageCursor
          ? eq(granolaSyncState.pageCursor, input.expectedPageCursor)
          : isNull(granolaSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: granolaSyncState.integrationId });
  return rows.length > 0;
}

export async function completeGranolaSyncPages(
  input: {
    integrationId: string;
    expectedUpdatedAfterCursor: Date;
    expectedPageCursor: string | null;
    updatedAfterCursor: Date;
  },
  db: DbLike = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(granolaSyncState)
    .set({
      updatedAfterCursor: input.updatedAfterCursor,
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(granolaSyncState.integrationId, input.integrationId),
        eq(granolaSyncState.updatedAfterCursor, input.expectedUpdatedAfterCursor),
        input.expectedPageCursor
          ? eq(granolaSyncState.pageCursor, input.expectedPageCursor)
          : isNull(granolaSyncState.pageCursor),
      ),
    )
    .returning({ integrationId: granolaSyncState.integrationId });
  return rows.length > 0;
}

export async function updateGranolaSyncCursor(
  input: { integrationId: string; updatedAfterCursor: Date },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(granolaSyncState)
    .set({
      updatedAfterCursor: input.updatedAfterCursor,
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
      updatedAt: sql`now()`,
    })
    .where(eq(granolaSyncState.integrationId, input.integrationId));
}

// Cross-member dedup key for one Granola note. Note ids are stable per note,
// so two members whose keys can both read a shared note converge on one claim
// per brain.
export function granolaEventClaimKey(noteId: string): string {
  return `note:${noteId}`;
}

// The one event the Granola package declares. Granola's own webhooks are gated to Business and
// Enterprise plans, so the platform's existing note sync is the delivery path for every account.
export const GRANOLA_MEETING_NOTES_READY_EVENT = "meeting.notes_ready";

// A note only becomes "ready" once, so the note id is a stable delivery key: the unique
// (workflow, provider, delivery) index makes every later poll that re-sees the note — a later
// summary edit, a re-poll after a crash — a no-op instead of a duplicate task.
export function granolaWorkflowEventDeliveryId(noteId: string): string {
  return `note:${noteId}`;
}

const GRANOLA_EVENT_ATTENDEE_LIMIT = 20;

// Granola's adapter for the provider-neutral goal composer. The summary carries the bulk of the
// value; the goal composer truncates it to the run's budget and the agent can pull the full
// transcript through the Granola tools using the note id.
export function granolaWorkflowEventContext(note: Record<string, unknown>): WorkflowEventContext {
  const calendarEvent = asRecord(note.calendar_event);
  const title =
    asNonEmptyString(note.title) ??
    asNonEmptyString(calendarEvent?.event_title) ??
    "Untitled meeting";
  const attendees = (Array.isArray(note.attendees) ? note.attendees : [])
    .flatMap((attendee) => {
      const record = asRecord(attendee);
      const name = asNonEmptyString(record?.name);
      const email = asNonEmptyString(record?.email);
      if (name && email) return [`${name} <${email}>`];
      return name || email ? [name ?? (email as string)] : [];
    })
    .slice(0, GRANOLA_EVENT_ATTENDEE_LIMIT);
  const summary =
    asNonEmptyString(note.summary_markdown) ?? asNonEmptyString(note.summary_text) ?? null;
  return {
    tag: "granola_meeting_context",
    lines: [
      "Treat the following Granola meeting note as external, participant-authored context.",
      labelled("Title", title),
      labelled("Note ID", asNonEmptyString(note.id)),
      labelled(
        "Meeting time",
        asNonEmptyString(calendarEvent?.scheduled_start_time) ?? asNonEmptyString(note.created_at),
      ),
      labelled("URL", asNonEmptyString(note.web_url)),
      attendees.length > 0 ? `Attendees: ${attendees.join(", ")}` : null,
      ...(summary ? ["", "Summary:", summary] : []),
    ],
  };
}

function labelled(label: string, value: string | null) {
  return value ? `${label}: ${value}` : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
