import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexWorkspacePanel } from "./CodexWorkspacePanel";

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

describe("CodexWorkspacePanel", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
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

  it("shows status without waking until the user chooses a workspace tab", async () => {
    const user = userEvent.setup();
    render(
      <CodexWorkspacePanel
        chatSessionId="chat_1"
        sandboxStatus="sleeping"
        codexIsRunning={false}
      />,
    );

    expect(screen.getByText("Workspace is sleeping")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Preview/ }));
    expect(fetch).toHaveBeenCalledWith("/api/codex-chat/sessions/chat_1/runtime-access", {
      method: "POST",
    });
  });

  it("discovers the strongest port, validates manual entry, and handles reconnect state", async () => {
    const user = userEvent.setup();
    render(
      <CodexWorkspacePanel chatSessionId="chat_1" sandboxStatus="running" codexIsRunning={false} />,
    );
    await user.click(screen.getByRole("button", { name: /Preview/ }));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;

    act(() => socket.open());
    expect(socket.protocols).toEqual(["goat-codex-runtime-v1", "goat-ticket.signed-ticket"]);
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
