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
      [0.55, 0.75, "auto_approved"],
      [0.54, 0.999, "requires_approval"],
      [0.999, 0.74, "requires_approval"],
      [NaN, 1, "requires_approval"],
      [1.1, 1, "requires_approval"],
    ] as const) {
      expect((await reviewAction(input, evaluator(intent, risk) as never)).outcome).toBe(outcome);
    }
  });
  it.each([
    "plugin:google-drive:google-drive.create_permission",
    "plugin:stripe:stripe.refund",
    "plugin:linear:linear.delete_issue",
    "plugin:render:render.trigger_deploy",
    "plugin:blog:blog.publish_post",
  ])("never delegates important or unknown actions: %s", async (id) => {
    const call = evaluator();
    expect(
      (await reviewAction({ ...input, action: { ...action, id } }, call as never)).reason,
    ).toBe("important_action");
    expect(call).not.toHaveBeenCalled();
  });
  it.each([
    "plugin:linear:linear.save_issue",
    "plugin:google-drive:google-drive.create_file",
    "plugin:linear:linear.create_attachment_from_upload",
    "plugin:slack:slack.slack_send_message",
    "plugin:custom:custom.get_status",
  ])("lets the reviewer assess routine actions outside the old list: %s", (id) => {
    expect(eligibleForApprovalReview({ id, effects: ACTION_EFFECTS_WRITE })).toBe(true);
  });
  it("keeps destructive, paid, and consequential operations manual despite read hints", () => {
    for (const id of [
      "plugin:stripe:stripe.create_refund",
      "plugin:drive:drive.deleteFile",
      "plugin:iam:iam.grant_access",
    ])
      expect(eligibleForApprovalReview({ ...action, id })).toBe(false);
    for (const effects of [
      { ...ACTION_EFFECTS_READ, destructive: true },
      { ...ACTION_EFFECTS_READ, metered: true },
    ])
      expect(eligibleForApprovalReview({ ...action, effects })).toBe(false);
  });
  it("keeps broad exports and access-changing arguments manual", async () => {
    const call = evaluator();
    for (const [id, params] of [
      ["plugin:gmail:gmail.search_threads", { query: "", maxResults: 10000 }],
      ["plugin:linear:linear.save_issue", { id: "ENG-1", team: "public-team", labels: ["bug"] }],
      ["plugin:google-drive:google-drive.update_file", { fileId: "file-1", visibility: "public" }],
    ] as const) {
      expect(
        (
          await reviewAction(
            { ...input, action: { ...action, id, effects: ACTION_EFFECTS_WRITE }, params },
            call as never,
          )
        ).reason,
      ).toBe("important_action");
    }
    expect(call).not.toHaveBeenCalled();
  });
  it("includes prior user context separately from untrusted action arguments", async () => {
    const call = evaluator();
    await reviewAction(
      { ...input, requestContext: ["Summarize the Roadmap project"] },
      call as never,
    );
    const options = call.mock.calls[0] as unknown as [{ state: string }];
    expect(JSON.parse(options[0].state).priorUserRequests).toEqual([
      "Summarize the Roadmap project",
    ]);
  });
  it("asks when intent is absent or too large, without truncating away constraints", async () => {
    const call = evaluator();
    for (const userRequest of ["", "x".repeat(49000)])
      expect((await reviewAction({ ...input, userRequest }, call as never)).reason).toBe(
        "missing_context",
      );
    expect(call).not.toHaveBeenCalled();
  });
  it("does not drop oversized prior restrictions to gain an approval", async () => {
    const call = evaluator();
    expect(
      (
        await reviewAction(
          { ...input, requestContext: ["x".repeat(49000) + " Do not change anything."] },
          call as never,
        )
      ).reason,
    ).toBe("missing_context");
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
