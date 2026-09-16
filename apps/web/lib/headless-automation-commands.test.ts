import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHeadlessWorkflow,
  invokeHeadlessWorkflow,
  listHeadlessWorkflowCatalog,
  runHeadlessWorkflowNow,
  updateHeadlessWorkflow,
} from "./headless-automation-commands";
import { awaitHeadlessTaskTransaction } from "./headless-task-collections";

vi.mock("./headless-task-collections", () => ({
  awaitHeadlessTaskTransaction: vi.fn(async () => undefined),
}));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const createdAt = "2026-08-11T09:00:00.000Z";
const workflow = {
  id: "workflow_1",
  slug: "weekly-research",
  name: "Weekly research",
  description: "Track material changes",
  steps: [
    {
      id: "step_1",
      title: "Research",
      model: "provider/model",
      instructions: "Find material changes.",
    },
  ],
  status: "active",
  trigger: { type: "manual" },
  version: 1,
  archivedAt: null,
  createdAt,
  updatedAt: createdAt,
} as const;
const schedule = {
  cron: "0 9 * * *",
  timezone: "UTC",
  prompt: "Research market changes.",
} as const;
const task = {
  id: "task_1",
  displayId: "TASK-1",
  name: "Weekly research",
  conversationId: "conversation_1",
};

describe("headless automation commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a Workflow through /v1 and returns the committed response directly", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        { data: { workflow, transactionId: "51", replayed: false }, meta },
        { status: 201 },
      );
    });

    await expect(
      createHeadlessWorkflow(
        { name: workflow.name, description: workflow.description },
        {
          baseUrl: "https://app.example.test",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ id: "workflow_1", version: 1 });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).pathname).toBe("/v1/workflows");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-workflow:/u);
    await expect(sent.json()).resolves.toEqual({
      name: workflow.name,
      description: workflow.description,
    });
  });

  it("returns a committed Workflow update without waiting for its live projection", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        data: { workflow: { ...workflow, version: 2 }, transactionId: "52" },
        meta,
      });
    });
    const command = {
      expectedVersion: 1,
      name: workflow.name,
      description: workflow.description,
      steps: [...workflow.steps],
      status: workflow.status,
      trigger: {
        type: "schedule" as const,
        cron: schedule.cron,
        timezone: schedule.timezone,
        prompt: schedule.prompt,
        enabled: true,
      },
    };

    await expect(
      updateHeadlessWorkflow("workflow_1", command, {
        baseUrl: "https://app.example.test",
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toMatchObject({ id: "workflow_1", version: 2 });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("PATCH");
    expect(new URL(sent.url).pathname).toBe("/v1/workflows/workflow_1");
    await expect(sent.json()).resolves.toEqual(command);
  });

  it("invokes a Workflow with skill and attachment ids, then reconciles the workspace Task", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        {
          data: {
            task,
            messageId: "message_1",
            runId: "run_1",
            transactionId: "53",
            replayed: false,
          },
          meta,
        },
        { status: 202 },
      );
    });
    const command = {
      description: "Focus on competitors.",
      skillIds: ["skill_1"],
      stepModelOverrides: [{ id: "step_1", model: "codex", runtimeModel: "openai/gpt-5.6-sol" }],
      attachmentIds: ["attachment_1"],
    };

    await invokeHeadlessWorkflow("workflow_1", command, {
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
      scopeKey: "workspace_1",
    });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).pathname).toBe("/v1/workflows/workflow_1/invoke");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-workflow-invoke:/u);
    await expect(sent.json()).resolves.toEqual(command);
    expect(awaitHeadlessTaskTransaction).toHaveBeenCalledWith("53", {
      scopeKey: "workspace_1",
    });
  });

  it("runs a scheduled Workflow now and reconciles the created Task", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        {
          data: {
            task,
            messageId: "message_2",
            runId: "run_2",
            transactionId: "54",
            replayed: false,
          },
          meta,
        },
        { status: 202 },
      );
    });

    await runHeadlessWorkflowNow("workflow_1", {
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
      scopeKey: "workspace_1",
    });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).pathname).toBe("/v1/workflows/workflow_1/run-now");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-workflow-run:/u);
    expect(awaitHeadlessTaskTransaction).toHaveBeenCalledWith("54", {
      scopeKey: "workspace_1",
    });
  });

  it("paginates the canonical Workflow catalog and excludes incomplete definitions", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      const cursor = new URL(request.url).searchParams.get("cursor");
      return Response.json({
        data:
          cursor === "page_2"
            ? [{ ...workflow, id: "workflow_2", slug: "draft", status: "draft" }]
            : [workflow],
        nextCursor: cursor ? null : "page_2",
        meta,
      });
    });

    await expect(
      listHeadlessWorkflowCatalog({
        baseUrl: "https://app.example.test",
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual([
      {
        id: "weekly-research",
        name: "Weekly research",
        description: "Track material changes",
        steps: workflow.steps,
      },
    ]);
    expect(requests.map((request) => new URL(request.url).search)).toEqual([
      "?limit=100",
      "?limit=100&cursor=page_2",
    ]);
  });

  it("surfaces the canonical error and request id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "conflict",
            message: "The Workflow changed in another session.",
            requestId: "request_1",
            retryable: false,
          },
          meta,
        },
        { status: 409 },
      ),
    );

    await expect(
      updateHeadlessWorkflow(
        workflow.id,
        {
          expectedVersion: 1,
          name: workflow.name,
          description: workflow.description,
          steps: [...workflow.steps],
          status: workflow.status,
          trigger: workflow.trigger,
        },
        {
          baseUrl: "https://app.example.test",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).rejects.toThrow("The Workflow changed in another session. (request request_1)");
  });
});
