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
  savePreferredMcpClientAction: actionsMock.saveClient,
  checkMcpSetupStatusAction: actionsMock.checkStatus,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: { error: vi.fn() },
}));

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

  it("shows the single user-level connector URL and a name-only first question", () => {
    renderGuide({ initialClient: "claude" });

    expect(screen.getByText(/\/mcp$/)).toBeInTheDocument();
    expect(screen.getByText(/Use the opencompany connector/)).toBeInTheDocument();
    expect(screen.getByText(/search it for "Ada Lovelace"/)).toHaveTextContent(
      /at Analytical Engines/,
    );
    expect(screen.queryByText(/ada@example\.com/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Brain" })).not.toBeInTheDocument();
  });

  it("uses opencompany as the Cursor server name", () => {
    renderGuide({ initialClient: "cursor" });

    fireEvent.click(screen.getByRole("button", { name: "Copy mcp.json" }));

    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('"opencompany"'));
    expect(clipboardWrite).not.toHaveBeenCalledWith(expect.stringContaining('"goat"'));
  });

  it("hides the guide header when embedded under a page-level header", () => {
    renderGuide({ initialClient: "claude", hideHeader: true });

    expect(screen.queryByText("Use your Wiki where you already work")).not.toBeInTheDocument();
  });

  it("starts waiting after copying the first question and refreshes after verification", async () => {
    actionsMock.checkStatus.mockResolvedValue({
      complete: true,
      completedAt: "2026-07-13T09:00:00.000Z",
    });
    renderGuide({ initialClient: "cursor" });

    fireEvent.click(screen.getByRole("button", { name: "Copy first question" }));

    await waitFor(() => expect(actionsMock.checkStatus).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("opencompany is connected")).toBeInTheDocument();
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining("Ada Lovelace"));
  });

  it("keeps an unsuccessful external query incomplete", async () => {
    renderGuide({ initialClient: "claude" });

    fireEvent.click(screen.getByRole("button", { name: "Copy first question" }));

    expect(await screen.findByText(/Waiting for your first Wiki query/)).toBeInTheDocument();
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
});

function renderGuide({
  initialClient,
  hideHeader,
}: {
  initialClient: "claude" | "chatgpt" | "cursor" | null;
  hideHeader?: boolean;
}) {
  return render(
    <McpSetupGuide
      displayName="Ada Lovelace"
      workspaceName="Analytical Engines"
      initialClient={initialClient}
      initialCompletedAt={null}
      {...(hideHeader !== undefined ? { hideHeader } : {})}
    />,
  );
}
