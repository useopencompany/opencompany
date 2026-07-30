import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatAuthContext } from "@/lib/auth";
import { currentGoatUser } from "@/lib/auth";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { createGoatTaskForUser } from "@/lib/tasks";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/codex-auth", () => ({
  isGoatCodexConnectedForUser: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  createGoatTaskForUser: vi.fn(),
}));

describe("POST /api/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: {
        workosUserId: "user_1",
        taskSpawningEnabled: true,
      },
      workspace: { id: "workspace_1" },
    } as GoatAuthContext);
    vi.mocked(isGoatCodexConnectedForUser).mockResolvedValue(true);
    vi.mocked(createGoatTaskForUser).mockResolvedValue({
      id: "goat_task_1",
      displayId: "TASK-1",
      name: "Research the market",
    } as never);
  });

  it("creates a durable task without passing the composer directive to the runner", async () => {
    const response = await POST(
      jsonRequest({
        description: "#task Research the market",
        model: "openai/gpt-5.5",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      task: {
        id: "goat_task_1",
        displayId: "TASK-1",
        name: "Research the market",
      },
    });
    expect(createGoatTaskForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      prompt: "Research the market",
      model: "openai/gpt-5.5",
    });
  });

  it("uses the normal default for an invalid model selection", async () => {
    await POST(jsonRequest({ description: "#task Research the market", model: "auto" }));

    expect(createGoatTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_GOAT_MODEL }),
    );
  });

  it("supports an explicitly selected connected Codex engine", async () => {
    await POST(
      jsonRequest({
        description: "#task Check the repository",
        model: DEFAULT_GOAT_MODEL,
        engine: "codex",
      }),
    );

    expect(createGoatTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "codex" }),
    );
  });

  it("rejects Codex tasks when Codex is not connected", async () => {
    vi.mocked(isGoatCodexConnectedForUser).mockResolvedValueOnce(false);

    const response = await POST(
      jsonRequest({
        description: "#task Check the repository",
        model: DEFAULT_GOAT_MODEL,
        engine: "codex",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Codex is not connected. Connect Codex in Settings first.",
    });
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
  });

  it("rejects unknown task engines", async () => {
    const response = await POST(
      jsonRequest({
        description: "#task Research the market",
        model: DEFAULT_GOAT_MODEL,
        engine: "claude",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid task engine." });
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
  });

  it("rejects empty task descriptions", async () => {
    const response = await POST(jsonRequest({ description: " #task ", model: DEFAULT_GOAT_MODEL }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Enter a task before starting a run.",
    });
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
  });

  it("requires an authenticated Goat user", async () => {
    vi.mocked(currentGoatUser).mockResolvedValueOnce(null as never);

    const response = await POST(
      jsonRequest({ description: "#task Research the market", model: DEFAULT_GOAT_MODEL }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
  });

  it("honors the Tasks & Workflows preference", async () => {
    vi.mocked(currentGoatUser).mockResolvedValueOnce({
      user: {
        workosUserId: "user_1",
        taskSpawningEnabled: false,
      },
      workspace: { id: "workspace_1" },
    } as GoatAuthContext);

    const response = await POST(
      jsonRequest({ description: "#task Research the market", model: DEFAULT_GOAT_MODEL }),
    );

    expect(response.status).toBe(403);
    expect(createGoatTaskForUser).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
