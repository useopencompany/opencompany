import { beforeEach, describe, expect, it, vi } from "vitest";

// Reset the module-level cache between tests so each starts clean.
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

async function load() {
  return import("./session-seen-store");
}

describe("session-seen store", () => {
  it("returns null for a session that was never seen", async () => {
    const store = await load();
    expect(store.getSeenAt("ses_1")).toBe(null);
  });

  it("records and reads back a seen timestamp", async () => {
    const store = await load();
    store.markSessionSeen("ses_1", "2026-06-05T10:00:00.000Z");
    expect(store.getSeenAt("ses_1")).toBe("2026-06-05T10:00:00.000Z");
  });

  it("persists to localStorage so a fresh load sees it", async () => {
    const first = await load();
    first.markSessionSeen("ses_1", "2026-06-05T10:00:00.000Z");

    vi.resetModules();
    const reloaded = await load();
    expect(reloaded.getSeenAt("ses_1")).toBe("2026-06-05T10:00:00.000Z");
  });

  it("only advances the seen timestamp forward, never backward", async () => {
    const store = await load();
    store.markSessionSeen("ses_1", "2026-06-05T11:00:00.000Z");
    store.markSessionSeen("ses_1", "2026-06-05T10:00:00.000Z"); // older — ignored
    expect(store.getSeenAt("ses_1")).toBe("2026-06-05T11:00:00.000Z");
  });

  it("notifies subscribers when a session is marked seen", async () => {
    const store = await load();
    const listener = vi.fn();
    store.subscribeSeen(listener);
    store.markSessionSeen("ses_1", "2026-06-05T10:00:00.000Z");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns a stable snapshot reference until something changes", async () => {
    const store = await load();
    const a = store.getSeenSnapshot();
    expect(store.getSeenSnapshot()).toBe(a); // unchanged → same ref
    store.markSessionSeen("ses_1", "2026-06-05T10:00:00.000Z");
    expect(store.getSeenSnapshot()).not.toBe(a); // changed → new ref
  });
});
