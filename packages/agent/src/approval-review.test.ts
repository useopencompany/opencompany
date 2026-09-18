import { describe, expect, it, vi } from "vitest";
import { ACTION_EFFECTS_READ, ACTION_EFFECTS_WRITE } from "./actions/types";
import { eligibleForApprovalReview, reviewAction } from "./approval-review";

const action = {
  id: "plugin:linear:linear.get_issue",
  effects: ACTION_EFFECTS_READ,
  description: "Get an issue",
};
const input = {
  action,
  params: { id: "ENG-1" },
  userRequest: "Summarize ENG-1",
  apiKey: "test-key",
};
const evaluator = (authorized = 0.999, routine = 0.999) =>
  vi.fn(async () => ({
    answers: { authorized: { probability: authorized }, routine: { probability: routine } },
  }));

describe("automatic approval review", () => {
  it("requires both clear intent and low risk", async () => {
    for (const [intent, risk, outcome] of [
      [0.999, 0.999, "auto_approved"],
      [0.74, 0.999, "requires_approval"],
      [0.999, 0.74, "requires_approval"],
      [NaN, 1, "requires_approval"],
      [1.1, 1, "requires_approval"],
    ] as const) {
      expect((await reviewAction(input, evaluator(intent, risk) as never)).outcome).toBe(outcome);
    }
  });
  it.each([
    "plugin:slack:slack.slack_send_message",
    "plugin:stripe:stripe.refund",
    "plugin:linear:linear.delete_issue",
    "plugin:custom:unknown.read",
    "plugin:github:github.merge_pull_request",
  ])("never delegates important or unknown actions: %s", async (id) => {
    const call = evaluator();
    expect(
      (await reviewAction({ ...input, action: { ...action, id } }, call as never)).reason,
    ).toBe("important_action");
    expect(call).not.toHaveBeenCalled();
  });
  it("allows only a narrowly scoped label update, not other issue edits", () => {
    const write = { id: "plugin:linear:linear.save_issue", effects: ACTION_EFFECTS_WRITE };
    expect(eligibleForApprovalReview(write, { id: "ENG-1", labels: ["bug"] })).toBe(true);
    expect(eligibleForApprovalReview(write, { id: "ENG-1", labels: [], assignee: "other" })).toBe(
      false,
    );
    expect(eligibleForApprovalReview(write, { labels: [] })).toBe(false);
  });
  it("does not trust read annotations or destructive/metered actions", () => {
    expect(eligibleForApprovalReview({ ...action, effects: ACTION_EFFECTS_WRITE }, {})).toBe(false);
    expect(
      eligibleForApprovalReview(
        { ...action, effects: { ...ACTION_EFFECTS_READ, destructive: true } },
        {},
      ),
    ).toBe(false);
    expect(
      eligibleForApprovalReview(
        { ...action, effects: { ...ACTION_EFFECTS_READ, metered: true } },
        {},
      ),
    ).toBe(false);
  });
  it("asks when intent is absent or too large, without truncating away constraints", async () => {
    const call = evaluator();
    for (const userRequest of ["", "x".repeat(25000)])
      expect((await reviewAction({ ...input, userRequest }, call as never)).reason).toBe(
        "missing_context",
      );
    expect(call).not.toHaveBeenCalled();
  });
  it("asks when the provider fails or returns malformed output", async () => {
    expect((await reviewAction(input, vi.fn().mockRejectedValue(new Error("secret")))).reason).toBe(
      "unavailable",
    );
    expect((await reviewAction(input, vi.fn().mockResolvedValue({ answers: {} }))).reason).toBe(
      "unavailable",
    );
    expect((await reviewAction({ ...input, apiKey: undefined }, evaluator() as never)).reason).toBe(
      "unavailable",
    );
  });
  it("sends only review fields, not runtime connection metadata", async () => {
    const call = evaluator();
    const runtimeAction = {
      ...action,
      approvalContext: "private-connection-metadata",
      permission: { integrationIds: ["private-id"] },
    };
    await reviewAction({ ...input, action: runtimeAction }, call as never);
    const options = call.mock.calls[0] as unknown as [{ state: string }];
    const state = JSON.parse(options[0].state);
    expect(Object.keys(state.action).sort()).toEqual(["description", "effects", "id"]);
    expect(options[0].state).not.toContain("private-");
  });
});
