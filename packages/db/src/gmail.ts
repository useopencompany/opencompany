import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type GoatGmailMessageDirection,
  goatBrainSources,
  goatGmailMessageEvents,
  goatGmailSyncState,
} from "./schema";

type DbLike = any;

export const GOAT_GMAIL_EVENT_TYPES = ["email_received", "email_sent"] as const;

export type GoatGmailEventType = (typeof GOAT_GMAIL_EVENT_TYPES)[number];

export type GoatGmailEventRef = {
  id: GoatGmailEventType;
};

export const GOAT_GMAIL_INSTRUCTIONS_MAX_LENGTH = 2000;

// The routing contract between the source editor, the poll worker, and the
// flush worker: buffered messages are ingested into a brain only when their
// direction matches the enabled brain-source event selection; `instructions`
// is the owner's free-form tuning prompt the ingest agent applies when judging
// what is brain-worthy.
export type GoatGmailBrainSourceConfig = {
  events?: GoatGmailEventRef[];
  instructions?: string;
};

export type GoatGmailBrainSourceRoute = {
  integrationId: string;
  brainRef: string;
  config: GoatGmailBrainSourceConfig;
};

export type GoatGmailMessageEventInsert = {
  integrationId: string;
  userWorkosId: string;
  threadId: string;
  messageId: string;
  // RFC822 Message-ID header — the cross-mailbox identity used for
  // cross-member brain dedup; null when the header is absent.
  rfc822MessageId?: string | null;
  direction: GoatGmailMessageDirection;
  subject?: string | null;
  fromHeader?: string | null;
  payload: Record<string, unknown>;
  eventTime: Date;
};

export type GoatGmailSyncStateRow = {
  integrationId: string;
  userWorkosId: string;
  emailAddress: string | null;
  historyId: string | null;
};

export function goatGmailEventTypeForDirection(
  direction: GoatGmailMessageDirection,
): GoatGmailEventType {
  return direction === "sent" ? "email_sent" : "email_received";
}

export function parseGoatGmailBrainSourceConfig(value: unknown): GoatGmailBrainSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const events = parseEventRefs(record.events);
  const instructions = sanitizeGoatGmailInstructions(record.instructions);
  return {
    ...(events ? { events } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

export function sanitizeGoatGmailInstructions(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, GOAT_GMAIL_INSTRUCTIONS_MAX_LENGTH);
}

export function goatGmailSelectedEventTypes(
  config: GoatGmailBrainSourceConfig,
): Set<GoatGmailEventType> | null {
  if (!config.events) return null;
  return new Set(config.events.map((ref) => ref.id));
}

export function goatGmailRouteMatchesEvent(
  config: GoatGmailBrainSourceConfig,
  eventType: GoatGmailEventType,
) {
  const selected = goatGmailSelectedEventTypes(config);
  return selected === null || selected.has(eventType);
}

export async function listEnabledGoatGmailBrainSourceRoutes(
  integrationIds: readonly string[],
  db: DbLike = getDb(),
): Promise<GoatGmailBrainSourceRoute[]> {
  if (integrationIds.length === 0) return [];
  const rows = await db
    .select({
      integrationId: goatBrainSources.integrationId,
      brainRef: goatBrainSources.brainId,
      config: goatBrainSources.config,
    })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, "gmail"),
        eq(goatBrainSources.enabled, true),
        inArray(goatBrainSources.integrationId, [...integrationIds]),
      ),
    );

  return rows.map((row: { integrationId: string; brainRef: string; config: unknown }) => ({
    integrationId: row.integrationId,
    brainRef: row.brainRef,
    config: parseGoatGmailBrainSourceConfig(row.config),
  }));
}

// Live lookup at ingest time so instruction edits apply to already-queued jobs
// (the job content hash covers only the normalized item, never instructions).
export async function getGoatGmailBrainSourceInstructions(
  input: { integrationId: string; brainRef: string },
  db: DbLike = getDb(),
): Promise<string | null> {
  const rows = await db
    .select({ config: goatBrainSources.config })
    .from(goatBrainSources)
    .where(
      and(
        eq(goatBrainSources.provider, "gmail"),
        eq(goatBrainSources.brainId, input.brainRef),
        eq(goatBrainSources.integrationId, input.integrationId),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return parseGoatGmailBrainSourceConfig(rows[0]?.config).instructions ?? null;
}

export async function insertGoatGmailMessageEvents(
  events: readonly GoatGmailMessageEventInsert[],
  db: DbLike = getDb(),
): Promise<number> {
  if (events.length === 0) return 0;
  // History polling can re-report a message across overlapping windows; the
  // unique (integration, message id) index makes re-discovery a no-op.
  const rows = await db
    .insert(goatGmailMessageEvents)
    .values(
      events.map((event) => ({
        id: newGoatGmailMessageEventId(),
        integrationId: event.integrationId,
        userWorkosId: event.userWorkosId,
        threadId: event.threadId,
        messageId: event.messageId,
        rfc822MessageId: event.rfc822MessageId ?? null,
        direction: event.direction,
        subject: event.subject ?? null,
        fromHeader: event.fromHeader ?? null,
        payload: event.payload,
        eventTime: event.eventTime,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: goatGmailMessageEvents.id });
  return rows.length;
}

export async function ensureGoatGmailSyncState(
  input: { integrationId: string; userWorkosId: string },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .insert(goatGmailSyncState)
    .values({ integrationId: input.integrationId, userWorkosId: input.userWorkosId })
    .onConflictDoNothing();
}

// Claims one integration's poll slot: stamps last_polled_at only when the row
// hasn't been polled within the cooldown, so concurrent runner replicas skip
// each other. Returns the cursor on success, null when another replica holds
// the slot.
export async function claimGoatGmailSyncState(
  input: { integrationId: string; cooldownMs: number },
  db: DbLike = getDb(),
): Promise<GoatGmailSyncStateRow | null> {
  const cooldownSeconds = Math.max(1, Math.floor(input.cooldownMs / 1000));
  const rows = await db
    .update(goatGmailSyncState)
    .set({ lastPolledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(goatGmailSyncState.integrationId, input.integrationId),
        or(
          isNull(goatGmailSyncState.lastPolledAt),
          lt(
            goatGmailSyncState.lastPolledAt,
            sql`now() - make_interval(secs => ${cooldownSeconds})`,
          ),
        ),
      ),
    )
    .returning({
      integrationId: goatGmailSyncState.integrationId,
      userWorkosId: goatGmailSyncState.userWorkosId,
      emailAddress: goatGmailSyncState.emailAddress,
      historyId: goatGmailSyncState.historyId,
    });
  return rows[0] ?? null;
}

export async function updateGoatGmailSyncCursor(
  input: {
    integrationId: string;
    historyId: string;
    emailAddress?: string | null;
    reset?: boolean;
  },
  db: DbLike = getDb(),
): Promise<void> {
  await db
    .update(goatGmailSyncState)
    .set({
      historyId: input.historyId,
      ...(input.emailAddress !== undefined ? { emailAddress: input.emailAddress } : {}),
      ...(input.reset ? { lastResetAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(goatGmailSyncState.integrationId, input.integrationId));
}

// Cross-member dedup key for one email. The RFC822 Message-ID header is the
// only identity shared by every mailbox that holds a copy of the message;
// Gmail's own message ids are per-mailbox. When the header is missing (rare),
// fall back to a per-mailbox key so dedup degrades to at-most-once per
// integration instead of colliding.
export function goatGmailEventClaimKey(input: {
  rfc822MessageId: string | null | undefined;
  integrationId: string;
  gmailMessageId: string;
}): string {
  const normalized = normalizeRfc822MessageId(input.rfc822MessageId);
  if (normalized) return normalized;
  return `mailbox:${input.integrationId}:${input.gmailMessageId}`;
}

export function normalizeRfc822MessageId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return trimmed || null;
}

export function newGoatGmailMessageEventId() {
  return `ggmevt_${randomUUID().replace(/-/g, "")}`;
}

export function newGoatGmailThreadWindowId() {
  return `ggmwin_${randomUUID().replace(/-/g, "")}`;
}

function parseEventRefs(value: unknown): GoatGmailEventRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<GoatGmailEventType>();
  const refs = value.flatMap((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (!isGoatGmailEventType(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  });
  return refs;
}

function isGoatGmailEventType(value: unknown): value is GoatGmailEventType {
  return typeof value === "string" && (GOAT_GMAIL_EVENT_TYPES as readonly string[]).includes(value);
}
