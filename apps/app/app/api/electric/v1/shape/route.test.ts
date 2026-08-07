import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeChatSessionShape } from "./route";

const dbMocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  select: vi.fn(),
  from: vi.fn(),
  leftJoin: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: dbMocks.select,
  }),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

vi.mock("@opencompany/db/workspaces", () => ({
  getBrainAccess: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.rows = [];
  dbMocks.select.mockReturnValue(builder);
  dbMocks.from.mockReturnValue(builder);
  dbMocks.leftJoin.mockReturnValue(builder);
  dbMocks.where.mockReturnValue(builder);
  dbMocks.limit.mockImplementation(async () => dbMocks.rows);
});

describe("authorizeChatSessionShape", () => {
  it("keeps regular chats private while allowing task chats by workspace", async () => {
    dbMocks.rows = [{ id: "goat_chat_1" }];

    await expect(
      authorizeChatSessionShape({
        requestUrl: new URL(
          "https://app.example.com/api/electric/v1/shape?table=goat.chat_messages&session_id=goat_chat_1",
        ),
        userWorkosId: "user_123",
        workspaceId: "workspace_123",
      }),
    ).resolves.toBe("goat_chat_1");

    const query = rendered(dbMocks.where.mock.calls[0]?.[0]);
    expect(query.sql).toContain('"goat"."chat_sessions"."kind" = $');
    expect(query.sql).toContain('"goat"."chat_sessions"."user_workos_id" = $');
    expect(query.sql).toContain('"goat"."codex_chat_sessions"."workspace_id" = $');
    expect(query.params).toContain("chat");
    expect(query.params).toContain("task");
    expect(query.params).toContain("user_123");
    expect(query.params).toContain("workspace_123");
  });

  it("ignores shapes that are not chat-session scoped", async () => {
    await expect(
      authorizeChatSessionShape({
        requestUrl: new URL("https://app.example.com/api/electric/v1/shape?table=goat.tasks"),
        userWorkosId: "user_123",
        workspaceId: "workspace_123",
      }),
    ).resolves.toBeNull();

    expect(dbMocks.select).not.toHaveBeenCalled();
  });
});

const builder = {
  from: dbMocks.from,
  leftJoin: dbMocks.leftJoin,
  where: dbMocks.where,
  limit: dbMocks.limit,
};

function rendered(query: SQL | undefined) {
  expect(query).toBeDefined();
  return new PgDialect().sqlToQuery(query!);
}
