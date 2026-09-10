import { Sandbox, SandboxNotFoundError } from "e2b";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrConnectSandbox, killSandbox, type SandboxHandle } from "./sandbox";
import { registerSandboxBilling } from "./sandbox-billing";
import { billSandboxBeforeTransition } from "./sandbox-billing-worker";

vi.mock("./sandbox-billing", () => ({ registerSandboxBilling: vi.fn(async () => undefined) }));
vi.mock("./sandbox-billing-worker", () => ({
  billSandboxBeforeTransition: vi.fn(async () => undefined),
}));

const billingOwner = { namespace: "test", workspaceId: "workspace", userWorkosId: "user" };
const input = { template: "custom-template", envs: {}, idleTimeoutMs: 60_000, billingOwner };
const handle = (sandboxId: string) =>
  ({
    sandboxId,
    setTimeout: vi.fn(async () => undefined),
    commands: { run: vi.fn(async () => ({ exitCode: 0 })) },
  }) as unknown as SandboxHandle;

describe("sandbox billing lifecycle wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the actual newly created sandbox before returning it to the workload", async () => {
    const sandbox = handle("new");
    vi.spyOn(Sandbox, "create").mockResolvedValue(sandbox);
    expect(await createOrConnectSandbox(input)).toBe(sandbox);
    expect(registerSandboxBilling).toHaveBeenCalledWith({
      ...billingOwner,
      sandboxId: "new",
      billableFrom: expect.any(Date),
    });
  });

  it("settles a paused interval before connecting and preserves the existing registration", async () => {
    const connect = vi.spyOn(Sandbox, "connect").mockResolvedValue(handle("existing"));
    await createOrConnectSandbox({ ...input, sandboxId: "existing" });
    expect(billSandboxBeforeTransition).toHaveBeenCalledWith("existing");
    expect(vi.mocked(billSandboxBeforeTransition).mock.invocationCallOrder[0]).toBeLessThan(
      connect.mock.invocationCallOrder[0]!,
    );
    expect(registerSandboxBilling).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "existing", ...billingOwner }),
    );
  });

  it("registers a replacement under its new provider id", async () => {
    vi.spyOn(Sandbox, "connect").mockRejectedValue(new SandboxNotFoundError("gone"));
    vi.spyOn(Sandbox, "create").mockResolvedValue(handle("replacement"));
    await createOrConnectSandbox({ ...input, sandboxId: "gone" });
    expect(registerSandboxBilling).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "replacement" }),
    );
  });

  it("does not hand out a sandbox if its billing owner cannot be persisted", async () => {
    vi.spyOn(Sandbox, "create").mockResolvedValue(handle("new"));
    const kill = vi.spyOn(Sandbox, "kill").mockResolvedValue(true);
    vi.mocked(registerSandboxBilling).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(createOrConnectSandbox(input)).rejects.toThrow("database unavailable");
    expect(kill).toHaveBeenCalledWith("new", expect.any(Object));
  });

  it("preserves existing files when registration fails on a reused sandbox", async () => {
    vi.spyOn(Sandbox, "connect").mockResolvedValue(handle("existing"));
    const kill = vi.spyOn(Sandbox, "kill").mockResolvedValue(true);
    vi.mocked(registerSandboxBilling).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(createOrConnectSandbox({ ...input, sandboxId: "existing" })).rejects.toThrow(
      "database unavailable",
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("captures the last confirmed runtime before deletion", async () => {
    const kill = vi.spyOn(Sandbox, "kill").mockResolvedValue(true);
    await expect(killSandbox("existing")).resolves.toBe(true);
    expect(billSandboxBeforeTransition).toHaveBeenCalledWith("existing");
    expect(vi.mocked(billSandboxBeforeTransition).mock.invocationCallOrder[0]).toBeLessThan(
      kill.mock.invocationCallOrder[0]!,
    );
  });
});
