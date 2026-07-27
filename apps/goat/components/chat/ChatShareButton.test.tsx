import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoatChatShareAction,
  getGoatChatShareAction,
  revokeGoatChatShareAction,
} from "@/lib/chat-actions";
import { ChatShareButton } from "./ChatShareButton";

const SHARE_ID = "goat_chat_share_123e4567-e89b-42d3-a456-426614174000";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: toastMock,
}));

vi.mock("@/lib/chat-actions", () => ({
  createGoatChatShareAction: vi.fn(),
  getGoatChatShareAction: vi.fn(),
  revokeGoatChatShareAction: vi.fn(),
}));

describe("ChatShareButton", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    vi.mocked(createGoatChatShareAction).mockReset();
    vi.mocked(getGoatChatShareAction).mockReset();
    vi.mocked(revokeGoatChatShareAction).mockReset();
    vi.mocked(getGoatChatShareAction).mockResolvedValue({ ok: true, shareId: null });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains the live read-only link before creating and copying it", async () => {
    vi.mocked(createGoatChatShareAction).mockResolvedValue({
      ok: true,
      shareId: SHARE_ID,
    });
    render(<ChatShareButton chatSessionId="chat_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Share chat" }));

    expect(await screen.findByRole("heading", { name: "Share this chat" })).toBeInTheDocument();
    expect(
      screen.getByText(/Anyone with the link can view this read-only chat, including new messages/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create & copy link" }));

    expect(createGoatChatShareAction).toHaveBeenCalledWith("chat_1");
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/${SHARE_ID}`),
    );
    expect(await screen.findByRole("heading", { name: "Chat is shared" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Read-only chat link" })).toHaveValue(
      `${window.location.origin}/share/${SHARE_ID}`,
    );
    expect(toastMock.success).toHaveBeenCalledWith("Read-only link copied", {
      description: "Anyone with the link can view this chat, including new messages.",
    });
  });

  it("confirms before revoking an existing link and leaves the chat ready to share again", async () => {
    vi.mocked(getGoatChatShareAction).mockResolvedValue({ ok: true, shareId: SHARE_ID });
    vi.mocked(revokeGoatChatShareAction).mockResolvedValue({ ok: true });
    render(<ChatShareButton chatSessionId="chat_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Share chat" }));

    expect(await screen.findByRole("heading", { name: "Chat is shared" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(screen.getByRole("heading", { name: "Stop sharing this chat?" })).toBeInTheDocument();
    expect(screen.getByText(/current link will stop working immediately/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));

    await waitFor(() => expect(revokeGoatChatShareAction).toHaveBeenCalledWith("chat_1"));
    expect(await screen.findByRole("heading", { name: "Share this chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create & copy link" })).toBeEnabled();
    expect(toastMock.success).toHaveBeenCalledWith("Chat is no longer shared", {
      description: "The old link no longer works.",
    });
  });

  it("keeps the unshared state and surfaces a share failure", async () => {
    vi.mocked(createGoatChatShareAction).mockResolvedValue({
      ok: false,
      error: "Could not share that chat.",
    });
    render(<ChatShareButton chatSessionId="chat_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Share chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create & copy link" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Could not share that chat."));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create & copy link" })).toBeEnabled();
  });
});
