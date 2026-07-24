import { describe, expect, it, vi } from "vitest";
import {
  GOAT_MANAGED_CAPABILITY_SOURCES,
  isGoatWorkspaceCapabilityEnabled,
  listGoatWorkspaceCapabilities,
  setGoatWorkspaceCapability,
} from "./goat-capabilities";

describe("Goat workspace capabilities", () => {
  it("defaults every managed source to enabled when no override row exists", async () => {
    await expect(listGoatWorkspaceCapabilities("workspace_1", selectDb([]))).resolves.toEqual(
      GOAT_MANAGED_CAPABILITY_SOURCES.map((source) => ({ source, enabled: true })),
    );
  });

  it("applies only explicit workspace overrides", async () => {
    await expect(
      listGoatWorkspaceCapabilities(
        "workspace_1",
        selectDb([
          { source: "linkedin", enabled: false },
          { source: "lead", enabled: true },
        ]),
      ),
    ).resolves.toEqual([
      { source: "x", enabled: true },
      { source: "linkedin", enabled: false },
      { source: "youtube", enabled: true },
      { source: "instagram", enabled: true },
      { source: "tiktok", enabled: true },
      { source: "lead", enabled: true },
      { source: "seo", enabled: true },
    ]);
  });

  it("treats a missing single-source override as enabled", async () => {
    await expect(
      isGoatWorkspaceCapabilityEnabled({
        workspaceId: "workspace_1",
        source: "x",
        db: selectOneDb([]),
      }),
    ).resolves.toBe(true);
    await expect(
      isGoatWorkspaceCapabilityEnabled({
        workspaceId: "workspace_1",
        source: "x",
        db: selectOneDb([{ enabled: false }]),
      }),
    ).resolves.toBe(false);
  });

  it("rejects unknown source ids before touching the database", async () => {
    const db = { insert: vi.fn() };
    await expect(
      setGoatWorkspaceCapability({
        workspaceId: "workspace_1",
        source: "followers_export" as never,
        enabled: true,
        updatedByWorkosId: "user_1",
        db,
      }),
    ).rejects.toThrow(/unknown managed capability source/i);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

function selectDb(rows: Array<{ source: string; enabled: boolean }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

function selectOneDb(rows: Array<{ enabled: boolean }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}
