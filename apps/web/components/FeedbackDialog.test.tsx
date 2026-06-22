import { fireEvent, render } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import { submitFeedback } from "@/lib/feedback/actions";
import { uploadFeedbackImage } from "@/lib/feedback/upload-image";
import FeedbackDialog from "./FeedbackDialog";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("@/lib/feedback/actions", () => ({
  submitFeedback: vi.fn(),
}));

vi.mock("@/lib/feedback/upload-image", () => ({
  uploadFeedbackImage: vi.fn(),
}));

const usePathnameMock = vi.mocked(usePathname);
const submitFeedbackMock = vi.mocked(submitFeedback);

describe("FeedbackDialog", () => {
  it("submits the current session id when feedback opens from a company session page", () => {
    usePathnameMock.mockReturnValue("/company/session/ses_123");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>('input[name="sessionId"]');
    expect(input).toHaveValue("ses_123");
  });

  it("submits the current session id when feedback opens from a personal session page", () => {
    usePathnameMock.mockReturnValue("/personal/session/ses_456");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>('input[name="sessionId"]');
    expect(input).toHaveValue("ses_456");
  });

  it("does not submit a session id outside session pages", () => {
    usePathnameMock.mockReturnValue("/company/settings");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(container.querySelector('input[name="sessionId"]')).toBeNull();
  });

  it("offers image attachment when a workspace id is provided", () => {
    usePathnameMock.mockReturnValue("/company");

    const { getByRole } = render(
      <FeedbackDialog open onClose={vi.fn()} onSubmit={vi.fn()} workspaceId="wks_123" />,
    );

    expect(getByRole("button", { name: /attach image/i })).toBeInTheDocument();
  });

  it("stays text-only when no workspace id is provided", () => {
    usePathnameMock.mockReturnValue("/company");

    const { queryByRole } = render(<FeedbackDialog open onClose={vi.fn()} onSubmit={vi.fn()} />);

    expect(queryByRole("button", { name: /attach image/i })).toBeNull();
  });

  it("warns and keeps Send enabled when an image upload fails", async () => {
    usePathnameMock.mockReturnValue("/company");
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    vi.mocked(uploadFeedbackImage).mockRejectedValue(new Error("upload failed"));

    const { container, getByRole, findByText } = render(
      <FeedbackDialog open onClose={vi.fn()} onSubmit={vi.fn()} workspaceId="wks_123" />,
    );

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("file input not found");
    fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "shot.png", { type: "image/png" })] },
    });

    // A failed upload must be surfaced, not silently dropped...
    await findByText(/failed to upload/i);
    // ...and it must not block sending the rest of the feedback.
    expect(getByRole("button", { name: /send/i })).not.toBeDisabled();
  });

  it("optimistically closes and hands the submission to the parent", () => {
    usePathnameMock.mockReturnValue("/company/settings");
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    const { container } = render(<FeedbackDialog open onClose={onClose} onSubmit={onSubmit} />);

    const message = container.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    if (!message) throw new Error("message field not found");
    fireEvent.change(message, { target: { value: "Something looks off." } });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);

    // Optimistic: the dialog closes immediately and forwards the form snapshot. It does NOT call the
    // server action itself — the parent owns sending and the success/failure toast.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const formData = onSubmit.mock.calls[0]?.[0] as FormData;
    expect(formData.get("message")).toBe("Something looks off.");
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });

  it("blocks an empty submission and keeps the dialog open", () => {
    usePathnameMock.mockReturnValue("/company/settings");
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    const { container, getByText } = render(
      <FeedbackDialog open onClose={onClose} onSubmit={onSubmit} />,
    );

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getByText(/enter feedback/i)).toBeInTheDocument();
  });
});
