"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

export default function CodingWorkspaceTerminal({ socket }: { socket: WebSocket }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#11130f",
        foreground: "#e4e7dd",
        cursor: "#b7f264",
        selectionBackground: "#52623a",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const sendSize = (type: "terminal.attach" | "terminal.resize") => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type, cols: terminal.cols, rows: terminal.rows }));
    };
    const fit = () => {
      try {
        fitAddon.fit();
        sendSize("terminal.resize");
      } catch {
        // The panel may be between layout states; the ResizeObserver will retry.
      }
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    fit();
    const onMessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((data) => terminal.write(new Uint8Array(data)));
      }
    };
    socket.addEventListener("message", onMessage);
    const encoder = new TextEncoder();
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    sendSize("terminal.attach");

    return () => {
      socket.removeEventListener("message", onMessage);
      resizeObserver.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [socket]);

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden p-2" />;
}
