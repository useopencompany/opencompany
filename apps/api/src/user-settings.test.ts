import type { Actor } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createUserSettingsService } from "./user-settings";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: [],
  authenticationMethod: "session",
};

const storedPreferences = {
  timezone: "UTC",
  taskSpawningEnabled: false,
  wikiEnabled: true as const,
  taskViewMode: "board" as const,
  autoModelRoutingEnabled: false,
};

function fakeDb(options: { selectRows?: unknown[]; updateRows?: unknown[] }) {
  const update = vi.fn(() => ({ set }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const updateWhere = vi.fn(() => ({
    returning: vi.fn(async () => options.updateRows ?? []),
  }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const selectWhere = vi.fn(() => ({ limit: vi.fn(async () => options.selectRows ?? []) }));
  return { db: { update, set, select }, update, set };
}

describe("user settings service", () => {
  it("skips the write entirely when every requested value already matches", async () => {
    const { db, update } = fakeDb({ selectRows: [storedPreferences] });
    const service = createUserSettingsService({ db });

    await expect(service.updatePreferences(actor, { timezone: "UTC" })).resolves.toEqual(
      storedPreferences,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("normalizes unknown timezones to UTC before comparing and writing", async () => {
    const { db, update } = fakeDb({ selectRows: [storedPreferences] });
    const service = createUserSettingsService({ db });

    await expect(service.updatePreferences(actor, { timezone: "Not/A_Zone" })).resolves.toEqual(
      storedPreferences,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the compatibility Wiki preference always on without writing", async () => {
    const { db, update } = fakeDb({ selectRows: [storedPreferences] });
    const service = createUserSettingsService({ db });

    await expect(service.updatePreferences(actor, { wikiEnabled: false })).resolves.toEqual(
      storedPreferences,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("writes only the changed fields and stamps updatedAt", async () => {
    const now = new Date("2026-08-13T08:00:00.000Z");
    const updated = { ...storedPreferences, taskViewMode: "list" as const };
    const { db, set } = fakeDb({ selectRows: [storedPreferences], updateRows: [updated] });
    const service = createUserSettingsService({ db, now: () => now });

    await expect(service.updatePreferences(actor, { taskViewMode: "list" })).resolves.toEqual(
      updated,
    );
    expect(set).toHaveBeenCalledWith({ taskViewMode: "list", updatedAt: now });
  });

  it("reports a missing profile as a structured not_found error", async () => {
    const { db } = fakeDb({ selectRows: [] });
    const service = createUserSettingsService({ db });

    await expect(
      service.updatePreferences(actor, { taskSpawningEnabled: true }),
    ).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(service.getMcpSetup(actor)).rejects.toBeInstanceOf(ApiError);
  });

  it("derives MCP setup completion from the completion timestamp", async () => {
    const completedAt = new Date("2026-08-01T12:00:00.000Z");
    const { db } = fakeDb({
      selectRows: [{ preferredClient: "claude", completedAt }],
    });
    const service = createUserSettingsService({ db });

    await expect(service.getMcpSetup(actor)).resolves.toEqual({
      preferredClient: "claude",
      complete: true,
      completedAt,
    });
  });

  it("saves the preferred MCP client and returns the refreshed status", async () => {
    const { db, set } = fakeDb({
      updateRows: [{ preferredClient: "cursor", completedAt: null }],
    });
    const now = new Date("2026-08-13T08:00:00.000Z");
    const service = createUserSettingsService({ db, now: () => now });

    await expect(service.setPreferredMcpClient(actor, "cursor")).resolves.toEqual({
      preferredClient: "cursor",
      complete: false,
      completedAt: null,
    });
    expect(set).toHaveBeenCalledWith({ preferredMcpClient: "cursor", updatedAt: now });
  });
});
