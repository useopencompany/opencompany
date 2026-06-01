import { describe, expect, it, vi } from "vitest";
import {
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
  insertToolMessageForLease,
  type LeaseWriteStore,
  StaleRunLeaseError,
} from "./lease-writes";

// The lease-guarded helpers route their durable event append through
// `events.appendRuntimeEvent` (mocked here so it never touches a database) and their
// row writes through an injected `LeaseWriteStore`. That lets us reproduce the exact
// TOCTOU the atomic statements close: reclaim the lease on another owner, then attempt
// a guarded write under the old lease, and assert the database refused it.
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
}));

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
  };

  return {
    store,
    messages,
    usage,
    toolUsage,
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
