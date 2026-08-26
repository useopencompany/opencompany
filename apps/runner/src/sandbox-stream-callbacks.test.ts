import { describe, expect, it } from "vitest";
import { guardCommandStreamCallbacks, isRetryableCommandStreamError } from "./sandbox";

describe("guardCommandStreamCallbacks", () => {
  it("serializes callback invocations before exposing a captured failure", async () => {
    const order: string[] = [];
    const state: { releaseFirst?: () => void } = {};
    const guarded = guardCommandStreamCallbacks({
      onStdout: async (data: string) => {
        order.push(`start:${data}`);
        if (data === "first") {
          await new Promise<void>((resolve) => {
            state.releaseFirst = resolve;
          });
        }
        order.push(`end:${data}`);
        if (data === "second") throw new Error("callback failed");
      },
    });

    const first = guarded.options.onStdout?.("first");
    const second = guarded.options.onStdout?.("second");
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);

    state.releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await expect(guarded.rethrow()).rejects.toThrow("callback failed");
  });
});

describe("isRetryableCommandStreamError", () => {
  it.each([
    "2: [unknown] The operation timed out.",
    "2: [unknown] The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  ])("recognizes a lost E2B command stream: %s", (message) => {
    const error = new Error(message);
    error.name = "SandboxError";

    expect(isRetryableCommandStreamError(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error("2: [unknown] The socket connection was closed unexpectedly."), {
      name: "Error",
    }),
    Object.assign(new Error("2: [unknown] The command failed."), { name: "SandboxError" }),
  ])("keeps unrelated failures terminal", (error) => {
    expect(isRetryableCommandStreamError(error)).toBe(false);
  });
});
