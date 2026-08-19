import { TimeoutWaitingForTxIdError } from "@tanstack/electric-db-collection";
import { describe, expect, it, vi } from "vitest";
import { reconcileCommittedProjection } from "./headless-collection-reconciliation";

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
