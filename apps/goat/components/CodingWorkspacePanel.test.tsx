import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatCodexSandboxStatus } from "@/lib/task-runner";
import { CodingWorkspacePanel, type CodingWorkspacePanelHandle } from "./CodingWorkspacePanel";

// The panel no longer owns its own open/close trigger — a host (GoatSurface's header
// button, in production) drives it through the imperative handle. This harness stands
// in for that host.
function Harness({
  chatSessionId,
  sandboxStatus,
  engineLabel,
}: {
  chatSessionId: string;
  sandboxStatus: GoatCodexSandboxStatus | null;
  engineLabel: string;
}) {
  const panelRef = useRef<CodingWorkspacePanelHandle>(null);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={toggleButtonRef} type="button" onClick={() => panelRef.current?.toggle()}>
        Toggle workspace
      </button>
      <CodingWorkspacePanel
        ref={panelRef}
        chatSessionId={chatSessionId}
        sandboxStatus={sandboxStatus}
        engineLabel={engineLabel}
        onRequestFocusReturn={() => toggleButtonRef.current?.focus()}
      />
    </>
  );
}

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  binaryType = "blob";
  readyState = MockWebSocket.CONNECTING;
  send = vi.fn();

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = String(url);
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

describe("CodingWorkspacePanel", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    window.localStorage.clear();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          websocketUrl: "wss://runner.example.com/goat/runtime",
          ticket: "signed-ticket",
          expiresAt: Date.now() + 60_000,
          sandboxStatus: "sleeping",
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts collapsed and shows status without waking until the user chooses a tab", async () => {
    const user = userEvent.setup();
    render(<Harness chatSessionId="chat_1" sandboxStatus="sleeping" engineLabel="Codex" />);

    expect(screen.queryByLabelText("Codex workspace")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle workspace" }));
    expect(screen.getByText("Workspace is sleeping")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(fetch).toHaveBeenCalledWith("/api/coding-workspaces/sessions/chat_1/runtime-access", {
      method: "POST",
    });
  });

  it("uses the intended default desktop width when no preference is stored", () => {
    render(<Harness chatSessionId="chat_1" sandboxStatus="sleeping" engineLabel="Codex" />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle workspace" }));
    expect(screen.getByLabelText("Codex workspace")).toHaveStyle({ width: "440px" });
  });

  it("uses the active engine label for accessibility and previews without an edit warning", async () => {
    const user = userEvent.setup();
    render(
      <Harness chatSessionId="chat_claude" sandboxStatus="running" engineLabel="Claude Code" />,
    );

    await user.click(screen.getByRole("button", { name: "Toggle workspace" }));
    expect(screen.getByLabelText("Claude Code workspace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => MockWebSocket.instances[0]!.open());
    expect(screen.queryByText(/working in this directory/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    act(() =>
      MockWebSocket.instances[0]!.receive({
        type: "preview",
        port: 5_173,
        url: "https://preview.example.com",
      }),
    );
    expect(screen.getByTitle("Claude Code preview on port 5173")).toBeInTheDocument();
  });

  it("opens as a modal without a fixed inline width on narrow screens and closes with Escape", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "(max-width: 1023px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    render(<Harness chatSessionId="chat_1" sandboxStatus="sleeping" engineLabel="Codex" />);

    await user.click(screen.getByRole("button", { name: "Toggle workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Codex workspace" });
    expect(dialog.style.width).toBe("");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const previewButton = screen.getByRole("button", { name: "Preview" });
    await waitFor(() => expect(previewButton).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Collapse workspace" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    const toggleButton = await screen.findByRole("button", { name: "Toggle workspace" });
    expect(toggleButton).toHaveFocus();
  });

  it("discovers the strongest port, validates manual entry, and handles reconnect state", async () => {
    const user = userEvent.setup();
    render(<Harness chatSessionId="chat_1" sandboxStatus="running" engineLabel="Codex" />);
    await user.click(screen.getByRole("button", { name: "Toggle workspace" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;

    act(() => socket.open());
    expect(socket.protocols).toEqual(["goat-coding-workspace-v1", "goat-ticket.signed-ticket"]);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "ports.refresh" }));

    act(() =>
      socket.receive({
        type: "ports",
        ports: [
          { port: 5_173, isHttp: true, score: 1_099 },
          { port: 8_080, isHttp: true, score: 1_000 },
          { port: 3_000, isHttp: false, score: 100 },
        ],
      }),
    );
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "preview.open", port: 5_173 }));

    const manualPort = screen.getByRole("textbox", { name: "Manual preview port" });
    const go = screen.getByRole("button", { name: "Open manual port" });
    expect(go).toBeDisabled();
    fireEvent.change(manualPort, { target: { value: "8080" } });
    expect(go).toBeEnabled();
    await user.click(go);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "preview.open", port: 8_080 }));

    act(() =>
      socket.receive({
        type: "preview",
        port: 8_080,
        url: "https://preview.example.com",
      }),
    );
    socket.send.mockClear();
    await user.click(screen.getByRole("button", { name: "Refresh ports" }));
    act(() =>
      socket.receive({
        type: "ports",
        ports: [
          { port: 5_173, isHttp: true, score: 1_099 },
          { port: 8_080, isHttp: true, score: 1_000 },
        ],
      }),
    );
    expect(screen.getByRole("combobox", { name: "Preview port" })).toHaveValue("8080");
    expect(socket.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "preview.open", port: 5_173 }),
    );

    act(() => socket.close());
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("rejects preview URLs with non-HTTP schemes", async () => {
    const user = userEvent.setup();
    render(<Harness chatSessionId="chat_1" sandboxStatus="running" engineLabel="Codex" />);
    await user.click(screen.getByRole("button", { name: "Toggle workspace" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;

    act(() => socket.open());
    act(() =>
      socket.receive({
        type: "preview",
        port: 5_173,
        url: "javascript:alert(document.domain)",
      }),
    );

    expect(screen.queryByTitle("Codex preview on port 5173")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open preview in new tab" })).toBeDisabled();
  });

  it("offers a retry when the workspace WebSocket handshake stalls", async () => {
    vi.useFakeTimers();
    render(<Harness chatSessionId="chat_1" sandboxStatus="sleeping" engineLabel="Codex" />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });

    expect(screen.getByText("Workspace unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("The workspace took too long to connect. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
