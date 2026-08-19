import { TimeoutWaitingForTxIdError } from "@tanstack/electric-db-collection";
import { describe, expect, it } from "vitest";
import { reconcileCommittedProjection } from "./headless-collection-reconciliation";

describe("committed projection reconciliation", () => {
  it("accepts a delayed Electric projection after the command has committed", async () => {
    await expect(
      reconcileCommittedProjection(
        Promise.reject(new TimeoutWaitingForTxIdError(42, "headless-workflows:v1:workspace_1")),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not hide unexpected reconciliation failures", async () => {
    await expect(
      reconcileCommittedProjection(Promise.reject(new Error("Invalid projection"))),
    ).rejects.toThrow("Invalid projection");
  });
});
