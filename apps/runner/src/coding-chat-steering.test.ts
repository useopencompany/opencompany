import { describe, expect, it, vi } from "vitest";
import type { AcpSteeringMessage } from "./acp-harness";
import { createProductSteeringChannel, steeringMessageSource } from "./coding-chat-steering";

function message(id: string): AcpSteeringMessage {
  return { id, prompt: [{ type: "text", text: `steer ${id}` }] };
}

async function take(source: AsyncIterable<AcpSteeringMessage>, count: number) {
  const taken: AcpSteeringMessage[] = [];
  for await (const value of source) {
    taken.push(value);
    if (taken.length === count) break;
  }
  return taken;
}

describe("steeringMessageSource", () => {
  const lease = { runId: "run_1", leaseId: "lease_1", leaseOwner: "runner_1" };

  it("yields each promoted message once, in the order the user sent them", async () => {
    // A row stays queued until the adapter confirms the injection, so consecutive polls keep
    // returning a message the harness is still delivering.
    const load = vi
      .fn()
      .mockResolvedValueOnce([message("turn_a")])
      .mockResolvedValueOnce([message("turn_a"), message("turn_b")])
      .mockResolvedValue([]);

    expect(await take(steeringMessageSource({ ...lease, pollIntervalMs: 0, load }), 2)).toEqual([
      message("turn_a"),
      message("turn_b"),
    ]);
  });

  it("does not re-offer a message the adapter already refused", async () => {
    // A refused promotion is left queued on purpose: it runs as the next turn instead. Re-offering
    // it every second would retry an injection the adapter has already rejected.
    const load = vi.fn().mockResolvedValue([message("turn_a"), message("turn_b")]);

    expect(await take(steeringMessageSource({ ...lease, pollIntervalMs: 0, load }), 2)).toEqual([
      message("turn_a"),
      message("turn_b"),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("scopes the poll to the worker holding the run's lease", async () => {
    const load = vi.fn().mockResolvedValue([message("turn_a")]);

    await take(steeringMessageSource({ ...lease, pollIntervalMs: 0, load }), 1);

    expect(load).toHaveBeenCalledWith(expect.objectContaining(lease));
  });

  it("closes immediately while a poll is in flight, so the turn can settle", async () => {
    // Production regression: the harness keeps one `next()` pending for the whole turn. When nobody
    // steers, an async-generator source never yields, so its `return()` queued behind that poll
    // never resolved and every coding turn stayed "running" after the engine had finished.
    const load = vi.fn().mockResolvedValue([]);
    const iterator = steeringMessageSource({ ...lease, pollIntervalMs: 60_000, load })[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();

    const closed = await Promise.race([
      iterator.return?.(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);

    expect(closed).toEqual({ done: true, value: undefined });
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(load).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("stops polling once closed, even if a poll was mid-flight", async () => {
    const loadResolvers: Array<(rows: AcpSteeringMessage[]) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<AcpSteeringMessage[]>((resolve) => {
          loadResolvers.push(resolve);
        }),
    );
    const iterator = steeringMessageSource({ ...lease, pollIntervalMs: 0, load })[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await iterator.return?.();
    loadResolvers[0]?.([message("turn_late")]);

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("createProductSteeringChannel", () => {
  const lease = { runId: "run_1", leaseId: "lease_1", leaseOwner: "runner_1" };

  it("settles each promoted message once and reports it to the transcript", async () => {
    // A promotion stays queued until it is taken, so the row is still there on the next poll.
    const load = vi.fn().mockResolvedValue([message("turn_a"), message("turn_b")]);
    const settle = vi.fn().mockResolvedValue(undefined);
    const steered: { id: string; text: string }[] = [];
    const channel = createProductSteeringChannel({
      ...lease,
      load,
      settle,
      onSteered: (steeredMessage) => steered.push(steeredMessage),
    });

    expect(await channel.take()).toEqual(["steer turn_a", "steer turn_b"]);
    expect(await channel.take()).toEqual([]);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ steeredRunId: "turn_a", ...lease }),
    );
    expect(steered).toEqual([
      { id: "turn_a", text: "steer turn_a" },
      { id: "turn_b", text: "steer turn_b" },
    ]);
  });

  it("keeps the running turn alive when the steering poll fails", async () => {
    // The turn this rides on has already produced work. A failed poll leaves the promotion queued,
    // so the message runs as the next turn instead of taking the turn down with it.
    const load = vi.fn().mockRejectedValue(new Error("connection terminated"));
    const channel = createProductSteeringChannel({
      ...lease,
      load,
      settle: vi.fn(),
      onSteered: () => {},
    });

    await expect(channel.take()).resolves.toEqual([]);
  });

  it("keeps messages it already took when a later settlement fails", async () => {
    const load = vi.fn().mockResolvedValue([message("turn_a"), message("turn_b")]);
    const settle = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("lease lost"));
    const channel = createProductSteeringChannel({ ...lease, load, settle, onSteered: () => {} });

    expect(await channel.take()).toEqual(["steer turn_a"]);
  });

  it("ignores a promoted message with nothing in it", async () => {
    const load = vi
      .fn()
      .mockResolvedValue([{ id: "turn_a", prompt: [{ type: "text", text: "  " }] }]);
    const settle = vi.fn().mockResolvedValue(undefined);
    const channel = createProductSteeringChannel({ ...lease, load, settle, onSteered: () => {} });

    expect(await channel.take()).toEqual([]);
    expect(settle).not.toHaveBeenCalled();
  });
});
