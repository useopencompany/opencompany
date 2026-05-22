import { agentSessionMessages, agentSessions, agentSessionUsage } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
  recordStepUsage,
} from "./agent-loop";
import { appendRuntimeEvent } from "./events";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
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

  it("rejects event writes under the wrong lease", async () => {
    const db = createLeaseDb({ runLeaseId: "run_current" });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      appendRuntimeEventForLease({
        sessionId: "ses_123",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        type: "session.status",
        payload: { status: "running" },
      }),
    ).resolves.toBe(false);

    expect(appendRuntimeEvent).not.toHaveBeenCalled();
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

describe("usage recording", () => {
  it("records model usage with sequential step indexes", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordStepUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 1,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response: {
        id: "response_1",
        timestamp: new Date("2026-05-22T12:00:00.000Z"),
        modelId: "openai/gpt-5.4-mini",
      },
      usage: usage(100, 20),
      finishReason: "tool-calls",
      rawFinishReason: undefined,
    });
    await recordStepUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 2,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response: {
        id: "response_2",
        timestamp: new Date("2026-05-22T12:00:01.000Z"),
        modelId: "openai/gpt-5.4-mini",
      },
      usage: usage(80, 30),
      finishReason: "stop",
      rawFinishReason: undefined,
    });

    expect(db.state.usage.map((row) => row.stepIndex)).toEqual([1, 2]);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.usage",
        payload: expect.objectContaining({ stepIndex: 1 }),
      }),
    );
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.usage",
        payload: expect.objectContaining({ stepIndex: 2 }),
      }),
    );
  });
});

type MessageState = {
  id: string;
  sessionId: string;
  status?: string;
  responseToMessageId?: string | null;
};

type UsageState = {
  stepIndex: number;
};

function createLeaseDb(input: {
  runLeaseId?: string | null;
  runLeaseExpiresAt?: Date | null;
  messages?: MessageState[];
}) {
  const state = {
    session: {
      id: "ses_123",
      archivedAt: null as Date | null,
      runLeaseId: input.runLeaseId ?? null,
      runLeaseOwner: input.runLeaseId ? "runner-test" : null,
      runLeaseMessageId: null as string | null,
      runLeaseExpiresAt: input.runLeaseExpiresAt ?? null,
    },
    messages: [...(input.messages ?? [])],
    usage: [] as UsageState[],
  };

  return {
    state,
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                async returning() {
                  if (table === agentSessions) {
                    if (typeof values.runLeaseId === "string") {
                      const expiresAt = state.session.runLeaseExpiresAt;
                      const canAcquire =
                        !state.session.archivedAt &&
                        (!state.session.runLeaseId || (expiresAt && expiresAt <= new Date()));
                      if (!canAcquire) return [];
                      Object.assign(state.session, values);
                      return [{ id: state.session.id, leaseId: state.session.runLeaseId }];
                    }

                    Object.assign(state.session, values);
                    return [{ id: state.session.id }];
                  }

                  if (table === agentSessionMessages) {
                    const message = state.messages.find(
                      (item) => item.id === values.id || item.id === "msg_assistant",
                    );
                    if (!message) return [];
                    Object.assign(message, values);
                    return [{ id: message.id }];
                  }

                  return [];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table === agentSessions && state.session.runLeaseId === "run_123") {
                    return [{ id: state.session.id }];
                  }
                  if (table === agentSessions && state.session.runLeaseId === "run_current") {
                    return [];
                  }
                  if (table === agentSessions) return [{ id: state.session.id }];
                  return [];
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessionUsage) {
            state.usage.push(values as UsageState);
            return Promise.resolve(undefined);
          }

          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  if (table !== agentSessionMessages) return [];
                  if (
                    state.messages.some(
                      (message) => message.responseToMessageId === values.responseToMessageId,
                    )
                  ) {
                    return [];
                  }
                  state.messages.push(values as MessageState);
                  return [{ id: values.id }];
                },
              };
            },
            async returning() {
              state.messages.push(values as MessageState);
              return [{ id: values.id }];
            },
          };
        },
      };
    },
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  };
}
