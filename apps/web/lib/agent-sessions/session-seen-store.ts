// Per-device "have I seen this finished session?" store, backing the blue
// unseen-finished sidebar dot (PRO-142).
//
// SEAM: this is intentionally a tiny localStorage-backed store with a
// subscribe/snapshot surface (consumed by `useSessionSeen`). Swapping to a
// server-persisted, cross-device source (an Electric `session_views` shape,
// mirroring `session_stars`) later means reimplementing these functions only —
// callers and the dot logic do not change.

const STORAGE_KEY = "opencompany-session-seen";

type SeenMap = Readonly<Record<string, string>>;

const EMPTY: SeenMap = Object.freeze({});

// Cached snapshot. Held so `getSeenSnapshot` returns a stable reference (a
// requirement of useSyncExternalStore) until a write replaces it.
let cache: SeenMap | null = null;
const listeners = new Set<() => void>();
let storageBound = false;

function readFromStorage(): SeenMap {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SeenMap;
    }
  } catch {
    // Corrupt/unavailable storage falls back to empty.
  }
  return EMPTY;
}

function current(): SeenMap {
  if (cache === null) cache = readFromStorage();
  return cache;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getSeenAt(sessionId: string): string | null {
  return current()[sessionId] ?? null;
}

export function markSessionSeen(sessionId: string, at: string = new Date().toISOString()): void {
  const existing = current()[sessionId];
  // Only ever advance forward — re-opening an old session must not "un-see" a
  // later finish, and a stale cross-tab write must not move it backward.
  if (existing !== undefined && existing >= at) return;

  const next: SeenMap = { ...current(), [sessionId]: at };
  cache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort; an in-memory cache still drives this tab's UI.
    }
  }
  notify();
}

export function getSeenSnapshot(): SeenMap {
  return current();
}

export function subscribeSeen(listener: () => void): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Keep the store in sync across tabs: another tab marking a session seen fires a
// `storage` event here, so we drop the cache and re-notify.
function ensureStorageListener(): void {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    cache = null;
    notify();
  });
}
