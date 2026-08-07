import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth";
import { currentUser } from "@/lib/auth";
import { isClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isCodexConnectedForUser } from "@/lib/codex-auth";
import { DEFAULT_MODEL } from "@/lib/model-options";
import { createTaskForUser } from "@/lib/tasks";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

vi.mock("@/lib/codex-auth", () => ({
  isCodexConnectedForUser: vi.fn(),
}));

vi.mock("@/lib/claude-code-auth", () => ({
  isClaudeCodeConnectedForUser: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  createTaskForUser: vi.fn(),
}));

describe("POST /api/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentUser).mockResolvedValue({
      user: {
        workosUserId: "user_1",
        taskSpawningEnabled: true,
      },
      workspace: { id: "workspace_1" },
    } as AuthContext);
    vi.mocked(isCodexConnectedForUser).mockResolvedValue(true);
    vi.mocked(isClaudeCodeConnectedForUser).mockResolvedValue(true);
    vi.mocked(createTaskForUser).mockResolvedValue({
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
    expect(createTaskForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      prompt: "Research the market",
      model: "openai/gpt-5.5",
    });
  });

  it("uses the normal default for an invalid model selection", async () => {
    await POST(jsonRequest({ description: "#task Research the market", model: "auto" }));

    expect(createTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_MODEL }),
    );
  });

  it("supports an explicitly selected connected Codex engine", async () => {
    await POST(
      jsonRequest({
        description: "#task Check the repository",
        model: DEFAULT_MODEL,
        engine: "codex",
      }),
    );

    expect(createTaskForUser).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex" }));
  });

  it("supports an explicitly selected connected Claude Code engine", async () => {
    await POST(
      jsonRequest({
        description: "#task Check the repository",
        model: DEFAULT_MODEL,
        engine: "claude_code",
      }),
    );

    expect(isCodexConnectedForUser).not.toHaveBeenCalled();
    expect(isClaudeCodeConnectedForUser).toHaveBeenCalledWith("user_1");
    expect(createTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "claude_code" }),
    );
  });

  it("rejects Codex tasks when Codex is not connected", async () => {
    vi.mocked(isCodexConnectedForUser).mockResolvedValueOnce(false);

    const response = await POST(
      jsonRequest({
        description: "#task Check the repository",
        model: DEFAULT_MODEL,
        engine: "codex",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Codex is not connected. Connect Codex in Settings first.",
    });
    expect(createTaskForUser).not.toHaveBeenCalled();
  });

  it("rejects Claude Code tasks when Claude Code is not connected", async () => {
    vi.mocked(isClaudeCodeConnectedForUser).mockResolvedValueOnce(false);

    const response = await POST(
      jsonRequest({
        description: "#task Check the repository",
        model: DEFAULT_MODEL,
        engine: "claude_code",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Claude Code is not connected. Connect Claude Code in Settings first.",
    });
    expect(createTaskForUser).not.toHaveBeenCalled();
  });

  it("rejects unknown task engines", async () => {
    const response = await POST(
      jsonRequest({
        description: "#task Research the market",
        model: DEFAULT_MODEL,
        engine: "claude",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid task engine." });
    expect(createTaskForUser).not.toHaveBeenCalled();
  });

  it("rejects empty task descriptions", async () => {
    const response = await POST(jsonRequest({ description: " #task ", model: DEFAULT_MODEL }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Enter a task before starting a run.",
    });
    expect(createTaskForUser).not.toHaveBeenCalled();
  });

  it("requires an authenticated Goat user", async () => {
    vi.mocked(currentUser).mockResolvedValueOnce(null as never);

    const response = await POST(
      jsonRequest({ description: "#task Research the market", model: DEFAULT_MODEL }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(createTaskForUser).not.toHaveBeenCalled();
  });

  it("honors the Tasks & Workflows preference", async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({
      user: {
        workosUserId: "user_1",
        taskSpawningEnabled: false,
      },
      workspace: { id: "workspace_1" },
    } as AuthContext);

    const response = await POST(
      jsonRequest({ description: "#task Research the market", model: DEFAULT_MODEL }),
    );

    expect(response.status).toBe(403);
    expect(createTaskForUser).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
