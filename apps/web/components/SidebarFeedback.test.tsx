import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarFeedback } from "./SidebarFeedback";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));
const submitFeedbackMock = vi.hoisted(() =>
  vi.fn<(previousState: unknown, formData: FormData) => Promise<{ ok: true }>>(async () => ({
    ok: true,
  })),
);
const uploadAttachmentMock = vi.hoisted(() => vi.fn(async () => ({ id: "attachment_screenshot" })));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
}));

vi.mock("@/lib/feedback/actions", () => ({
  submitFeedback: submitFeedbackMock,
}));

vi.mock("@/lib/headless-chat-attachment-upload", () => ({
  uploadHeadlessChatAttachment: uploadAttachmentMock,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

async function openDialog(pathname: string) {
  pathnameMock.value = pathname;
  const user = userEvent.setup();
  render(<SidebarFeedback />);
  await user.click(screen.getByRole("button", { name: "Feedback" }));
  return user;
}

describe("SidebarFeedback", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:screenshot-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    pathnameMock.value = "/";
  });

  it("sends the viewed task with the report and says so", async () => {
    const user = await openDialog("/tasks/tsk_1/run");

    expect(screen.getByText(/Attaching this task/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "The run stalled halfway.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(submitFeedbackMock.mock.calls[0]?.[1].get("path")).toBe("/tasks/tsk_1/run");
  });

  it("names a chat session as the attached reference", async () => {
    await openDialog("/chat/ses_1");

    expect(screen.getByText(/Attaching this chat session/)).toBeInTheDocument();
  });

  it("promises nothing when the reporter is not viewing a session", async () => {
    await openDialog("/settings/preferences");

    expect(screen.queryByText(/Attaching/)).not.toBeInTheDocument();
  });

  it("uploads a screenshot and includes it with the report", async () => {
    const user = await openDialog("/chat/ses_1");
    const screenshot = new File(["png"], "broken-modal.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("Choose screenshots"), screenshot);
    await waitFor(() => expect(uploadAttachmentMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByRole("textbox"), "The modal clips this screenshot.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    expect(submitFeedbackMock.mock.calls[0]?.[1].getAll("attachmentId")).toEqual([
      "attachment_screenshot",
    ]);
  });

  it("submits with Cmd+Enter", async () => {
    await openDialog("/");
    const message = screen.getByRole("textbox");
    fireEvent.change(message, { target: { value: "Keyboard submission works." } });

    fireEvent.keyDown(message, { key: "Enter", metaKey: true });

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
  });
});
