import { Sandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedSandboxMetadata } from "./sandbox";
import {
  listManagedSandboxes,
  reconcileManagedSandboxes,
  SANDBOX_RECONCILE_GRACE_MS,
} from "./sandbox-reconciler";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managedSandboxMetadata", () => {
  it("includes the reconciler namespace", () => {
    expect(
      managedSandboxMetadata({
        namespace: "production",
        ownerKind: "codex_chat_session",
        ownerId: "session_1",
      }),
    ).toEqual({
      opencompany_managed: "true",
      opencompany_sandbox_namespace: "production",
      opencompany_owner_kind: "codex_chat_session",
      opencompany_owner_id: "session_1",
    });
  });
});

describe("listManagedSandboxes", () => {
  it("asks E2B for only the configured namespace", async () => {
    let hasNext = true;
    const nextItems = vi.fn(async () => {
      hasNext = false;
      return [];
    });
    const list = vi.spyOn(Sandbox, "list").mockReturnValue({
      get hasNext() {
        return hasNext;
      },
      nextItems,
    } as never);
    const signal = new AbortController().signal;

    await listManagedSandboxes(signal, "local_workspace_1");

    expect(list).toHaveBeenCalledWith({
      query: {
        metadata: {
          opencompany_managed: "true",
          opencompany_sandbox_namespace: "local_workspace_1",
        },
      },
      limit: 100,
      requestTimeoutMs: 30_000,
    });
    expect(nextItems).toHaveBeenCalledWith({ signal, requestTimeoutMs: 30_000 });
  });
});

describe("reconcileManagedSandboxes", () => {
  it("kills only old sandboxes in its namespace without a live persisted owner", async () => {
    const now = new Date("2026-08-19T12:00:00Z");
    const metadata = (ownerId: string, namespace = "production") => ({
      opencompany_managed: "true",
      opencompany_sandbox_namespace: namespace,
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
      {
        sandboxId: "local-orphan",
        metadata: metadata("session_local", "local_workspace_1"),
        startedAt: new Date(now.getTime() - SANDBOX_RECONCILE_GRACE_MS - 1),
      },
    ]);
    const findLive = vi.fn(async () => new Set(["live"]));
    const kill = vi.fn(async () => true);

    const result = await reconcileManagedSandboxes({
      signal: new AbortController().signal,
      namespace: "production",
      now,
      list,
      findLive,
      kill,
    });

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("orphan");
    expect(result).toEqual({ listed: 4, checked: 2, killed: 1 });
  });
});
