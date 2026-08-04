"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

const TERMINAL_INPUT_BATCH_MS = 8;
const MAX_BATCHED_TERMINAL_INPUT_CHARS = 8_192;

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
    // xterm leaves this unspecified, which lets password managers mistake its hidden input for a
    // credential field and offer to fill secrets into the shell.
    terminal.textarea?.setAttribute("autocomplete", "off");
    terminal.textarea?.setAttribute("autocorrect", "off");
    terminal.textarea?.setAttribute("autocapitalize", "off");
    terminal.textarea?.setAttribute("spellcheck", "false");
    terminal.textarea?.setAttribute("data-1p-ignore", "true");
    terminal.textarea?.setAttribute("data-lpignore", "true");

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
    let pendingInput = "";
    let inputFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushInput = () => {
      if (inputFlushTimer !== null) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = null;
      }
      if (!pendingInput) return;
      const data = pendingInput;
      pendingInput = "";
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    };
    const scheduleInputFlush = () => {
      if (inputFlushTimer !== null) return;
      inputFlushTimer = setTimeout(flushInput, TERMINAL_INPUT_BATCH_MS);
    };
    const input = terminal.onData((data) => {
      pendingInput += data;
      if (pendingInput.length >= MAX_BATCHED_TERMINAL_INPUT_CHARS) {
        flushInput();
      } else {
        scheduleInputFlush();
      }
    });
    sendSize("terminal.attach");

    return () => {
      flushInput();
      socket.removeEventListener("message", onMessage);
      resizeObserver.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [socket]);

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden p-2" />;
}
