import { describe, expect, it, vi } from "vitest";

type ApprovalRow = {
  status: "pending" | "approved" | "denied";
  decisionSource: "user" | "timeout" | "abort" | null;
  messageId: string | null;
  toolName: string;
  providerKey: string;
  permissionGroup: "read" | "post" | "modify" | "admin";
};

const state: { rows: ApprovalRow[] } = { rows: [] };

// Minimal drizzle stub for select({...}).from(t).where(c).limit(1) -> Promise<row[]>.
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => state.rows,
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

  it("returns null when no row exists", async () => {
    state.rows = [];
    expect(await loadToolApproval("ses_1", "missing")).toBeNull();
  });
});
