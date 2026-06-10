import { agentSessionEvents } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfig, env } from "./agent-loop-test-support";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const analyticsMocks = vi.hoisted(() => ({ captureServerEvent: vi.fn() }));
const sandboxMocks = vi.hoisted(() => ({
  armSandboxIdleTimeout: vi.fn(),
  createOrConnectSandbox: vi.fn(),
  killSandbox: vi.fn(),
  prepareWorkspace: vi.fn(),
  sandboxPreparationErrorFields: vi.fn(() => ({})),
}));
const materializeMocks = vi.hoisted(() => ({
  materializeAgentBundleForSession: vi.fn(),
  materializeBrainForSession: vi.fn(),
  materializeSkillsForSession: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: analyticsMocks.captureServerEvent,
}));

vi.mock("./sandbox", () => sandboxMocks);

vi.mock("./agent-bundle", () => ({
  materializeAgentBundleForSession: materializeMocks.materializeAgentBundleForSession,
}));

vi.mock("./brain", () => ({
  materializeBrainForSession: materializeMocks.materializeBrainForSession,
}));

vi.mock("./skills", () => ({
  materializeSkillsForSession: materializeMocks.materializeSkillsForSession,
}));

import { startSession } from "./session-lifecycle";

beforeEach(() => {
  vi.resetAllMocks();
  analyticsMocks.captureServerEvent.mockResolvedValue(undefined);
  sandboxMocks.armSandboxIdleTimeout.mockResolvedValue(true);
  sandboxMocks.prepareWorkspace.mockResolvedValue(undefined);
  sandboxMocks.killSandbox.mockResolvedValue(undefined);
  materializeMocks.materializeAgentBundleForSession.mockResolvedValue(undefined);
  materializeMocks.materializeBrainForSession.mockResolvedValue(undefined);
  materializeMocks.materializeSkillsForSession.mockResolvedValue(undefined);
});

describe("startSession", () => {
  it("does not regress a completed session to ready when sandbox hydration finishes late", async () => {
    const sandbox = { sandboxId: "sbx_late" };
    sandboxMocks.createOrConnectSandbox.mockResolvedValue(sandbox);
    const fakeDb = createStartSessionDb({
      updateResults: [[{ id: "ses_memory" }], []],
    });
    dbMocks.getDb.mockReturnValue(fakeDb.db);

    await startSession("ses_memory", env());

    expect(fakeDb.updates).toEqual([
      expect.objectContaining({ status: "provisioning" }),
      expect.objectContaining({ e2bSandboxId: "sbx_late", status: "ready" }),
    ]);
    expect(containsColumnName(fakeDb.updateWheres[1], "status")).toBe(true);
    expect(fakeDb.events).toEqual([
      expect.objectContaining({
        sessionId: "ses_memory",
        type: "session.status",
        payload: { status: "provisioning", message: "Starting sandbox" },
      }),
    ]);
    expect(sandboxMocks.killSandbox).toHaveBeenCalledWith("sbx_late");
  });
});

function createStartSessionDb(input: { updateResults: Array<Array<{ id: string }>> }) {
  const row = {
    session: {
      id: "ses_memory",
      userId: "usr_1",
      workspaceId: "wks_1",
      agentId: "agt_1",
      e2bSandboxId: null,
      workdir: "/home/user/workspace",
      archivedAt: null,
    },
    workspace: { id: "wks_1" },
    agent: { id: "agt_1", config: agentConfig() },
    user: { id: "usr_1", email: "louis@example.com", firstName: "Louis", lastName: "Morgner" },
  };
  const updates: Record<string, unknown>[] = [];
  const updateWheres: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  let selectCount = 0;
  let updateCount = 0;

  return {
    updates,
    updateWheres,
    events,
    db: {
      select() {
        selectCount += 1;
        return chain({
          limit: async () => (selectCount === 1 ? [row] : []),
        });
      },
      update() {
        const index = updateCount;
        const result = input.updateResults[index] ?? [];
        updateCount += 1;
        return {
          set(values: Record<string, unknown>) {
            updates.push(values);
            return chain({
              where: (condition: unknown) => {
                updateWheres[index] = condition;
                return chain({ returning: async () => result });
              },
            });
          },
        };
      },
      insert(table: unknown) {
        return {
          values(values: Record<string, unknown>) {
            if (table === agentSessionEvents) events.push(values);
            return {
              returning: async () => [
                { id: events.length, ...values, createdAt: new Date("2026-06-08T00:00:00.000Z") },
              ],
            };
          },
        };
      },
    },
  };
}

function chain(overrides: Record<string, unknown> = {}) {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    limit: async () => [],
    returning: async () => [],
    ...overrides,
  };
  return builder;
}

function containsColumnName(
  value: unknown,
  columnName: string,
  seen = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if ("name" in value && value.name === columnName) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsColumnName(item, columnName, seen));
  }
  return Object.values(value).some((item) => containsColumnName(item, columnName, seen));
}
