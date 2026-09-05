import { getDb } from "@opencompany/db/client";
import {
  browserProfileSessions,
  browserProfiles,
  codexChatTurns,
} from "@opencompany/db/product-schema";
import { and, eq, isNotNull, isNull, lt, ne, notExists } from "drizzle-orm";
import {
  type BrowserbaseSessionSnapshot,
  listRunningBrowserbaseProfileSessions,
  requestBrowserbaseSessionRelease,
  retrieveBrowserbaseSession,
  settleBrowserbaseSession,
} from "./index";

type DbLike = any;

export const BROWSER_PROFILE_RECONCILE_GRACE_MS = 2 * 60_000;
export const BROWSER_PROFILE_LOGIN_RESCUE_WINDOW_MS = 15 * 60_000;

export type OpenBrowserProfileSession = {
  id: number;
  profileId: string;
  userWorkosId: string;
  browserbaseSessionId: string;
  kind: string;
  activeSessionId: string | null;
  turnStatus: string | null;
  turnLeaseExpiresAt: Date | null;
  createdAt: Date;
};

export async function loadOpenBrowserProfileSessions(
  db: DbLike = getDb(),
): Promise<OpenBrowserProfileSession[]> {
  return db
    .select({
      id: browserProfileSessions.id,
      profileId: browserProfileSessions.profileId,
      userWorkosId: browserProfileSessions.userWorkosId,
      browserbaseSessionId: browserProfileSessions.browserbaseSessionId,
      kind: browserProfileSessions.kind,
      activeSessionId: browserProfiles.activeSessionId,
      turnStatus: codexChatTurns.status,
      turnLeaseExpiresAt: codexChatTurns.leaseExpiresAt,
      createdAt: browserProfileSessions.createdAt,
    })
    .from(browserProfileSessions)
    .innerJoin(browserProfiles, eq(browserProfiles.id, browserProfileSessions.profileId))
    .leftJoin(
      codexChatTurns,
      and(
        eq(codexChatTurns.chatSessionId, browserProfileSessions.chatSessionId),
        eq(codexChatTurns.userMessageId, browserProfileSessions.userMessageId),
        eq(codexChatTurns.userWorkosId, browserProfileSessions.userWorkosId),
      ),
    )
    .where(isNull(browserProfileSessions.endedAt));
}

export async function clearStaleStartingBrowserProfileLocks(cutoff: Date, db: DbLike = getDb()) {
  const rows = await db
    .update(browserProfiles)
    .set({ activeSessionId: null, updatedAt: new Date() })
    .where(
      and(eq(browserProfiles.activeSessionId, "starting"), lt(browserProfiles.updatedAt, cutoff)),
    )
    .returning({ id: browserProfiles.id });
  return rows.length;
}

export async function clearOrphanedBrowserProfileLocks(db: DbLike = getDb()) {
  const rows = await db
    .update(browserProfiles)
    .set({ activeSessionId: null, updatedAt: new Date() })
    .where(
      and(
        isNotNull(browserProfiles.activeSessionId),
        ne(browserProfiles.activeSessionId, "starting"),
        notExists(
          db
            .select({ id: browserProfileSessions.id })
            .from(browserProfileSessions)
            .where(
              and(
                eq(browserProfileSessions.profileId, browserProfiles.id),
                eq(browserProfileSessions.browserbaseSessionId, browserProfiles.activeSessionId),
                isNull(browserProfileSessions.endedAt),
              ),
            ),
        ),
      ),
    )
    .returning({ id: browserProfiles.id });
  return rows.length;
}

export async function clearBrowserProfileSessionLock(
  session: OpenBrowserProfileSession,
  db: DbLike = getDb(),
) {
  const rows = await db
    .update(browserProfiles)
    .set({ activeSessionId: null, updatedAt: new Date() })
    .where(
      and(
        eq(browserProfiles.id, session.profileId),
        eq(browserProfiles.userWorkosId, session.userWorkosId),
        eq(browserProfiles.activeSessionId, session.browserbaseSessionId),
      ),
    )
    .returning({ id: browserProfiles.id });
  return rows.length > 0;
}

export async function reconcileBrowserProfileSessions(input: {
  signal: AbortSignal;
  now?: Date;
  graceMs?: number;
  listRunning?: () => Promise<BrowserbaseSessionSnapshot[]>;
  loadOpen?: () => Promise<OpenBrowserProfileSession[]>;
  retrieve?: (sessionId: string) => Promise<BrowserbaseSessionSnapshot>;
  release?: (sessionId: string) => Promise<boolean>;
  settle?: (
    session: OpenBrowserProfileSession,
    snapshot: BrowserbaseSessionSnapshot,
  ) => Promise<boolean>;
  clearStarting?: (cutoff: Date) => Promise<number>;
  clearOrphanedLocks?: () => Promise<number>;
  clearSessionLock?: (session: OpenBrowserProfileSession) => Promise<boolean>;
  releaseAll?: boolean;
}) {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input.graceMs ?? BROWSER_PROFILE_RECONCILE_GRACE_MS));
  const [running, open] = await Promise.all([
    (input.listRunning ?? listRunningBrowserbaseProfileSessions)(),
    (input.loadOpen ?? loadOpenBrowserProfileSessions)(),
  ]);
  const retrieve = input.retrieve ?? retrieveBrowserbaseSession;
  const release = input.release ?? requestBrowserbaseSessionRelease;
  const clearSessionLock = input.clearSessionLock ?? clearBrowserProfileSessionLock;
  const settle =
    input.settle ??
    ((session: OpenBrowserProfileSession, snapshot: BrowserbaseSessionSnapshot) =>
      settleBrowserbaseSession(
        {
          userWorkosId: session.userWorkosId,
          profileId: session.profileId,
          browserbaseSessionId: session.browserbaseSessionId,
          snapshot,
        },
        getDb(),
      ));
  const validOpenIds = new Set(
    input.releaseAll
      ? []
      : open
          .filter((session) => isPersistedSessionLive(session, now))
          .map((session) => session.browserbaseSessionId),
  );
  const released = new Set<string>();
  let settled = 0;
  let failed = 0;
  let clearedSessionLocks = 0;

  for (const persisted of open) {
    input.signal.throwIfAborted();
    if (persisted.createdAt > cutoff) continue;
    let provider: BrowserbaseSessionSnapshot;
    try {
      provider = await retrieve(persisted.browserbaseSessionId);
    } catch {
      failed += 1;
      continue;
    }
    if (provider.status === "RUNNING" || provider.status === "PENDING") {
      if (input.releaseAll || !isPersistedSessionLive(persisted, now)) {
        if (await releaseOnce(persisted.browserbaseSessionId, released, release)) {
          if (await clearSessionLock(persisted)) clearedSessionLocks += 1;
          continue;
        }
        failed += 1;
      }
      continue;
    }
    if (await settle(persisted, provider)) settled += 1;
    else failed += 1;
  }

  for (const provider of running) {
    input.signal.throwIfAborted();
    if (provider.userMetadata?.surface !== "goat-browser-profile") continue;
    const startedAt = new Date(provider.startedAt);
    if (!Number.isFinite(startedAt.getTime()) || startedAt > cutoff) continue;
    if (validOpenIds.has(provider.id)) continue;
    if (!(await releaseOnce(provider.id, released, release))) failed += 1;
  }

  const [clearedStartingLocks, clearedOrphanedLocks] = await Promise.all([
    (input.clearStarting ?? clearStaleStartingBrowserProfileLocks)(cutoff),
    (input.clearOrphanedLocks ?? clearOrphanedBrowserProfileLocks)(),
  ]);
  return {
    providerRunning: running.length,
    persistedOpen: open.length,
    released: released.size,
    settled,
    failed,
    clearedSessionLocks,
    clearedStartingLocks,
    clearedOrphanedLocks,
  };
}

function isPersistedSessionLive(session: OpenBrowserProfileSession, now: Date) {
  if (session.activeSessionId !== session.browserbaseSessionId) return false;
  if (session.kind === "login") {
    return session.createdAt.getTime() + BROWSER_PROFILE_LOGIN_RESCUE_WINDOW_MS > now.getTime();
  }
  return (
    session.kind === "agent" &&
    session.turnStatus === "running" &&
    Boolean(session.turnLeaseExpiresAt && session.turnLeaseExpiresAt > now)
  );
}

async function releaseOnce(
  sessionId: string,
  released: Set<string>,
  release: (sessionId: string) => Promise<boolean>,
) {
  if (released.has(sessionId)) return true;
  if (!(await release(sessionId))) return false;
  released.add(sessionId);
  return true;
}
