import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeGoatChatSessionAction } from "@/lib/chat-actions";

const mocks = vi.hoisted(() => ({
  archiveGoatChatSessionForUser: vi.fn(),
  currentGoatUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ currentGoatUser: mocks.currentGoatUser }));
vi.mock("@/lib/chat", () => ({
  reopenGoatChatSessionForUser: vi.fn(),
  setGoatChatSessionPinnedForUser: vi.fn(),
}));
vi.mock("@/lib/chat-sharing", () => ({
  ensureGoatChatShareForUser: vi.fn(),
  findGoatChatShareForUser: vi.fn(),
  revokeGoatChatShareForUser: vi.fn(),
}));
vi.mock("@/lib/codex-chat", () => ({
  archiveGoatChatSessionForUser: mocks.archiveGoatChatSessionForUser,
}));

describe("closeGoatChatSessionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentGoatUser.mockResolvedValue({
      user: { workosUserId: "user_1" },
    });
    mocks.archiveGoatChatSessionForUser.mockResolvedValue(true);
  });

  it("archives the owned chat and revalidates home", async () => {
    await expect(closeGoatChatSessionAction(" chat_1 ")).resolves.toEqual({
      ok: true,
      error: null,
    });

    expect(mocks.archiveGoatChatSessionForUser).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      chatSessionId: "chat_1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns a safe failure when the archive operation throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.archiveGoatChatSessionForUser.mockRejectedValue(new Error("database unavailable"));

    await expect(closeGoatChatSessionAction("chat_1")).resolves.toEqual({
      ok: false,
      error: "Could not archive that chat.",
    });

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[goat] Failed to archive chat session",
      expect.objectContaining({
        event: "goat.chat_archive_failed",
        chat_session_id: "chat_1",
      }),
    );
    consoleError.mockRestore();
  });
});
