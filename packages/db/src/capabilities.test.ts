import { describe, expect, it, vi } from "vitest";
import {
  approveCapabilityRunByToolCall,
  CAPABILITY_SESSION_BUDGET_DEFAULT_USD_MICROS,
  cancelCapabilityRunByToolCall,
  consumeCapabilityApprovalByToolCall,
  getCapabilityApprovalByToolCall,
  getCapabilitySessionBudgetUsdMicros,
  isWorkspaceCapabilityEnabled,
  listWorkspaceCapabilities,
  MANAGED_CAPABILITY_SOURCES,
  setCapabilitySessionBudget,
  setWorkspaceCapability,
  sumCapabilitySessionSpendUsdMicros,
} from "./capabilities";

describe("opencompany workspace capabilities", () => {
  it("defaults every managed source to enabled when no override row exists", async () => {
    await expect(listWorkspaceCapabilities("workspace_1", selectDb([]))).resolves.toEqual(
      MANAGED_CAPABILITY_SOURCES.map((source) => ({ source, enabled: true })),
    );
  });

  it("applies only explicit workspace overrides", async () => {
    await expect(
      listWorkspaceCapabilities(
        "workspace_1",
        selectDb([
          { source: "linkedin", enabled: false },
          { source: "lead", enabled: true },
        ]),
      ),
    ).resolves.toEqual([
      { source: "x", enabled: true },
      { source: "linkedin", enabled: false },
      { source: "youtube", enabled: true },
      { source: "instagram", enabled: true },
      { source: "tiktok", enabled: true },
      { source: "lead", enabled: true },
      { source: "seo", enabled: true },
      { source: "image", enabled: true },
    ]);
  });

  it("treats a missing single-source override as enabled", async () => {
    await expect(
      isWorkspaceCapabilityEnabled({
        workspaceId: "workspace_1",
        source: "x",
        db: selectOneDb([]),
      }),
    ).resolves.toBe(true);
    await expect(
      isWorkspaceCapabilityEnabled({
        workspaceId: "workspace_1",
        source: "x",
        db: selectOneDb([{ enabled: false }]),
      }),
    ).resolves.toBe(false);
  });

  it("rejects unknown source ids before touching the database", async () => {
    const db = { insert: vi.fn() };
    await expect(
      setWorkspaceCapability({
        workspaceId: "workspace_1",
        source: "followers_export" as never,
        enabled: true,
        updatedByWorkosId: "user_1",
        db,
      }),
    ).rejects.toThrow(/unknown managed capability source/i);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("opencompany capability session budgets", () => {
  it("uses the default budget only when the workspace override is null or missing", async () => {
    await expect(
      getCapabilitySessionBudgetUsdMicros("workspace_1", fluentDb({ selects: [] })),
    ).resolves.toBe(CAPABILITY_SESSION_BUDGET_DEFAULT_USD_MICROS);
    await expect(
      getCapabilitySessionBudgetUsdMicros(
        "workspace_1",
        fluentDb({ selects: [[{ budgetUsdMicros: null }]] }),
      ),
    ).resolves.toBe(CAPABILITY_SESSION_BUDGET_DEFAULT_USD_MICROS);
    await expect(
      getCapabilitySessionBudgetUsdMicros(
        "workspace_1",
        fluentDb({ selects: [[{ budgetUsdMicros: 2_500_000 }]] }),
      ),
    ).resolves.toBe(2_500_000);
  });

  it("stores a positive micros override and rejects invalid values", async () => {
    const db = fluentDb({ updates: [[{ budgetUsdMicros: 2_500_000 }]] });
    await expect(
      setCapabilitySessionBudget({
        workspaceId: "workspace_1",
        budgetUsdMicros: 2_500_000,
        db,
      }),
    ).resolves.toBe(2_500_000);
    await expect(
      setCapabilitySessionBudget({
        workspaceId: "workspace_1",
        budgetUsdMicros: 0,
        db,
      }),
    ).rejects.toThrow(/positive whole number/i);
  });

  it("returns the database session-spend aggregate and accepts exclusions", async () => {
    const db = fluentDb({ selects: [[{ totalUsdMicros: 425_000 }]] });
    await expect(
      sumCapabilitySessionSpendUsdMicros({
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
        excludeToolCallIds: ["tool_1", "tool_1"],
        db,
      }),
    ).resolves.toBe(425_000);
  });
});

describe("opencompany capability approvals by tool call", () => {
  const approval = {
    id: "gcr_1",
    toolCallId: "tool_1",
    status: "awaiting_approval",
    action: "lead.enrich_person",
    inputHash: "a".repeat(64),
    quoteTotalCostUsdMicros: 360_000,
    createdAt: new Date("2026-07-23T10:00:00.000Z"),
  };

  it("loads the newest owned row after lazily expiring stale approvals", async () => {
    const db = fluentDb({
      updates: [[]],
      selects: [[approval]],
    });
    await expect(
      getCapabilityApprovalByToolCall({
        toolCallId: "tool_1",
        chatSessionId: "chat_1",
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        now: new Date("2026-07-23T10:05:00.000Z"),
        db,
      }),
    ).resolves.toEqual(approval);
  });

  it("approves or cancels the newest pending row", async () => {
    const approved = { ...approval, status: "approved" };
    await expect(
      approveCapabilityRunByToolCall({
        toolCallId: "tool_1",
        chatSessionId: "chat_1",
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        db: fluentDb({
          updates: [[], [approved]],
          selects: [[approval]],
        }),
      }),
    ).resolves.toEqual(approved);

    const canceled = { ...approval, status: "canceled" };
    await expect(
      cancelCapabilityRunByToolCall({
        toolCallId: "tool_1",
        chatSessionId: "chat_1",
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        db: fluentDb({
          updates: [[], [canceled]],
          selects: [[approval]],
        }),
      }),
    ).resolves.toEqual(canceled);
  });

  it("consumes an approved row once and returns null when the guarded update loses", async () => {
    const approved = { ...approval, status: "approved" };
    const executing = { ...approval, status: "executing" };
    const input = {
      toolCallId: "tool_1",
      chatSessionId: "chat_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      action: "lead.enrich_person",
      inputHash: "a".repeat(64),
      quoteTotalCostUsdMicros: 360_000,
    };
    await expect(
      consumeCapabilityApprovalByToolCall({
        ...input,
        db: fluentDb({
          updates: [[], [executing]],
          selects: [[approved]],
        }),
      }),
    ).resolves.toEqual(executing);
    await expect(
      consumeCapabilityApprovalByToolCall({
        ...input,
        db: fluentDb({
          updates: [[], []],
          selects: [[approved]],
        }),
      }),
    ).resolves.toBeNull();
  });
});

function selectDb(rows: Array<{ source: string; enabled: boolean }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

function selectOneDb(rows: Array<{ enabled: boolean }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

function fluentDb(input: { selects?: unknown[][]; updates?: unknown[][] }) {
  const selects = [...(input.selects ?? [])];
  const updates = [...(input.updates ?? [])];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => rowsChain(selects.shift() ?? [])),
      })),
    })),
    update: vi.fn(() => {
      const rows = updates.shift() ?? [];
      return {
        set: vi.fn(() => ({
          where: vi.fn(() => rowsChain(rows)),
        })),
      };
    }),
  };
}

function rowsChain(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    then: promise.then.bind(promise),
    limit: vi.fn(async () => rows),
    orderBy: vi.fn(() => ({
      limit: vi.fn(async () => rows),
    })),
    returning: vi.fn(async () => rows),
  };
}
