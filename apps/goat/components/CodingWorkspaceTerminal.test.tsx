import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodingWorkspaceTerminal from "./CodingWorkspaceTerminal";

const mocks = vi.hoisted(() => ({
  terminals: [] as Array<{
    emitData: (data: string) => void;
    writes: Array<string | Uint8Array>;
  }>,
  terminalTextareas: [] as HTMLTextAreaElement[],
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    textarea: HTMLTextAreaElement | undefined;
    dataHandler: ((data: string) => void) | undefined;
    writes: Array<string | Uint8Array> = [];

    loadAddon = vi.fn();
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    });
    write = vi.fn((data: string | Uint8Array) => this.writes.push(data));
    dispose = vi.fn();

    open(container: HTMLElement) {
      this.textarea = document.createElement("textarea");
      container.append(this.textarea);
      mocks.terminals.push({
        emitData: (data: string) => this.dataHandler?.(data),
        writes: this.writes,
      });
      mocks.terminalTextareas.push(this.textarea);
    }
  },
}));

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;

  readyState = MockWebSocket.OPEN;
  send = vi.fn();
}

describe("CodingWorkspaceTerminal", () => {
  beforeEach(() => {
    mocks.terminals = [];
    mocks.terminalTextareas = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prevents text helpers and password managers from hooking the terminal input", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminalTextareas).toHaveLength(1));
    const textarea = mocks.terminalTextareas[0]!;
    expect(textarea).toHaveAttribute("autocomplete", "off");
    expect(textarea).toHaveAttribute("autocorrect", "off");
    expect(textarea).toHaveAttribute("autocapitalize", "off");
    expect(textarea).toHaveAttribute("spellcheck", "false");
    expect(textarea).toHaveAttribute("data-1p-ignore", "true");
    expect(textarea).toHaveAttribute("data-lpignore", "true");
  });

  it("sends terminal input and renders simple local echo immediately", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminals).toHaveLength(1));
    mocks.terminals[0]!.emitData("g");

    expect(inputFrames(socket).map((frame) => new TextDecoder().decode(frame))).toEqual(["g"]);
    expect(writesAsText(mocks.terminals[0]!.writes)).toEqual(["g"]);
  });

  it("suppresses matching remote echo while preserving command output", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminals).toHaveLength(1));
    mocks.terminals[0]!.emitData("git\r");
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: new TextEncoder().encode("git\r\nOn branch main\r\n"),
      }),
    );

    expect(writesAsText(mocks.terminals[0]!.writes)).toEqual(["git\r\n", "On branch main\r\n"]);
  });

  it("does not hide mismatched remote output", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminals).toHaveLength(1));
    mocks.terminals[0]!.emitData("x");
    socket.dispatchEvent(new MessageEvent("message", { data: new TextEncoder().encode("y") }));

    expect(writesAsText(mocks.terminals[0]!.writes)).toEqual(["x", "y"]);
  });

  it("does not locally echo input at sensitive prompts", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminals).toHaveLength(1));
    socket.dispatchEvent(
      new MessageEvent("message", { data: new TextEncoder().encode("Enter pass") }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: new TextEncoder().encode("phrase for key '/tmp/key': "),
      }),
    );
    mocks.terminals[0]!.emitData("secret");

    expect(inputFrames(socket).map((frame) => new TextDecoder().decode(frame))).toContain("secret");
    expect(writesAsText(mocks.terminals[0]!.writes)).toEqual([
      "Enter pass",
      "phrase for key '/tmp/key': ",
    ]);
  });
});

function inputFrames(socket: MockWebSocket): Uint8Array[] {
  return socket.send.mock.calls
    .map(([data]) => data)
    .filter((data): data is ArrayBufferView => ArrayBuffer.isView(data))
    .map((data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

function writesAsText(writes: Array<string | Uint8Array>) {
  return writes.map((data) => (typeof data === "string" ? data : new TextDecoder().decode(data)));
}
