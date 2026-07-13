import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpSetupGuide } from "./McpSetupGuide";

const routerMock = vi.hoisted(() => ({ refresh: vi.fn() }));
const actionsMock = vi.hoisted(() => ({
  saveClient: vi.fn(async () => ({ ok: true as const })),
  checkStatus: vi.fn(
    async (): Promise<{ complete: boolean; completedAt: string | null }> => ({
      complete: false,
      completedAt: null,
    }),
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => true,
}));

vi.mock("@/lib/mcp-setup-actions", () => ({
  savePreferredGoatMcpClientAction: actionsMock.saveClient,
  checkGoatMcpSetupStatusAction: actionsMock.checkStatus,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: { error: vi.fn() },
}));

const brains = [
  { id: "goat_brain_1", name: "Company Brain", slug: "company-brain" },
  { id: "goat_brain_2", name: "Design Brain", slug: "design-brain" },
];

describe("McpSetupGuide", () => {
  const clipboardWrite = vi.fn(async () => undefined);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    clipboardWrite.mockClear();
    routerMock.refresh.mockClear();
    actionsMock.saveClient.mockClear();
    actionsMock.checkStatus.mockReset();
    actionsMock.checkStatus.mockResolvedValue({ complete: false, completedAt: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives Claude, ChatGPT, and Cursor equal client choices and persists selection", async () => {
    const user = userEvent.setup();
    renderGuide({ initialClient: null });

    expect(screen.getByRole("button", { name: /Claude/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ChatGPT/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cursor/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /ChatGPT/ }));

    expect(actionsMock.saveClient).toHaveBeenCalledWith("chatgpt");
    expect(screen.getByText(/plan and workspace permissions/)).toBeInTheDocument();
  });

  it("switches brains and creates a name-only first question", async () => {
    const user = userEvent.setup();
    renderGuide({ initialClient: "claude" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Brain" }), "goat_brain_2");

    expect(screen.getByText(/query the brain for "Ada Lovelace"/)).toHaveTextContent(
      /at Analytical Engines/,
    );
    expect(screen.getByText(/query the brain for "Ada Lovelace"/)).toHaveTextContent(
      /"Design Brain"/,
    );
    expect(screen.queryByText(/ada@example\.com/i)).not.toBeInTheDocument();
    expect(screen.getByText(/api\/mcp\/goat_brain_2\/mcp/)).toBeInTheDocument();
  });

  it("starts waiting after copying the first question and refreshes after verification", async () => {
    actionsMock.checkStatus.mockResolvedValue({
      complete: true,
      completedAt: "2026-07-13T09:00:00.000Z",
    });
    renderGuide({ initialClient: "cursor" });

    fireEvent.click(screen.getByRole("button", { name: "Copy first question" }));

    await waitFor(() => expect(actionsMock.checkStatus).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Goat Brain is connected")).toBeInTheDocument();
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining("Ada Lovelace"));
  });

  it("keeps an unsuccessful external query incomplete", async () => {
    renderGuide({ initialClient: "claude" });

    fireEvent.click(screen.getByRole("button", { name: "Copy first question" }));

    expect(await screen.findByText(/Waiting for your first Brain query/)).toBeInTheDocument();
    await waitFor(() => expect(actionsMock.checkStatus).toHaveBeenCalledTimes(1));
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("does not overlap status checks and stops polling after unmount", async () => {
    vi.useFakeTimers();
    let resolveStatus!: (status: { complete: boolean; completedAt: string | null }) => void;
    actionsMock.checkStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const view = renderGuide({ initialClient: "claude" });

    fireEvent.click(screen.getByRole("button", { name: "Copy first question" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(actionsMock.checkStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7500);
    });
    expect(actionsMock.checkStatus).toHaveBeenCalledTimes(1);

    view.unmount();
    resolveStatus({ complete: false, completedAt: null });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(actionsMock.checkStatus).toHaveBeenCalledTimes(1);
  });

  it("shows an admin-contact state when the user cannot access a brain", () => {
    renderGuide({ brains: [], initialClient: null });

    expect(screen.getByText("A brain needs to be shared first")).toBeInTheDocument();
    expect(screen.getByText(/Ask a workspace admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Claude/ })).not.toBeInTheDocument();
  });
});

function renderGuide({
  initialClient,
  brains: brainOptions = brains,
}: {
  initialClient: "claude" | "chatgpt" | "cursor" | null;
  brains?: typeof brains;
}) {
  return render(
    <McpSetupGuide
      displayName="Ada Lovelace"
      workspaceName="Analytical Engines"
      brains={brainOptions}
      initialBrainRef="goat_brain_1"
      initialClient={initialClient}
      initialCompletedAt={null}
    />,
  );
}
