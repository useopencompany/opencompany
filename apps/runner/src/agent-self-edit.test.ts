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
      input({ body: "New sharper instructions. Research with @exa.", summary: "tightened tone" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(4);
      expect(result.changedFields).toContain("instructions");
    }
    // agents row updated with bumped version and pending sync status.
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ version: 4, githubSyncStatus: "pending" });
    // The Tiptap "pill" doc is regenerated so the detail page renders resolved
    // mentions instead of a lossy text-only rebuild.
    const updated = calls.update[0] as { content?: { type: string; content?: unknown[] } };
    expect(updated.content?.type).toBe("doc");
    const mentions: Array<{ attrs?: Record<string, unknown> }> = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
      if (n.type === "mention") mentions.push(n);
      (n.content ?? []).forEach(walk);
    };
    (updated.content?.content ?? []).forEach(walk);
    expect(mentions.map((m) => m.attrs?.id)).toContain("tool:exa");
    // workspace sync job queued for the unified projector.
    expect(calls.insert).toHaveLength(1);
    expect(calls.insert[0]).toMatchObject({
      repoPath: "agents/leo.agent",
      sourceKind: "agent",
      sourceRef: "agt_1",
      operation: "upsert",
    });
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

  it("adds a schedule trigger and reports triggers as changed", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(
      input({
        body: "Keep helping.",
        triggers: [
          {
            cron: "0 9 * * 1-5",
            prompt: "Review yesterday's PRs.",
            timezone: "America/New_York",
            enabled: true,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFields).toContain("triggers");
    const config = (calls.update[0] as { config: AgentConfig }).config;
    expect(config.triggers).toEqual([
      expect.objectContaining({
        type: "agent.schedule",
        cron: "0 9 * * 1-5",
        prompt: "Review yesterday's PRs.",
        timezone: "America/New_York",
        enabled: true,
        id: expect.any(String),
      }),
    ]);
  });

  it("preserves current triggers when triggers is omitted", async () => {
    const existing: AgentConfig = agentConfig({
      triggers: [
        {
          id: "schedule-1",
          type: "agent.schedule",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Daily standup.",
          enabled: true,
        },
      ],
    });
    const { db, calls } = createDb({ row: { ...baseRow, config: existing } });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(input({ body: "Sharper instructions." }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFields).not.toContain("triggers");
    const config = (calls.update[0] as { config: AgentConfig }).config;
    expect(config.triggers).toHaveLength(1);
    expect(config.triggers[0]).toMatchObject({ id: "schedule-1", cron: "0 9 * * *" });
  });

  it("clears schedules with [] while preserving a GitHub PR trigger", async () => {
    const existing: AgentConfig = agentConfig({
      integrations: {
        github: {
          repositories: [{ id: "octo-repo", fullName: "octo/repo", defaultBranch: "main" }],
        },
      },
      triggers: [
        {
          id: "schedule-1",
          type: "agent.schedule",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Daily standup.",
          enabled: true,
        },
        {
          id: "octo-repo-pr",
          type: "github.pull_request",
          repository: "octo-repo",
          events: ["opened"],
          branches: ["main"],
          enabled: true,
        },
      ],
    });
    const { db, calls } = createDb({ row: { ...baseRow, config: existing } });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(input({ body: "Keep helping.", triggers: [] }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedFields).toContain("triggers");
    const config = (calls.update[0] as { config: AgentConfig }).config;
    expect(config.triggers).toHaveLength(1);
    expect(config.triggers[0]).toMatchObject({
      type: "github.pull_request",
      repository: "octo-repo",
    });
  });

  it("rejects an unsupported cron without writing", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(
      input({ body: "Keep helping.", triggers: [{ cron: "5 4 * * 0,3", prompt: "Hi." }] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/unsupported cron/i);
    expect(calls.update).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
  });

  it("rejects a schedule with an empty prompt without writing", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(
      input({ body: "Keep helping.", triggers: [{ cron: "0 9 * * *", prompt: "  " }] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/prompt/i);
    expect(calls.update).toHaveLength(0);
  });

  it("rejects schedule ids that collide with generated ids without writing", async () => {
    const { db, calls } = createDb({ row: baseRow });
    dbMocks.getDb.mockReturnValue(db);

    const result = await applyAgentSelfUpdate(
      input({
        body: "Keep helping.",
        triggers: [
          { cron: "0 9 * * *", prompt: "Daily standup." },
          { id: "schedule-1", cron: "0 10 * * *", prompt: "Daily follow-up." },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/duplicate trigger id "schedule-1"/i);
    expect(calls.update).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
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
