import { describe, expect, it } from "vitest";
import {
  renderCheckinEmail,
  renderFeedbackCallEmail,
  renderOnboardingEmail,
  renderWelcomeEmail,
} from "@/lib/email/templates/onboarding";

const UNSUB = "https://opencompany.example.com/api/email/unsubscribe?token=abc.def";

describe("onboarding email templates", () => {
  it("greets by first name (lowercased) and includes the reply + unsubscribe affordances", () => {
    const email = renderWelcomeEmail({ firstName: "Ada", unsubscribeUrl: UNSUB });
    expect(email.subject).toBe("welcome to opencompany");
    expect(email.text).toContain("hey ada,");
    expect(email.html).toContain("hey ada,");
    expect(email.text).toContain("feedback box");
    expect(email.text).toContain("just reply to this email");
    expect(email.text).toContain("— Louis");
    // The bracketed reply note was removed.
    expect(email.text).not.toContain("it comes to me");
    expect(email.text).toContain(`unsubscribe: ${UNSUB}`);
    expect(email.html).toContain(`href="${UNSUB}"`);
  });

  it("has no emojis and no uppercase except the name Louis", () => {
    const email = renderWelcomeEmail({ unsubscribeUrl: UNSUB });
    // "Louis" is the only allowed uppercase; nothing else should be capitalized.
    expect(email.text.replaceAll("Louis", "")).not.toMatch(/[A-Z]/);
    // No emoji / non-ASCII pictographs (em dash is allowed).
    expect(email.text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("falls back to a generic greeting without a first name", () => {
    const email = renderWelcomeEmail({});
    expect(email.text).toContain("hey there,");
    expect(email.html).toContain("hey there,");
  });

  it("check-in explains sources plus bringing the mcp into the user's tools", () => {
    const email = renderCheckinEmail({ firstName: "Grace", unsubscribeUrl: UNSUB });
    expect(email.subject).toBe("how's it going with opencompany?");
    expect(email.text).toContain("connect the sources");
    expect(email.text).toContain("opencompany mcp");
  });

  it("feedback-call email links the cal.com booking url", () => {
    const email = renderFeedbackCallEmail({ firstName: "Linus", unsubscribeUrl: UNSUB });
    const bookingUrl = "https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding";
    expect(email.subject).toBe("can i grab 15 minutes with you?");
    expect(email.text).toContain(bookingUrl);
    expect(email.html).toContain(`href="${bookingUrl}"`);
  });

  it("dispatches by step", () => {
    expect(renderOnboardingEmail("welcome", {}).subject).toBe(renderWelcomeEmail({}).subject);
    expect(renderOnboardingEmail("checkin", {}).subject).toBe(renderCheckinEmail({}).subject);
    expect(renderOnboardingEmail("feedback_call", {}).subject).toBe(
      renderFeedbackCallEmail({}).subject,
    );
  });

  it("escapes html in the first name", () => {
    const email = renderWelcomeEmail({ firstName: "<script>", unsubscribeUrl: UNSUB });
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).not.toContain("<script>");
  });
});
