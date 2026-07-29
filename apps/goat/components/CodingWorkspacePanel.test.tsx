import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingWorkspacePanel } from "./CodingWorkspacePanel";

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
    vi.unstubAllGlobals();
  });

  it("starts collapsed and shows status without waking until the user chooses a tab", async () => {
    const user = userEvent.setup();
    render(
      <CodingWorkspacePanel
        chatSessionId="chat_1"
        sandboxStatus="sleeping"
        engineLabel="Codex"
        engineIsRunning={false}
      />,
    );

    expect(screen.queryByLabelText("Codex workspace")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(screen.getByText("Workspace is sleeping")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(fetch).toHaveBeenCalledWith("/api/coding-workspaces/sessions/chat_1/runtime-access", {
      method: "POST",
    });
  });

  it("uses the intended default desktop width when no preference is stored", () => {
    render(
      <CodingWorkspacePanel
        chatSessionId="chat_1"
        sandboxStatus="sleeping"
        engineLabel="Codex"
        engineIsRunning={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(screen.getByLabelText("Codex workspace")).toHaveStyle({ width: "440px" });
  });

  it("uses the active engine label for accessibility, previews, and edit warnings", async () => {
    const user = userEvent.setup();
    render(
      <CodingWorkspacePanel
        chatSessionId="chat_claude"
        sandboxStatus="running"
        engineLabel="Claude Code"
        engineIsRunning
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(screen.getByLabelText("Claude Code workspace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => MockWebSocket.instances[0]!.open());
    expect(screen.getByText(/Claude Code is working in this directory/)).toBeInTheDocument();

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
    render(
      <CodingWorkspacePanel
        chatSessionId="chat_1"
        sandboxStatus="sleeping"
        engineLabel="Codex"
        engineIsRunning={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Codex workspace" });
    expect(dialog.style.width).toBe("");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const previewButton = screen.getByRole("button", { name: "Preview" });
    await waitFor(() => expect(previewButton).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Collapse workspace" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    const openButton = await screen.findByRole("button", { name: "Open workspace" });
    expect(openButton).toHaveFocus();
  });

  it("discovers the strongest port, validates manual entry, and handles reconnect state", async () => {
    const user = userEvent.setup();
    render(
      <CodingWorkspacePanel
        chatSessionId="chat_1"
        sandboxStatus="running"
        engineLabel="Codex"
        engineIsRunning={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open preview" }));
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

    act(() => socket.close());
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
