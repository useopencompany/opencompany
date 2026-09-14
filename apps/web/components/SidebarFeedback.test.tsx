import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarFeedback } from "./SidebarFeedback";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));
const submitFeedbackMock = vi.hoisted(() =>
  vi.fn(async (_previousState: unknown, _formData: FormData) => ({ ok: true as const })),
);

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
}));

vi.mock("@/lib/feedback/actions", () => ({
  submitFeedback: submitFeedbackMock,
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
});
