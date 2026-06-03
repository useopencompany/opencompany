import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLeaseDb,
  createStateLeaseWriteStore,
  type LeaseDbState,
  usage,
} from "./agent-loop-test-support";
import { appendRuntimeEvent } from "./events";
import { setLeaseWriteStoreForTests } from "./lease-writes";
import { recordSandboxUsage, recordStepUsage, recordToolUsage } from "./usage-recorder";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

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
    expect(db.state.ledgerDebits).toBe(2);
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

  it("records hosted tool usage and emits usage events", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordToolUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      toolCallId: "call_exa",
      toolName: "exa_search",
      usage: {
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_123",
        costUsdMicros: 7000,
        rawUsage: { costDollars: { total: 0.007 } },
      },
    });

    expect(db.state.toolUsage).toEqual([
      expect.objectContaining({
        toolCallId: "call_exa",
        toolName: "exa_search",
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_123",
        costUsdMicros: 7000,
      }),
    ]);
    expect(db.state.ledgerDebits).toBe(1);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.tool_usage",
        payload: expect.objectContaining({
          toolCallId: "call_exa",
          provider: "exa",
          costUsdMicros: 7000,
        }),
      }),
    );
  });

  it("records sandbox compute usage, debits the ledger, and emits a usage event", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordSandboxUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      sandboxId: "sbx_abc",
      template: "amp",
      vcpu: 2,
      ramMib: 512,
      startedAt: new Date("2026-05-22T12:00:00.000Z"),
      endedAt: new Date("2026-05-22T12:01:00.000Z"),
      activeMs: 60_000,
    });

    expect(db.state.sandboxUsage).toEqual([
      expect.objectContaining({
        sandboxId: "sbx_abc",
        template: "amp",
        vcpu: 2,
        ramMib: 512,
        activeMs: 60_000,
        costUsdMicros: 1_815,
      }),
    ]);
    expect(db.state.ledgerDebits).toBe(1);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.sandbox_usage",
        payload: expect.objectContaining({
          sandboxId: "sbx_abc",
          activeMs: 60_000,
          chargedCostUsdMicros: 1_997,
        }),
      }),
    );
  });

  it("does not debit for a zero-duration sandbox window", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordSandboxUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      sandboxId: "sbx_abc",
      template: "amp",
      vcpu: 2,
      ramMib: 512,
      startedAt: new Date("2026-05-22T12:00:00.000Z"),
      endedAt: new Date("2026-05-22T12:00:00.000Z"),
      activeMs: 0,
    });

    expect(db.state.sandboxUsage).toHaveLength(1);
    expect(db.state.ledgerDebits).toBe(0);
  });
});
