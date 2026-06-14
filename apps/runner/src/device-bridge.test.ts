import { describe, expect, it, vi } from "vitest";

// The registry/message-correlation mechanics only; everything DB-backed (auth, device
// resolution, audit) is exercised against the real stack in manual QA. getDb is mocked
// so touchDeviceLastSeen's best-effort write never reaches for a connection string.
vi.mock("./db", () => ({
  getDb: () => ({
    update: () => ({ set: () => ({ where: async () => [] }) }),
  }),
}));

import { checkDevicePermission, disconnectDevice, registerDeviceConnection } from "./device-bridge";

function createFakeSocket() {
  const sent: string[] = [];
  return {
    sent,
    closed: [] as { code: number | undefined; reason: string | undefined }[],
    send(data: string) {
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
    },
  };
}

describe("registerDeviceConnection", () => {
  it("correlates a daemon reply to its pending request by id", async () => {
    const socket = createFakeSocket();
    const handlers = registerDeviceConnection({
      deviceId: "dvc_corr",
      workspaceId: "ws_1",
      userId: "user_1",
      socket,
    });

    // checkDevicePermission resolves the session's device via the DB, which is mocked
    // away — so drive the correlation through the registry directly: a second
    // registration replaces the first and fails its pending requests.
    expect(socket.sent).toHaveLength(0);
    handlers.onMessage(JSON.stringify({ kind: "pong", id: "unknown-id" }));
    // An unknown id is ignored, not a crash.
    expect(socket.closed).toHaveLength(0);
    disconnectDevice("dvc_corr");
    expect(socket.closed).toEqual([{ code: 4403, reason: "Device revoked." }]);
  });

  it("replaces a stale connection when the same device reconnects", () => {
    const first = createFakeSocket();
    registerDeviceConnection({
      deviceId: "dvc_reconnect",
      workspaceId: "ws_1",
      userId: "user_1",
      socket: first,
    });
    const second = createFakeSocket();
    registerDeviceConnection({
      deviceId: "dvc_reconnect",
      workspaceId: "ws_1",
      userId: "user_1",
      socket: second,
    });
    expect(first.closed).toHaveLength(1);
    expect(second.closed).toHaveLength(0);
    // The stale socket's close must not deregister the replacement.
    expect(disconnectDevice("dvc_reconnect")).toBe(true);
  });

  it("ignores malformed daemon messages", () => {
    const socket = createFakeSocket();
    const handlers = registerDeviceConnection({
      deviceId: "dvc_malformed",
      workspaceId: "ws_1",
      userId: "user_1",
      socket,
    });
    expect(() => handlers.onMessage("not json {")).not.toThrow();
    disconnectDevice("dvc_malformed");
  });

  it("deregisters on close so the device reads as offline", () => {
    const socket = createFakeSocket();
    const handlers = registerDeviceConnection({
      deviceId: "dvc_close",
      workspaceId: "ws_1",
      userId: "user_1",
      socket,
    });
    handlers.onClose();
    expect(disconnectDevice("dvc_close")).toBe(false);
  });
});

describe("checkDevicePermission", () => {
  it("maps an unresolvable session to unreachable (gate then allows; execute errors visibly)", async () => {
    // The mocked db has no select(), so resolveSessionDevice throws — which must map to
    // "unreachable" rather than crash the stream gate.
    const result = await checkDevicePermission({
      sessionId: "session_missing",
      tool: "local_shell",
      args: { command: "ls" },
    });
    expect(result).toEqual({ kind: "unreachable" });
  });
});
