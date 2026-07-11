import { describe, expect, it, vi } from "vitest";
import {
  defaultGoatBrainIdForUser,
  getGoatBrainEnrichmentEnabled,
  newGoatBrainId,
  updateGoatBrainEnrichmentEnabled,
} from "./goat-workspaces";

describe("Goat brain ids", () => {
  it("generates readable default brain ids without embedding the WorkOS user id", () => {
    const id = defaultGoatBrainIdForUser("user_01JXYZ123456789");

    expect(id).toMatch(/^general-[a-f0-9]{12}$/);
    expect(id).not.toContain("user_01JXYZ123456789");
  });

  it("prefixes new brain ids with the normalized brain name", () => {
    expect(newGoatBrainId("Customer Research")).toMatch(/^customer-research-[a-f0-9]{12}$/);
  });

  it("falls back to a generic readable prefix when the name has no slug characters", () => {
    expect(newGoatBrainId("!!!")).toMatch(/^brain-[a-f0-9]{12}$/);
  });

  it("keeps generated ids within the legacy brain document id length", () => {
    const id = newGoatBrainId("A".repeat(200));

    expect(id).toHaveLength(80);
  });
});

describe("Goat brain enrichment flag", () => {
  it("returns the stored enrichment setting when the brain exists", async () => {
    const db = selectRowsDb([{ enrichmentEnabled: false }]);

    await expect(getGoatBrainEnrichmentEnabled("gbrain_123", db)).resolves.toBe(false);
  });

  it("fails closed when the brain row is missing", async () => {
    const db = selectRowsDb([]);

    await expect(getGoatBrainEnrichmentEnabled("gbrain_missing", db)).resolves.toBe(false);
  });

  it("throws when updating a missing brain", async () => {
    const db = updateRowsDb([]);

    await expect(
      updateGoatBrainEnrichmentEnabled({ brainRef: "gbrain_missing", enabled: true }, { db }),
    ).rejects.toThrow("Brain not found.");
  });
});

function selectRowsDb(rows: Array<{ enrichmentEnabled: boolean }>) {
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

function updateRowsDb(rows: Array<{ id: string }>) {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}
