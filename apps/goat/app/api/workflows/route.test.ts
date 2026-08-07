import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { createGoatTaskFromWorkflow, generateGoatWorkflowTaskTitle } from "@/lib/workflow-tasks";
import { POST } from "./route";

vi.mock("next/server", () => ({
  after: vi.fn((work: Promise<unknown>) => work),
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      }),
  },
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/workflow-tasks", () => ({
  createGoatTaskFromWorkflow: vi.fn(),
  generateGoatWorkflowTaskTitle: vi.fn(async () => undefined),
}));

describe("POST /api/workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: {
        workosUserId: "user_1",
        taskSpawningEnabled: true,
      },
      workspace: { id: "workspace_1" },
    } as GoatAuthContext);
    vi.mocked(createGoatTaskFromWorkflow).mockResolvedValue({
      id: "goat_task_1",
      displayId: "TASK-1",
      name: "Morning Test",
    } as never);
  });

  it("validates and forwards uploaded attachments into workflow task creation", async () => {
    const response = await POST(
      jsonRequest({
        workflow: { kind: "workflow", id: "morning-test" },
        description: "#morning-test Review this screenshot with @skill/visual-review",
        mentions: [{ kind: "skill", id: "visual-review" }],
        attachments: [
          {
            id: "client_attachment_1",
            kind: "image",
            mediaType: "image/png",
            filename: "screen.png",
            sizeBytes: 1024,
            blobUrl: "https://blob.test/goat-chat/user_1/screen.png",
          },
        ],
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      task: {
        id: "goat_task_1",
        displayId: "TASK-1",
        name: "Morning Test",
      },
    });
    expect(createGoatTaskFromWorkflow).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      mention: { id: "morning-test" },
      skillMentions: [{ id: "visual-review" }],
      description: "#morning-test Review this screenshot with @skill/visual-review",
      attachments: [
        expect.objectContaining({
          id: expect.stringMatching(/^goat_chat_att_/),
          kind: "image",
          mediaType: "image/png",
          filename: "screen.png",
          sizeBytes: 1024,
          blobPathname: "goat-chat/user_1/screen.png",
          blobUrl: "https://blob.test/goat-chat/user_1/screen.png",
        }),
      ],
      attachmentTexts: null,
    });
    expect(generateGoatWorkflowTaskTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "goat_task_1",
        userWorkosId: "user_1",
      }),
    );
  });

  it("rejects malformed invocation skill mentions", async () => {
    const response = await POST(
      jsonRequest({
        workflow: { kind: "workflow", id: "morning-test" },
        description: "#morning-test Review this screenshot",
        mentions: [{ kind: "skill", id: "../not-a-skill" }],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid skill mention." });
    expect(createGoatTaskFromWorkflow).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
