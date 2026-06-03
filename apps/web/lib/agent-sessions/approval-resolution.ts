export type ApprovalResolutionResult =
  | { ok: true; shouldResume: true }
  | { ok: false; error: string; shouldResume: false };

export function determineApprovalResolution(input: {
  sessionId: string;
  toolCallId: string;
  decision: "approved" | "denied";
  workspaceId: string;
  updatedRows: readonly unknown[];
}): ApprovalResolutionResult {
  if (input.updatedRows.length === 0) {
    return {
      ok: false,
      error: "This request is no longer awaiting approval.",
      shouldResume: false,
    };
  }

  return { ok: true, shouldResume: true };
}
