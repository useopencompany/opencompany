import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock("./client", () => ({ getDb: getDbMock }));

const { setGoatBrainSourceEnabled, upsertGoatBrainSource } = await import("./brain-sources");

describe("upsertGoatBrainSource", () => {
  it("reports a new source without opening a transaction on the neon-http web client", async () => {
    const returning = vi.fn(async () => [{ id: "gbscfg_1" }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({ returning })),
        })),
      })),
      transaction,
    };
    Object.setPrototypeOf(db, NeonHttpDatabase.prototype);
    getDbMock.mockReturnValue(db);

    await expect(
      upsertGoatBrainSource({
        brainRef: "gbrain_1",
        provider: "github",
        integrationId: "gint_1",
        userWorkosId: "user_1",
        createdByWorkosId: "user_1",
        enabled: true,
        config: { repos: [{ owner: "acme", repo: "api" }] },
        now: new Date("2026-07-22T13:30:00.000Z"),
      }),
    ).resolves.toEqual({ id: "gbscfg_1", created: true });

    expect(transaction).not.toHaveBeenCalled();
    expect(returning).toHaveBeenCalledOnce();
  });

  it("updates and reports an existing source", async () => {
    const insertReturning = vi.fn(async () => []);
    const updateReturning = vi.fn(async () => [{ id: "gbscfg_1" }]);
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({ returning: insertReturning })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: updateReturning })),
        })),
      })),
    };

    await expect(
      upsertGoatBrainSource({
        brainRef: "gbrain_1",
        provider: "github",
        integrationId: "gint_1",
        userWorkosId: "user_1",
        createdByWorkosId: "user_1",
        enabled: true,
        config: { repos: [{ owner: "acme", repo: "api" }] },
        now: new Date("2026-07-22T13:30:00.000Z"),
        db,
      }),
    ).resolves.toEqual({ id: "gbscfg_1", created: false });

    expect(insertReturning).toHaveBeenCalledOnce();
    expect(updateReturning).toHaveBeenCalledOnce();
  });
});

describe("setGoatBrainSourceEnabled", () => {
  it("terminally cancels active ingest work when a source is disabled", async () => {
    const execute = vi.fn(async () => undefined);
    const returning = vi.fn(async () => [{ id: "gbscfg_1", integrationId: "gint_1" }]);
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
      execute,
    };

    await expect(
      setGoatBrainSourceEnabled({
        brainRef: "gbrain_1",
        sourceId: "gbscfg_1",
        enabled: false,
        now: new Date("2026-07-17T13:27:12.000Z"),
        db,
      }),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not touch existing jobs when a source is enabled", async () => {
    const execute = vi.fn(async () => undefined);
    const returning = vi.fn(async () => [{ id: "gbscfg_1", integrationId: "gint_1" }]);
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
      execute,
    };

    await expect(
      setGoatBrainSourceEnabled({
        brainRef: "gbrain_1",
        sourceId: "gbscfg_1",
        enabled: true,
        now: new Date("2026-07-17T13:27:12.000Z"),
        db,
      }),
    ).resolves.toBe(true);

    expect(execute).not.toHaveBeenCalled();
  });
});
