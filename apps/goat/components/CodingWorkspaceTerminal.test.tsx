import "@testing-library/jest-dom/vitest";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodingWorkspaceTerminal from "./CodingWorkspaceTerminal";

const mocks = vi.hoisted(() => ({
  terminals: [] as Array<{ emitData: (data: string) => void }>,
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

    loadAddon = vi.fn();
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    });
    write = vi.fn();
    dispose = vi.fn();

    open(container: HTMLElement) {
      this.textarea = document.createElement("textarea");
      container.append(this.textarea);
      mocks.terminals.push({ emitData: (data: string) => this.dataHandler?.(data) });
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

  it("batches terminal input into one websocket frame within a sub-frame window", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminals).toHaveLength(1));
    vi.useFakeTimers();
    mocks.terminals[0]!.emitData("g");
    mocks.terminals[0]!.emitData("i");
    mocks.terminals[0]!.emitData("t");
    expect(inputFrames(socket)).toEqual([]);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(inputFrames(socket).map((frame) => new TextDecoder().decode(frame))).toEqual(["git"]);
  });
});

function inputFrames(socket: MockWebSocket): Uint8Array[] {
  return socket.send.mock.calls
    .map(([data]) => data)
    .filter((data): data is ArrayBufferView => ArrayBuffer.isView(data))
    .map((data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}
