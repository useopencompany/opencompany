import type { OnboardingEmailStep as OnboardingEmailStep } from "@opencompany/protocol";

// Plain, personal founder emails — no heavy HTML chrome, no emojis, all lowercase.
// Each email is written so replies land in Louis' inbox and every send carries an
// unsubscribe link.

const FEEDBACK_CALL_URL = "https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding";

export type OnboardingEmailRenderInput = {
  firstName?: string | null | undefined;
  unsubscribeUrl?: string | null | undefined;
};

type Paragraph = { html: string; text: string };

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function greeting(firstName?: string | null): Paragraph {
  // Lowercase the name too, to match the all-lowercase house style.
  const name = firstName?.trim().toLowerCase();
  const line = name ? `hey ${name},` : "hey there,";
  return { html: escapeHtml(line), text: line };
}

// A plain paragraph whose text is identical in the HTML and text parts.
function p(text: string): Paragraph {
  return { html: escapeHtml(text), text };
}

function link(label: string, url: string): Paragraph {
  return {
    html: `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
    text: `${label}: ${url}`,
  };
}

function render(
  subject: string,
  paragraphs: Paragraph[],
  unsubscribeUrl?: string | null,
): { subject: string; html: string; text: string } {
  // "Louis" stays capitalized — a deliberate exception to the all-lowercase style.
  const signOff = p("— Louis");
  const body = [...paragraphs, signOff];

  const textParts: string[] = [];
  for (const part of body) {
    textParts.push(part.text, "");
  }

  const htmlParts = ["<!doctype html>", '<html lang="en">', "<body>"];
  for (const part of body) {
    htmlParts.push(`<p>${part.html}</p>`);
  }

  const unsubscribe = unsubscribeUrl?.trim();
  if (unsubscribe) {
    textParts.push(`unsubscribe: ${unsubscribe}`);
    htmlParts.push(
      `<p style="color:#666;font-size:12px;margin-top:32px"><a href="${escapeHtml(unsubscribe)}">unsubscribe</a></p>`,
    );
  }

  htmlParts.push("</body>", "</html>");

  return {
    subject,
    text: textParts.join("\n").trimEnd(),
    html: htmlParts.join(""),
  };
}

export function renderWelcomeEmail(input: OnboardingEmailRenderInput) {
  return render(
    "welcome to opencompany",
    [
      greeting(input.firstName),
      p("Louis here — founder of opencompany. thanks for giving it a try."),
      p(
        "two quick things. first: you can always send me feedback directly — just reply to this email, or use the feedback box in the app. i read every bit of it and move fast.",
      ),
      p(
        "second, so i can actually help: what are you hoping opencompany does for you and your team? hit reply and tell me — even a one-liner is useful.",
      ),
    ],
    input.unsubscribeUrl,
  );
}

export function renderCheckinEmail(input: OnboardingEmailRenderInput) {
  return render(
    "how's it going with opencompany?",
    [
      greeting(input.firstName),
      p("quick check-in — how are you finding it so far? any questions i can answer?"),
      p(
        "one thing worth doing early: the brain gets a lot more useful once it has real context. two quick wins — first, connect the sources that actually matter to you (slack, gmail, linear, your docs). second, bring the opencompany mcp into wherever you already work (claude, cursor, your editor) so the brain is right there in your flow instead of a separate tab.",
      ),
      p("want a hand with either? just reply — happy to walk through it with you."),
    ],
    input.unsubscribeUrl,
  );
}

export function renderFeedbackCallEmail(input: OnboardingEmailRenderInput) {
  return render(
    "can i grab 15 minutes with you?",
    [
      greeting(input.firstName),
      p(
        "you've been using opencompany for a few days now, and i'd genuinely love to hear how it's going — what's working, and (honestly, more useful to me) what isn't.",
      ),
      link("grab any slot that works for you", FEEDBACK_CALL_URL),
      p("even 15 minutes directly shapes what we build next. thank you."),
    ],
    input.unsubscribeUrl,
  );
}

export function renderOnboardingEmail(
  step: OnboardingEmailStep,
  input: OnboardingEmailRenderInput,
) {
  switch (step) {
    case "welcome":
      return renderWelcomeEmail(input);
    case "checkin":
      return renderCheckinEmail(input);
    case "feedback_call":
      return renderFeedbackCallEmail(input);
    default: {
      const exhaustive: never = step;
      throw new Error(`Unknown onboarding email step: ${String(exhaustive)}`);
    }
  }
}
