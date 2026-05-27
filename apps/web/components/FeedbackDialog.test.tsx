import { render } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import FeedbackDialog from "./FeedbackDialog";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("@/lib/feedback/actions", () => ({
  submitFeedback: vi.fn(),
}));

const usePathnameMock = vi.mocked(usePathname);

describe("FeedbackDialog", () => {
  it("submits the current session id when feedback opens from a session page", () => {
    usePathnameMock.mockReturnValue("/session/ses_123");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>('input[name="sessionId"]');
    expect(input).toHaveValue("ses_123");
  });

  it("does not submit a session id outside session pages", () => {
    usePathnameMock.mockReturnValue("/settings");

    const { container } = render(<FeedbackDialog open onClose={vi.fn()} />);

    expect(container.querySelector('input[name="sessionId"]')).toBeNull();
  });
});
