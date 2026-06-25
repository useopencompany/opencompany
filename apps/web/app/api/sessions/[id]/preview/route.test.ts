import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentSessionPreviewTargetForWorkspace } from "@/lib/agent-sessions/data";
import { callRunnerJson, getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import { currentWorkspace } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/agent-sessions/data", () => ({
  loadAgentSessionPreviewTargetForWorkspace: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/runner", () => ({
  callRunnerJson: vi.fn(),
  getRunnerPublicUrl: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

const loadPreviewTargetMock = vi.mocked(loadAgentSessionPreviewTargetForWorkspace);
const callRunnerJsonMock = vi.mocked(callRunnerJson);
const getRunnerPublicUrlMock = vi.mocked(getRunnerPublicUrl);
const currentWorkspaceMock = vi.mocked(currentWorkspace);

describe("session preview API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    getRunnerPublicUrlMock.mockReturnValue("https://runner.example.com");
    process.env.RUNNER_INTERNAL_TOKEN = "internal-token";
  });

  it("returns 404 for missing sessions", async () => {
    loadPreviewTargetMock.mockResolvedValue(null);

    const response = await GET(
      new Request("https://app.example.com/api/sessions/ses_missing/preview"),
      { params: Promise.resolve({ id: "ses_missing" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Session not found." });
  });

  it("returns unavailable for non-Codex sessions without calling the runner", async () => {
    loadPreviewTargetMock.mockResolvedValue({
      id: "ses_123",
      engine: "opencompany",
      e2bSandboxId: "sbx_123",
    });

    const response = await GET(
      new Request("https://app.example.com/api/sessions/ses_123/preview"),
      {
        params: Promise.resolve({ id: "ses_123" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      preview: {
        available: false,
        reason: "not_codex",
        message: "Preview URLs are only available for Codex.",
      },
    });
    expect(callRunnerJsonMock).not.toHaveBeenCalled();
  });

  it("returns unavailable for Codex sessions without an active sandbox", async () => {
    loadPreviewTargetMock.mockResolvedValue({
      id: "ses_123",
      engine: "codex",
      e2bSandboxId: null,
    });

    const response = await GET(
      new Request("https://app.example.com/api/sessions/ses_123/preview"),
      {
        params: Promise.resolve({ id: "ses_123" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      preview: {
        available: false,
        reason: "no_sandbox",
        message: "No active sandbox has been attached to this session yet.",
      },
    });
    expect(callRunnerJsonMock).not.toHaveBeenCalled();
  });

  it("returns the runner preview payload for Codex sessions", async () => {
    loadPreviewTargetMock.mockResolvedValue({
      id: "ses_123",
      engine: "codex",
      e2bSandboxId: "sbx_123",
    });
    callRunnerJsonMock.mockResolvedValue({
      preview: {
        available: true,
        url: "https://preview.example.com",
        port: 3000,
        previews: [
          { url: "https://preview.example.com", port: 3000 },
          { url: "https://vite.example.com", port: 5173 },
        ],
        sandboxId: "sbx_123",
        detectedAt: "2026-06-25T10:00:00.000Z",
      },
    });

    const response = await GET(
      new Request("https://app.example.com/api/sessions/ses_123/preview"),
      {
        params: Promise.resolve({ id: "ses_123" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      preview: {
        available: true,
        url: "https://preview.example.com",
        port: 3000,
        previews: [
          { url: "https://preview.example.com", port: 3000 },
          { url: "https://vite.example.com", port: 5173 },
        ],
        sandboxId: "sbx_123",
        detectedAt: "2026-06-25T10:00:00.000Z",
      },
    });
    expect(callRunnerJsonMock).toHaveBeenCalledWith("/internal/sessions/ses_123/preview-url", {
      body: { workspaceId: "wks_123" },
      context: {
        workspace_id: "wks_123",
        session_id: "ses_123",
        engine: "codex",
        event: "opencompany.session_preview_url_detect",
      },
    });
  });
});
