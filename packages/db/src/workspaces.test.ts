import { describe, expect, it, vi } from "vitest";
import { wikis, workspaceMembers, workspaces } from "./product-schema";
import { createWorkspaceForUser } from "./workspaces";

describe("opencompany workspace creation", () => {
  it("creates the workspace, its creator membership, and its default wiki in one batch", async () => {
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
    expect(batch).toHaveBeenCalledOnce();
    const batchedQueries = batch.mock.calls[0]?.[0] ?? [];
    expect(batchedQueries).toHaveLength(3);
    expect(batchedQueries.some((query) => query.table === workspaceMembers)).toBe(true);
    // The workspace's one default wiki is created in the same batch, so no entry
    // point can ever resolve a workspace with no wiki to write to.
    expect(batchedQueries.find((query) => query.table === wikis)?.values).toMatchObject({
      workspaceId: "goat_ws_new",
      name: "Company",
      slug: "company",
      access: "workspace",
      isDefault: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("uses one transaction for the pooled API client", async () => {
    const insertedRows: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const insert = vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedRows.push({ table, values });
        if (table === workspaces) {
          return { returning: vi.fn(async () => [values]) };
        }
        return Promise.resolve();
      }),
    }));
    const transaction = vi.fn(async (callback: (tx: { insert: typeof insert }) => unknown) =>
      callback({ insert }),
    );
    const execute = vi.fn(async () => []);

    const result = await createWorkspaceForUser(
      {
        workspaceId: "workspace_new",
        workosOrganizationId: "org_new",
        userWorkosId: "user_123",
        name: "Analytical Co",
        slug: "analytical-co",
      },
      { db: { transaction, execute } },
    );

    expect(result.workspace).toEqual(
      expect.objectContaining({
        id: "workspace_new",
        workosOrganizationId: "org_new",
      }),
    );
    expect(transaction).toHaveBeenCalledOnce();
    expect(insertedRows.some((row) => row.table === workspaceMembers)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
