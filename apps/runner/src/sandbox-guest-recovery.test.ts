import { Sandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSandbox, createOrConnectSandbox } from "./sandbox";

afterEach(() => {
  vi.restoreAllMocks();
});

function timeoutError(message = "[deadline_exceeded] the operation timed out") {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function fakeSandbox(sandboxId: string, run: () => Promise<unknown>) {
  return {
    sandboxId,
    commands: { run: vi.fn(run) },
    setTimeout: vi.fn(async () => {}),
  } as never;
}

describe("connectSandbox guest recovery", () => {
  it("returns the connected sandbox when the guest answers the probe", async () => {
    const sandbox = fakeSandbox("sbx_healthy", async () => ({ exitCode: 0 }));
    const connect = vi.spyOn(Sandbox, "connect").mockResolvedValue(sandbox);
    const getInfo = vi.spyOn(Sandbox, "getInfo");

    const result = await connectSandbox({
      sandboxId: "sbx_healthy",
      recoverUnresponsiveGuest: true,
    });

    expect(result).toBe(sandbox);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[1]).not.toHaveProperty("onResume");
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("skips the probe entirely when recovery is not requested", async () => {
    const sandbox = fakeSandbox("sbx_side_channel", async () => ({ exitCode: 0 }));
    vi.spyOn(Sandbox, "connect").mockResolvedValue(sandbox);

    const result = await connectSandbox({ sandboxId: "sbx_side_channel" });

    expect(result).toBe(sandbox);
    expect((result as { commands: { run: unknown } }).commands.run).not.toHaveBeenCalled();
  });

  it("reboots a wedged paused sandbox from disk state without pausing again", async () => {
    const wedged = fakeSandbox("sbx_wedged", async () => {
      throw timeoutError();
    });
    const rebooted = fakeSandbox("sbx_wedged", async () => ({ exitCode: 0 }));
    const connect = vi
      .spyOn(Sandbox, "connect")
      .mockResolvedValueOnce(wedged)
      .mockResolvedValueOnce(rebooted);
    vi.spyOn(Sandbox, "getInfo").mockResolvedValue({ state: "paused" } as never);
    const pause = vi.spyOn(Sandbox, "pause").mockResolvedValue(true as never);

    const result = await connectSandbox({
      sandboxId: "sbx_wedged",
      recoverUnresponsiveGuest: true,
    });

    expect(result).toBe(rebooted);
    expect(pause).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[1]).toMatchObject({ onResume: "reboot" });
  });

  it("pauses a wedged sandbox stuck in running state before rebooting", async () => {
    const wedged = fakeSandbox("sbx_stuck_running", async () => {
      throw timeoutError();
    });
    const rebooted = fakeSandbox("sbx_stuck_running", async () => ({ exitCode: 0 }));
    vi.spyOn(Sandbox, "connect").mockResolvedValueOnce(wedged).mockResolvedValueOnce(rebooted);
    vi.spyOn(Sandbox, "getInfo").mockResolvedValue({ state: "running" } as never);
    const pause = vi.spyOn(Sandbox, "pause").mockResolvedValue(true as never);

    const result = await connectSandbox({
      sandboxId: "sbx_stuck_running",
      recoverUnresponsiveGuest: true,
    });

    expect(result).toBe(rebooted);
    expect(pause).toHaveBeenCalledWith("sbx_stuck_running", expect.anything());
  });

  it("returns null when the guest stays dead after the reboot", async () => {
    const deadProbe = async () => {
      throw timeoutError();
    };
    vi.spyOn(Sandbox, "connect")
      .mockResolvedValueOnce(fakeSandbox("sbx_dead", deadProbe))
      .mockResolvedValueOnce(fakeSandbox("sbx_dead", deadProbe));
    vi.spyOn(Sandbox, "getInfo").mockResolvedValue({ state: "paused" } as never);
    const observations: unknown[] = [];

    const result = await connectSandbox({
      sandboxId: "sbx_dead",
      recoverUnresponsiveGuest: true,
      onLatency: (observation) => {
        observations.push(observation);
      },
    });

    expect(result).toBeNull();
    expect(observations).toMatchObject([{ operation: "connect", outcome: "unresponsive" }]);
  });

  it("rethrows capacity errors from the reboot connect so the turn retry budget applies", async () => {
    const placement = new Error(
      "504: Failed to place sandbox: placement timed out after 2 attempt(s), please retry",
    );
    placement.name = "SandboxError";
    vi.spyOn(Sandbox, "connect")
      .mockResolvedValueOnce(
        fakeSandbox("sbx_capacity", async () => {
          throw timeoutError();
        }),
      )
      .mockRejectedValueOnce(placement);
    vi.spyOn(Sandbox, "getInfo").mockResolvedValue({ state: "paused" } as never);

    await expect(
      connectSandbox({ sandboxId: "sbx_capacity", recoverUnresponsiveGuest: true }),
    ).rejects.toBe(placement);
  });

  it("rethrows non-timeout probe failures instead of rebooting", async () => {
    const crash = new Error("envd exploded");
    vi.spyOn(Sandbox, "connect").mockResolvedValue(
      fakeSandbox("sbx_crash", async () => {
        throw crash;
      }),
    );
    const getInfo = vi.spyOn(Sandbox, "getInfo");

    await expect(
      connectSandbox({ sandboxId: "sbx_crash", recoverUnresponsiveGuest: true }),
    ).rejects.toBe(crash);
    expect(getInfo).not.toHaveBeenCalled();
  });
});

describe("createOrConnectSandbox", () => {
  it("provisions a replacement when the pinned sandbox is unrecoverable", async () => {
    const deadProbe = async () => {
      throw timeoutError();
    };
    vi.spyOn(Sandbox, "connect")
      .mockResolvedValueOnce(fakeSandbox("sbx_pinned", deadProbe))
      .mockResolvedValueOnce(fakeSandbox("sbx_pinned", deadProbe));
    vi.spyOn(Sandbox, "getInfo").mockResolvedValue({ state: "paused" } as never);
    const replacement = fakeSandbox("sbx_replacement", async () => ({ exitCode: 0 }));
    const create = vi.spyOn(Sandbox, "create").mockResolvedValue(replacement);

    const result = await createOrConnectSandbox({
      sandboxId: "sbx_pinned",
      template: "codex",
      envs: {},
      idleTimeoutMs: 60_000,
    });

    expect(result).toBe(replacement);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
