import { describe, expect, it, vi } from "vitest";
import { setGoatBrainSourceEnabled } from "./goat-brain-sources";

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
