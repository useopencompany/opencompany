import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROFILE_RECONCILE_GRACE_MS,
  type OpenBrowserProfileSession,
  reconcileBrowserProfileSessions,
} from "./reconciler";

const now = new Date("2026-09-05T12:00:00.000Z");

function persisted(
  browserbaseSessionId: string,
  activeSessionId: string | null = browserbaseSessionId,
): OpenBrowserProfileSession {
  return {
    id: 1,
    profileId: "profile_1",
    userWorkosId: "user_1",
    browserbaseSessionId,
    kind: "agent",
    activeSessionId,
    turnStatus: "running",
    turnLeaseExpiresAt: new Date(now.getTime() + 60_000),
    createdAt: new Date(now.getTime() - BROWSER_PROFILE_RECONCILE_GRACE_MS - 1),
  };
}

function provider(
  id: string,
  status: "PENDING" | "RUNNING" | "ERROR" | "TIMED_OUT" | "COMPLETED" = "RUNNING",
) {
  return {
    id,
    projectId: "project_1",
    status,
    startedAt: new Date(now.getTime() - BROWSER_PROFILE_RECONCILE_GRACE_MS - 1).toISOString(),
    updatedAt: now.toISOString(),
    ...(status === "COMPLETED" ? { endedAt: now.toISOString() } : {}),
    proxyBytes: 0,
    userMetadata: { surface: "goat-browser-profile" },
  };
}

describe("reconcileBrowserProfileSessions", () => {
  it("releases provider orphans and running rows whose active lock no longer matches", async () => {
    const release = vi.fn(async () => true);
    const stale = persisted("stale", "different");

    const result = await reconcileBrowserProfileSessions({
      signal: new AbortController().signal,
      now,
      listRunning: async () => [provider("healthy"), provider("orphan"), provider("unrelated")],
      loadOpen: async () => [persisted("healthy"), stale],
      retrieve: async (id) => provider(id),
      release,
      clearSessionLock: async () => true,
      settle: vi.fn(),
      clearStarting: async () => 1,
      clearOrphanedLocks: async () => 1,
    });

    expect(release.mock.calls).toEqual([["stale"], ["orphan"], ["unrelated"]]);
    expect(result).toMatchObject({ released: 3, settled: 0, failed: 0 });
  });

  it("settles terminal provider sessions and leaves healthy running sessions alone", async () => {
    const release = vi.fn(async () => true);
    const settle = vi.fn(async () => true);

    const result = await reconcileBrowserProfileSessions({
      signal: new AbortController().signal,
      now,
      listRunning: async () => [provider("healthy")],
      loadOpen: async () => [persisted("healthy"), persisted("completed")],
      retrieve: async (id) => provider(id, id === "completed" ? "COMPLETED" : "RUNNING"),
      release,
      clearSessionLock: async () => true,
      settle,
      clearStarting: async () => 0,
      clearOrphanedLocks: async () => 0,
    });

    expect(release).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ browserbaseSessionId: "completed" }),
      expect.objectContaining({ status: "COMPLETED" }),
    );
    expect(result.settled).toBe(1);
  });

  it("releases a crash leak after its owning turn lease expires", async () => {
    const release = vi.fn(async () => true);
    const clearSessionLock = vi.fn(async () => true);
    const crashed = {
      ...persisted("crashed"),
      turnLeaseExpiresAt: new Date(now.getTime() - 1),
    };

    const result = await reconcileBrowserProfileSessions({
      signal: new AbortController().signal,
      now,
      listRunning: async () => [provider("crashed")],
      loadOpen: async () => [crashed],
      retrieve: async () => provider("crashed"),
      release,
      clearSessionLock,
      settle: vi.fn(),
      clearStarting: async () => 0,
      clearOrphanedLocks: async () => 0,
    });

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("crashed");
    expect(clearSessionLock).toHaveBeenCalledWith(crashed);
    expect(result).toMatchObject({ released: 1, clearedSessionLocks: 1 });
  });

  it("keeps newly-created sessions inside the persistence grace window", async () => {
    const release = vi.fn(async () => true);
    const recent = provider("recent");
    recent.startedAt = new Date(now.getTime() - 1_000).toISOString();

    const result = await reconcileBrowserProfileSessions({
      signal: new AbortController().signal,
      now,
      listRunning: async () => [recent],
      loadOpen: async () => [],
      retrieve: vi.fn(),
      release,
      clearSessionLock: async () => true,
      settle: vi.fn(),
      clearStarting: async () => 0,
      clearOrphanedLocks: async () => 0,
    });

    expect(release).not.toHaveBeenCalled();
    expect(result.released).toBe(0);
  });

  it("releases otherwise healthy sessions when the kill switch is active", async () => {
    const release = vi.fn(async () => true);

    await reconcileBrowserProfileSessions({
      signal: new AbortController().signal,
      now,
      releaseAll: true,
      listRunning: async () => [provider("healthy")],
      loadOpen: async () => [persisted("healthy")],
      retrieve: async () => provider("healthy"),
      release,
      clearSessionLock: async () => true,
      settle: vi.fn(),
      clearStarting: async () => 0,
      clearOrphanedLocks: async () => 0,
    });

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("healthy");
  });
});
