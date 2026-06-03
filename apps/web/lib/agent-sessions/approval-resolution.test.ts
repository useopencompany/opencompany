import { describe, expect, it } from "vitest";
import { determineApprovalResolution } from "./approval-resolution";

const baseInput = {
  sessionId: "ses_123",
  toolCallId: "call_123",
  decision: "denied" as const,
  workspaceId: "wks_123",
};

describe("determineApprovalResolution", () => {
  it("resumes when the approval row was updated", () => {
    expect(determineApprovalResolution({ ...baseInput, updatedRows: [{ id: 1 }] })).toEqual({
      ok: true,
      shouldResume: true,
    });
  });

  it("does not resume when the approval row was already decided", () => {
    expect(determineApprovalResolution({ ...baseInput, updatedRows: [] })).toEqual({
      ok: false,
      error: "This request is no longer awaiting approval.",
      shouldResume: false,
    });
  });
});
