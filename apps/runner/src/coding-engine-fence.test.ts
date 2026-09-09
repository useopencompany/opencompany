import type { CodexChatSession } from "@opencompany/db/product-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexChatRetryableInfrastructureError } from "./codex-chat-errors";
import { fenceCodingSessionEngine } from "./coding-engine-fence";

const mocks = vi.hoisted(() => ({
  connectSandbox: vi.fn(),
  armSandboxIdleTimeoutById: vi.fn(),
  killLeftoverCodexTurnProcesses: vi.fn(),
  killLeftoverClaudeTurnProcesses: vi.fn(),
}));
vi.mock("./sandbox", () => mocks);
vi.mock("./codex-cli", () => mocks);
vi.mock("./claude-code-cli", () => mocks);

const sandbox = { sandboxId: "sandbox_1" };
const session = { sandboxId: sandbox.sandboxId, engine: "codex" } as CodexChatSession;

describe("coding engine cleanup before terminal recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connectSandbox.mockResolvedValue(sandbox);
  });

  it.each(["codex", "claude_code"] as const)(
    "stops a detached %s engine and parks its retained workspace",
    async (engine) => {
      await fenceCodingSessionEngine({ ...session, engine }, 300_000);
      const kill =
        engine === "codex"
          ? mocks.killLeftoverCodexTurnProcesses
          : mocks.killLeftoverClaudeTurnProcesses;
      expect(kill).toHaveBeenCalledExactlyOnceWith(sandbox);
      expect(mocks.armSandboxIdleTimeoutById).toHaveBeenCalledExactlyOnceWith(
        sandbox.sandboxId,
        300_000,
      );
      expect(kill.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.armSandboxIdleTimeoutById.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("allows settlement when the sandbox no longer exists", async () => {
    mocks.connectSandbox.mockResolvedValue(null);
    await expect(fenceCodingSessionEngine(session, 300_000)).resolves.toBeUndefined();
    expect(mocks.killLeftoverCodexTurnProcesses).not.toHaveBeenCalled();
    expect(mocks.armSandboxIdleTimeoutById).not.toHaveBeenCalled();
  });

  it("does not acquire a coding sandbox for native engine cancellation", async () => {
    await fenceCodingSessionEngine({ ...session, engine: "opencompany" }, 300_000);
    expect(mocks.connectSandbox).not.toHaveBeenCalled();
  });

  it("requires retry when stopping the detached process fails", async () => {
    mocks.killLeftoverCodexTurnProcesses.mockRejectedValue(
      new Error("command service unavailable"),
    );
    await expect(fenceCodingSessionEngine(session, 300_000)).rejects.toBeInstanceOf(
      CodexChatRetryableInfrastructureError,
    );
    expect(mocks.armSandboxIdleTimeoutById).not.toHaveBeenCalled();
  });
});
