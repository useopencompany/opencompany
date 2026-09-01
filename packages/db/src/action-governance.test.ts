import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  actionApprovalInputHash,
  claimActionAsyncRun,
  claimActionInvocation,
  registerActionApproval,
  resolveActionApproval,
  storeActionCapabilityQuote,
} from "./action-governance";

const turn = {
  sessionId: "session_1",
  turnId: "turn_1",
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  policy: "foregroundInteractive" as const,
};

describe("opencompany action turn governance", () => {
  it("classifies a repeated invocation without incrementing or redispatching it", async () => {
    const db = governanceDb({
      updates: [[]],
      selects: [
        [
          {
            actionCallCount: 3,
            invocationIds: ["invocation_1"],
            listedSourceIds: ["gmail"],
          },
        ],
      ],
    });

    await expect(
      claimActionInvocation({
        turn,
        sourceId: "gmail",
        invocationId: "invocation_1",
        maxCalls: 16,
        db,
      }),
    ).resolves.toEqual({ ok: true, callCount: 3, duplicate: true });
  });

  it("distinguishes discovery failures from the shared call budget", async () => {
    await expect(
      claimActionInvocation({
        turn,
        sourceId: "gmail",
        invocationId: "invocation_1",
        maxCalls: 16,
        db: governanceDb({
          updates: [[]],
          selects: [[{ actionCallCount: 0, invocationIds: [], listedSourceIds: [] }]],
        }),
      }),
    ).resolves.toEqual({ ok: false, reason: "list_required" });

    await expect(
      claimActionInvocation({
        turn,
        sourceId: "gmail",
        invocationId: "invocation_17",
        maxCalls: 16,
        db: governanceDb({
          updates: [[]],
          selects: [[{ actionCallCount: 16, invocationIds: [], listedSourceIds: ["gmail"] }]],
        }),
      }),
    ).resolves.toEqual({ ok: false, reason: "call_budget" });
  });

  it("reports whether the atomic quote and async-run guards won", async () => {
    const quote = {
      inputHash: "a".repeat(64),
      quoteProviderCostUsdMicros: 100_000,
      quotePlatformFeeUsdMicros: 20_000,
      quoteTotalCostUsdMicros: 120_000,
      decision: "auto" as const,
    };

    await expect(
      storeActionCapabilityQuote({
        turn,
        invocationId: "invocation_1",
        quote,
        admitted: true,
        maxQuotedTotalUsdMicros: 500_000,
        db: governanceDb({ updates: [[]] }),
      }),
    ).resolves.toBe(false);
    await expect(
      storeActionCapabilityQuote({
        turn,
        invocationId: "invocation_1",
        quote,
        admitted: true,
        maxQuotedTotalUsdMicros: 500_000,
        db: governanceDb({ updates: [[{ id: "turn_1" }]] }),
      }),
    ).resolves.toBe(true);
    await expect(
      claimActionAsyncRun({
        turn,
        invocationId: "invocation_1",
        maxRuns: 6,
        db: governanceDb({ updates: [[]] }),
      }),
    ).resolves.toBe(false);
  });

  it("binds approval input deterministically and resolves it exactly once", async () => {
    expect(actionApprovalInputHash({ b: 2, a: { y: true, x: 1 } })).toBe(
      actionApprovalInputHash({ a: { x: 1, y: true }, b: 2 }),
    );
    const approved = {
      actionId: "gmail.send",
      sourceId: "gmail",
      capabilityId: "write",
      inputHash: "a".repeat(64),
      status: "approved" as const,
      requestedAt: "2026-08-26T00:00:00.000Z",
      resolvedAt: "2026-08-26T00:01:00.000Z",
    };

    await expect(
      resolveActionApproval({
        turn,
        invocationId: "invocation_1",
        decision: "approved",
        db: governanceDb({ updates: [[{ approvalRecords: { invocation_1: approved } }]] }),
      }),
    ).resolves.toEqual({ ok: true, record: approved, duplicate: false });
    await expect(
      resolveActionApproval({
        turn,
        invocationId: "invocation_1",
        decision: "approved",
        db: governanceDb({
          updates: [[]],
          selects: [[{ approvalRecords: { invocation_1: approved } }]],
        }),
      }),
    ).resolves.toEqual({ ok: true, record: approved, duplicate: true });
  });

  it("casts the invocation id used as a jsonb object key", async () => {
    let approvalRecordsSql: SQL | undefined;
    const params = { issueId: "PRO-185", body: "Approval gateway test" };
    const pending = {
      actionId: "plugin:linear:linear.save_comment",
      sourceId: "plugin:linear:linear",
      capabilityId: "write",
      inputHash: actionApprovalInputHash(params),
      status: "pending" as const,
      requestedAt: "2026-09-01T08:30:00.000Z",
    };
    const db = governanceDb({
      updates: [[{ approvalRecords: { invocation_1: pending } }]],
      onUpdateSet: (values) => {
        approvalRecordsSql = values.approvalRecords as SQL;
      },
    });

    await expect(
      registerActionApproval({
        turn,
        invocationId: "invocation_1",
        actionId: pending.actionId,
        sourceId: pending.sourceId,
        capabilityId: pending.capabilityId,
        params,
        now: new Date(pending.requestedAt),
        db,
      }),
    ).resolves.toEqual(pending);

    expect(approvalRecordsSql).toBeDefined();
    const query = new PgDialect().sqlToQuery(approvalRecordsSql!);
    expect(query.sql).toMatch(/jsonb_build_object\(\$\d+::text, \$\d+::jsonb\)/u);
  });
});

function governanceDb(input: {
  updates?: unknown[][];
  selects?: unknown[][];
  onUpdateSet?: (values: Record<string, unknown>) => void;
}) {
  const updates = [...(input.updates ?? [])];
  const selects = [...(input.selects ?? [])];
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(async () => undefined),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        input.onUpdateSet?.(values);
        return {
          where: vi.fn(() => rowsChain(updates.shift() ?? [])),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => rowsChain(selects.shift() ?? [])),
      })),
    })),
  };
}

function rowsChain(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    then: promise.then.bind(promise),
    limit: vi.fn(async () => rows),
    returning: vi.fn(async () => rows),
  };
}
