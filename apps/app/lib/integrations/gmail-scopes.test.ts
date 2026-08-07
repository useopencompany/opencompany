import { describe, expect, it } from "vitest";
import {
  GOAT_GMAIL_COMPOSE_SCOPE,
  GOAT_GMAIL_SEND_SCOPE,
  hasGoatGmailDraftScope,
  hasGoatGmailSendScope,
} from "./gmail-scopes";

describe("Gmail OAuth scope capabilities", () => {
  it("treats compose as draft- and send-capable", () => {
    expect(hasGoatGmailDraftScope([GOAT_GMAIL_COMPOSE_SCOPE])).toBe(true);
    expect(hasGoatGmailSendScope([GOAT_GMAIL_COMPOSE_SCOPE])).toBe(true);
  });

  it("does not treat the send-only scope as draft-capable", () => {
    expect(hasGoatGmailDraftScope([GOAT_GMAIL_SEND_SCOPE])).toBe(false);
    expect(hasGoatGmailSendScope([GOAT_GMAIL_SEND_SCOPE])).toBe(true);
  });

  it("accepts broader legacy grants and rejects malformed scope values", () => {
    for (const scope of [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.modify",
    ]) {
      expect(hasGoatGmailDraftScope([scope])).toBe(true);
      expect(hasGoatGmailSendScope([scope])).toBe(true);
    }
    expect(hasGoatGmailDraftScope(null)).toBe(false);
    expect(hasGoatGmailDraftScope(["gmail.compose", 42])).toBe(false);
  });
});
