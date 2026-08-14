import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };

describe("/api/workflows compatibility adapter", () => {
  beforeEach(() => vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test"));
  afterEach(() => vi.unstubAllEnvs());

  it("projects the canonical catalog into the legacy response shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [workflow()],
        nextCursor: null,
        meta,
      }),
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflows: [{ id: "morning-test", name: "Morning Test", description: "Review the morning." }],
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const upstream = input instanceof Request ? input : new Request(input!, init);
    expect(new URL(upstream.url).pathname).toBe("/v1/workflows");
    expect(upstream.headers.get("cookie")).toBe("wos-session=sealed");
  });

  it("translates legacy invocation input into the typed canonical command", async () => {
    let upstream: Request | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      upstream = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        {
          data: {
            task: {
              id: "goat_task_1",
              displayId: "TASK-1",
              name: "Morning Test",
              conversationId: "conversation_1",
            },
            messageId: "message_1",
            assistantMessageId: "message_2",
            runId: "run_1",
            transactionId: "42",
            replayed: false,
          },
          meta,
        },
        { status: 202, headers: { "Set-Cookie": "wos-session=rotated; Path=/; HttpOnly" } },
      );
    });

    const response = await POST(
      request({
        workflow: { kind: "workflow", id: "morning-test" },
        description: "#morning-test Review this screenshot with @skill/visual-review",
        mentions: [{ kind: "skill", id: "visual-review" }],
        attachments: [{ id: "attachment_1" }],
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("wos-session=rotated");
    await expect(response.json()).resolves.toEqual({
      task: { id: "goat_task_1", displayId: "TASK-1", name: "Morning Test" },
    });
    const sent = upstream as unknown as Request;
    expect(new URL(sent.url).pathname).toBe("/v1/workflows/morning-test/invoke");
    expect(sent.headers.get("idempotency-key")).toMatch(/^web-workflow-compat:/u);
    expect(sent.headers.get("origin")).toBe("http://localhost");
    await expect(sent.json()).resolves.toEqual({
      description: "#morning-test Review this screenshot with @skill/visual-review",
      skillIds: ["visual-review"],
      attachmentIds: ["attachment_1"],
    });
  });

  it("rejects malformed invocation skill mentions before proxying", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await POST(
      request({
        workflow: { kind: "workflow", id: "morning-test" },
        description: "#morning-test Review this screenshot",
        mentions: [{ kind: "skill", id: "../not-a-skill" }],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid skill mention." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function request(body?: unknown) {
  return new Request("http://localhost/api/workflows", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: "wos-session=sealed",
      Origin: "http://localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function workflow() {
  return {
    id: "workflow_1",
    slug: "morning-test",
    name: "Morning Test",
    description: "Review the morning.",
    steps: [{ id: "step_1", title: "Review", model: "provider/model", instructions: "Review." }],
    status: "active",
    trigger: { type: "manual" },
    version: 1,
    archivedAt: null,
    createdAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:00.000Z",
  };
}
