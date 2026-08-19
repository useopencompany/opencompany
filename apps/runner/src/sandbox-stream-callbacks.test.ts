import { describe, expect, it } from "vitest";
import { guardCommandStreamCallbacks } from "./sandbox";

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
