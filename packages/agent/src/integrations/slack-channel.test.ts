import { describe, expect, it, vi } from "vitest";
import { isSupportedSlackChannel, postWorkflowSlackMessage } from "./slack-channel";

describe("Slack Channel boundary", () => {
  it("allows only public channels the bot has joined", () => {
    expect(isSupportedSlackChannel({ id: "C123", is_member: true })).toBe(true);
    for (const forbidden of [
      "is_private",
      "is_im",
      "is_mpim",
      "is_shared",
      "is_ext_shared",
      "is_pending_ext_shared",
      "is_archived",
    ]) {
      expect(isSupportedSlackChannel({ id: "C123", is_member: true, [forbidden]: true })).toBe(
        false,
      );
    }
    expect(isSupportedSlackChannel({ id: "C123" })).toBe(false);
    expect(isSupportedSlackChannel({ id: "D123", is_member: true })).toBe(false);
  });
  it("rejects an inactive, foreign, or unsubscribed turn before any provider request", async () => {
    await expect(
      postWorkflowSlackMessage(
        {
          runId: "unavailable",
          actorId: "member",
          post: { channel: "#product", text: "Result", messageKey: "summary" },
        },
        async () => [],
      ),
    ).rejects.toThrow("active session with Slack posting enabled");
  });
  it("bounds messages and requires a stable idempotency key", async () => {
    const execute = vi.fn();
    for (const post of [
      { channel: "C123", text: "", messageKey: "summary" },
      { channel: "C123", text: "x".repeat(3501), messageKey: "summary" },
      { channel: "C123", text: "Result", messageKey: "" },
    ])
      await expect(
        postWorkflowSlackMessage({ runId: "run", actorId: "member", post }, execute),
      ).rejects.toThrow("Provide text");
    expect(execute).not.toHaveBeenCalled();
  });
});
