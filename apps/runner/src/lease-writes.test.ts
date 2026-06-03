import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLeaseDb,
  createStateLeaseWriteStore,
  type LeaseDbState,
} from "./agent-loop-test-support";
import { appendRuntimeEvent } from "./events";
import {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
  insertToolApprovalForLease,
  insertToolMessageForLease,
  type LeaseWriteStore,
  StaleRunLeaseError,
  setLeaseWriteStoreForTests,
} from "./lease-writes";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

// The lease-guarded helpers route their durable event append through
// `events.appendRuntimeEvent` (mocked here so it never touches a database) and their
// row writes through an injected `LeaseWriteStore`. That lets us reproduce the exact
// TOCTOU the atomic statements close: reclaim the lease on another owner, then attempt
// a guarded write under the old lease, and assert the database refused it.
vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
  publishTransientRuntimeEvent: vi.fn((event) => ({ ...event, id: null, transient: true })),
}));

beforeEach(() => {
  setLeaseWriteStoreForTests(
    createStateLeaseWriteStore(() => (dbMocks.getDb() as { state: LeaseDbState }).state),
  );
});

afterEach(() => {
  setLeaseWriteStoreForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type StoredMessage = {
  id: string;
  sessionId: string;
  role: string;
  status: string;
  internal: boolean;
  content?: string;
  responseToMessageId: string | null;
  toolName?: string;
  toolCallId?: string;
};

/**
 * In-memory `LeaseWriteStore` whose writes are gated on a mutable session lease — the
 * same atomicity the SQL `WHERE EXISTS (lease current)` enforces. `reclaim()` models
 * another instance taking the lease; any subsequent guarded write under the old lease
 * sees the new owner and writes nothing.
 */
function createMemoryLeaseWriteStore(initial: { leaseId: string; leaseOwner: string }) {
  const lease = { leaseId: initial.leaseId, leaseOwner: initial.leaseOwner, archived: false };
  const messages: StoredMessage[] = [];
  const usage: Array<{ id: number }> = [];
  const toolUsage: Array<{ id: number }> = [];
  const sandboxUsage: Array<{ id: number }> = [];

  const isCurrent = (guard: { leaseId: string; leaseOwner: string }) =>
    !lease.archived && lease.leaseId === guard.leaseId && lease.leaseOwner === guard.leaseOwner;

  const store: LeaseWriteStore = {
    async insertAssistantMessage(input, guard) {
      if (!isCurrent(guard)) return null;
      if (
        input.responseToMessageId &&
        messages.some((message) => message.responseToMessageId === input.responseToMessageId)
      ) {
        return "conflict";
      }
      messages.push({
        id: input.id,
        sessionId: input.sessionId,
        role: "assistant",
        status: "running",
        internal: input.internal,
        responseToMessageId: input.responseToMessageId,
      });
      return "inserted";
    },
    async findResponseMessage(sessionId, responseToMessageId) {
      const message = messages.find(
        (item) => item.sessionId === sessionId && item.responseToMessageId === responseToMessageId,
      );
      return message ? { id: message.id, status: message.status } : null;
    },
    async completeAssistantMessage(input, guard) {
      if (!isCurrent(guard)) return false;
      const message = messages.find(
        (item) => item.id === input.assistantMessageId && item.sessionId === input.sessionId,
      );
      if (!message) return false;
      message.status = "completed";
      message.content = input.content;
      return true;
    },
    async insertToolApproval(_input, guard) {
      if (!isCurrent(guard)) return null;
      return "inserted";
    },
    async insertToolMessage(input, guard) {
      if (!isCurrent(guard)) return false;
      messages.push({
        id: input.id,
        sessionId: input.sessionId,
        role: "tool",
        status: "completed",
        internal: input.internal,
        content: input.content,
        responseToMessageId: null,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
      });
      return true;
    },
    async insertModelUsage(_input, guard) {
      if (!isCurrent(guard)) return null;
      const row = { id: usage.length + 1 };
      usage.push(row);
      return row;
    },
    async insertToolUsage(_input, guard) {
      if (!isCurrent(guard)) return null;
      const row = { id: toolUsage.length + 1 };
      toolUsage.push(row);
      return row;
    },
    async insertSandboxUsage(_input, guard) {
      if (!isCurrent(guard)) return null;
      const row = { id: sandboxUsage.length + 1 };
      sandboxUsage.push(row);
      return row;
    },
  };

  return {
    store,
    messages,
    usage,
    toolUsage,
    sandboxUsage,
    reclaim(next: { leaseId?: string; leaseOwner: string }) {
      lease.leaseId = next.leaseId ?? lease.leaseId;
      lease.leaseOwner = next.leaseOwner;
    },
    archive() {
      lease.archived = true;
    },
  };
}

const lease = { sessionId: "ses_123", leaseId: "run_a", leaseOwner: "runner-a" };

describe("atomic lease-guarded writes", () => {
  it("writes the assistant message and its created event while the lease is current", async () => {
    const memory = createMemoryLeaseWriteStore(lease);

    await expect(
      createAssistantMessageForLease(
        { id: "msg_assistant", ...lease, responseToMessageId: "msg_user" },
        memory.store,
      ),
    ).resolves.toBe(true);

    expect(memory.messages).toHaveLength(1);
    expect(memory.messages[0]).toMatchObject({ id: "msg_assistant", status: "running" });
  });

  it("rejects an assistant write after the lease is reclaimed by another owner", async () => {
    const memory = createMemoryLeaseWriteStore(lease);

    // A concurrent instance reclaims the session between turns.
    memory.reclaim({ leaseOwner: "runner-b" });

    await expect(
      createAssistantMessageForLease(
        { id: "msg_assistant", ...lease, responseToMessageId: "msg_user" },
        memory.store,
      ),
    ).rejects.toBeInstanceOf(StaleRunLeaseError);

    // The guard is enforced by the write itself, so nothing was persisted.
    expect(memory.messages).toHaveLength(0);
  });

  it("rejects assistant completion after a reclaim and leaves the row untouched", async () => {
    const memory = createMemoryLeaseWriteStore(lease);
    await createAssistantMessageForLease(
      { id: "msg_assistant", ...lease, responseToMessageId: "msg_user" },
      memory.store,
    );

    memory.reclaim({ leaseId: "run_b", leaseOwner: "runner-b" });

    await expect(
      completeAssistantMessageForLease(
        {
          assistantMessageId: "msg_assistant",
          ...lease,
          content: "done",
          modelMessage: { role: "assistant", content: "done" },
        },
        memory.store,
      ),
    ).rejects.toBeInstanceOf(StaleRunLeaseError);

    expect(memory.messages[0]).toMatchObject({ status: "running" });
    expect(memory.messages[0]?.content).toBeUndefined();
  });

  it("rejects a tool-message write after a reclaim", async () => {
    const memory = createMemoryLeaseWriteStore(lease);
    memory.reclaim({ leaseOwner: "runner-b" });

    await expect(
      insertToolMessageForLease(
        {
          id: "msg_tool",
          ...lease,
          content: "result",
          modelMessage: { role: "tool", content: "result" },
          toolName: "exa_search",
          toolCallId: "call_1",
        },
        memory.store,
      ),
    ).resolves.toBe(false);

    expect(memory.messages).toHaveLength(0);
  });

  it("rejects a guarded write once the session is archived", async () => {
    const memory = createMemoryLeaseWriteStore(lease);
    memory.archive();

    await expect(
      createAssistantMessageForLease(
        { id: "msg_assistant", ...lease, responseToMessageId: "msg_user" },
        memory.store,
      ),
    ).rejects.toBeInstanceOf(StaleRunLeaseError);
    expect(memory.messages).toHaveLength(0);
  });

  describe("idempotency is distinguished from lease loss", () => {
    it("treats a retried insert of the same in-flight message as success without duplicating", async () => {
      const memory = createMemoryLeaseWriteStore(lease);
      const input = {
        id: "msg_assistant",
        ...lease,
        responseToMessageId: "msg_user",
      };

      await expect(createAssistantMessageForLease(input, memory.store)).resolves.toBe(true);
      // Same message id, lease still current: the conflict is idempotent, not lease loss.
      await expect(createAssistantMessageForLease(input, memory.store)).resolves.toBe(true);

      expect(memory.messages).toHaveLength(1);
    });

    it("skips a different assistant response already answering the same user message", async () => {
      const memory = createMemoryLeaseWriteStore(lease);
      await createAssistantMessageForLease(
        { id: "msg_first", ...lease, responseToMessageId: "msg_user" },
        memory.store,
      );

      await expect(
        createAssistantMessageForLease(
          { id: "msg_second", ...lease, responseToMessageId: "msg_user" },
          memory.store,
        ),
      ).resolves.toBe(false);

      expect(memory.messages).toHaveLength(1);
      expect(memory.messages[0]?.id).toBe("msg_first");
    });
  });

  it("maps a lost-lease event append (no row written) to a rejected write", async () => {
    const { appendRuntimeEvent } = await import("./events");
    vi.mocked(appendRuntimeEvent).mockResolvedValueOnce(null);

    await expect(
      appendRuntimeEventForLease({
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        leaseOwner: lease.leaseOwner,
        type: "session.status",
        payload: { status: "running" },
      }),
    ).resolves.toBe(false);
  });
});

describe("run lease acquisition", () => {
  it("blocks acquisition while a non-expired lease is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const db = createLeaseDb({
      runLeaseId: "run_active",
      runLeaseExpiresAt: new Date("2026-05-22T12:05:00.000Z"),
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      acquireRunLease({
        sessionId: "ses_123",
        messageId: "msg_user",
        leaseId: "run_next",
        leaseOwner: "runner-test",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      }),
    ).resolves.toBe(false);

    expect(db.state.session.runLeaseId).toBe("run_active");
  });

  it("replaces an expired lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const db = createLeaseDb({
      runLeaseId: "run_stale",
      runLeaseExpiresAt: new Date("2026-05-22T11:59:00.000Z"),
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      acquireRunLease({
        sessionId: "ses_123",
        messageId: "msg_user",
        leaseId: "run_next",
        leaseOwner: "runner-test",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      }),
    ).resolves.toBe(true);

    expect(db.state.session.runLeaseId).toBe("run_next");
    expect(db.state.session.runLeaseOwner).toBe("runner-test");
    expect(db.state.session.runLeaseMessageId).toBe("msg_user");
    expect(db.state.session.runLeaseExpiresAt).toEqual(new Date("2026-05-22T12:15:00.000Z"));
  });
});

describe("lease-guarded writes", () => {
  it("deduplicates assistant responses for the same user message", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_1",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(true);
    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_2",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(false);

    expect(db.state.messages).toHaveLength(1);
    expect(db.state.messages[0]).toMatchObject({
      id: "msg_assistant_1",
      responseToMessageId: "msg_user",
    });
    expect(appendRuntimeEvent).toHaveBeenCalledTimes(1);
  });

  it("deduplicates tool approvals for the same session tool call", async () => {
    const db = createLeaseDb({ runLeaseId: "run_current" });
    dbMocks.getDb.mockReturnValue(db);
    const input = {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      toolCallId: "call_123",
      toolName: "linear__create_issue",
      providerKey: "linear",
      permissionGroup: "post" as const,
      inputPreview: '{ "title": "Bug" }',
      leaseId: "run_current",
      leaseOwner: "runner-test",
    };

    await expect(insertToolApprovalForLease(input)).resolves.toBe("inserted");
    await expect(insertToolApprovalForLease(input)).resolves.toBe("conflict");

    expect(db.state.approvals).toHaveLength(1);
    expect(db.state.approvals[0]).toMatchObject({
      sessionId: "ses_123",
      messageId: "msg_assistant",
      toolCallId: "call_123",
      toolName: "linear__create_issue",
      providerKey: "linear",
      permissionGroup: "post",
      status: "pending",
      inputPreview: '{ "title": "Bug" }',
    });
  });

  it("rejects event writes when the lease guard writes no row", async () => {
    const db = createLeaseDb({ runLeaseId: "run_current" });
    dbMocks.getDb.mockReturnValue(db);
    // The atomic append inserts only while the lease is current; a lost lease writes
    // nothing and resolves to null. appendRuntimeEventForLease must surface that as a
    // rejected lease write rather than a success.
    vi.mocked(appendRuntimeEvent).mockResolvedValueOnce(null);

    await expect(
      appendRuntimeEventForLease({
        sessionId: "ses_123",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        type: "session.status",
        payload: { status: "running" },
      }),
    ).resolves.toBe(false);
  });

  it("rejects assistant completion under the wrong lease", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_current",
      messages: [{ id: "msg_assistant", sessionId: "ses_123", status: "running" }],
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      completeAssistantMessageForLease({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        content: "done",
        modelMessage: { role: "assistant", content: "done" },
      }),
    ).rejects.toThrow("Run lease is no longer current.");

    expect(db.state.messages[0]?.status).toBe("running");
  });
});
