import { randomUUID } from "node:crypto";
import { ApiError, errorResponse } from "./errors";

export type ClosableHttpServer = {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
};

export function closeHttpServer(server: ClosableHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      // Node closes idle connections as part of server.close(), but Bun's node:http
      // compatibility can invoke the callback while old keep-alive sockets still exist.
      // Once active requests have drained, no connection should survive the cutover.
      server.closeAllConnections?.();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    // Close keep-alive sockets as soon as shutdown starts so they cannot submit a
    // fresh request after the service's dependencies have been released.
    server.closeIdleConnections?.();
  });
}

type FetchHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

export function createDrainAwareFetch<Args extends unknown[]>(
  fetch: FetchHandler<Args>,
  shutdownSignal: AbortSignal,
): FetchHandler<Args> {
  return (request, ...args) => {
    if (!shutdownSignal.aborted) return fetch(request, ...args);

    const requestId = `request_${randomUUID()}`;
    const response = errorResponse(
      new ApiError(503, "unavailable", "The service is restarting. Please retry.", true, {
        "Retry-After": "1",
      }),
      requestId,
    );
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Connection", "close");
    response.headers.set("X-Request-Id", requestId);
    return response;
  };
}
