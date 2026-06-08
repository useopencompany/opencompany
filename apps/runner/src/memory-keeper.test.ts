import { agentSessionEvents, agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const jobMocks = vi.hoisted(() => ({ enqueueRunnerJob: vi.fn(async () => ({ id: 1 })) }));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./jobs", () => ({ enqueueRunnerJob: jobMocks.enqueueRunnerJob }));

import { spawnMemoryKeeperSession } from "./memory-keeper";

type Insert = { table: unknown; values: Record<string, unknown> };

function createFakeDb() {
  const inserts: Insert[] = [];
  const tx = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return Promise.resolve();
        },
      };
    },
  };
  return {
    inserts,
    db: {
      async transaction(cb: (tx: unknown) => Promise<unknown>) {
        return cb(tx);
      },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("spawnMemoryKeeperSession", () => {
  it("creates a source:'memory' child under the parent and enqueues start then message", async () => {
    const { db, inserts } = createFakeDb();
    dbMocks.getDb.mockReturnValue(db);

    const result = await spawnMemoryKeeperSession({
      parentSessionId: "ses_parent",
      parentTitle: "Chat about Acme",
      workspaceId: "ws_1",
      userId: "user_1",
      agentId: "agent_personal",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
    });

    const sessionInsert = inserts.find((i) => i.table === agentSessions);
    expect(sessionInsert?.values).toMatchObject({
      id: result.childSessionId,
      workspaceId: "ws_1",
      userId: "user_1",
      agentId: "agent_personal",
      source: "memory",
      parentSessionId: "ses_parent",
    });
    expect(sessionInsert?.values.title).toContain("Memory pass");

    const messageInsert = inserts.find((i) => i.table === agentSessionMessages);
    expect(messageInsert?.values).toMatchObject({
      id: result.childMessageId,
      sessionId: result.childSessionId,
      role: "user",
      status: "completed",
    });
    // The kickoff names the parent session so the keeper knows what to fetch_transcript.
    expect(String(messageInsert?.values.content)).toContain("ses_parent");

    expect(inserts.some((i) => i.table === agentSessionEvents)).toBe(true);

    // Async boot: provision the sandbox (start) then run the seeded message.
    expect(jobMocks.enqueueRunnerJob).toHaveBeenNthCalledWith(1, {
      kind: "start",
      sessionId: result.childSessionId,
    });
    expect(jobMocks.enqueueRunnerJob).toHaveBeenNthCalledWith(2, {
      kind: "message",
      sessionId: result.childSessionId,
      messageId: result.childMessageId,
    });
  });
});
