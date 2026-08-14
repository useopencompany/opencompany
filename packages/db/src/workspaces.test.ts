import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { defaultBrainFolderManifestEntries } from "../../brain/src/index";
import { brainFolders, brains, workspaceMembers, workspaces } from "./product-schema";
import {
  createWorkspaceForUser,
  getBrainEnrichmentEnabled,
  newBrainId,
  replaceBrainMembers,
  updateBrainEnrichmentEnabled,
} from "./workspaces";

const pgDialect = new PgDialect();

describe("opencompany brain ids", () => {
  it("prefixes new brain ids with the normalized brain name", () => {
    expect(newBrainId("Customer Research")).toMatch(/^customer-research-[a-f0-9]{12}$/);
  });

  it("falls back to a generic readable prefix when the name has no slug characters", () => {
    expect(newBrainId("!!!")).toMatch(/^brain-[a-f0-9]{12}$/);
  });

  it("keeps generated ids within the legacy brain document id length", () => {
    const id = newBrainId("A".repeat(200));

    expect(id).toHaveLength(80);
  });
});

describe("opencompany workspace creation", () => {
  it("batches the workspace, membership, default brain, and folder rows together", async () => {
    const insert = vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        const query = {
          table,
          values,
          returning: vi.fn(),
        };
        query.returning.mockReturnValue(query);
        return query;
      }),
    }));
    const batch = vi.fn(
      async (queries: Array<{ table: unknown; values: Record<string, unknown> }>) =>
        queries.map((query) => {
          if (query.table === workspaces) return [query.values];
          if (query.table === brains) return [query.values];
          return undefined;
        }),
    );
    const execute = vi.fn(async () => []);

    const result = await createWorkspaceForUser(
      {
        workspaceId: "goat_ws_new",
        workosOrganizationId: "org_new",
        userWorkosId: "user_123",
        name: "  Analytical Co  ",
        slug: "analytical-co",
      },
      { db: { insert, batch, execute } },
    );

    expect(result.workspace).toEqual(
      expect.objectContaining({
        id: "goat_ws_new",
        workosOrganizationId: "org_new",
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    );
    expect(result.brain).toEqual(
      expect.objectContaining({
        workspaceId: "goat_ws_new",
        name: "General",
        slug: "general",
      }),
    );
    expect(batch).toHaveBeenCalledOnce();
    const batchedQueries = batch.mock.calls[0]?.[0] ?? [];
    expect(batchedQueries).toHaveLength(3 + defaultBrainFolderManifestEntries().length);
    expect(batchedQueries.some((query) => query.table === workspaceMembers)).toBe(true);
    expect(batchedQueries.filter((query) => query.table === brainFolders)).toHaveLength(
      defaultBrainFolderManifestEntries().length,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("opencompany brain enrichment flag", () => {
  it("returns the stored enrichment setting when the brain exists", async () => {
    const db = selectRowsDb([{ enrichmentEnabled: false }]);

    await expect(getBrainEnrichmentEnabled("gbrain_123", db)).resolves.toBe(false);
  });

  it("fails closed when the brain row is missing", async () => {
    const db = selectRowsDb([]);

    await expect(getBrainEnrichmentEnabled("gbrain_missing", db)).resolves.toBe(false);
  });

  it("throws when updating a missing brain", async () => {
    const db = updateRowsDb([]);

    await expect(
      updateBrainEnrichmentEnabled({ brainRef: "gbrain_missing", enabled: true }, { db }),
    ).rejects.toThrow("Brain not found.");
  });
});

describe("opencompany brain access membership", () => {
  it("removes personal sources for users excluded from the desired member set", async () => {
    let executedQuery: unknown;
    const execute = vi.fn(async (query: unknown) => {
      executedQuery = query;
      return [];
    });

    await replaceBrainMembers(
      {
        brainRef: "brain_restricted",
        userWorkosIds: ["user_admin", "user_retained"],
        addedByWorkosId: "user_admin",
      },
      { db: { execute } },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const query = pgDialect.sqlToQuery(executedQuery as SQL);
    const normalizedSql = query.sql.toLowerCase();
    expect(normalizedSql).toContain("delete from goat.brain_members");
    expect(normalizedSql).toContain("insert into goat.brain_members");
    expect(normalizedSql).toContain("delete from goat.brain_sources");
    expect(normalizedSql).toContain("integration.workspace_id is null");
    expect(normalizedSql).toContain("desired.user_workos_id = bs.user_workos_id");
    expect(query.params).toEqual(
      expect.arrayContaining(["brain_restricted", "user_admin", "user_retained"]),
    );
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
