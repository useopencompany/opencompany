import { describe, expect, it, vi } from "vitest";

const drizzleMocks = vi.hoisted(() => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  and: drizzleMocks.and,
  eq: drizzleMocks.eq,
}));

type ApprovalRow = {
  sessionId: string;
  toolCallId: string;
  status: "pending" | "approved" | "denied";
  decisionSource: "user" | "timeout" | "abort" | null;
  messageId: string | null;
  toolName: string;
  providerKey: string;
  permissionGroup: "read" | "post" | "modify" | "merge" | "admin";
};

const state: { rows: ApprovalRow[] } = { rows: [] };

// Minimal drizzle stub for select({...}).from(t).where(c).limit(1) -> Promise<row[]>.
const db = {
  select: () => ({
    from: () => ({
      where: (condition: unknown) => ({
        limit: async () => {
          const values = Array.isArray(condition)
            ? condition.map((clause) =>
                clause && typeof clause === "object" && "value" in clause
                  ? (clause as { value: unknown }).value
                  : undefined,
              )
            : [];
          const [sessionId, toolCallId] = values;
          return state.rows
            .filter((row) => row.sessionId === sessionId && row.toolCallId === toolCallId)
            .map(({ sessionId: _sessionId, toolCallId: _toolCallId, ...row }) => row);
        },
      }),
    }),
  }),
};

vi.mock("./db", () => ({ getDb: () => db }));

const { loadToolApproval } = await import("./tool-approvals");

describe("loadToolApproval", () => {
  it("returns the decided approval row", async () => {
    state.rows = [
      {
        sessionId: "ses_1",
        toolCallId: "call_1",
        status: "approved",
        decisionSource: "user",
        messageId: "msg_assistant",
        toolName: "linear__create_issue",
        providerKey: "linear",
        permissionGroup: "post",
      },
    ];

    const row = await loadToolApproval("ses_1", "call_1");

    expect(row).toEqual({
      status: "approved",
      decisionSource: "user",
      messageId: "msg_assistant",
      toolName: "linear__create_issue",
      providerKey: "linear",
      permissionGroup: "post",
    });
  });

  it("keys approvals by session and tool call", async () => {
    state.rows = [
      {
        sessionId: "ses_1",
        toolCallId: "call_1",
        status: "approved",
        decisionSource: "user",
        messageId: "msg_assistant",
        toolName: "linear__create_issue",
        providerKey: "linear",
        permissionGroup: "post",
      },
    ];

    expect(await loadToolApproval("ses_2", "call_1")).toBeNull();
    expect(await loadToolApproval("ses_1", "call_2")).toBeNull();
  });

  it("returns null when no row exists", async () => {
    state.rows = [];
    expect(await loadToolApproval("ses_1", "missing")).toBeNull();
  });
});
