import { TimeoutWaitingForTxIdError } from "@tanstack/electric-db-collection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitCollectionTransaction,
  observeCommittedProjection,
  reconcileCommittedProjection,
} from "./headless-collection-reconciliation";

const captureExceptionMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());

vi.mock("@opencompany/observability", () => ({
  captureException: captureExceptionMock,
  createLogger: vi.fn(() => ({ warn: warnMock })),
}));

beforeEach(() => {
  captureExceptionMock.mockClear();
  warnMock.mockClear();
});

describe("committed projection reconciliation", () => {
  it("accepts a delayed Electric projection after the command has committed", async () => {
    const timeout = new TimeoutWaitingForTxIdError(42, "headless-workflows:v1:workspace_1");

    await expect(reconcileCommittedProjection(Promise.reject(timeout))).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith("Committed projection reconciliation timed out", {
      event: "opencompany.read_model_reconciliation_timeout",
      error: timeout,
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("does not hide unexpected reconciliation failures", async () => {
    await expect(
      reconcileCommittedProjection(Promise.reject(new Error("Invalid projection"))),
    ).rejects.toThrow("Invalid projection");
  });

  it("reports unexpected failures while observing reconciliation in the background", async () => {
    const error = new Error("Invalid projection");

    observeCommittedProjection(Promise.reject(error));

    await vi.waitFor(() =>
      expect(captureExceptionMock).toHaveBeenCalledWith(error, {
        event: "opencompany.read_model_reconciliation_failed",
      }),
    );
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
