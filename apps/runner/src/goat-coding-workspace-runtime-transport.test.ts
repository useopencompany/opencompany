import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { RunnerEnv } from "./env";
import type { GoatCodingWorkspaceSession } from "./goat-coding-workspace-runtime";
import {
  attachRuntimeConnection,
  forwardPreviewWebSocketMessages,
  isGoatCodingWorkspaceOriginAllowed,
  RUNTIME_TOOLS_INSTALL_COMMAND,
  rewritePreviewResponseHeaders,
} from "./goat-coding-workspace-runtime-transport";
import type { SandboxHandle } from "./sandbox";

const openServers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe("Goat coding workspace origin validation", () => {
  it("requires an exact configured browser origin", () => {
    const allowed = ["https://goat.example.com"];
    expect(isGoatCodingWorkspaceOriginAllowed("https://goat.example.com", allowed)).toBe(true);
    expect(isGoatCodingWorkspaceOriginAllowed("https://evil.example.com", allowed)).toBe(false);
    expect(isGoatCodingWorkspaceOriginAllowed(undefined, allowed)).toBe(false);
  });
});

describe("Goat coding workspace preview response headers", () => {
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

describe("Goat coding workspace preview WebSocket transport", () => {
  it("buffers downstream messages until the upstream connection opens", () => {
    const downstream = new EventEmitter() as unknown as WebSocket & EventEmitter;
    const upstream = new EventEmitter() as unknown as WebSocket & EventEmitter;
    Object.defineProperty(upstream, "readyState", {
      configurable: true,
      value: WebSocket.CONNECTING,
    });
    upstream.send = vi.fn();
    const onOverflow = vi.fn();
    const stop = forwardPreviewWebSocketMessages(downstream, upstream, onOverflow);

    downstream.emit("message", Buffer.from("subscribe"), false);
    expect(upstream.send).not.toHaveBeenCalled();

    Object.defineProperty(upstream, "readyState", { value: WebSocket.OPEN });
    upstream.emit("open");
    expect(upstream.send).toHaveBeenCalledWith(Buffer.from("subscribe"), { binary: false });
    expect(onOverflow).not.toHaveBeenCalled();

    stop();
  });

  it("closes the bridge when buffered messages exceed the safety limit", () => {
    const downstream = new EventEmitter() as unknown as WebSocket & EventEmitter;
    const upstream = new EventEmitter() as unknown as WebSocket & EventEmitter;
    Object.defineProperty(upstream, "readyState", { value: WebSocket.CONNECTING });
    upstream.send = vi.fn();
    const onOverflow = vi.fn();
    const stop = forwardPreviewWebSocketMessages(downstream, upstream, onOverflow, 4);

    downstream.emit("message", Buffer.from("12345"), true);
    expect(onOverflow).toHaveBeenCalledOnce();
    expect(upstream.send).not.toHaveBeenCalled();

    stop();
  });
});

describe("Goat coding workspace terminal transport", () => {
  it.each([
    ["codex", "/home/user/opencompany-goat/codex-chat"],
    ["claude_code", "/home/user/opencompany-goat/claude-chat"],
  ] as const)("opens %s terminals in the trusted engine directory", async (engine, expectedWorkDirectory) => {
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
          engine,
        } satisfies GoatCodingWorkspaceSession,
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
    client.send(Buffer.from("pwd\r"));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cols: 100,
        rows: 30,
        cwd: expectedWorkDirectory,
        user: "user",
      }),
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(`mkdir -p '${expectedWorkDirectory}'`, {
      user: "user",
      timeoutMs: 10_000,
    });
    expect(binaryOutput.join("")).toContain("persisted output");
    expect(binaryOutput.join("")).toContain("live output");
    expect(sendInput).toHaveBeenCalledWith(
      42,
      Buffer.from("exec tmux new-session -A -s goat-coding-workspace\r"),
    );
    expect(sendInput).toHaveBeenCalledWith(42, Buffer.from("pwd\r"));

    client.send(JSON.stringify({ type: "terminal.attach", cols: 110, rows: 35 }));
    await vi.waitFor(() => expect(sandbox.commands.run).toHaveBeenCalledTimes(3));
    expect(create).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(42, { cols: 110, rows: 35 });

    client.send(JSON.stringify({ type: "terminal.resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(42, { cols: 120, rows: 40 }));

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

describe("Goat coding workspace terminal input latency", () => {
  it("coalesces keystrokes and never queues input behind control operations", async () => {
    const kill = vi.fn(async () => true);
    // Keyed by keystroke content so the assertions never depend on call ordering
    // relative to the tmux bootstrap write (which is CI-timing sensitive).
    const keystrokes: string[] = [];
    let releaseTypedA: () => void = () => {};
    const typedAHeld = new Promise<void>((resolve) => {
      releaseTypedA = resolve;
    });
    const sendInput = vi.fn(async (_pid: number, data: Uint8Array) => {
      const text = Buffer.from(data).toString();
      if (text.includes("tmux new-session")) return; // bootstrap write, not a keystroke
      keystrokes.push(text);
      // Hold the "a" RPC open so "b"/"c" typed meanwhile must coalesce into one call.
      if (text === "a") await typedAHeld;
    });
    const create = vi.fn(async () => ({ pid: 42, kill }));
    let releasePortScan: () => void = () => {};
    const portScanReached = new Promise<void>((resolve) => {
      releasePortScan = resolve;
    });
    const run = vi.fn((command: string) => {
      // The ports.refresh scan blocks until released; typing must not wait behind it.
      if (command.startsWith("ss ")) {
        releasePortScan();
        return new Promise(() => {});
      }
      return Promise.resolve({ stdout: "" });
    });
    const sandbox = {
      sandboxId: "sandbox_1",
      commands: { run },
      pty: { create, sendInput, resize: vi.fn(async () => undefined) },
      setTimeout: vi.fn(async () => undefined),
    } as unknown as SandboxHandle;
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
          engine: "codex",
        } satisfies GoatCodingWorkspaceSession,
        { goatCodexChatIdleTimeoutMs: 300_000 } as RunnerEnv,
        vi.fn(async () => undefined),
      );
    });

    const address = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve) => client.once("open", resolve));
    client.send(JSON.stringify({ type: "terminal.attach", cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    // Kick off a control op that blocks in the sandbox, then type immediately.
    client.send(JSON.stringify({ type: "ports.refresh" }));
    await portScanReached;
    client.send(Buffer.from("a"));
    // "a" is delivered even though the port scan is still blocked in the control queue.
    await vi.waitFor(() => expect(keystrokes).toEqual(["a"]));

    // Both arrive while the "a" RPC is still in flight, so they coalesce into one call.
    // Wait for each frame's write to complete before releasing "a", so the server has
    // buffered both keystrokes by the time the in-flight RPC resolves and flushes.
    await new Promise<void>((resolve, reject) =>
      client.send(Buffer.from("b"), (error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      client.send(Buffer.from("c"), (error) => (error ? reject(error) : resolve())),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(keystrokes).toEqual(["a"]);
    releaseTypedA();
    await vi.waitFor(() => expect(keystrokes).toEqual(["a", "bc"]));

    client.close();
  });
});

describe("Goat coding workspace runtime tools install command", () => {
  // Regression: a missing `;` after `fi` made this command a bash syntax error, so every
  // runtime connection failed before the install could run (issue behind the prod
  // "Workspace unavailable" panel).
  it("is valid bash syntax", () => {
    const result = spawnSync("bash", ["-n", "-c", RUNTIME_TOOLS_INSTALL_COMMAND]);
    expect(result.stderr.toString()).toBe("");
    expect(result.status).toBe(0);
  });
});
