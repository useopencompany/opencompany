import { describe, expect, it, vi } from "vitest";
import type { AcpSteeringMessage } from "./acp-harness";
import { steeringMessageSource } from "./coding-chat-steering";

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
});
