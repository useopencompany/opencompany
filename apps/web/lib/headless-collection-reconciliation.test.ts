import { TimeoutWaitingForTxIdError } from "@tanstack/electric-db-collection";
import { describe, expect, it, vi } from "vitest";
import {
  awaitCollectionTransaction,
  reconcileCommittedProjection,
} from "./headless-collection-reconciliation";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("@opencompany/observability", () => ({
  captureException: captureExceptionMock,
}));

describe("committed projection reconciliation", () => {
  it("accepts a delayed Electric projection after the command has committed", async () => {
    const timeout = new TimeoutWaitingForTxIdError(42, "headless-workflows:v1:workspace_1");

    await expect(reconcileCommittedProjection(Promise.reject(timeout))).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(timeout, {
      event: "opencompany.read_model_reconciliation_timeout",
    });
  });

  it("does not hide unexpected reconciliation failures", async () => {
    await expect(
      reconcileCommittedProjection(Promise.reject(new Error("Invalid projection"))),
    ).rejects.toThrow("Invalid projection");
  });
});

describe("collection transaction waits", () => {
  it("waits on a collection that is syncing its shape", async () => {
    const awaitTxId = vi.fn(async () => undefined);

    await awaitCollectionTransaction({ status: "ready", utils: { awaitTxId } }, 42, 1_000);

    expect(awaitTxId).toHaveBeenCalledWith(42, 1_000);
  });

  it("skips a collection nobody subscribed to, whose transaction ids can never arrive", async () => {
    const awaitTxId = vi.fn(async () => undefined);

    await awaitCollectionTransaction({ status: "idle", utils: { awaitTxId } }, 42);
    await awaitCollectionTransaction({ status: "cleaned-up", utils: { awaitTxId } }, 42);

    expect(awaitTxId).not.toHaveBeenCalled();
  });
});
