import { describe, expect, it, vi } from "vitest";
import { reconcileManagedSandboxes, SANDBOX_RECONCILE_GRACE_MS } from "./sandbox-reconciler";

describe("reconcileManagedSandboxes", () => {
  it("kills only old managed sandboxes without a live persisted owner", async () => {
    const now = new Date("2026-08-19T12:00:00Z");
    const metadata = (ownerId: string) => ({
      opencompany_managed: "true",
      opencompany_owner_kind: "codex_chat_session",
      opencompany_owner_id: ownerId,
    });
    const list = vi.fn(async () => [
      {
        sandboxId: "live",
        metadata: metadata("session_live"),
        startedAt: new Date(now.getTime() - SANDBOX_RECONCILE_GRACE_MS - 1),
      },
      {
        sandboxId: "orphan",
        metadata: metadata("session_missing"),
        startedAt: new Date(now.getTime() - SANDBOX_RECONCILE_GRACE_MS - 1),
      },
      {
        sandboxId: "creating",
        metadata: metadata("session_creating"),
        startedAt: new Date(now.getTime() - 1_000),
      },
    ]);
    const findLive = vi.fn(async () => new Set(["live"]));
    const kill = vi.fn(async () => true);

    const result = await reconcileManagedSandboxes({
      signal: new AbortController().signal,
      now,
      list,
      findLive,
      kill,
    });

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("orphan");
    expect(result).toEqual({ listed: 3, checked: 2, killed: 1 });
  });
});
