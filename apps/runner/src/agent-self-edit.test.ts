import type { AgentConfig } from "@opencompany/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const leaseMocks = vi.hoisted(() => ({
  appendRuntimeEventForLease: vi.fn(async () => true),
  requireLeaseWrite: vi.fn(async (write: Promise<boolean> | boolean) => {
    if (!(await write)) throw new Error("stale lease");
  }),
}));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./lease-writes", () => leaseMocks);

import { applyAgentSelfUpdate } from "./agent-self-edit";

afterEach(() => {
  vi.resetAllMocks();
});

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaVersion: "agent.v1",
    title: "Leo",
    instructions: "Old instructions.",
    model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
    tools: [],
    brain: [],
    agents: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
    ...overrides,
  };
}

function createDb(opts: { row?: unknown; updateReturning?: unknown[] }) {
  const calls = { update: [] as unknown[], insert: [] as unknown[] };
  const selectBuilder = {
    from: () => selectBuilder,
    innerJoin: () => selectBuilder,
    where: () => selectBuilder,
    limit: async () => (opts.row ? [opts.row] : []),
  };
  const updateBuilder = {
    set: (value: unknown) => {
      calls.update.push(value);
      return updateBuilder;
    },
    where: () => updateBuilder,
    returning: async () => opts.updateReturning ?? [{ id: "agt_1" }],
  };
  const insertBuilder = {
    values: (value: unknown) => {
      calls.insert.push(value);
      return insertBuilder;
    },
    onConflictDoUpdate: async () => undefined,
  };
  return {
    calls,
    db: {
      select: () => selectBuilder,
      update: () => updateBuilder,
      insert: () => insertBuilder,
    },
  };
}

const baseRow = {
  agentId: "agt_1",
  workspaceId: "wsp_1",
  path: "agents/leo.agent",
  name: "Leo",
  version: 3,
  config: agentConfig(),
};

function input(args: unknown) {
  return {
    sessionId: "ses_1",
    assistantMessageId: "msg_1",
    runLeaseId: "lease_1",
    runLeaseOwner: "owner_1",
    args,
  };
}

describe("applyAgentSelfUpdate", () => {
  it("persists a valid edit, bumps the version, queues sync, and emits an event", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(
      input({ body: "New sharper instructions.", summary: "tightened tone" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(4);
      expect(result.changedFields).toContain("instructions");
    }
    // agents row updated with bumped version and pending sync status.
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ version: 4, githubSyncStatus: "pending" });
    // sync job queued for the GitHub sweeper.
    expect(calls.insert).toHaveLength(1);
    expect(calls.insert[0]).toMatchObject({ agentId: "agt_1", desiredVersion: 4 });
    // self-update event emitted.
    expect(leaseMocks.appendRuntimeEventForLease).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent.self_updated" }),
    );
  });

  it("switches the model when a valid one is provided", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(
      input({ body: "Keep helping.", model: "anthropic/claude-opus-4.8" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFields).toContain("model");
    expect(calls.update[0]).toMatchObject({
      config: expect.objectContaining({
        model: { provider: "vercel-ai-gateway", name: "anthropic/claude-opus-4.8" },
      }),
    });
  });

  it("keeps the current model when model is omitted even if the body contains legacy model mentions", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(input({ body: "Keep helping. Use @deep prose." }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFields).not.toContain("model");
    expect(calls.update[0]).toMatchObject({
      config: expect.objectContaining({
        model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      }),
    });
  });

  it("rejects an empty body without writing", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(input({ body: "   " }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/body/i);
    expect(calls.update).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
  });

  it("rejects an unknown model without writing", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(input({ body: "Hi.", model: "openai/not-real" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/model/i);
    expect(calls.update).toHaveLength(0);
  });

  it("reports a concurrent modification when the version guard misses", async () => {
    const { db, calls } = createDb({ row: baseRow, updateReturning: [] });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(input({ body: "New instructions." }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/changed while/i);
    // No sync job and no event when the guarded update did not apply.
    expect(calls.insert).toHaveLength(0);
    expect(leaseMocks.appendRuntimeEventForLease).not.toHaveBeenCalled();
  });
});
