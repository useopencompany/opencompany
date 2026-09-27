import { Sandbox } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedSandboxMetadata } from "./sandbox";
import {
  listManagedSandboxes,
  reconcileManagedSandboxes,
  SANDBOX_RECONCILE_GRACE_MS,
  startSandboxReconciler,
} from "./sandbox-reconciler";

const observability = vi.hoisted(() => ({
  captureException: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: observability.captureException,
  createLogger: () => ({
    error: observability.error,
    warn: observability.warn,
    info: observability.info,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("managedSandboxMetadata", () => {
  it("includes the reconciler namespace", () => {
    expect(
      managedSandboxMetadata({
        namespace: "production",
        ownerKind: "codex_chat_session",
        ownerId: "session_1",
        execution: { backend: "runner_attached", version: 1 },
      }),
    ).toEqual({
      opencompany_managed: "true",
      opencompany_sandbox_namespace: "production",
      opencompany_owner_kind: "codex_chat_session",
      opencompany_owner_id: "session_1",
      opencompany_execution_backend: "runner_attached",
      opencompany_execution_backend_version: "1",
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

describe("startSandboxReconciler", () => {
  it("keeps provider request timeouts in retry telemetry", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    let hasNext = true;
    vi.spyOn(Sandbox, "list").mockReturnValue({
      get hasNext() {
        return hasNext;
      },
      nextItems: vi.fn(async () => {
        hasNext = false;
        throw timeout;
      }),
    } as never);

    const worker = startSandboxReconciler({ namespace: "production", pollIntervalMs: 60_000 });
    await vi.waitFor(() =>
      expect(observability.warn).toHaveBeenCalledWith(
        "Managed sandbox reconciliation timed out; the next poll will retry",
        {
          event: "opencompany.runner_sandbox_reconcile_deferred",
          error: timeout,
        },
      ),
    );
    await worker.stop();

    expect(observability.captureException).not.toHaveBeenCalled();
    expect(observability.error).not.toHaveBeenCalled();
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
        sandboxId: "v2-orphan",
        metadata: {
          ...metadata("session_v2"),
          opencompany_execution_backend: "sandbox_supervisor",
          opencompany_execution_backend_version: "1",
        },
        startedAt: new Date(now.getTime() - SANDBOX_RECONCILE_GRACE_MS - 1),
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
    expect(result).toEqual({ listed: 5, checked: 2, killed: 1 });
  });
});
