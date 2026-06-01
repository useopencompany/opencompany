import { beforeEach, describe, expect, it, vi } from "vitest";

type ApprovalRow = {
  status: "pending" | "approved" | "denied";
  decisionSource: "user" | "timeout" | "abort" | null;
};

const state: { row: ApprovalRow } = { row: { status: "pending", decisionSource: null } };

// Minimal drizzle query-builder stub supporting the two chains awaitToolApproval uses:
//   select({...}).from(t).where(c).limit(1)            -> Promise<row[]>
//   update(t).set(v).where(c).returning({id})          -> Promise<{id}[]>
// The update honors the `status = 'pending'` guard the way the real WHERE clause does.
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ status: state.row.status, decisionSource: state.row.decisionSource }],
      }),
    }),
  }),
  update: () => ({
    set: (values: Partial<ApprovalRow>) => ({
      where: () => ({
        returning: async () => {
          if (state.row.status !== "pending") return [];
          state.row = {
            status: (values.status as ApprovalRow["status"]) ?? state.row.status,
            decisionSource:
              (values.decisionSource as ApprovalRow["decisionSource"]) ?? state.row.decisionSource,
          };
          return [{ id: 1 }];
        },
      }),
    }),
  }),
};

vi.mock("./db", () => ({ getDb: () => db }));

const { awaitToolApproval } = await import("./tool-approvals");

function neverAbort() {
  return new AbortController().signal;
}

beforeEach(() => {
  state.row = { status: "pending", decisionSource: null };
});

describe("awaitToolApproval", () => {
  it("returns the user decision once the row is resolved", async () => {
    let calls = 0;
    const checkAbort = vi.fn(async () => {
      // Simulate the user approving in chat after the first poll.
      calls += 1;
      if (calls === 2) state.row = { status: "approved", decisionSource: "user" };
    });

    const result = await awaitToolApproval({
      sessionId: "ses_1",
      toolCallId: "call_1",
      requestedAtMs: 0,
      checkAbort,
      signal: neverAbort(),
      now: () => 1_000,
      pollIntervalMs: 1,
      timeoutMs: 60_000,
    });

    expect(result).toEqual({ decision: "approved", source: "user" });
  });

  it("auto-denies with a timeout source once the deadline passes", async () => {
    const result = await awaitToolApproval({
      sessionId: "ses_1",
      toolCallId: "call_1",
      requestedAtMs: 0,
      checkAbort: async () => {},
      signal: neverAbort(),
      now: () => 10_000,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ decision: "denied", source: "timeout" });
    expect(state.row).toEqual({ status: "denied", decisionSource: "timeout" });
  });

  it("propagates an abort thrown by checkAbort", async () => {
    await expect(
      awaitToolApproval({
        sessionId: "ses_1",
        toolCallId: "call_1",
        requestedAtMs: 0,
        checkAbort: async () => {
          throw new Error("Run aborted.");
        },
        signal: neverAbort(),
        now: () => 0,
        pollIntervalMs: 1,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("Run aborted.");
  });
});
