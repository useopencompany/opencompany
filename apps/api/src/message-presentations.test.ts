import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  messagePresentationEtag,
  PostgresMessagePresentationService,
} from "./message-presentations";

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin" as const,
  permissions: ["chat:read" as const],
  authenticationMethod: "session" as const,
};

describe("PostgresMessagePresentationService", () => {
  it("keeps Message, Conversation, workspace, legacy owner, and membership scope in the read", async () => {
    const dialect = new PgDialect();
    const compiledQueries: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (query: SQL) => {
      compiledQueries.push(dialect.sqlToQuery(query));
      return {
        rows: [
          {
            presentation: { uiMessageParts: [{ type: "text", text: "Done" }] },
            updatedAt: new Date("2026-08-10T20:00:01.000Z"),
          },
        ],
      };
    });
    const service = new PostgresMessagePresentationService(execute);

    await expect(
      service.get({
        actor,
        conversationId: "conversation_1",
        messageId: "message_1",
      }),
    ).resolves.toEqual({
      presentation: { uiMessageParts: [{ type: "text", text: "Done" }] },
      updatedAt: "2026-08-10T20:00:01.000Z",
    });
    const compiled = compiledQueries[0]!;
    expect(compiled.sql).toContain("message.id = $1");
    expect(compiled.sql).toContain("message.conversation_id = $2");
    expect(compiled.sql).toContain("message.workspace_id = $3");
    expect(compiled.sql).toContain("message.actor_id = $4");
    expect(compiled.sql).toContain("member.workspace_id = $5");
    expect(compiled.sql).toContain("member.user_workos_id = $6");
    expect(compiled.params).toEqual([
      "message_1",
      "conversation_1",
      "workspace_1",
      "user_1",
      "workspace_1",
      "user_1",
    ]);
  });

  it("builds a stable weak ETag from Message identity and update time", () => {
    const first = messagePresentationEtag("message_1", "2026-08-10T20:00:01.000Z");
    expect(first).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);
    expect(messagePresentationEtag("message_1", "2026-08-10T20:00:01.000Z")).toBe(first);
    expect(messagePresentationEtag("message_1", "2026-08-10T20:00:02.000Z")).not.toBe(first);
  });
});
