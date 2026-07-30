import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodingWorkspaceTerminal from "./CodingWorkspaceTerminal";

const mocks = vi.hoisted(() => ({
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

    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    dispose = vi.fn();

    open(container: HTMLElement) {
      this.textarea = document.createElement("textarea");
      container.append(this.textarea);
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
    vi.unstubAllGlobals();
  });

  it("prevents password managers from autofilling the terminal input", async () => {
    const socket = new MockWebSocket();

    render(<CodingWorkspaceTerminal socket={socket as unknown as WebSocket} />);

    await waitFor(() => expect(mocks.terminalTextareas).toHaveLength(1));
    expect(mocks.terminalTextareas[0]).toHaveAttribute("autocomplete", "off");
  });
});
