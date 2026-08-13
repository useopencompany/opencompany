import type { Actor, CoreError } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profile = {
  id: "9c2f2c6d-8f0e-5abc-aabc-0123456789ab",
  name: "Acme back office",
  siteHost: "app.acme.com",
  allowedHosts: ["app.acme.com"],
  status: "pending_login" as const,
  active: false,
  lastUsedAt: null,
  createdAt: "2026-08-10T20:00:00.000Z",
  updatedAt: "2026-08-10T20:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  browserProfilesAvailable: vi.fn(() => true),
  listBrowserProfilesForUser: vi.fn(async () => [] as (typeof profile)[]),
  createBrowserProfile: vi.fn(async (input: { profileId?: string }) => ({
    ...profile,
    id: input.profileId ?? profile.id,
  })),
  deleteBrowserProfile: vi.fn(async () => undefined),
  createLoginSession: vi.fn(async () => ({
    sessionId: "session_1",
    liveViewUrl: "https://browserbase.example/live/session_1",
  })),
  completeLoginSession: vi.fn(async () => ({ ok: true })),
  resolveLiveViewUrl: vi.fn(async () => "https://browserbase.example/live/session_1"),
}));

vi.mock("./index", () => mocks);

const { GoatBrowserProfileApplicationService } = await import("./service");

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: [],
  authenticationMethod: "session",
};

type Reservation = { requestHash: string; operation: string; resourceId: string };

// Mirrors the insert ... on conflict do update ... returning chain the service issues against
// the idempotency table. By default the reservation echoes the inserted row (first write wins).
function fakeDb(stored?: (inserted: Reservation) => Reservation) {
  const inserted: Reservation[] = [];
  return {
    inserted,
    insert: () => ({
      values: (row: Reservation) => {
        inserted.push(row);
        return {
          onConflictDoUpdate: () => ({
            returning: async () => [stored ? stored(row) : row],
          }),
        };
      },
    }),
  };
}

describe("GoatBrowserProfileApplicationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listBrowserProfilesForUser.mockResolvedValue([]);
  });

  it("creates a profile under a deterministic reserved command id", async () => {
    const db = fakeDb();
    const service = new GoatBrowserProfileApplicationService(db);

    const result = await service.create(actor, {
      idempotencyKey: "profile-key-1",
      name: "Acme back office",
      siteUrl: "https://app.acme.com",
    });

    expect(result.replayed).toBe(false);
    expect(db.inserted[0]?.resourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(mocks.createBrowserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        profileId: db.inserted[0]?.resourceId,
      }),
    );
    expect(result.profile.id).toBe(db.inserted[0]?.resourceId);
  });

  it("replays the stored profile for a repeated identical command", async () => {
    const db = fakeDb();
    const service = new GoatBrowserProfileApplicationService(db);
    const command = {
      idempotencyKey: "profile-key-1",
      name: "Acme back office",
      siteUrl: "https://app.acme.com",
    };

    const first = await service.create(actor, command);
    mocks.listBrowserProfilesForUser.mockResolvedValue([{ ...profile, id: first.profile.id }]);
    const replayed = await service.create(actor, command);

    expect(replayed).toMatchObject({ profile: { id: first.profile.id }, replayed: true });
    expect(mocks.createBrowserProfile).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing an Idempotency-Key for a different command", async () => {
    const db = fakeDb((row) => ({ ...row, requestHash: "0".repeat(64) }));
    const service = new GoatBrowserProfileApplicationService(db);

    await expect(
      service.create(actor, {
        idempotencyKey: "profile-key-1",
        name: "Different profile",
        siteUrl: "https://other.acme.com",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<CoreError>);
    expect(mocks.createBrowserProfile).not.toHaveBeenCalled();
  });

  it("returns the winner when a concurrent identical retry loses the insert race", async () => {
    const db = fakeDb();
    const service = new GoatBrowserProfileApplicationService(db);
    mocks.createBrowserProfile.mockImplementationOnce(async (input: { profileId?: string }) => {
      mocks.listBrowserProfilesForUser.mockResolvedValue([
        { ...profile, id: input.profileId ?? profile.id },
      ]);
      throw Object.assign(new Error("duplicate key"), { cause: { code: "23505" } });
    });

    const result = await service.create(actor, {
      idempotencyKey: "profile-key-1",
      name: "Acme back office",
      siteUrl: "https://app.acme.com",
    });

    expect(result.replayed).toBe(true);
    expect(result.profile.id).toBe(db.inserted[0]?.resourceId);
  });

  it("maps shared browser-profile errors onto typed protocol codes", async () => {
    const service = new GoatBrowserProfileApplicationService(fakeDb());

    mocks.deleteBrowserProfile.mockRejectedValueOnce(new Error("Browser profile not found."));
    await expect(service.delete(actor, "profile_1")).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<CoreError>);

    mocks.createLoginSession.mockRejectedValueOnce(
      new Error("This browser profile already has an active session."),
    );
    await expect(service.startLoginSession(actor, "profile_1")).rejects.toMatchObject({
      code: "conflict",
    } satisfies Partial<CoreError>);

    mocks.createLoginSession.mockRejectedValueOnce(
      new Error("Browser profiles are temporarily disabled."),
    );
    await expect(service.startLoginSession(actor, "profile_1")).rejects.toMatchObject({
      code: "unavailable",
    } satisfies Partial<CoreError>);

    const unmapped = new Error("Unexpected provider outage.");
    mocks.createLoginSession.mockRejectedValueOnce(unmapped);
    await expect(service.startLoginSession(actor, "profile_1")).rejects.toBe(unmapped);
  });

  it("validates the actor and identifiers before touching the provider", async () => {
    const service = new GoatBrowserProfileApplicationService(fakeDb());

    await expect(service.list({ ...actor, workspaceId: " " })).rejects.toMatchObject({
      code: "forbidden",
    } satisfies Partial<CoreError>);

    await expect(service.delete(actor, "../etc/passwd")).rejects.toMatchObject({
      code: "invalid_argument",
    } satisfies Partial<CoreError>);

    await expect(
      service.create(actor, {
        idempotencyKey: "bad key with spaces",
        name: "Acme back office",
        siteUrl: "https://app.acme.com",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" } satisfies Partial<CoreError>);
    expect(mocks.deleteBrowserProfile).not.toHaveBeenCalled();
    expect(mocks.createBrowserProfile).not.toHaveBeenCalled();
  });
});
