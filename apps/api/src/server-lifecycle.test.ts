import { describe, expect, it, vi } from "vitest";
import {
  type ClosableHttpServer,
  closeHttpServer,
  createDrainAwareFetch,
} from "./server-lifecycle";

describe("closeHttpServer", () => {
  it("waits for the HTTP server to drain", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const server: ClosableHttpServer = {
      close: vi.fn((callback) => {
        finishClose = callback;
      }),
      closeAllConnections: vi.fn(),
      closeIdleConnections: vi.fn(),
    };

    let drained = false;
    const closing = closeHttpServer(server).then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    finishClose?.();
    await closing;
    expect(drained).toBe(true);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
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

  it("rejects late requests before they reach application dependencies", async () => {
    const shutdown = new AbortController();
    const fetch = vi.fn(async () => new Response("ok"));
    const drainAwareFetch = createDrainAwareFetch(fetch, shutdown.signal);

    const liveResponse = await drainAwareFetch(new Request("https://api.example.test/healthz"));
    expect(liveResponse.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();

    shutdown.abort();
    const drainingResponse = await drainAwareFetch(
      new Request("https://api.example.test/v1/billing/balance"),
    );

    expect(drainingResponse.status).toBe(503);
    expect(drainingResponse.headers.get("cache-control")).toBe("no-store");
    expect(drainingResponse.headers.get("connection")).toBe("close");
    expect(drainingResponse.headers.get("retry-after")).toBe("1");
    expect(drainingResponse.headers.get("x-request-id")).toMatch(/^request_[0-9a-f-]+$/u);
    await expect(drainingResponse.json()).resolves.toMatchObject({
      error: {
        code: "unavailable",
        message: "The service is restarting. Please retry.",
        retryable: true,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
