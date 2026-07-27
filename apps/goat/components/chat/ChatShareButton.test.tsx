import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatChatShareAction } from "@/lib/chat-actions";
import { ChatShareButton } from "./ChatShareButton";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: toastMock,
}));

vi.mock("@/lib/chat-actions", () => ({
  createGoatChatShareAction: vi.fn(),
}));

describe("ChatShareButton", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    vi.mocked(createGoatChatShareAction).mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates and copies a stable read-only URL", async () => {
    vi.mocked(createGoatChatShareAction).mockResolvedValue({
      ok: true,
      shareId: "goat_chat_share_123e4567-e89b-42d3-a456-426614174000",
    });
    render(<ChatShareButton chatSessionId="chat_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy read-only link" }));

    expect(createGoatChatShareAction).toHaveBeenCalledWith("chat_1");
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/share/goat_chat_share_123e4567-e89b-42d3-a456-426614174000`,
      ),
    );
    expect(await screen.findByRole("button", { name: "Read-only link copied" })).toBeEnabled();
    expect(toastMock.success).toHaveBeenCalledWith("Read-only link copied", {
      description: "Anyone with the link can view this chat, including new messages.",
    });
  });

  it("surfaces a share failure without writing to the clipboard", async () => {
    vi.mocked(createGoatChatShareAction).mockResolvedValue({
      ok: false,
      error: "Could not share that chat.",
    });
    render(<ChatShareButton chatSessionId="chat_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy read-only link" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Could not share that chat."));
    expect(writeText).not.toHaveBeenCalled();
  });
});
