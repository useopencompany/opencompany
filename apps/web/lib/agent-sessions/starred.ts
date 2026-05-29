"use client";

const STARRED_SESSIONS_STORAGE_KEY = "opencompany-starred-sessions";

/**
 * An in-memory snapshot of the current starred-sessions map. This single
 * reference is stable as long as the map hasn't changed, which lets
 * useSyncExternalStore avoid unnecessary re-renders.
 */
let cachedSnapshot: Record<string, string> = {};
let snapshotLoaded = false;

const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to starred-session changes. Compatible with useSyncExternalStore.
 * Also wires up a "storage" event listener so tabs stay in sync.
 */
export function subscribeStarredSessions(listener: () => void): () => void {
  listeners.add(listener);

  function onStorage(event: StorageEvent) {
    if (event.key === STARRED_SESSIONS_STORAGE_KEY) {
      cachedSnapshot = parseFromStorage(event.newValue);
      notifyListeners();
    }
  }

  if (listeners.size === 1) {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/**
 * Snapshot for useSyncExternalStore (client-side).
 * Reads localStorage on first call to hydrate the cache.
 */
export function getStarredSessionsSnapshot(): Record<string, string> {
  if (!snapshotLoaded) {
    snapshotLoaded = true;
    cachedSnapshot = parseFromStorage(
      typeof window !== "undefined"
        ? window.localStorage.getItem(STARRED_SESSIONS_STORAGE_KEY)
        : null,
    );
  }
  return cachedSnapshot;
}

/**
 * Server-side snapshot — always returns an empty map.
 * Required by useSyncExternalStore for SSR.
 */
export function getStarredSessionsServerSnapshot(): Record<string, string> {
  return cachedSnapshot;
}

/** Adds a session to the starred map and writes it back to localStorage. */
export function starSession(sessionId: string): Record<string, string> {
  const next = { ...cachedSnapshot, [sessionId]: new Date().toISOString() };
  commitStarredSessions(next);
  return next;
}

/** Removes a session from the starred map and writes it back to localStorage. */
export function unstarSession(sessionId: string): Record<string, string> {
  const next = { ...cachedSnapshot };
  delete next[sessionId];
  commitStarredSessions(next);
  return next;
}

function commitStarredSessions(map: Record<string, string>) {
  cachedSnapshot = map;
  try {
    window.localStorage.setItem(STARRED_SESSIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore — storage quota errors or private browsing restrictions.
  }
  notifyListeners();
}

function parseFromStorage(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [id, ts] of Object.entries(record)) {
      if (typeof ts === "string") result[id] = ts;
    }
    return result;
  } catch {
    return {};
  }
}
