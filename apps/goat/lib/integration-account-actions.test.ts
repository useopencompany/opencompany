import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, revalidatePathMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({ execute: executeMock }),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(async () => ({ user: { workosUserId: "user_owner" } })),
}));

const { disconnectGoatIntegrationAccountAction } = await import("./integration-account-actions");
const pgDialect = new PgDialect();

describe("disconnectGoatIntegrationAccountAction", () => {
  beforeEach(() => {
    executeMock.mockReset();
    revalidatePathMock.mockReset();
  });

  it("releases claims without a successful brain job before deleting the integration", async () => {
    executeMock.mockResolvedValue([{ id: "integration_123" }]);

    await expect(disconnectGoatIntegrationAccountAction("integration_123")).resolves.toEqual({
      ok: true,
    });

    const query = pgDialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL);
    const normalizedSql = query.sql.toLowerCase();
    expect(normalizedSql).toContain("delete from goat.brain_source_event_claims");
    expect(normalizedSql).toContain("job.status = 'succeeded'");
    expect(normalizedSql).toContain("delete from goat.integrations");
    expect(normalizedSql.indexOf("released_claims")).toBeLessThan(
      normalizedSql.indexOf("release_guard"),
    );
    expect(query.params).toEqual(expect.arrayContaining(["integration_123", "user_owner"]));
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("rejects deleting an account the current user does not own", async () => {
    executeMock.mockResolvedValue([]);

    await expect(disconnectGoatIntegrationAccountAction("integration_other")).resolves.toEqual({
      ok: false,
      error: "Only the connection owner can manage this account.",
    });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
