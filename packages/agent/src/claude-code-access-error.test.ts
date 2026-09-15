import { describe, expect, it } from "vitest";
import { classifyClaudeCodeAccessFailure } from "./claude-code-access-error";

describe("classifyClaudeCodeAccessFailure", () => {
  it.each([
    "Failed to authenticate. API Error: 401",
    "OAuth token has expired",
    "Unauthorized: login expired",
    "Invalid API key",
  ])("recognizes rejected credentials: %s", (message) => {
    expect(classifyClaudeCodeAccessFailure(message)?.kind).toBe("credential_rejected");
    expect(classifyClaudeCodeAccessFailure(message)?.invalidateCredential).toBe(true);
  });

  it("distinguishes an organization access denial from a rejected token", () => {
    expect(
      classifyClaudeCodeAccessFailure(
        "Internal error: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
      ),
    ).toMatchObject({
      kind: "organization_access_disabled",
      invalidateCredential: false,
      turnMessage: expect.stringContaining("if it continues"),
    });
  });

  it.each([
    "You're out of usage credits · resets 10am (UTC)",
    "Credit balance is too low",
    "5-hour limit reached - resets 10am (UTC)",
  ])("keeps credentials connected for usage limits: %s", (message) => {
    expect(classifyClaudeCodeAccessFailure(message)).toBeNull();
  });
});
