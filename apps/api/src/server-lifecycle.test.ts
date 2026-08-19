import { describe, expect, it, vi } from "vitest";
import { type ClosableHttpServer, closeHttpServer } from "./server-lifecycle";

describe("closeHttpServer", () => {
  it("waits for the HTTP server to drain", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server: ClosableHttpServer = {
      close: vi.fn((callback) => {
        finishClose = callback;
      }),
    };

    let drained = false;
    const closing = closeHttpServer(server).then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    finishClose?.();
    await closing;
    expect(drained).toBe(true);
  });

  it("surfaces HTTP close failures", async () => {
    const failure = new Error("close failed");
    const server: ClosableHttpServer = {
      close(callback) {
        callback(failure);
      },
    };

    await expect(closeHttpServer(server)).rejects.toBe(failure);
  });
});
