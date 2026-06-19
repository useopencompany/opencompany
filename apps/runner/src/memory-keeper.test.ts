import { MEMORY_KEEPER_MODEL } from "@opencompany/agent-runtime";
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
    });

    const sessionInsert = inserts.find((i) => i.table === agentSessions);
    expect(sessionInsert?.values).toMatchObject({
      id: result.childSessionId,
      workspaceId: "ws_1",
      userId: "user_1",
      agentId: "agent_personal",
      source: "memory",
      parentSessionId: "ses_parent",
      // The keeper never inherits the parent's model — always the pinned cheap one.
      modelProvider: MEMORY_KEEPER_MODEL.provider,
      modelName: MEMORY_KEEPER_MODEL.name,
    });
    expect(sessionInsert?.values.title).toContain("Memory pass");

    const messageInsert = inserts.find((i) => i.table === agentSessionMessages);
    expect(messageInsert?.values).toMatchObject({
      id: result.childMessageId,
      sessionId: result.childSessionId,
      role: "user",
      status: "completed",
    });
    expect(messageInsert?.values.content).toBe(
      [
        "ses_parent",
        "",
        'Review ses_parent for explicit long-lived memory signals. If the user did not clearly ask to remember/save/update something and the transcript contains no correction or stable preference, identity fact, ongoing project, decision, or convention likely to matter in future sessions, make no tool writes and end exactly "Nothing new worth remembering." Otherwise update only the relevant structured memory/profile according to the system instructions.',
      ].join("\n"),
    );
    expect(messageInsert?.values.content).not.toContain("if you had to remember something");

    expect(inserts.some((i) => i.table === agentSessionEvents)).toBe(true);

    // The message job hydrates a sandbox under the run lease only if the memory pass needs one.
    expect(jobMocks.enqueueRunnerJob).toHaveBeenCalledOnce();
    expect(jobMocks.enqueueRunnerJob).toHaveBeenCalledWith({
      kind: "message",
      sessionId: result.childSessionId,
      messageId: result.childMessageId,
    });
  });
});
