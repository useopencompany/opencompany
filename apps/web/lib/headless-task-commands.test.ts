import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitHeadlessTaskTransaction } from "./headless-task-collections";
import {
  archiveHeadlessTask,
  cancelHeadlessTaskRun,
  createHeadlessTask,
  getHeadlessTaskSummary,
  getLegacyTaskCompatibilityHistory,
  listLegacyTaskCompatibility,
} from "./headless-task-commands";

vi.mock("./headless-task-collections", () => ({
  awaitHeadlessTaskTransaction: vi.fn(async () => undefined),
}));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const task = {
  id: "task_1",
  displayId: "TASK-1",
  name: "Prepare launch brief",
  goal: "Prepare a launch brief",
  conversationId: "conversation_1",
  status: "queued",
  source: "manual",
  engine: "opencompany",
  model: "moonshotai/kimi-k3",
  workflowId: null,
  scheduleId: null,
  scheduledFor: null,
  outcome: { result: null, error: null, reportedStatus: null, comment: null },
  archivedAt: null,
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};

describe("headless Task commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates through /v1 and reconciles the workspace Task read model", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        {
          data: {
            task,
            messageId: "message_1",
            runId: "run_1",
            transactionId: "42",
            replayed: false,
          },
          meta,
        },
        { status: 202 },
      );
    });

    await createHeadlessTask(
      { goal: task.goal, engine: "opencompany", model: task.model },
      {
        baseUrl: "https://app.example.test",
        fetch: fetchMock as typeof fetch,
        scopeKey: "workspace_1",
      },
    );

    const sent = request as unknown as Request;
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).pathname).toBe("/v1/tasks");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-task:/u);
    await expect(sent.json()).resolves.toEqual({
      goal: task.goal,
      engine: "opencompany",
      model: task.model,
    });
    expect(awaitHeadlessTaskTransaction).toHaveBeenCalledWith("42", {
      scopeKey: "workspace_1",
    });
  });

  it("archives through the typed Task mutation and waits for its read model", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        data: { task: { ...task, status: "archived" }, transactionId: "43" },
        meta,
      });
    });

    await archiveHeadlessTask("TASK-1", {
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
      scopeKey: "workspace_1",
    });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("PATCH");
    expect(new URL(sent.url).pathname).toBe("/v1/tasks/TASK-1");
    await expect(sent.json()).resolves.toEqual({ archived: true });
    expect(awaitHeadlessTaskTransaction).toHaveBeenCalledWith("43", {
      scopeKey: "workspace_1",
    });
  });

  it("cancels the canonical Run rather than a Task-specific execution resource", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        data: { runId: "run_1", status: "canceled", replayed: false },
        meta,
      });
    });

    await cancelHeadlessTaskRun("run_1", {
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).pathname).toBe("/v1/runs/run_1/cancel");
  });

  it("loads API-owned summaries and bounded read-only legacy history", async () => {
    const paths: string[] = [];
    const { conversationId, ...legacyTask } = task;
    expect(conversationId).toBe("conversation_1");
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/summary")) {
        return Response.json({
          data: {
            cost: { hasRecordedCosts: true, totalCostUsdMicros: 1_200 },
            durationMs: 4_000,
          },
          meta,
        });
      }
      if (path.endsWith("/history")) {
        return Response.json({
          data: { task: legacyTask, messages: [], events: [] },
          meta,
        });
      }
      return Response.json({ data: [legacyTask], meta });
    });
    const options = {
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    };

    await expect(getHeadlessTaskSummary("task_1", options)).resolves.toMatchObject({
      durationMs: 4_000,
    });
    await expect(listLegacyTaskCompatibility(options)).resolves.toHaveLength(1);
    await expect(getLegacyTaskCompatibilityHistory("task_legacy", options)).resolves.toMatchObject({
      messages: [],
      events: [],
    });

    expect(paths).toEqual([
      "/v1/tasks/task_1/summary",
      "/v1/compatibility/tasks",
      "/v1/compatibility/tasks/task_legacy/history",
    ]);
  });
});
