"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

const MAX_LOCAL_ECHO_INPUT_CHARS = 256;
const MAX_PENDING_LOCAL_ECHO_BYTES = 64 * 1_024;

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
    const encoder = new TextEncoder();
    let pendingLocalEcho: Uint8Array[] = [];
    let pendingLocalEchoBytes = 0;
    let localEchoColumns = 0;
    let appendOnlyLocalEcho = true;
    let alternateScreenActive = false;
    let sensitivePromptActive = false;
    let remoteLineTail = "";

    const appendPendingLocalEcho = (data: string) => {
      if (!data) return;
      const encoded = encoder.encode(data);
      if (pendingLocalEchoBytes + encoded.byteLength > MAX_PENDING_LOCAL_ECHO_BYTES) {
        pendingLocalEcho = [];
        pendingLocalEchoBytes = 0;
        return;
      }
      pendingLocalEcho.push(encoded);
      pendingLocalEchoBytes += encoded.byteLength;
    };

    const stripPendingLocalEcho = (data: Uint8Array) => {
      if (pendingLocalEchoBytes === 0) return data;

      const expected = new Uint8Array(pendingLocalEchoBytes);
      let offset = 0;
      for (const chunk of pendingLocalEcho) {
        expected.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const compareLength = Math.min(data.byteLength, expected.byteLength);
      for (let index = 0; index < compareLength; index += 1) {
        if (data[index] !== expected[index]) {
          pendingLocalEcho = [];
          pendingLocalEchoBytes = 0;
          return data;
        }
      }

      if (data.byteLength <= expected.byteLength) {
        const remaining = expected.slice(data.byteLength);
        pendingLocalEcho = remaining.byteLength > 0 ? [remaining] : [];
        pendingLocalEchoBytes = remaining.byteLength;
        return null;
      }

      pendingLocalEcho = [];
      pendingLocalEchoBytes = 0;
      return data.slice(expected.byteLength);
    };

    const localEchoForInput = (data: string) => {
      if (sensitivePromptActive) {
        if (data.includes("\r") || data.includes("\n")) sensitivePromptActive = false;
        return null;
      }
      if (alternateScreenActive || data.length > MAX_LOCAL_ECHO_INPUT_CHARS) return null;

      let echo = "";
      for (const character of data) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === "\r" || character === "\n") {
          echo += "\r\n";
          localEchoColumns = 0;
          appendOnlyLocalEcho = true;
        } else if (character === "\u007f" || character === "\b") {
          if (!appendOnlyLocalEcho) return null;
          if (localEchoColumns > 0) {
            echo += "\b \b";
            localEchoColumns -= 1;
          }
        } else if (character === "\t" || codePoint < 0x20 || codePoint === 0x7f) {
          appendOnlyLocalEcho = false;
          return null;
        } else {
          if (!appendOnlyLocalEcho) return null;
          echo += character;
          localEchoColumns += 1;
        }
      }
      return echo;
    };

    const writeRemoteData = (data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      remoteLineTail = trailingTerminalLine(`${remoteLineTail}${text}`);
      sensitivePromptActive = isSensitiveTerminalPrompt(remoteLineTail);
      if (text.includes("\x1b[?1049h")) alternateScreenActive = true;
      if (text.includes("\x1b[?1049l")) {
        alternateScreenActive = false;
        appendOnlyLocalEcho = true;
        localEchoColumns = 0;
      }

      const filtered = stripPendingLocalEcho(data);
      if (filtered && filtered.byteLength > 0) terminal.write(filtered);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        writeRemoteData(new Uint8Array(event.data));
      } else if (ArrayBuffer.isView(event.data)) {
        writeRemoteData(
          new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
        );
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((data) => writeRemoteData(new Uint8Array(data)));
      }
    };
    socket.addEventListener("message", onMessage);

    const input = terminal.onData((data) => {
      const localEcho = localEchoForInput(data);
      if (localEcho) {
        terminal.write(localEcho);
        appendPendingLocalEcho(localEcho);
      }
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

function isSensitiveTerminalPrompt(text: string) {
  return /\b(password|passphrase|secret|token|api\s*key|otp|verification code)\b.*[:?]\s*$/i.test(
    text,
  );
}

function trailingTerminalLine(text: string) {
  return text.split(/\r?\n/).at(-1)?.slice(-256) ?? "";
}
