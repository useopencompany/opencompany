import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isClaudeCodeConnectedForUser,
  isCodexConnectedForUser,
} from "./application/engine-auth-status";
import { listGitHubUserRepositoryAccess } from "./integrations/github-user";
import { validateWorkflowStepRepository } from "./workflow-step-repository";

vi.mock("./application/engine-auth-status", () => ({
  isCodexConnectedForUser: vi.fn(),
  isClaudeCodeConnectedForUser: vi.fn(),
}));
vi.mock("./integrations/github-user", () => ({
  loadGitHubUserIntegration: vi.fn(async () => ({ id: "github", status: "connected" })),
  getGitHubUserAccessToken: vi.fn(async () => "fixture-github"),
  listGitHubUserRepositoryAccess: vi.fn(),
}));
const repository = { fullName: "acme/service", baseBranch: "release/stable" };
const setup = { userWorkosId: "user", engine: "codex", repository };
beforeEach(() => {
  vi.mocked(isCodexConnectedForUser).mockResolvedValue(true);
  vi.mocked(isClaudeCodeConnectedForUser).mockResolvedValue(true);
  vi.mocked(listGitHubUserRepositoryAccess).mockResolvedValue({
    installations: [
      {
        id: "1",
        suspendedAt: null,
        permissions: { contents: "write", pull_requests: "write" },
        repositories: [{ fullName: "acme/service" }],
      },
    ],
  } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/acme/service/branches/release%2Fstable");
      return Response.json({ name: "release/stable" });
    }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("verifies repository permissions and the branch", async () => {
  await expect(validateWorkflowStepRepository({ ...setup, activation: true })).resolves.toEqual(
    repository,
  );
});
it("requires a coding engine for a step that works in a repository", async () => {
  await expect(
    validateWorkflowStepRepository({ ...setup, engine: "kimi-k2.6", activation: true }),
  ).rejects.toThrow("must use Codex or Claude Code");
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["codex", "claude-code"] as const)(
  "requires the chosen %s account at activation",
  async (engine) => {
    vi.mocked(
      engine === "codex" ? isCodexConnectedForUser : isClaudeCodeConnectedForUser,
    ).mockResolvedValue(false);
    await expect(
      validateWorkflowStepRepository({ ...setup, engine, activation: true }),
    ).rejects.toThrow("before activating");
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("rejects insufficient push and PR permissions without changing them", async () => {
  vi.mocked(listGitHubUserRepositoryAccess).mockResolvedValue({
    installations: [
      {
        id: "1",
        suspendedAt: null,
        permissions: { contents: "read", pull_requests: "write" },
        repositories: [{ fullName: "acme/service" }],
      },
    ],
  } as never);
  await expect(validateWorkflowStepRepository(setup)).rejects.toThrow(
    "Contents and Pull requests write access",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects inaccessible repositories and nonexistent base branches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  await expect(validateWorkflowStepRepository(setup)).rejects.toThrow("base branch does not exist");
  vi.mocked(listGitHubUserRepositoryAccess).mockResolvedValue({ installations: [] } as never);
  await expect(validateWorkflowStepRepository(setup)).rejects.toThrow("cannot access");
});
