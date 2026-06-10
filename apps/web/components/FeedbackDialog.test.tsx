import { fireEvent, render, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import { submitFeedback } from "@/lib/feedback/actions";
import FeedbackDialog from "./FeedbackDialog";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("@/lib/feedback/actions", () => ({
  submitFeedback: vi.fn(),
}));

const usePathnameMock = vi.mocked(usePathname);
const submitFeedbackMock = vi.mocked(submitFeedback);

describe("FeedbackDialog", () => {
  it("submits the current session id when feedback opens from a company session page", () => {
    usePathnameMock.mockReturnValue("/company/session/ses_123");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>('input[name="sessionId"]');
    expect(input).toHaveValue("ses_123");
  });

  it("submits the current session id when feedback opens from a personal session page", () => {
    usePathnameMock.mockReturnValue("/personal/session/ses_456");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>('input[name="sessionId"]');
    expect(input).toHaveValue("ses_456");
  });

  it("does not submit a session id outside session pages", () => {
    usePathnameMock.mockReturnValue("/company/settings");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} />);

    expect(container.querySelector('input[name="sessionId"]')).toBeNull();
  });

  it("auto-closes the dialog after a successful submit", async () => {
    usePathnameMock.mockReturnValue("/company/settings");
    submitFeedbackMock.mockResolvedValue({ ok: true });
    const onClose = vi.fn();

    const { container } = render(<FeedbackDialog open onClose={onClose} />);

    const message = container.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    if (!message) throw new Error("message field not found");
    fireEvent.change(message, { target: { value: "Something looks off." } });

    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });
});
