import { describe, expect, it } from "vitest";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SEND_SCOPE,
  hasGmailDraftScope,
  hasGmailSendScope,
} from "./gmail-scopes";

describe("Gmail OAuth scope capabilities", () => {
  it("treats compose as draft- and send-capable", () => {
    expect(hasGmailDraftScope([GMAIL_COMPOSE_SCOPE])).toBe(true);
    expect(hasGmailSendScope([GMAIL_COMPOSE_SCOPE])).toBe(true);
  });

  it("does not treat the send-only scope as draft-capable", () => {
    expect(hasGmailDraftScope([GMAIL_SEND_SCOPE])).toBe(false);
    expect(hasGmailSendScope([GMAIL_SEND_SCOPE])).toBe(true);
  });

  it("accepts broader legacy grants and rejects malformed scope values", () => {
    for (const scope of [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.modify",
    ]) {
      expect(hasGmailDraftScope([scope])).toBe(true);
      expect(hasGmailSendScope([scope])).toBe(true);
    }
    expect(hasGmailDraftScope(null)).toBe(false);
    expect(hasGmailDraftScope(["gmail.compose", 42])).toBe(false);
  });
});
