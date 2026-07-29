import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { RunnerEnv } from "./env";
import type { GoatCodexRuntimeSession } from "./goat-codex-runtime";
import {
  attachRuntimeConnection,
  isGoatCodexRuntimeOriginAllowed,
  rewritePreviewResponseHeaders,
} from "./goat-codex-runtime-transport";
import type { SandboxHandle } from "./sandbox";

const openServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("Goat Codex runtime origin validation", () => {
  it("requires an exact configured browser origin", () => {
    const allowed = ["https://goat.example.com"];
    expect(isGoatCodexRuntimeOriginAllowed("https://goat.example.com", allowed)).toBe(true);
    expect(isGoatCodexRuntimeOriginAllowed("https://evil.example.com", allowed)).toBe(false);
    expect(isGoatCodexRuntimeOriginAllowed(undefined, allowed)).toBe(false);
  });
});

describe("Goat Codex preview response headers", () => {
  it("rewrites upstream authority, cookie domains, and framing policy", () => {
    const headers = rewritePreviewResponseHeaders(
      {
        location: "https://3000-sandbox.e2b.app/dashboard",
        "set-cookie": ["session=abc; Domain=3000-sandbox.e2b.app; Path=/; HttpOnly"],
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      },
      "3000-sandbox.e2b.app",
      "signed.preview.goat.example.com",
      ["https://goat.example.com"],
      "https",
      3_000,
    );

    expect(headers.location).toBe("https://signed.preview.goat.example.com/dashboard");
    expect(headers["set-cookie"]).toEqual(["session=abc; Path=/; HttpOnly"]);
    expect(headers["x-frame-options"]).toBeUndefined();
    expect(headers["content-security-policy"]).toBe(
      "default-src 'self'; frame-ancestors https://goat.example.com",
    );
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });

  it("rewrites selected loopback redirects but leaves external redirects alone", () => {
    const loopback = rewritePreviewResponseHeaders(
      { location: "http://localhost:3000/login" },
      "3000-sandbox.e2b.app",
      "signed.preview.goat.example.com",
      ["https://goat.example.com"],
      "https",
      3_000,
    );
    const external = rewritePreviewResponseHeaders(
      { location: "https://accounts.example.com/login" },
      "3000-sandbox.e2b.app",
      "signed.preview.goat.example.com",
      ["https://goat.example.com"],
      "https",
      3_000,
    );

    expect(loopback.location).toBe("https://signed.preview.goat.example.com/login");
    expect(external.location).toBe("https://accounts.example.com/login");
  });
});

describe("Goat Codex terminal transport", () => {
  it("restores tmux scrollback and forwards binary input, output, and resize", async () => {
    const kill = vi.fn(async () => true);
    const sendInput = vi.fn(async () => undefined);
    const resize = vi.fn(async () => undefined);
    const create = vi.fn(async (options: { onData: (data: Uint8Array) => void }) => {
      options.onData(Buffer.from("live output\n"));
      return { pid: 42, kill };
    });
    const sandbox = {
      sandboxId: "sandbox_1",
      commands: {
        run: vi.fn(async () => ({ stdout: "persisted output\n" })),
      },
      pty: { create, sendInput, resize },
      setTimeout: vi.fn(async () => undefined),
    } as unknown as SandboxHandle;
    const restoreTimeout = vi.fn(async () => undefined);
    const server = new WebSocketServer({ port: 0 });
    openServers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (webSocket) => {
      attachRuntimeConnection(
        webSocket,
        sandbox,
        {
          id: "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
          chatSessionId: "chat_1",
          userWorkosId: "user_1",
          sandboxId: "sandbox_1",
          status: "idle",
        } satisfies GoatCodexRuntimeSession,
        { goatCodexChatIdleTimeoutMs: 300_000 } as RunnerEnv,
        restoreTimeout,
      );
    });

    const address = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const binaryOutput: string[] = [];
    client.on("message", (data, binary) => {
      if (binary) binaryOutput.push(data.toString());
    });
    await new Promise<void>((resolve) => client.once("open", resolve));

    client.send(JSON.stringify({ type: "terminal.attach", cols: 100, rows: 30 }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 100, rows: 30, user: "user" }),
    );
    expect(binaryOutput.join("")).toContain("persisted output");
    expect(binaryOutput.join("")).toContain("live output");
    expect(sendInput).toHaveBeenCalledWith(
      42,
      Buffer.from("exec tmux new-session -A -s goat-codex\r"),
    );

    client.send(JSON.stringify({ type: "terminal.attach", cols: 110, rows: 35 }));
    await vi.waitFor(() => expect(sandbox.commands.run).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(42, { cols: 110, rows: 35 });

    client.send(Buffer.from("pwd\r"));
    client.send(JSON.stringify({ type: "terminal.resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(42, { cols: 120, rows: 40 }));
    expect(sendInput).toHaveBeenCalledWith(42, new Uint8Array(Buffer.from("pwd\r")));

    client.close();
    await new Promise<void>((resolve) => client.once("close", resolve));
    await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
    expect(restoreTimeout).toHaveBeenCalledWith(
      "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000",
      sandbox,
      300_000,
    );
  });
});
